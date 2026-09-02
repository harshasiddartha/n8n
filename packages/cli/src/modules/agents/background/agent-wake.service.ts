import { LockNamespace, LockService, Logger } from '@n8n/backend-common';
import { AgentsConfig } from '@n8n/config';
import { UserRepository } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';

import { Publisher } from '@/scaling/pubsub/publisher.service';

import type { AgentBackgroundJob } from '../entities/agent-background-job.entity';
import { AgentExecutionOrchestratorService } from '../agent-execution-orchestrator.service';
import { hashAgentSandboxPrincipal, isAgentSandboxPrincipalHash } from '../agent-sandbox-principal';
import { ChatIntegrationRegistry } from '../integrations/agent-chat-integration';
import { N8NCheckpointStorage } from '../integrations/n8n-checkpoint-storage';
import { AgentBackgroundJobRepository } from '../repositories/agent-background-job.repository';
import { AgentExecutionRepository } from '../repositories/agent-execution.repository';
import { AgentRepository } from '../repositories/agent.repository';
import {
	integrationTypeFromMemoryResourceId,
	userIdFromDraftChatMemoryResourceId,
} from '../utils/agent-memory-scope';
import { AGENT_BACKGROUND_UPDATES_TAG, formatWakeMessage } from './background-job-messages';

export const WAKE_DEBOUNCE_MS = 5_000;
export const MAX_CONSECUTIVE_FAILED_WAKES = 3;

const WAKE_LOCK_WAIT_MS = 250;
const WAKE_LOCK_TTL_MS = 30_000;

type FailureState = { generation: string; count: number };

@Service()
export class AgentWakeService {
	private readonly timers = new Map<string, NodeJS.Timeout>();

	private readonly failures = new Map<string, FailureState>();

	constructor(
		private readonly jobRepository: AgentBackgroundJobRepository,
		private readonly executionRepository: AgentExecutionRepository,
		private readonly agentRepository: AgentRepository,
		private readonly userRepository: UserRepository,
		private readonly checkpointStorage: N8NCheckpointStorage,
		private readonly integrationRegistry: ChatIntegrationRegistry,
		private readonly orchestrator: AgentExecutionOrchestratorService,
		private readonly lockService: LockService,
		private readonly publisher: Publisher,
		private readonly instanceSettings: InstanceSettings,
		private readonly agentsConfig: AgentsConfig,
		private readonly logger: Logger,
	) {
		this.logger = this.logger.scoped('agents');
	}

	async requestWake(threadId: string): Promise<void> {
		if (!this.agentsConfig.backgroundTasksEnabled) return;
		if (this.instanceSettings.isWorker) {
			await this.publisher.publishCommand({
				command: 'wake-agent-background-job',
				payload: { threadId },
			});
			return;
		}
		this.scheduleLocal(threadId);
	}

	@OnPubSubEvent('wake-agent-background-job', { instanceType: 'main' })
	handleWakeRelay({ threadId }: { threadId: string }): void {
		if (!this.agentsConfig.backgroundTasksEnabled) return;
		this.scheduleLocal(threadId);
	}

	async drainUnconsumed(): Promise<void> {
		if (!this.agentsConfig.backgroundTasksEnabled) return;
		const threadIds = await this.jobRepository.findThreadsWithUnconsumedMail();
		for (const threadId of threadIds) this.scheduleLocal(threadId);
	}

	async onParentTurnFinished(threadId: string): Promise<void> {
		this.failures.delete(threadId);
		await this.requestWake(threadId);
	}

	async getBackgroundUpdates(threadId: string): Promise<string | undefined> {
		if (!this.agentsConfig.backgroundTasksEnabled) return undefined;
		const jobs = await this.jobRepository.findWakeableUnconsumedSettled(threadId);
		if (jobs.length === 0) return undefined;
		const summaries = jobs.map((job) => `"${job.title}" (${job.status})`).join(', ');
		return `${AGENT_BACKGROUND_UPDATES_TAG}${jobs.length} background job(s) settled: ${summaries}. Call check_background_jobs before you finish this turn.</background-updates>`;
	}

	private scheduleLocal(threadId: string): void {
		if (this.timers.has(threadId)) return;
		const timer = setTimeout(() => {
			this.timers.delete(threadId);
			void this.attemptWake(threadId);
		}, WAKE_DEBOUNCE_MS);
		timer.unref();
		this.timers.set(threadId, timer);
	}

