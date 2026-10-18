import { ProjectMemory } from '../project-memory.mjs';
export const createClient = client => new ProjectMemory(client);
const string = target => ({ target, type: 'string' });
export const commands = {
  'account projects memory get': { method: 'get', positionals: ['projectId'], required: ['accountId'],
    description: 'Read project memory configuration and current service-readable eligibility.', flags: { '--account': string('accountId') } },
  'account projects memory set': { method: 'set', positionals: ['projectId', 'scope'], required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'projectId']],
    description: 'Change an eligible private project to global or project_v2 memory and verify the stored setting; conversation behavior may propagate later.',
    flags: { '--account': string('accountId'), '--confirm': string('confirm') } },
};
