import type { LockService, Logger } from '@n8n/backend-common';
import type { AgentsConfig } from '@n8n/config';
import type { UserRepository } from '@n8n/db';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { Publisher } from '@/scaling/pubsub/publisher.service';

import type { AgentExecutionOrchestratorService } from '../../agent-execution-orchestrator.service';
import { hashAgentSandboxPrincipal } from '../../agent-sandbox-principal';
import type { AgentBackgroundJob } from '../../entities/agent-background-job.entity';
import type { ChatIntegrationRegistry } from '../../integrations/agent-chat-integration';
import type { N8NCheckpointStorage } from '../../integrations/n8n-checkpoint-storage';
import type { AgentBackgroundJobRepository } from '../../repositories/agent-background-job.repository';
import type { AgentExecutionRepository } from '../../repositories/agent-execution.repository';
import type { AgentRepository } from '../../repositories/agent.repository';
import {
	AgentWakeService,
	MAX_CONSECUTIVE_FAILED_WAKES,
	WAKE_DEBOUNCE_MS,
} from '../agent-wake.service';
import { formatWakeMessage, WAKE_RESULT_TEXT_MAX_CHARS } from '../background-job-messages';

const user = { id: 'user-1' };
const principalHash = hashAgentSandboxPrincipal({ type: 'n8n-user', userId: user.id });

