import { JtiCleanupTask } from '../services/jti-cleanup.task';
import { TrustedKeyRefreshTask } from '../services/trusted-key-refresh.task';
import { TokenExchangeModule } from '../token-exchange.module';

describe('TokenExchangeModule', () => {
	const module = new TokenExchangeModule();

	afterEach(() => {
		delete process.env.N8N_ENV_FEAT_TOKEN_EXCHANGE;
	});

	describe('systemTasks()', () => {
		it('should register the maintenance tasks when the feature flag is enabled', async () => {
			process.env.N8N_ENV_FEAT_TOKEN_EXCHANGE = 'true';

			await expect(module.systemTasks()).resolves.toEqual([TrustedKeyRefreshTask, JtiCleanupTask]);
		});

		it('should register no tasks when the feature flag is disabled', async () => {
			await expect(module.systemTasks()).resolves.toEqual([]);
		});
	});
});
