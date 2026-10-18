import { DotPlugins } from '../plugins.mjs';
import { DotError } from '../errors.mjs';
class CliPlugins extends DotPlugins {
  async importArchive(options = {}) {
    if ((options.stateFile !== undefined) === (options.reservationFile !== undefined)) throw new DotError('INVALID_ARGUMENT', 'Plugin import requires exactly one of --state-file FILE or --reservation-file FILE.');
    return super.importArchive(options);
  }
}
export const createClient = client => new CliPlugins(client);
const str = target => ({ target, type: 'string' });
const common = { '--account': str('expectedAccountId') };
const paging = { '--limit': { target: 'limit', type: 'number' }, '--cursor': str('cursor') };
const cmd = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { ...common, ...flags }, ...extra });
const confirm = { '--confirm': str('confirmPluginId') };
const confirmed = { required: ['confirmPluginId'], confirmMatch: [['confirmPluginId', 'pluginId']] };
export const commands = {
  'plugin list': cmd('list', [], 'List hosted plugins installed on the selected account.', { ...paging, '--include-extensions': { target: 'includeExtensions', type: 'boolean' } }, { defaults: { view: 'installed' } }),
  'plugin catalog': cmd('list', [], 'Browse the hosted plugin catalog.', { ...paging, '--scope': str('scope') }, { defaults: { view: 'catalog' } }),
  'plugin search': cmd('list', ['q'], 'Search the hosted plugin catalog.', { ...paging, '--scope': str('scope') }, { defaults: { view: 'catalog' } }),
  'plugin created': cmd('list', [], 'List plugins created in this workspace.', paging, { defaults: { view: 'created' } }),
  'plugin shared': cmd('list', [], 'List plugins shared in this workspace.', paging, { defaults: { view: 'shared' } }),
  'plugin home': cmd('home', [], 'Read featured plugin catalog sections.'),
  'plugin resolve-app': cmd('resolveApp', ['appId'], 'Resolve the hosted plugin belonging to an exact app or connector ID.'),
  'plugin get': cmd('get', ['pluginId'], 'Inspect a hosted plugin.'),
  'plugin batch': cmd('batch', [], 'Inspect up to 50 hosted plugins.', { '--ids': { target: 'pluginIds', type: 'list' } }, { required: ['pluginIds'] }),
  'plugin skill': cmd('skill', ['pluginId', 'skillName'], 'Read one plugin skill without download tokens.'),
  'plugin skill-enable': cmd('setSkillEnabled', ['pluginId', 'skillName'], 'Enable one hosted plugin skill.', {}, { defaults: { enabled: true } }),
  'plugin skill-disable': cmd('setSkillEnabled', ['pluginId', 'skillName'], 'Disable one hosted plugin skill.', {}, { defaults: { enabled: false } }),
  'plugin install': cmd('install', ['pluginId'], 'Install a hosted plugin; provider authorization remains separate.', { '--request-id': str('installAttemptId') }, { key: 'installAttemptId' }),
  'plugin enable': cmd('setEnabled', ['pluginId'], 'Enable an installed hosted plugin.', {}, { defaults: { enabled: true } }),
  'plugin disable': cmd('setEnabled', ['pluginId'], 'Disable an installed hosted plugin.', {}, { defaults: { enabled: false } }),
  'plugin uninstall': cmd('uninstall', ['pluginId'], 'Uninstall a hosted plugin from the selected account.', confirm, confirmed),
  'plugin delete': cmd('delete', ['pluginId'], 'Delete a plugin owned by the selected account.', confirm, confirmed),
  'plugin shares': cmd('shares', ['pluginId'], 'Inspect a plugin sharing policy.'),
  'plugin share': cmd('setShares', ['pluginId'], 'Replace plugin share targets and discoverability.', { '--targets': { target: 'targets', type: 'json' }, '--discoverability': str('discoverability') }, { required: ['targets'], specFields: ['targets', 'discoverability'] }),
  'plugin export': cmd('exportArchive', ['pluginId'], 'Download a hosted plugin ZIP into a private local file.', { '--out': { target: 'output', type: 'path' }, '--overwrite': { target: 'overwrite', type: 'boolean' } }, { required: ['output'] }),
  'plugin import': cmd('importArchive', [], 'Import a bounded archive; exactly one of --state-file or --reservation-file is required.', { '--file': { target: 'file', type: 'path' }, '--plugin': str('pluginId'), '--confirm': str('confirmPluginId'), '--state-file': { target: 'stateFile', type: 'secretPath' }, '--reservation-file': { target: 'reservationFile', type: 'secretPath' } }, { required: ['file'] }),
  'plugin import-status': cmd('importStatus', [], 'Read a private upload journal without exposing its signed URL.', { '--state-file': { target: 'stateFile', type: 'secretPath' } }, { required: ['stateFile'] }),
  'plugin service-account list': cmd('teamList', ['serviceAccountUserId', 'teamId'], 'List plugins installed on a selected team service account.'),
  'plugin service-account install': cmd('teamInstall', ['serviceAccountUserId', 'teamId', 'pluginId'], 'Install a plugin for a selected team service account.'),
  'plugin service-account uninstall': cmd('teamUninstall', ['serviceAccountUserId', 'teamId', 'pluginId'], 'Uninstall a plugin from a selected team service account.', confirm, confirmed)
};
