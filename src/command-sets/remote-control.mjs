import { DotRemoteControl } from '../remote-control.mjs';
export const createClient = client => new DotRemoteControl(client);
const common = { '--account': { target: 'expectedAccountId', type: 'string' }, '--no-open': { target: 'noOpen', type: 'boolean' } };
export const commands = {
  'remote computer': { method: 'open', positionals: [], flags: { ...common, '--dot': { target: 'dotId', type: 'string' }, '--thread': { target: 'threadId', type: 'string' }, '--handoff-conversation': { target: 'handoffConversationId', type: 'string' }, '--handoff-tab': { target: 'handoffTabId', type: 'string' } }, stream: true, description: 'Open a local WebRTC viewer for the Dot computer; taking control requires an explicit browser click.' },
  'remote browser': { method: 'open', positionals: ['conversationId'], flags: common, defaults: { source: 'flora' }, stream: true, description: 'Open a local WebRTC viewer for an existing cloud browser conversation.' },
};
