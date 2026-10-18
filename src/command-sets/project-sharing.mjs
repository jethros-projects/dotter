import { ProjectSharing } from '../project-sharing.mjs';
export const createClient = client => new ProjectSharing(client);
const string = target => ({ target, type: 'string' });
const common = { '--account': string('accountId') };
const write = { '--confirm': string('confirm'), '--detach-library-files': { target: 'detachLibraryFiles', type: 'boolean' } };
const spec = (method, positionals, description, flags = {}, mutation = false) => ({ method, positionals, description, flags: { ...common, ...flags }, required: mutation ? ['accountId', 'confirm'] : ['accountId'], ...(mutation ? { confirmMatch: [['confirm', 'projectId']] } : {}) });
export const commands = {
  'account projects sharing get': spec('get', ['projectId'], 'Read fresh project sharing subjects, roles, link audience and native workspace permissions.'),
  'account projects sharing access': spec('access', ['projectId', 'access'], 'Set private (invited people retain access), link, or workspace_link access. Work conversations block expansion. First sharing may detach Library sources after acknowledgment.', write, true),
  'account projects sharing invite': spec('invite', ['projectId'], 'Invite explicit recipients using --subjects JSON [{"type":"email","email":"person@example.com"}] or workspace user/userId and group/groupId records; roles are chat or edit (default). May send invitations.', { ...write, '--subjects': { target: 'subjects', type: 'json' }, '--subjects-file': { target: 'subjects', type: 'jsonFile' }, '--role': string('role') }, true),
  'account projects sharing role': spec('role', ['projectId', 'subject', 'role'], 'Change a current user:, group: or email: subject to chat or edit after fresh owner and sharing-permission checks.', write, true),
  'account projects sharing remove': spec('remove', ['projectId', 'subject'], 'Remove a current user:, group: or email: subject. They lose access to all project content. Requires exact project confirmation.', write, true),
};
