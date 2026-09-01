import { Logger } from '@n8n/backend-common';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';

@BackendModule({ name: 'mcp-registry' })
export class McpRegistryModule implements ModuleInterface {
	async init() {
		const { McpRegistryService } = await import('./registry/mcp-registry.service.js');
		await Container.get(McpRegistryService).init();

		await import('./mcp-registry.controller.js');

		if (process.env.E2E_TESTS === 'true') {
			await import('./mcp-registry-test.controller.js');
		}
	}

	async systemTasks() {
		// In E2E the registry is populated via the test seed endpoint, so the
		// periodic remote refresh must never run there.
		const { inE2ETests } = await import('@/constants.js');
		if (inE2ETests) {
			return [];
		}

		const { McpRegistryRefreshTask } = await import('./mcp-registry-refresh.task.js');
		return [McpRegistryRefreshTask];
	}

	async entities() {
		const { McpRegistryServerEntity } = await import('./registry/mcp-registry-server.entity.js');
		return [McpRegistryServerEntity];
	}

	async nodeLoaders() {
		const { McpRegistryNodeLoader } = await import('./mcp-registry-node-loader.js');

		return [
			new McpRegistryNodeLoader(Container.get(LoadNodesAndCredentials), Container.get(Logger)),
		];
	}
}
