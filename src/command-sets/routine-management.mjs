import { RoutineManagement } from '../routine-management.mjs';

export const createClient = client => new RoutineManagement(client);
const routine = ['routineId'];
export const commands = {
  'routine query': {
    method: 'query', positionals: [],
    flags: { '--scope': { target: 'scope', type: 'string' }, '--query': { target: 'query', type: 'string' },
      '--status': { target: 'status', type: 'string' }, '--sort': { target: 'sort', type: 'string' },
      '--limit': { target: 'limit', type: 'number' }, '--cursor': { target: 'cursor', type: 'string' } },
    description: 'Search, filter and sort personal, team or all accessible cloud routines.'
  },
  'routine share current': { method: 'currentShare', positionals: routine, flags: {}, description: 'Read the selected routine’s current public share.' },
  'routine share create': { method: 'createShare', positionals: routine, flags: {}, description: 'Publish a public share link for the selected routine.' },
  'routine share refresh': { method: 'refreshShare', positionals: routine, flags: {}, description: 'Refresh the public share for the selected routine.' },
  'routine share revoke': { method: 'revokeShare', positionals: routine, flags: {}, description: 'Revoke the selected routine’s public share.' },
  'routine shared': { method: 'shared', positionals: ['postId'], flags: {}, description: 'Read a shared routine’s source and import metadata.' },
  'routine import-prompt': {
    method: 'creationPrompt', positionals: ['postId'],
    flags: { '--title': { target: 'title', type: 'string' }, '--prompt': { target: 'prompt', type: 'string' },
      '--prompt-file': { target: 'prompt', type: 'textFile' }, '--schedule': { target: 'schedule', type: 'string' },
      '--timing-mode': { target: 'timingMode', type: 'string' } },
    specFields: ['title', 'prompt', 'schedule', 'timingMode'], required: ['title', 'prompt', 'schedule', 'timingMode'],
    description: 'Prepare a shared-routine creation prompt; this does not create or run a routine.'
  }
};
