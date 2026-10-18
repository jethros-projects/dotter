import { DotConnectorAdmin } from '../connectors-admin.mjs';
export const createClient = client => new DotConnectorAdmin(client);
const str = target => ({ target, type: 'string' });
const json = target => ({ target, type: 'json' });
const privatePath = target => ({ target, type: 'secretPath' });
const account = { '--account': str('expectedAccountId') };
const cmd = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { ...account, ...flags }, ...extra });
export const commands = {
  'connector admin get': cmd('get', ['connectorId'], 'Inspect the complete connector schema and actions.'),
  'connector admin tos': cmd('tos', ['connectorId'], 'Read connector terms of service.'),
  'connector admin mfa': cmd('mfaRequirement', ['connectorId'], 'Read connector MFA requirements.'),
  'connector admin privacy': cmd('setPrivacy', ['connectorId', 'linkId', 'policy'], 'Set the selected connection privacy policy.'),
  'connector admin oauth': cmd('startOAuth', ['connectorId'], 'Start browser OAuth with explicit scopes and companion apps.', {
    '--actions': { target: 'actionNames', type: 'list' }, '--scopes': { target: 'requestedScopes', type: 'list' }, '--link-params': json('linkParams'),
    '--companions': { target: 'companionConnectorIds', type: 'list' }, '--slack-team': str('slackTeamId')
  }, { specFields: ['actionNames', 'requestedScopes', 'linkParams', 'companionConnectorIds', 'slackTeamId'] }),
  'connector admin unlink-all': cmd('unlinkAll', ['connectorId'], 'Disconnect every account for one connector.', { '--confirm': str('confirmConnectorId') }, { required: ['confirmConnectorId'], confirmMatch: [['confirmConnectorId', 'connectorId']] }),
  'connector admin tunnels': cmd('tunnels', [], 'List available personal MCP tunnels.'),
  'connector admin oauth-config': cmd('discoverOAuth', [], 'Discover MCP OAuth configuration.', { '--target': json('target') }, { required: ['target'], specFields: ['target'] }),
  'connector admin oauth-clients': cmd('oauthClients', ['service'], 'List existing OAuth client metadata for a service.'),
  'connector admin oauth-callback': cmd('oauthCallback', [], 'Get the registered MCP OAuth callback ID.', { '--target': json('target') }, { required: ['target'], specFields: ['target'] }),
  'connector admin mcp-create': cmd('createMcp', [], 'Create a personal custom MCP connector.', {
    '--name': str('name'), '--description': str('description'), '--target': json('target'), '--auth-config': { target: 'authRequest', type: 'jsonFile' },
    '--client-secret-file': privatePath('clientSecretFile'), '--logo': { target: 'logoFile', type: 'path' }
  }, { required: ['name', 'target', 'authRequest'], specFields: ['name', 'description', 'target', 'authRequest'] }),
  'connector admin mcp-update': cmd('updateMcp', ['connectorId', 'field'], 'Update a custom MCP name, description, or PNG logo.', { '--value': str('value'), '--logo': { target: 'logoFile', type: 'path' } }),
  'connector admin refresh-actions': cmd('refreshActions', ['connectorId', 'linkId'], 'Refresh a custom MCP connection action catalog.'),
  'connector service-account links': cmd('serviceAccountLinks', ['serviceAccountUserId'], 'List visible connector links on one service account.'),
  'connector service-account oauth': cmd('serviceAccountOAuth', ['serviceAccountUserId', 'connectorId'], 'Start OAuth for a selected service account.', { '--actions': { target: 'actionNames', type: 'list' }, '--scopes': { target: 'requestedScopes', type: 'list' }, '--link-params': json('linkParams') }, { specFields: ['actionNames', 'requestedScopes', 'linkParams'] }),
  'connector service-account api-key': cmd('serviceAccountApiKey', ['serviceAccountUserId', 'connectorId'], 'Connect a service account using a private API-key file.', { '--key-file': privatePath('keyFile'), '--actions': { target: 'actionNames', type: 'list' }, '--link-params': json('linkParams') }, { required: ['keyFile'] }),
  'connector service-account no-auth': cmd('serviceAccountNoAuth', ['serviceAccountUserId', 'connectorId'], 'Connect a no-auth connector on one service account.'),
  'connector service-account unlink': cmd('serviceAccountUnlink', ['serviceAccountUserId', 'connectorId', 'linkId'], 'Disconnect a selected service-account link.', { '--confirm': str('confirmLinkId') }, { required: ['confirmLinkId'], confirmMatch: [['confirmLinkId', 'linkId']] }),
  'connector service-account workspace-connections': cmd('serviceAccountConnections', ['serviceAccountUserId', 'teamId'], 'List workspace connections assigned to one service account.'),
  'connector service-account workspace-enable': cmd('setServiceAccountConnection', ['serviceAccountUserId', 'teamId', 'linkId'], 'Enable a workspace connection on one service account.', {}, { defaults: { enabled: true } }),
  'connector service-account workspace-disable': cmd('setServiceAccountConnection', ['serviceAccountUserId', 'teamId', 'linkId'], 'Disable a workspace connection on one service account.', {}, { defaults: { enabled: false } }),
  'connector service-account read-only': cmd('setServiceAccountReadOnly', ['serviceAccountUserId', 'linkId'], 'Restrict a selected service-account connector link to reads.', {}, { defaults: { readOnly: true } }),
  'connector service-account read-write': cmd('setServiceAccountReadOnly', ['serviceAccountUserId', 'linkId'], 'Allow writes on a selected service-account connector link.', {}, { defaults: { readOnly: false } })
};
