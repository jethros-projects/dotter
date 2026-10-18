import { DotExtras } from '../dot-extras.mjs';

export const createClient = client => new DotExtras(client);
export const commands = {
  'threads inventory': {
    method: 'listThreads', positionals: [],
    flags: { '--dot': { target: 'dotId', type: 'string' }, '--include-hidden': { target: 'includeHidden', type: 'boolean' }, '--limit': { target: 'limit', type: 'number' }, '--cursor': { target: 'cursor', type: 'string' } },
    description: 'List Dot thread identities; hidden threads expose metadata only.'
  },
  'dot avatar-default': {
    method: 'avatar', positionals: ['dotId', 'avatar'], flags: {}, defaults: { onlyIfDefault: true },
    description: 'Set a legacy avatar only while the Dot still has its default avatar.'
  },
  'dot recover-deletion': {
    method: 'recoverDeletions', positionals: [], flags: { '--confirm': { target: 'confirm', type: 'boolean' } }, required: ['confirm'],
    description: 'Retry pending deletion finalization; this does not restore deleted Dots.'
  },
  'dot primary-thread': {
    method: 'setPrimaryThread', positionals: ['threadId'], flags: {},
    description: 'Select the primary Dot through the legacy thread-ID route.'
  },
  'account reference-photos list': {
    method: 'listReferencePhotos', positionals: [], flags: {},
    description: 'List saved account reference-photo identities and asset pointers.'
  },
  'account reference-photos add': {
    method: 'uploadReferencePhoto', positionals: ['file'], flags: { '--kind': { target: 'kind', type: 'string' } },
    description: 'Upload and save a self or full_body_likeness reference photo.'
  },
  'account reference-photos replace': {
    method: 'updateReferencePhoto', positionals: ['imageTagId', 'file'], flags: {},
    description: 'Replace the image in an existing account reference-photo tag.'
  },
  'account reference-photos delete': {
    method: 'removeReferencePhoto', positionals: ['imageTagId'], flags: { '--confirm': { target: 'confirmImageTagId', type: 'string' } },
    required: ['confirmImageTagId'], confirmMatch: [['confirmImageTagId', 'imageTagId']],
    description: 'Delete a saved reference-photo tag with exact ID confirmation.'
  }
};
