import type { INodeProperties } from 'n8n-workflow';

import { userRLC } from './rlc.description';

export const groupSourceOptions: INodeProperties = {
	displayName: 'Group Source',
	name: 'groupSource',
	required: true,
	type: 'options',
	default: 'all',
	description: 'From where to select groups and teams',
	options: [
		{
			name: 'All Groups',
			value: 'all',
			description: 'From all groups',
		},
		{
			name: 'My Groups',
			value: 'mine',
			description: 'Only load groups that account is member of',
		},
	],
};

/**
 * Shared by `channelMessage:create` and `chatMessage:create`. Safe to spread into both:
 * `updateDisplayOptions` merges into a fresh object rather than mutating this one.
 */
export const mentionsField: INodeProperties = {
	displayName: 'Mentions',
	name: 'mentions',
	type: 'fixedCollection',
	placeholder: 'Add Mention',
	default: {},
	typeOptions: {
		multipleValues: true,
	},
	description:
		'People to @mention. Mention tokens are appended to the end of the message, and adding a mention makes the message render as HTML even when Content Type is Text.',
	options: [
		{
			displayName: 'Mention',
			name: 'mention',
			values: [userRLC],
		},
	],
};
