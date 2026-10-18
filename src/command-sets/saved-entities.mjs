import { SavedEntities } from '../saved-entities.mjs';
export const createClient = client => new SavedEntities(client);
const s = target => ({ target, type: 'string' });
const account = { '--account': s('accountId') };
export const commands = {
  'library saved capabilities': { method: 'capabilities', description: 'Describe native account Library saved-entity operations and typed constructors.' },
  'library saved status': { method: 'status', flags: { ...account, '--specs-file': { target: 'specs', type: 'jsonFile' } }, required: ['accountId', 'specs'], description: 'Read saved status for 1 to 100 typed product/local-business specs.' },
  'library saved get': { method: 'get', positionals: ['fileId'], flags: account, required: ['accountId'], description: 'Read one native saved-entity Library node and verify its current saved status.' },
  'library saved save': { method: 'save', flags: { ...account, '--file': { target: 'spec', type: 'jsonFile' } }, required: ['accountId', 'spec'], description: 'Save one typed product/local-business spec and verify the returned Library ID.' },
  'library saved remove': { method: 'remove', positionals: ['fileId'], flags: { ...account, '--confirm': s('confirm') }, required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'fileId']], description: 'Remove a saved entity using its exact confirmed Library node; verify it is no longer saved.' },
  'library saved move': { method: 'move', positionals: ['fileId'], flags: { ...account, '--directory': s('directoryId'), '--root': { target: 'root', type: 'boolean' } }, required: ['accountId'], description: 'Move a saved entity to an accessible native folder or the Library root; verify status.' },
};
