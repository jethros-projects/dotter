import { ProjectFiles } from '../project-files.mjs';
export const createClient = client => new ProjectFiles(client);
const string = target => ({ target, type: 'string' });
const account = { '--account': string('accountId') };
export const commands = {
  'account projects files list': { method: 'list', positionals: ['projectId'], flags: account, required: ['accountId'], description: 'List project file membership and current file capacity without reading file contents.' },
  'account projects files attach-library': { method: 'attachLibrary', positionals: ['projectId'], flags: { ...account, '--ids': { target: 'libraryFileIds', type: 'list' } }, required: ['accountId', 'libraryFileIds'], description: 'Attach existing ready native Library files after fresh identity, project permission, private/default-memory and file-limit checks.' },
  'account projects files remove': { method: 'remove', positionals: ['projectId', 'fileId'], flags: { ...account, '--confirm': string('confirm') }, required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'fileId']], description: 'Remove one exact project source. Sends no Library or general Files deletion; confirm its project file ID.' },
};
