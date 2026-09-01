import type { Mock } from 'vitest';
import type { MockProxy } from 'vitest-mock-extended';
import { mock } from 'vitest-mock-extended';
import type { IExecuteFunctions, INode, NodeParameterValueType } from 'n8n-workflow';

import { versionDescription } from '../../../../v2/actions/versionDescription';
import { MicrosoftTeamsV2 } from '../../../../v2/MicrosoftTeamsV2.node';
import * as transport from '../../../../v2/transport';
import type * as _importType0 from '../../../../v2/transport';

// Real transport except the network helper, so buildTeamsPath/validateTeamsId
// run for real; only microsoftApiRequest is stubbed.
vi.mock('../../../../v2/transport', async () => {
	const originalModule = await vi.importActual<typeof _importType0>('../../../../v2/transport');
	return {
		...originalModule,
		microsoftApiRequest: vi.fn(),
	};
});

describe('Microsoft Teams V2 — onlineMeeting:get lookup handling', () => {
	let node: MicrosoftTeamsV2;
	let ctx: MockProxy<IExecuteFunctions>;

	beforeEach(() => {
		node = new MicrosoftTeamsV2(versionDescription);
		ctx = mock<IExecuteFunctions>();
		ctx.getInputData.mockReturnValue([{ json: {} }]);
		ctx.getInstanceId.mockReturnValue('instanceId');
		ctx.getNode.mockReturnValue(mock<INode>({ typeVersion: 2 }));
		ctx.continueOnFail.mockReturnValue(false);
		ctx.helpers.returnJsonArray = vi.fn((data) =>
			(Array.isArray(data) ? data : [data]).map((json) => ({ json })),
		) as unknown as IExecuteFunctions['helpers']['returnJsonArray'];
		ctx.helpers.constructExecutionMetaData = vi.fn(
			(data) => data,
		) as unknown as IExecuteFunctions['helpers']['constructExecutionMetaData'];
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const setParams = (params: Record<string, unknown>) => {
		ctx.getNodeParameter.mockImplementation(
			(name: string, _itemIndex?: number, fallback?: unknown): NodeParameterValueType =>
				(name in params ? params[name] : fallback) as NodeParameterValueType,
		);
	};

	it('queries Graph with the documented JoinWebUrl OData filter and unwraps value[0]', async () => {
		const joinWebUrl =
			'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZDE2Nzg0%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d';
		(transport.microsoftApiRequest as Mock).mockResolvedValue({ value: [{ id: 'meeting-1' }] });
		setParams({ resource: 'onlineMeeting', operation: 'get', getBy: 'joinWebUrl', joinWebUrl });

		const result = await node.execute.call(ctx);

		expect(transport.microsoftApiRequest).toHaveBeenCalledWith(
			'GET',
			'/v1.0/me/onlineMeetings',
			{},
			{ $filter: `JoinWebUrl eq '${joinWebUrl}'` },
		);
		expect(result).toEqual([[{ json: { id: 'meeting-1' } }]]);
	});

	it('doubles single quotes in the join URL to keep the OData literal intact', async () => {
		(transport.microsoftApiRequest as Mock).mockResolvedValue({ value: [{ id: 'meeting-1' }] });
		setParams({
			resource: 'onlineMeeting',
			operation: 'get',
			getBy: 'joinWebUrl',
			joinWebUrl: "https://teams.microsoft.com/l/meetup-join/o'brien",
		});

		await node.execute.call(ctx);

		expect(transport.microsoftApiRequest).toHaveBeenCalledWith(
			'GET',
			'/v1.0/me/onlineMeetings',
			{},
			{ $filter: "JoinWebUrl eq 'https://teams.microsoft.com/l/meetup-join/o''brien'" },
		);
	});

	it('throws a clear error when no meeting matches the join URL', async () => {
		(transport.microsoftApiRequest as Mock).mockResolvedValue({ value: [] });
		setParams({
			resource: 'onlineMeeting',
			operation: 'get',
			getBy: 'joinWebUrl',
			joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/unknown',
		});

		await expect(node.execute.call(ctx)).rejects.toThrow(
			'No meeting was found for the provided join URL',
		);
	});

	it('throws on a blank join URL before any request', async () => {
		setParams({
			resource: 'onlineMeeting',
			operation: 'get',
			getBy: 'joinWebUrl',
			joinWebUrl: ' ',
		});

		await expect(node.execute.call(ctx)).rejects.toThrow('The Join URL must not be empty');
		expect(transport.microsoftApiRequest).not.toHaveBeenCalled();
	});

	it.each(['get'])(
		'onlineMeeting:%s rejects a separator-bearing meetingId before any request',
		async (op) => {
			setParams({
				resource: 'onlineMeeting',
				operation: op,
				getBy: 'id',
				meetingId: 'x/../../users/evil',
			});

			// The path (and its validation) is built outside the op's try/catch, so the
			// validator's specific message surfaces instead of the generic "doesn't exist" one.
			await expect(node.execute.call(ctx)).rejects.toThrow('The ID is not valid');
			expect(transport.microsoftApiRequest).not.toHaveBeenCalled();
		},
	);

	it.each([['get', "The meeting you are trying to get doesn't exist"]])(
		'replaces a Graph 404 on %s by ID with the friendly not-found message',
		async (op, message) => {
			(transport.microsoftApiRequest as Mock).mockRejectedValue(
				Object.assign(new Error('Not Found'), { httpCode: '404' }),
			);
			setParams({
				resource: 'onlineMeeting',
				operation: op,
				getBy: 'id',
				meetingId: 'MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZi',
			});

			await expect(node.execute.call(ctx)).rejects.toThrow(message);
		},
	);

	it.each(['get'])(
		'rethrows a non-404 Graph error on %s unchanged (e.g. missing-scope 403)',
		async (op) => {
			(transport.microsoftApiRequest as Mock).mockRejectedValue(
				Object.assign(new Error('Insufficient privileges to complete the operation'), {
					httpCode: '403',
				}),
			);
			setParams({
				resource: 'onlineMeeting',
				operation: op,
				getBy: 'id',
				meetingId: 'MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZi',
			});

			await expect(node.execute.call(ctx)).rejects.toThrow(
				'Insufficient privileges to complete the operation',
			);
		},
	);
});
