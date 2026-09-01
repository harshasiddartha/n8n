import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import type { TokenExchangeJtiRepository } from '../../database/repositories/token-exchange-jti.repository';
import type { TokenExchangeConfig } from '../../token-exchange.config';
import { JtiCleanupTask } from '../jti-cleanup.task';

const logger = mock<Logger>({ scoped: vi.fn().mockReturnThis() });
const config = mock<TokenExchangeConfig>({
	jtiCleanupIntervalSeconds: 30,
	jtiCleanupBatchSize: 500,
});
const jtiRepository = mock<TokenExchangeJtiRepository>();

let task: JtiCleanupTask;

beforeEach(() => {
	vi.clearAllMocks();
	task = new JtiCleanupTask(logger, config, jtiRepository);
});

describe('JtiCleanupTask', () => {
	it('should declare the configured cadence', () => {
		expect(task.name).toBe('jti-cleanup');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 30 });
		expect(task.effects).toBe('idempotent');
		expect(task.durable).toBe(false);
	});

	describe('run', () => {
		it('should delete a batch of expired JTIs', async () => {
			jtiRepository.deleteExpiredBatch.mockResolvedValue(10);

			await task.run();

			expect(jtiRepository.deleteExpiredBatch).toHaveBeenCalledWith(500);
			expect(jtiRepository.deleteExpiredBatch).toHaveBeenCalledTimes(1);
		});

		it('should loop until fewer than batchSize rows are deleted', async () => {
			jtiRepository.deleteExpiredBatch
				.mockResolvedValueOnce(500) // first batch: full
				.mockResolvedValueOnce(500) // second batch: full
				.mockResolvedValueOnce(123); // third batch: partial → stop

			await task.run();

			expect(jtiRepository.deleteExpiredBatch).toHaveBeenCalledTimes(3);
		});

		it('should log total count when expired JTIs are deleted', async () => {
			jtiRepository.deleteExpiredBatch.mockResolvedValueOnce(500).mockResolvedValueOnce(42);

			await task.run();

			expect(logger.debug).toHaveBeenCalledWith('Cleaned up expired JTIs', { count: 542 });
		});

		it('should catch and log errors without throwing', async () => {
			jtiRepository.deleteExpiredBatch.mockRejectedValue(new Error('DB error'));

			await expect(task.run()).resolves.toBeUndefined();

			expect(logger.error).toHaveBeenCalledWith('Failed to clean up expired JTIs', {
				error: expect.any(Error),
			});
		});
	});
});
