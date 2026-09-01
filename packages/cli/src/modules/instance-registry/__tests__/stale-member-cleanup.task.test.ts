import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import type { InstanceRegistryService } from '../instance-registry.service';
import { StaleMemberCleanupTask } from '../stale-member-cleanup.task';

const logger = mock<Logger>({ scoped: vi.fn().mockReturnThis() });
const instanceRegistryService = mock<InstanceRegistryService>();

let task: StaleMemberCleanupTask;

beforeEach(() => {
	vi.clearAllMocks();
	task = new StaleMemberCleanupTask(logger, instanceRegistryService);
});

describe('StaleMemberCleanupTask', () => {
	it('should declare the reconciliation cadence', () => {
		expect(task.name).toBe('instance-registry-stale-member-cleanup');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 180 });
		expect(task.effects).toBe('idempotent');
		expect(task.durable).toBe(false);
	});

	describe('run', () => {
		it('should clean up stale members', async () => {
			instanceRegistryService.cleanupStaleMembers.mockResolvedValue(0);

			await task.run();

			expect(instanceRegistryService.cleanupStaleMembers).toHaveBeenCalledTimes(1);
			expect(logger.info).not.toHaveBeenCalled();
		});

		it('should log when members were removed', async () => {
			instanceRegistryService.cleanupStaleMembers.mockResolvedValue(3);

			await task.run();

			expect(logger.info).toHaveBeenCalledWith('Cleaned up stale registry members', {
				removed: 3,
			});
		});

		it('should catch and log errors without throwing', async () => {
			instanceRegistryService.cleanupStaleMembers.mockRejectedValue(new Error('DB error'));

			await expect(task.run()).resolves.toBeUndefined();

			expect(logger.warn).toHaveBeenCalledWith('Failed to clean up stale registry members', {
				error: expect.any(Error),
			});
		});
	});
});
