import { ConversationClient } from '../conversations.mjs';
export const createClient = client => new ConversationClient(client);
const string = target => ({ target, type: 'string' });
const number = target => ({ target, type: 'number' });
const boolean = target => ({ target, type: 'boolean' });
const common = { '--account': string('expectedAccountId') };
const spec = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags: { ...common, ...flags }, ...extra });
export const commands = {
  'conversation list': spec('list', [], 'List account conversations by last update with native filters; --order accepts updated only.', { '--limit': number('limit'), '--offset': number('offset'), '--order': string('order'), '--origin': string('conversationOrigin'), '--exclude-origin': string('excludeConversationOrigin'), '--expand': boolean('expand'), '--hide-snorlax': boolean('hideSnorlax'), '--show-snorlax': { target: 'hideSnorlax', type: 'boolean', value: false }, '--archived': boolean('archived'), '--not-archived': { target: 'archived', type: 'boolean', value: false }, '--starred': boolean('starred'), '--not-starred': { target: 'starred', type: 'boolean', value: false } }),
  'conversation search': spec('search', ['query'], 'Search account conversations; omit internal match snippets.', { '--cursor': string('cursor') }),
  'conversation batch': spec('batch', [], 'Read exact account conversation metadata.', { '--ids': { target: 'conversationIds', type: 'list' } }, { required: ['conversationIds'] }),
  'conversation get': spec('get', ['conversationId'], 'Read the selected visible account conversation branch.'),
  'conversation history': spec('historyPages', ['conversationId'], 'Read visible account history with native pagination.', { '--before': string('before'), '--turns': number('numTurns'), '--pages': number('pages') }),
  'conversation rename': spec('rename', ['conversationId', 'title'], 'Rename an account conversation.'),
  'conversation archive': spec('archive', ['conversationId'], 'Archive an account conversation.'),
  'conversation unarchive': spec('unarchive', ['conversationId'], 'Unarchive an account conversation.'),
  'conversation delete': spec('delete', ['conversationId'], 'Delete an account conversation with exact-ID confirmation.', { '--confirm': string('confirm') }, { required: ['confirm'], confirmMatch: [['confirm', 'conversationId']] }),
  'conversation select-response': spec('selectResponse', ['conversationId', 'nodeId'], 'Select a visible assistant response branch.'),
  'conversation responses': spec('responses', ['conversationId'], 'List visible response variants with their selected-branch state.'),
  'conversation pin': spec('pin', ['conversationId'], 'Pin an account conversation.'),
  'conversation unpin': spec('unpin', ['conversationId'], 'Unpin an account conversation.'),
  'conversation move-project': spec('moveProject', ['conversationId'], 'Move an account conversation to a project or account root.', { '--project': string('projectId'), '--root': boolean('root') }),
  'conversation inbox list': spec('inbox', [], 'Read the account activity inbox.', { '--unread-only': boolean('unreadOnly'), '--all-items': { target: 'unreadOnly', type: 'boolean', value: false }, '--limit': number('limit'), '--cursor': string('cursor') }),
  'conversation inbox mark-read': spec('markRead', [], 'Mark exact account inbox items as read.', { '--ids': { target: 'itemIds', type: 'list' } }, { required: ['itemIds'] }),
  'conversation clear-async-status': spec('clearAsyncStatus', ['conversationId'], 'Clear account conversation unread activity status.'),
  'conversation shares list': spec('shareList', [], 'List the signed-in account’s owned conversation shares.'),
  'conversation shares get': spec('shareGet', ['shareId'], 'Read share metadata without exposing its raw transcript.'),
  'conversation shares create': spec('shareCreate', ['conversationId', 'nodeId'], 'Create a visible conversation snapshot; --publish creates a public link.', { '--publish': boolean('publish'), '--confirm': string('confirm') }, { required: ['confirm'], confirmMatch: [['confirm', 'conversationId']] }),
  'conversation shares update': spec('shareUpdate', ['shareId', 'nodeId'], 'Update a verified owned conversation share with exact-ID confirmation.', { '--title': string('title'), '--publish': boolean('publish'), '--unpublish': { target: 'publish', type: 'boolean', value: false }, '--visible': boolean('visible'), '--hide': { target: 'visible', type: 'boolean', value: false }, '--confirm': string('confirm') }, { required: ['confirm'], confirmMatch: [['confirm', 'shareId']] }),
  'conversation shares revoke': spec('shareRevoke', ['shareId'], 'Revoke an owned account conversation link.', { '--confirm': string('confirm') }, { required: ['confirm'], confirmMatch: [['confirm', 'shareId']] }),
};
