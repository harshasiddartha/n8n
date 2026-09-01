import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import type { CheckService } from '../checks/check.service';
import { InstanceRegistryReconciliationTask } from '../checks/instance-registry-reconciliation.task';

const logger = mock<Logger>({ scoped: vi.fn().mockReturnThis() });
const checkService = mock<CheckService>();

let task: InstanceRegistryReconciliationTask;

beforeEach(() => {
	vi.clearAllMocks();
	task = new InstanceRegistryReconciliationTask(logger, checkService);
});

describe('InstanceRegistryReconciliationTask', () => {
	it('should declare the reconciliation cadence', () => {
		expect(task.name).toBe('instance-registry-reconciliation');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 180 });
		expect(task.effects).toBe('idempotent');
		expect(task.durable).toBe(false);
		expect(task.runOnTakeover).toBe(true);
	});

	describe('run', () => {
		it('should run one reconciliation cycle with the run signal', async () => {
			const signal = new AbortController().signal;

			await task.run(signal);

			expect(checkService.reconcile).toHaveBeenCalledTimes(1);
			expect(checkService.reconcile).toHaveBeenCalledWith(signal);
		});

		it('should catch and log a failed cycle without throwing', async () => {
			checkService.reconcile.mockRejectedValue(new Error('boom'));

			await expect(task.run(new AbortController().signal)).resolves.toBeUndefined();

			expect(logger.warn).toHaveBeenCalledWith('Reconciliation cycle failed', {
				error: expect.any(Error),
			});
		});
	});
});
