import { type INodeProperties, type IExecuteFunctions, NodeOperationError } from 'n8n-workflow';

import { updateDisplayOptions } from '@utils/utilities';

import { throwIfOnlineMeetingUnsupported } from './sharedGuard';
import { buildTeamsPath, microsoftApiRequest, SP_HIDE } from '../../transport';

const properties: INodeProperties[] = [
	{
		displayName: 'Meeting ID',
		name: 'meetingId',
		required: true,
		type: 'string',
		default: '',
		placeholder: 'e.g. MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZi...',
		description: 'The ID of the meeting to delete',
	},
];

const displayOptions = {
	show: {
		resource: ['onlineMeeting'],
		operation: ['deleteMeeting'],
	},
	hide: {
		...SP_HIDE,
	},
};

export const description = updateDisplayOptions(displayOptions, properties);

export async function execute(this: IExecuteFunctions, i: number) {
	// https://learn.microsoft.com/en-us/graph/api/onlinemeeting-delete?view=graph-rest-1.0&tabs=http
	throwIfOnlineMeetingUnsupported.call(this);

	const meetingId = this.getNodeParameter('meetingId', i) as string;
	// Built outside the try so an invalid id surfaces as its own validation
	// error instead of being replaced by the not-found message below
	const endpoint = buildTeamsPath.call(this, ['/v1.0/me/onlineMeetings/', { id: meetingId }]);

	try {
		await microsoftApiRequest.call(this, 'DELETE', endpoint);
		return { success: true };
	} catch (error) {
		// Only a 404 means the meeting is gone; other statuses (403 from a missing
		// OnlineMeetings.ReadWrite consent, 429, 5xx) must surface as the real error.
		if (error?.httpCode !== '404') throw error;
		throw new NodeOperationError(
			this.getNode(),
			"The meeting you are trying to delete doesn't exist",
			{
				description: "Check that the 'Meeting ID' parameter is correctly set",
			},
		);
	}
}
