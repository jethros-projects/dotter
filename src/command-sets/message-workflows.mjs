import { DotMessageWorkflows } from '../message-workflows.mjs';
export const createClient = client => new DotMessageWorkflows(client);
const account = { '--account': { target: 'expectedAccountId', type: 'string' } };
const request = { ...account, '--connect': { target: 'connect', type: 'boolean' } };
export const commands = {
  'message plugins get': { method: 'pluginSuggestions', positionals: ['reference'], flags: account, description: 'Inspect plugins requested by a message continuation.' },
  'message plugins continue': { method: 'continuePlugins', positionals: ['reference'], flags: { ...account, '--plugins': { target: 'pluginIds', type: 'list' }, '--fingerprint': { target: 'requestFingerprint', type: 'string' } }, required: ['pluginIds', 'requestFingerprint'], description: 'Continue the exact message with selected connected plugin IDs.' },
  'message auth get': { method: 'connectorAuth', positionals: ['reference'], flags: request, description: 'Inspect a message-bound connect or reauthentication request.' },
  'message auth start': { method: 'startConnectorAuth', positionals: ['reference'], flags: { ...request, '--fingerprint': { target: 'requestFingerprint', type: 'string' }, '--session-file': { target: 'sessionFile', type: 'path' } }, required: ['requestFingerprint', 'sessionFile'], description: 'Start message-bound OAuth and save its capability privately.' },
  'message auth complete': { method: 'completeConnectorAuth', positionals: ['reference'], flags: { ...account, '--session-file': { target: 'sessionFile', type: 'path' }, '--callback-file': { target: 'callbackFile', type: 'secretPath' }, '--resume': { target: 'resume', type: 'boolean' } }, required: ['sessionFile'], description: 'Verify a private provider callback and continue the original message.' }
};
