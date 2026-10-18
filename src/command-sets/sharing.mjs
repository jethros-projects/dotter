import { LibrarySharing } from '../sharing.mjs';

export const createClient = client => new LibrarySharing(client);
const accountFlags = { '--account': { target: 'accountId', type: 'string' }, '--user': { target: 'accountUserId', type: 'string' } };
const scopeFlags = { ...accountFlags, '--kind': { target: 'resourceKind', type: 'string' } };
const mutateFlags = { ...scopeFlags, '--confirm': { target: 'confirm', type: 'string' } };
const required = ['accountId', 'accountUserId'];
const defaults = { resourceKind: 'file' };
const resource = (method, description, flags = {}) => ({ method, positionals: ['resourceId'], flags: { ...scopeFlags, ...flags }, required, defaults, description });
const mutation = (method, description, flags = {}, moreRequired = [], specFields = []) => ({ method, positionals: ['resourceId'], flags: { ...mutateFlags, ...flags },
  required: [...required, 'confirm', ...moreRequired], defaults, confirmMatch: [['confirm', 'resourceId']],
  ...(specFields.length ? { specFields } : {}), description });
const invite = (method, description, write = false) => ({ method, positionals: ['invitationId'], flags: { ...accountFlags,
  '--resource': { target: 'resourceId', type: 'string' }, '--kind': { target: 'resourceKind', type: 'string' },
  ...(write ? { '--confirm': { target: 'confirm', type: 'string' } } : {}) }, required: [...required, ...(write ? ['confirm'] : [])],
  ...(write ? { confirmMatch: [['confirm', 'invitationId']] } : {}), description });

export const commands = {
  'library sharing capabilities': { method: 'capabilities', positionals: [], flags: {}, description: 'Describe audited Library sharing capabilities and guards.' },
  'library sharing identity': { method: 'identity', positionals: ['resourceId'], flags: { '--account': accountFlags['--account'], '--kind': scopeFlags['--kind'] },
    required: ['accountId'], defaults, description: 'Discover the actual server user principal for an accessible Library resource within the selected account.' },
  'library sharing state': resource('state', 'Read scoped file or folder permissions.'),
  'library sharing shares': resource('shares', 'List every page of direct shares with current owner validation.'),
  'library sharing effective': resource('effectiveAccess', 'Read effective collaborator access.'),
  'library sharing collaborators': resource('collaborators', 'Read collaborators and optional access-request context.', { '--request-ids': { target: 'accessRequestIds', type: 'list' } }),
  'library sharing resolve': { method: 'resolveRecipient', positionals: ['email'], flags: accountFlags, required, description: 'Resolve an invitation recipient within the selected account.' },
  'library sharing grant': mutation('createShare', 'Invite a recipient or update an observed direct share; requires resource confirmation.', {
    '--recipient': { target: 'recipient', type: 'json' }, '--role': { target: 'role', type: 'string' }, '--expected-share': { target: 'expectedInvitationId', type: 'string' }
  }, ['recipient', 'role'], ['recipient', 'role', 'expectedInvitationId']),
  'library sharing revoke': mutation('removeShare', 'Remove a current direct share; requires resource confirmation.', { '--share': { target: 'shareId', type: 'string' } }, ['shareId']),
  'library sharing link': mutation('updateLinkAccess', 'Set workspace or collaborators-only link access; requires owner and resource confirmation.', {
    '--mode': { target: 'mode', type: 'string' }, '--role': { target: 'role', type: 'string' }, '--workspace': { target: 'workspaceId', type: 'string' }
  }, ['mode']),
  'library sharing preview': resource('previewAccessChange', 'Preview a permission change with a server fingerprint.', {
    '--recipient': { target: 'recipient', type: 'json' }, '--role': { target: 'desiredRole', type: 'json' }
  }),
  'library sharing apply': mutation('applyAccessChange', 'Revalidate and apply a saved access preview; requires resource confirmation.', {
    '--preview': { target: 'preview', type: 'jsonFile' }
  }, ['preview'], ['preview']),
  'library sharing requests': resource('accessRequests', 'List owner or requester access requests.', { '--side': { target: 'side', type: 'string' }, '--cursor': { target: 'cursor', type: 'string' } }),
  'library sharing request': mutation('createAccessRequest', 'Ask the owner to share with specified recipients; requires resource confirmation.', {
    '--recipients': { target: 'recipients', type: 'json' }, '--role': { target: 'role', type: 'string' }
  }, ['recipients', 'role'], ['recipients', 'role']),
  'library sharing decide': mutation('decideAccessRequest', 'Approve or decline one pending recipient request; requires owner and resource confirmation.', {
    '--request': { target: 'requestId', type: 'string' }, '--recipient': { target: 'recipient', type: 'json' }, '--decision': { target: 'decision', type: 'string' }
  }, ['requestId', 'recipient', 'decision'], ['requestId', 'recipient', 'decision']),
  'library sharing invitations': { method: 'invitations', positionals: [], flags: { ...accountFlags, '--kind': { target: 'resourceKind', type: 'string' },
    '--cursor': { target: 'cursor', type: 'string' }, '--limit': { target: 'limit', type: 'number' } }, required, description: 'List received Library invitations in the selected account.' },
  'library sharing invitation': invite('invitation', 'Inspect a received Library invitation.'),
  'library sharing accept': invite('acceptInvitation', 'Accept one pending invitation; requires invitation confirmation.', true),
  'library sharing decline': invite('declineInvitation', 'Decline one pending invitation; requires invitation confirmation.', true),
  'library sharing leave': mutation('removeReceivedShare', 'Leave a direct share or remove its Shared With Me entry; requires resource confirmation.', { '--share': { target: 'shareId', type: 'string' } })
};

commands['library sharing preview'].required = [...required, 'recipient', 'desiredRole'];