	async attemptWake(threadId: string): Promise<void> {
		if (!this.agentsConfig.backgroundTasksEnabled) return;

		try {
			await this.lockService.withLease(
				LockNamespace.KNOWN_LOCKS,
				`agent-background-wake:${threadId}`,
				async (signal) => await this.deliverInsideLease(threadId, signal),
				{ waitTimeoutMs: WAKE_LOCK_WAIT_MS, leaseTtlMs: WAKE_LOCK_TTL_MS },
			);
		} catch (error) {
			this.logger.warn('Could not acquire the background job wake lease', { threadId, error });
		}
	}

	private async deliverInsideLease(threadId: string, signal: AbortSignal): Promise<void> {
		const jobs = await this.jobRepository.findWakeableUnconsumedSettled(threadId);
		if (jobs.length === 0 || signal.aborted) return;

		const generation = jobs
			.map((job) => job.id)
			.sort()
			.join(':');
		const failure = this.failures.get(threadId);
		if (failure?.generation === generation && failure.count >= MAX_CONSECUTIVE_FAILED_WAKES) {
			return;
		}

		const first = jobs[0];
		if (!first || !this.hasOneParentIdentity(jobs, first)) {
			this.recordFailure(
				threadId,
				generation,
				'Background job mail has conflicting parent identity',
			);
			return;
		}

		if (
			(await this.executionRepository.existsRunningByThread(threadId)) ||
			(await this.checkpointStorage.findSuspendedForThread(first.parentAgentId, threadId)) !== null
		) {
			return;
		}

		const agent = await this.agentRepository.findById(first.parentAgentId);
		if (!agent || !first.parentResourceId || !first.parentPrincipalHash) {
			this.recordFailure(threadId, generation, 'Background job parent no longer exists');
			return;
		}

		try {
			const message = formatWakeMessage(jobs);
			const userId = userIdFromDraftChatMemoryResourceId(first.parentResourceId);
			if (userId) {
				const expectedHash = hashAgentSandboxPrincipal({ type: 'n8n-user', userId });
				if (expectedHash !== first.parentPrincipalHash) {
					throw new Error('Draft wake identity does not match its principal');
				}
				const user = await this.userRepository.findOneBy({ id: userId });
				if (!user) throw new Error('Draft wake user no longer exists');
				await this.orchestrator.executeForWake({
					agentId: agent.id,
					projectId: agent.projectId,
					message,
					memory: { threadId, resourceId: first.parentResourceId },
					identity: { type: 'draft', user, principalHash: expectedHash },
					abortSignal: signal,
				});
			} else {
				const integrationType = integrationTypeFromMemoryResourceId(first.parentResourceId);
				if (
					!integrationType ||
					!this.integrationRegistry.get(integrationType) ||
					!isAgentSandboxPrincipalHash(first.parentPrincipalHash)
				) {
					throw new Error('Published wake identity is invalid');
				}
				await this.orchestrator.executeForWake({
					agentId: agent.id,
					projectId: agent.projectId,
					message,
					memory: { threadId, resourceId: first.parentResourceId },
					identity: {
						type: 'published',
						integrationType,
						principalHash: first.parentPrincipalHash,
					},
					abortSignal: signal,
				});
			}

			if (signal.aborted) return;
			await this.jobRepository.markMailConsumed(
				threadId,
				jobs.map((job) => job.id),
			);
			this.failures.delete(threadId);
		} catch (error) {
			if (signal.aborted) return;
			this.recordFailure(
				threadId,
				generation,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private hasOneParentIdentity(jobs: AgentBackgroundJob[], first: AgentBackgroundJob): boolean {
		return jobs.every(
			(job) =>
				job.parentAgentId === first.parentAgentId &&
				job.parentResourceId === first.parentResourceId &&
				job.parentPrincipalHash === first.parentPrincipalHash,
		);
	}

	private recordFailure(threadId: string, generation: string, reason: string): void {
		const previous = this.failures.get(threadId);
		const count = previous?.generation === generation ? previous.count + 1 : 1;
		this.failures.set(threadId, { generation, count });
		this.logger.warn('Failed to deliver background job mail to its parent agent', {
			threadId,
			attempt: count,
			reason,
		});
	}
}
