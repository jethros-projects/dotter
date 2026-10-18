import { AccountProjects } from '../account-projects.mjs';
export const createClient = client => new AccountProjects(client);
const string = target => ({ target, type: 'string' });
const number = target => ({ target, type: 'number' });
const common = { '--account': string('accountId') };
const page = { '--limit': number('limit'), '--pages': number('pages'), '--cursor': string('cursor'), '--owned-only': { target: 'ownedOnly', type: 'boolean' }, '--all-accessible': { target: 'ownedOnly', type: 'boolean', value: false } };
const appearance = { '--emoji': string('emoji'), '--theme': string('theme') };
const spec = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { ...common, ...flags }, required: ['accountId'], ...extra });
export const commands = {
  'account projects list': spec('list', [], 'List native account projects with cursor pagination; defaults to owned projects. Verified page-size range: 1–50.', page),
  'account projects get': spec('get', ['projectId'], 'Read one native g-p- project with safe file metadata and instructions.'),
  'account projects conversations': spec('conversations', ['projectId'], 'List visible conversations belonging to one readable account project; page size is 1–50.', page),
  'account projects create': spec('create', ['name'], 'Create one private native account project and verify its persisted fields; creation memory scope is unset (default), global or project_v2.', { ...appearance, '--memory-scope': string('memoryScope') }),
  'account projects update': spec('update', ['projectId'], 'Update name, emoji, native palette color or instructions after fresh write-permission checks; existing memory scope is preserved.', { ...appearance, '--name': string('name'), '--instructions': string('instructions'), '--instructions-file': { target: 'instructions', type: 'textFile' }, '--clear-emoji': { target: 'clearEmoji', type: 'boolean' }, '--clear-theme': { target: 'clearTheme', type: 'boolean' } }),
  'account projects delete': spec('delete', ['projectId'], 'Permanently delete a project and ALL its chats after fresh delete-permission checks. Saved Library/Space files are retained. Requires exact ID confirmation and --delete-chats.', { '--confirm': string('confirm'), '--delete-chats': { target: 'deleteChats', type: 'boolean' } }, { required: ['accountId', 'confirm', 'deleteChats'], confirmMatch: [['confirm', 'projectId']] }),
  'account projects pinned': spec('pinned', [], 'List pinned native account projects.'),
  'account projects pin': spec('pin', ['projectId'], 'Pin a freshly verified readable project and confirm the pin list.'),
  'account projects unpin': spec('unpin', ['projectId'], 'Unpin a freshly verified readable project and confirm the pin list.'),
};