function makeJob(overrides: Partial<AgentBackgroundJob> = {}): AgentBackgroundJob {
	return {
		id: 'job-1',
		kind: 'subagent',
		status: 'completed',
		parentAgentId: 'agent-1',
		parentThreadId: 'thread-1',
		parentResourceId: `draft-chat:${user.id}`,
		parentPrincipalHash: principalHash,
		title: 'Research',
		subAgentId: 'sub-agent-1',
		childThreadId: 'child-thread-1',
		childExecutionId: null,
		workflowId: null,
		timeoutAt: null,
		result: 'Done',
		error: null,
		settledAt: new Date(),
		notifiedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as AgentBackgroundJob;
}

function setup(options: { worker?: boolean; enabled?: boolean } = {}) {
	const jobRepository = mock<AgentBackgroundJobRepository>();
	const executionRepository = mock<AgentExecutionRepository>();
	const agentRepository = mock<AgentRepository>();
	const userRepository = mock<UserRepository>();
	const checkpointStorage = mock<N8NCheckpointStorage>();
	const integrationRegistry = mock<ChatIntegrationRegistry>();
	const orchestrator = mock<AgentExecutionOrchestratorService>();
	const lockService = mock<LockService>();
	const publisher = mock<Publisher>();
	const instanceSettings = mock<InstanceSettings>({ isWorker: options.worker ?? false });
	const agentsConfig = mock<AgentsConfig>({ backgroundTasksEnabled: options.enabled ?? true });
	const logger = mock<Logger>();
	logger.scoped.mockReturnValue(logger);

	jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([makeJob()]);
	executionRepository.existsRunningByThread.mockResolvedValue(false);
	checkpointStorage.findSuspendedForThread.mockResolvedValue(null);
	agentRepository.findById.mockResolvedValue({ id: 'agent-1', projectId: 'project-1' } as never);
	userRepository.findOneBy.mockResolvedValue(user as never);
	integrationRegistry.get.mockReturnValue({} as never);
	lockService.withLease.mockImplementation(async (_namespace, _key, callback) => {
		return await callback(new AbortController().signal);
	});

	const service = new AgentWakeService(
		jobRepository,
		executionRepository,
		agentRepository,
		userRepository,
		checkpointStorage,
		integrationRegistry,
		orchestrator,
		lockService,
		publisher,
		instanceSettings,
		agentsConfig,
		logger,
	);

	return {
		service,
		jobRepository,
		executionRepository,
		checkpointStorage,
		orchestrator,
		lockService,
		publisher,
		integrationRegistry,
	};
}

describe('AgentWakeService', () => {
	it('debounces wakes for one thread', async () => {
		vi.useFakeTimers();
		try {
			const { service, lockService } = setup();

			await service.requestWake('thread-1');
			await service.requestWake('thread-1');
			expect(lockService.withLease).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

			expect(lockService.withLease).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('routes worker wakes through pubsub', async () => {
		const { service, publisher, lockService } = setup({ worker: true });

		await service.requestWake('thread-1');

		expect(publisher.publishCommand).toHaveBeenCalledWith({
			command: 'wake-agent-background-job',
			payload: { threadId: 'thread-1' },
		});
		expect(lockService.withLease).not.toHaveBeenCalled();
	});

	it('does nothing while background tasks are disabled', async () => {
		const { service, publisher, lockService, jobRepository } = setup({ enabled: false });

		await service.requestWake('thread-1');
		await service.drainUnconsumed();
		await service.attemptWake('thread-1');

		expect(publisher.publishCommand).not.toHaveBeenCalled();
		expect(lockService.withLease).not.toHaveBeenCalled();
		expect(jobRepository.findThreadsWithUnconsumedMail).not.toHaveBeenCalled();
	});

	it('does not wake when a check consumes the mail before the debounce ends', async () => {
		vi.useFakeTimers();
		try {
			const { service, jobRepository, orchestrator } = setup();
			await service.requestWake('thread-1');
			jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([]);

			await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

			expect(orchestrator.executeForWake).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not expose legacy rows through volatile instructions', async () => {
		const { service, jobRepository } = setup();
		jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([]);

		await expect(service.getBackgroundUpdates('thread-1')).resolves.toBeUndefined();
	});

	it('delivers pending mail and consumes only the selected rows', async () => {
		const { service, orchestrator, jobRepository } = setup();

		await service.attemptWake('thread-1');

		expect(orchestrator.executeForWake).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'agent-1',
				projectId: 'project-1',
				memory: { threadId: 'thread-1', resourceId: 'draft-chat:user-1' },
				identity: expect.objectContaining({ type: 'draft', principalHash }),
			}),
		);
		expect(jobRepository.markMailConsumed).toHaveBeenCalledWith('thread-1', ['job-1']);
	});

	it('does not wake a running or currently suspended parent', async () => {
		const running = setup();
		running.executionRepository.existsRunningByThread.mockResolvedValue(true);
		await running.service.attemptWake('thread-1');
		expect(running.orchestrator.executeForWake).not.toHaveBeenCalled();

		const suspended = setup();
		suspended.checkpointStorage.findSuspendedForThread.mockResolvedValue({} as never);
		await suspended.service.attemptWake('thread-1');
		expect(suspended.orchestrator.executeForWake).not.toHaveBeenCalled();
	});

	it('does not consume mail after lease loss', async () => {
		const { service, lockService, orchestrator, jobRepository } = setup();
		const controller = new AbortController();
		lockService.withLease.mockImplementation(async (_namespace, _key, callback) => {
			return await callback(controller.signal);
		});
		orchestrator.executeForWake.mockImplementation(async () => {
			controller.abort();
		});

		await service.attemptWake('thread-1');

		expect(jobRepository.markMailConsumed).not.toHaveBeenCalled();
	});

	it('leaves mail pending when the lease cannot be acquired', async () => {
		const { service, lockService, orchestrator, jobRepository } = setup();
		lockService.withLease.mockRejectedValue(new Error('lock unavailable'));

		await service.attemptWake('thread-1');

		expect(orchestrator.executeForWake).not.toHaveBeenCalled();
		expect(jobRepository.markMailConsumed).not.toHaveBeenCalled();
	});

	it('rejects a draft identity whose principal hash does not match', async () => {
		const { service, jobRepository, orchestrator } = setup();
		jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([
			makeJob({ parentPrincipalHash: 'A'.repeat(43) }),
		]);

		await service.attemptWake('thread-1');

		expect(orchestrator.executeForWake).not.toHaveBeenCalled();
		expect(jobRepository.markMailConsumed).not.toHaveBeenCalled();
	});

	it('rejects an unknown published integration identity', async () => {
		const { service, jobRepository, integrationRegistry, orchestrator } = setup();
		jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([
			makeJob({
				parentResourceId: 'integration:unknown:channel-1',
				parentPrincipalHash: 'A'.repeat(43),
			}),
		]);
		integrationRegistry.get.mockReturnValue(undefined);

		await service.attemptWake('thread-1');

		expect(orchestrator.executeForWake).not.toHaveBeenCalled();
		expect(jobRepository.markMailConsumed).not.toHaveBeenCalled();
	});

	it('stops after three failures for the same pending set', async () => {
		const { service, orchestrator } = setup();
		orchestrator.executeForWake.mockRejectedValue(new Error('model unavailable'));

		for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILED_WAKES + 1; attempt++) {
			await service.attemptWake('thread-1');
		}

		expect(orchestrator.executeForWake).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILED_WAKES);
	});

	it('retries when new mail changes the pending set', async () => {
		const { service, orchestrator, jobRepository } = setup();
		orchestrator.executeForWake.mockRejectedValue(new Error('model unavailable'));

		for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILED_WAKES; attempt++) {
			await service.attemptWake('thread-1');
		}
		jobRepository.findWakeableUnconsumedSettled.mockResolvedValue([
			makeJob(),
			makeJob({ id: 'job-2' }),
		]);
		await service.attemptWake('thread-1');

		expect(orchestrator.executeForWake).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILED_WAKES + 1);
	});

	it('resets the retry limit after a real parent turn', async () => {
		vi.useFakeTimers();
		try {
			const { service, orchestrator } = setup();
			orchestrator.executeForWake.mockRejectedValue(new Error('model unavailable'));
			for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILED_WAKES; attempt++) {
				await service.attemptWake('thread-1');
			}
			orchestrator.executeForWake.mockResolvedValue(undefined);

			await service.onParentTurnFinished('thread-1');
			await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

			expect(orchestrator.executeForWake).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILED_WAKES + 1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('formatWakeMessage', () => {
	it('keeps all metadata while it limits result and error text', () => {
		const jobs = [
			makeJob({ id: 'job-1', result: 'a'.repeat(WAKE_RESULT_TEXT_MAX_CHARS) }),
			makeJob({ id: 'job-2', title: 'Second job', result: null, error: 'b'.repeat(100) }),
		];

		const message = formatWakeMessage(jobs);

		expect(message).toContain('job-1');
		expect(message).toContain('job-2');
		expect(message).toContain('Second job');
		expect(message).not.toContain('b'.repeat(100));
	});
});
