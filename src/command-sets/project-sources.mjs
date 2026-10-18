import { ProjectSources } from '../project-sources.mjs';
export const createClient = client => new ProjectSources(client);
const string = target => ({ target, type: 'string' });
const number = target => ({ target, type: 'number' });
const common = { '--account': string('accountId') };
const polling = { '--timeout': number('timeout'), '--interval': number('interval') };
const sync = { '--wait': { target: 'wait', type: 'boolean' }, ...polling };
const spec = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { ...common, ...flags }, required: ['accountId'], ...extra });
export const commands = {
  'account projects sources list': spec('sourcesList', ['projectId'], 'List visible native connector and website project sources, 100 per page.', { '--pages': number('pages'), '--cursor': string('cursor') }),
  'account projects sources get': spec('sourceGet', ['projectId', 'scopeId'], 'Read one exact project source with current synchronization metadata.'),
  'account projects sources providers': spec('sourceProviders', ['projectId'], 'Check existing provider connections using the native CHATGPT_PROJECTS product scope.', { '--type': string('connectorType') }),
  'account projects sources add': spec('sourceAdd', ['projectId', 'connectorType', 'url'], 'Add a website, google_drive, slack or linear source; verify persistence and start eligible connector sync.', sync),
  'account projects sources remove': spec('sourceRemove', ['projectId', 'scopeId'], 'Remove a source from this project and verify absence. Shared changes affect every member.', { '--confirm': string('confirm'), '--shared': { target: 'shared', type: 'boolean' } }, { required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'scopeId']] }),
  'account projects sources sync': spec('sourceSync', ['projectId', 'scopeId'], 'Request one native connector synchronization; accepted and completed states remain distinct.', sync),
  'account projects sources wait': spec('sourceWait', ['projectId', 'scopeId'], 'Wait for an existing connector synchronization without restarting it; website sources do not synchronize.', polling),
};
