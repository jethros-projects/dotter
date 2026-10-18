import { ProjectConnections } from '../project-connections.mjs';
export const createClient = client => new ProjectConnections(client);
const string = target => ({ target, type: 'string' });
const privatePath = target => ({ target, type: 'secretPath' });
const common = { '--account': string('accountId') };
const state = { '--state-file': privatePath('stateFile') };
const request = { '--actions': { target: 'actionNames', type: 'list' }, '--scopes': { target: 'requestedScopes', type: 'list' } };
const spec = (method, positionals, description, flags = {}, required = []) => ({ method, positionals, description, flags: { ...common, ...flags }, required: ['accountId', ...required] });
export const commands = {
  'account projects connections get': spec('connectionGet', ['projectId', 'connectorType'], 'Read native project-provider metadata for google_drive, slack or linear.'),
  'account projects connections status': spec('connectionStatus', ['projectId', 'connectorType'], 'Read current project-SKU provider status; a supplied link is checked exactly.', { '--link': string('linkId') }),
  'account projects connections tos': spec('connectionTos', ['projectId', 'connectorType'], 'Read project-provider consent text and policy links without accepting or connecting.'),
  'account projects connections oauth': spec('connectionStart', ['projectId', 'connectorType'], 'Start one browser authorization, bound to a private account/user/project journal.', { ...state, ...request }, ['stateFile']),
  'account projects connections reauthorize': spec('connectionReauthorize', ['projectId', 'connectorType', 'linkId'], 'Reauthorize one exact existing provider link using a private handoff journal.', { ...state, '--scopes': request['--scopes'] }, ['stateFile']),
  'account projects connections complete': spec('connectionComplete', [], 'Submit a matching private OAuth callback once and verify the exact active account link.', { ...state, '--redirect-file': privatePath('redirectFile') }, ['stateFile', 'redirectFile']),
  'account projects connections no-auth': spec('connectionNoAuth', ['projectId', 'connectorType'], 'Connect only when this native provider advertises no-auth, then verify its exact link.', state, ['stateFile']),
  'account projects connections operation': spec('connectionOperation', [], 'Inspect or reconcile a private provider-operation journal without replaying auth requests.', state, ['stateFile']),
};
