import { mock } from 'vitest-mock-extended';

import { McpRegistryRefreshTask } from '../mcp-registry-refresh.task';
import type { McpRegistryService } from '../registry/mcp-registry.service';

describe('McpRegistryRefreshTask', () => {
	const mcpRegistryService = mock<McpRegistryService>();
	const task = new McpRegistryRefreshTask(mcpRegistryService);

	it('should declare an 8-hour refresh cadence', () => {
		expect(task.name).toBe('mcp-registry-refresh');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 8 * 3600 });
		expect(task.effects).toBe('idempotent');
		expect(task.durable).toBe(false);
	});

	it('should refresh the registry on run', async () => {
		await task.run();

		expect(mcpRegistryService.refreshFromApi).toHaveBeenCalledWith('interval');
	});
});
