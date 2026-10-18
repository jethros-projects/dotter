import { ProjectSaves } from '../project-saves.mjs';
export const createClient = client => new ProjectSaves(client);
const string = target => ({ target, type: 'string' });
const number = target => ({ target, type: 'number' });
const spec = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { '--account': string('accountId'), ...flags }, required: ['accountId'], ...extra });
export const commands = {
  'account projects saves list': spec('list', ['projectId'], 'List native project saved-response metadata with cursor pagination and the native 100-item page size.', { '--pages': number('pages'), '--cursor': string('cursor') }),
  'account projects saves get': spec('get', ['projectId', 'saveId'], 'Read one saved response through its fully paginated project source collection.'),
  'account projects saves create': spec('create', ['projectId', 'conversationId', 'messageId'], 'Save an eligible visible assistant response from this project; an existing save is returned unchanged.'),
  'account projects saves rename': spec('rename', ['projectId', 'saveId', 'title'], 'Rename one project saved response with a trimmed title of 1 to 200 characters.'),
  'account projects saves remove': spec('remove', ['projectId', 'saveId'], 'Remove a saved response from the project for everyone with access. Requires the exact saved-response ID.', { '--confirm': string('confirm') }, { required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'saveId']] }),
};
