import { LibraryContent } from '../library-content.mjs';
export const createClient = client => new LibraryContent(client);
const s = target => ({ target, type: 'string' });
const n = target => ({ target, type: 'number' });
const path = target => ({ target, type: 'path' });
const list = target => ({ target, type: 'list' });
const json = target => ({ target, type: 'json' });
const assetFlags = { '--output': path('output'), '--overwrite': { target: 'overwrite', type: 'boolean' }, '--max-bytes': n('maxBytes'), '--range': s('range'), '--page': s('pageId') };
const reportFlags = { '--args': json('args') };
export const commands = {
  'library create-directory': { method: 'createDirectory', positionals: ['name'], flags: { '--parent': s('parentDirectoryId') }, description: 'Create a Library folder; omitting --parent selects the root.' },
  'library delete-directory': { method: 'deleteDirectory', positionals: ['directoryId'], flags: { '--confirm': s('confirm') }, required: ['confirm'], confirmMatch: [['confirm', 'directoryId']], description: 'Delete a Library folder using its exact ID confirmation.' },
  'library register-upload': { method: 'registerUpload', positionals: ['fileId', 'fileName'], flags: { '--parent': s('parentDirectoryId'), '--mime': s('mimeType') }, required: ['parentDirectoryId'], description: 'Finalize an external-provider upload in an eligible existing provider folder. Requires its general Files ID and --parent; native and room uploads are already registered. Provider finalization remains live-unverified.' },
  'library create-inline': { method: 'createInline', positionals: ['fileName'], flags: { '--content-file': { target: 'content', type: 'textFile' }, '--content': s('content'), '--directory': s('directoryId'), '--create-key': s('createKey') }, required: ['content'], key: 'createKey', description: 'Create a Library note from text, at most 1 MiB.' },
  'library update-inline': { method: 'updateInline', positionals: ['fileId', 'fileName'], flags: { '--content-file': { target: 'content', type: 'textFile' }, '--content': s('content'), '--confirm': s('confirm') }, required: ['content', 'confirm'], confirmMatch: [['confirm', 'fileId']], description: 'Replace a Library note with explicit file ID confirmation.' },
  'library download': { method: 'download', positionals: ['fileId'], flags: assetFlags, required: ['output'], description: 'Save Library download bytes privately, up to 100 MiB.' },
  'library content': { method: 'content', positionals: ['fileId'], flags: assetFlags, required: ['output'], description: 'Save Library content privately, with optional byte range.' },
  'library thumbnail': { method: 'thumbnail', positionals: ['fileId'], flags: assetFlags, required: ['output'], description: 'Save a Library thumbnail privately.' },
  'library recents': { method: 'recents', positionals: [], flags: { '--limit': n('limit'), '--providers': list('providers'), '--external-accounts': json('externalAccountKeys') }, description: 'List recently opened account Library files.' },
  'library opened': { method: 'markOpened', positionals: ['fileId'], flags: {}, description: 'Record a Library file as opened.' },
  'library plan-summary': { method: 'planSummary', positionals: ['fileId'], flags: {}, description: 'Read a saved learning-plan summary.' },
  'library deep-research': { method: 'deepResearch', positionals: ['fileId'], flags: {}, description: 'Read visible saved-report preview state.' },
  'library deep-research-state': { method: 'deepResearchState', positionals: ['fileId'], flags: reportFlags, description: 'Read visible saved-report state through its native tool.' },
  'library deep-research-images': { method: 'deepResearchImages', positionals: ['fileId'], flags: reportFlags, description: 'Read saved-report inline image data.' },
  'library deep-research-export': { method: 'deepResearchExport', positionals: ['fileId'], flags: { ...reportFlags, '--output': path('output'), '--overwrite': { target: 'overwrite', type: 'boolean' } }, description: 'Request report export; optionally save filtered result JSON.' },
  'library delete-permanently': { method: 'permanentDelete', positionals: ['fileId'], flags: { '--confirm': s('confirm') }, required: ['confirm'], confirmMatch: [['confirm', 'fileId']], description: 'Permanently delete one regular Library file or current, unshared native saved chat snapshot by exact ID; snapshot removal preserves its source conversation.' },
  'library delete-batch': { method: 'deleteBatch', positionals: [], flags: { '--files': list('fileIds'), '--confirm-files': list('confirmFileIds') }, required: ['fileIds', 'confirmFileIds'], description: 'Soft-delete up to 25 exact, explicitly confirmed Library file IDs.' },
  'library empty-trash': { method: 'emptyTrash', positionals: [], flags: { '--confirm': s('confirm') }, required: ['confirm'], description: 'Permanently clear Library file trash; requires EMPTY LIBRARY TRASH.' },
};
