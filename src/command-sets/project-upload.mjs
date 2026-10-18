import { ProjectUpload } from '../project-upload.mjs';
export const createClient = client => new ProjectUpload(client);
const string = target => ({ target, type: 'string' });
const common = { '--account': string('accountId'), '--state-file': { target: 'stateFile', type: 'path' } };
export const commands = {
  'account projects files upload': { method: 'upload', positionals: ['projectId', 'file'], flags: { ...common, '--mime': string('mimeType'), '--resume-parts': { target: 'resumeParts', type: 'boolean' } }, required: ['accountId', 'stateFile'], description: 'Upload a local file through the native project-specific reservation, transfer, processing and membership flow, recording a private recovery journal.' },
  'account projects files upload-status': { method: 'status', positionals: [], flags: common, required: ['accountId', 'stateFile'], description: 'Inspect a private project-upload journal without replaying its writes.' },
  'account projects files upload-reconcile': { method: 'reconcile', positionals: [], flags: common, required: ['accountId', 'stateFile'], description: 'Reconcile an uncertain native project upload through read-only checks; never reserve, process or attach again.' },
};
