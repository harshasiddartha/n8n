import { type INodeProperties, type IExecuteFunctions, NodeOperationError } from 'n8n-workflow';

import { updateDisplayOptions } from '@utils/utilities';

import { throwIfOnlineMeetingUnsupported } from './sharedGuard';
import { buildTeamsPath, microsoftApiRequest, SP_HIDE } from '../../transport';

const properties: INodeProperties[] = [
	{
		displayName: 'Get By',
		name: 'getBy',
		type: 'options',
		options: [
			{
				name: 'Join URL',
				value: 'joinWebUrl',
				description: 'Look up the meeting by its join web URL',
			},
			{
				name: 'Meeting ID',
				value: 'id',
				description: 'Look up the meeting by its ID',
			},
		],
		default: 'id',
		description: 'How to identify the meeting to retrieve',
	},
	{
		displayName: 'Meeting ID',
		name: 'meetingId',
		required: true,
		type: 'string',
		default: '',
		placeholder: 'e.g. MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZi...',
		description: 'The ID of the meeting to retrieve',
		displayOptions: {
			show: {
				getBy: ['id'],
			},
		},
	},
	{
		displayName: 'Join URL',
		name: 'joinWebUrl',
		required: true,
		type: 'string',
		default: '',
		placeholder: 'e.g. https://teams.microsoft.com/l/meetup-join/19%3ameeting...',
		description: 'The join web URL of the meeting to retrieve',
		displayOptions: {
			show: {
				getBy: ['joinWebUrl'],
			},
		},
	},
];

const displayOptions = {
	show: {
		resource: ['onlineMeeting'],
		operation: ['get'],
	},
	hide: {
		...SP_HIDE,
	},
};

export const description = updateDisplayOptions(displayOptions, properties);

export async function execute(this: IExecuteFunctions, i: number) {
	// https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0&tabs=http
	throwIfOnlineMeetingUnsupported.call(this);

	const getBy = this.getNodeParameter('getBy', i) as string;

	if (getBy === 'joinWebUrl') {
		// String() because `as string` is compile-time only: an expression can
		// resolve the parameter to null or a number, which must not crash .trim()
		const joinWebUrl = String(this.getNodeParameter('joinWebUrl', i) ?? '').trim();
		if (!joinWebUrl) {
			throw new NodeOperationError(this.getNode(), 'The Join URL must not be empty', {
				description: "Check that the 'Join URL' parameter is correctly set",
			});
		}
		// Graph filters meetings with an OData string literal; single quotes inside it
		// are escaped by doubling. The transport percent-encodes the query value, which
		// is the URL-encoding Graph requires for joinWebUrl.
		const response = await microsoftApiRequest.call(
			this,
			'GET',
			'/v1.0/me/onlineMeetings',
			{},
			{ $filter: `JoinWebUrl eq '${joinWebUrl.replace(/'/g, "''")}'` },
		);
		const meeting = response?.value?.[0];
		if (!meeting) {
			throw new NodeOperationError(
				this.getNode(),
				'No meeting was found for the provided join URL',
				{
					description: "Check that the 'Join URL' parameter is correctly set",
				},
			);
		}
		return meeting;
	}

	const meetingId = this.getNodeParameter('meetingId', i) as string;
	// Built outside the try so an invalid id surfaces as its own validation
	// error instead of being replaced by the not-found message below
	const endpoint = buildTeamsPath.call(this, ['/v1.0/me/onlineMeetings/', { id: meetingId }]);

	try {
		return await microsoftApiRequest.call(this, 'GET', endpoint);
	} catch (error) {
		// Only a 404 means the meeting is gone; other statuses (403 from a missing
		// OnlineMeetings.ReadWrite consent, 429, 5xx) must surface as the real error.
		if (error?.httpCode !== '404') throw error;
		throw new NodeOperationError(
			this.getNode(),
			"The meeting you are trying to get doesn't exist",
			{
				description: "Check that the 'Meeting ID' parameter is correctly set",
			},
		);
	}
}
