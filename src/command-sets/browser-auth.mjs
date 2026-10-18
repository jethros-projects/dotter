import { DotBrowserAuth } from '../browser-auth.mjs';
export const createClient = client => new DotBrowserAuth(client);
const common = { '--account': { target: 'expectedAccountId', type: 'string' } };
export const commands = {
  'remote auth prepare': { method: 'prepare', positionals: ['conversationId', 'challengeId'], flags: common, description: 'Prepare an existing browser sign-in challenge; returns metadata without credentials or fill capabilities.' },
  'remote auth availability': { method: 'availability', positionals: ['conversationId', 'challengeId'], flags: { ...common, '--trigger': { target: 'trigger', type: 'string' } }, description: 'Read credential availability metadata for an existing browser sign-in challenge.' },
  'remote auth candidates': { method: 'candidates', positionals: ['conversationId', 'challengeId'], flags: { ...common, '--cursor': { target: 'cursor', type: 'string' } }, description: 'List candidate account labels and origins without secret values or selection capabilities.' },
  'remote auth reconcile': { method: 'reconcile', positionals: ['conversationId', 'challengeId', 'operationId'], flags: common, description: 'Recover the fill/save status of an existing browser-auth operation.' },
};
