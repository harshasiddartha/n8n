import { NodeTestHarness } from '@nodes-testing/node-test-harness';
import nock from 'nock';

import { credentials } from '../../../credentials';

describe('Test MicrosoftTeamsV2, onlineMeeting => deleteMeeting', () => {
	nock('https://graph.microsoft.com')
		.delete('/v1.0/me/onlineMeetings/MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZi')
		.reply(204);

	new NodeTestHarness().setupTests({
		credentials,
		workflowFiles: ['deleteMeeting.workflow.json'],
	});
});
