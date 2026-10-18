import { LibraryProviders } from '../library-providers.mjs';
export const createClient = client => new LibraryProviders(client);
const s = target => ({ target, type: 'string' });
const n = target => ({ target, type: 'number' });
const b = target => ({ target, type: 'boolean' });
const l = target => ({ target, type: 'list' });
const j = target => ({ target, type: 'json' });
const command = (method, positionals, description, flags = {}, extra = {}) => ({ method, positionals, description, flags, ...extra });
const refFlags = { '--name': s('entityName'), '--type': s('entityType') };
export const commands = {
  'library browse': command('browse', [], 'Browse account Library files, folders, provider roots, and Pages.', { '--directory': s('directoryId'), '--query': s('query'), '--cursor': s('cursor'), '--categories': l('categories'), '--category': l('categories'), '--folders-only': b('foldersOnly'), '--source': s('source'), '--include-files': b('includeFiles'), '--include-saved-entities': b('includeSavedEntities'), '--include-provider-roots': b('includeProviderRoots'), '--include-pages': b('includePages'), '--include-sites': b('includeSites'), '--include-folder-counts': b('includeFolderCounts'), '--include-onedrive': b('includeOneDrive'), '--hydrate-folder-thumbnails': b('hydrateFolderThumbnails') }),
  'library search': command('librarySearch', [], 'Search Library files; --providers selects external services and --include-native-files includes native entries.', { '--query': s('query'), '--limit': n('limit'), '--cursor': s('cursor'), '--categories': l('categories'), '--category': l('categories'), '--trash': b('trash'), '--state': s('state'), '--source': s('source'), '--ranking': s('ranking'), '--providers': l('providers'), '--external-accounts': j('externalAccountKeys'), '--allowlist': l('allowlistIds'), '--include-native-files': b('includeNativeFiles'), '--include-uploaded-files': b('includeUploadedFiles'), '--include-imagegen-files': b('includeImagegenFiles'), '--include-saved-entities': b('includeSavedEntities'), '--include-pages': b('includePages'), '--include-sites': b('includeSites'), '--exclude-space-roots': b('excludeSpaceRoots') }),
  'library providers capabilities': command('mountedCapabilities', [], 'Inspect account-linked provider and link browsing capabilities.', { '--provider': s('provider'), '--link': s('linkId') }),
  'library providers onedrive-status': command('oneDriveCapability', [], 'Inspect the native OneDrive capability state.'),
  'library providers search': command('search', ['query'], 'Search selected mounted file providers.', { '--providers': l('providers'), '--limit': n('limit') }, { required: ['providers'] }),
  'library providers search-cache': command('searchCache', ['query'], 'Read one provider search cache without implicit live fallback.', { '--provider': s('provider'), '--limit': n('limit') }, { required: ['provider'] }),
  'library providers materialize': command('materialize', ['fileId', 'name'], 'Materialize a mounted file; retrieval indexing is opt-in.', { '--mime': s('mimeType'), '--index': b('indexForRetrieval') }),
  'library providers metadata': command('fileMetadata', ['provider', 'fileId'], 'Read provider metadata for an exact mounted file.'),
  'library providers resolve': command('resolve', ['provider'], 'Resolve a provider URL or a Google Drive/Box native file ID.', { '--url': s('url'), '--native-id': s('nativeFileId') }),
  'library providers preview': command('preview', ['provider', 'fileId'], 'Request a provider preview, exposing only sanitized source links.'),
  'library shared-search': command('sharedSearch', ['query'], 'Search files and folders shared with the account.'),
  'library global-search': command('globalSearch', ['query'], 'Run a federated Library, files, and Pages search.', {
    '--query-id': s('queryId'), '--cursor': s('cursor'), '--limit': n('limit'), '--entrypoint': s('entrypoint'), '--providers': l('providers'), '--external-accounts': j('externalAccountKeys'), '--lanes': l('lanes'), '--directory': s('directoryId'), '--file-types': l('fileTypes'), '--source': s('source'), '--allowlist': l('allowlistIds'), '--include-sites': b('includeSites'), '--include-pages': b('includePages'), '--page-source': s('spaceSearchSource'), '--include-space-files': b('includeSpaceFiles'), '--ownership': s('ownership'), '--page-search-target': s('pageSearchTarget')
  }),
  'library references list': command('referenceImages', [], 'List saved account reference-image metadata.', { '--limit': n('limit'), '--cursor': s('cursor') }),
  'library references add': command('createReferenceImage', ['assetPointer'], 'Save an already uploaded sediment image as a named reference.', { ...refFlags, '--idempotency-key': s('idempotencyKey') }, { required: ['entityName', 'entityType'], key: 'idempotencyKey' }),
  'library references add-suggestion': command('createReferenceImage', [], 'Save an exact account reference-image suggestion.', {}, { required: ['entityName', 'entityType', 'entityDescription', 'libraryFileId', 'sourceConversationId', 'sourceMessageId', 'suggestionMessageId'], defaults: { requestKind: 'suggestion_library' }, specFields: ['entityName', 'entityType', 'entityDescription', 'imageIndex', 'libraryFileId', 'sourceConversationId', 'sourceMessageId', 'suggestionMessageId'] }),
  'library references update': command('updateReferenceImage', ['referenceImageId'], 'Update an existing reference-image name and type.', refFlags, { required: ['entityName', 'entityType'] }),
  'library references delete': command('deleteReferenceImage', ['referenceImageId'], 'Delete a saved reference image using exact-ID confirmation.', { '--confirm': s('confirm') }, { required: ['confirm'], confirmMatch: [['confirm', 'referenceImageId']] }),
  'library references thumbnail': command('referenceThumbnail', ['referenceImageId'], 'Inspect thumbnail availability or save it privately.', { '--output': { target: 'output', type: 'path' }, '--overwrite': b('overwrite') }),
  'library image-favorites add': command('imageFavorite', [], 'Save an image source to account Library favorites.', { '--source': j('source') }, { required: ['source'] }),
  'library image-favorites status': command('imageFavoriteStatus', [], 'Read favorite state for up to 50 image sources.', { '--sources': j('sources') }, { required: ['sources'] }),
  'library conversation-favorites': command('conversationFavorites', ['conversationId'], 'List Library favorites originating from an account conversation.', { '--limit': n('limit'), '--cursor': s('cursor') }),
};

// Preserve the API's three states (omitted, true, false). Positive switches
// alone cannot express an explicit false value for these optional filters.
const inverseFlags = {
  'library browse': {
    '--files-and-folders': 'foldersOnly',
    '--exclude-files': 'includeFiles',
    '--exclude-saved-entities': 'includeSavedEntities',
    '--exclude-provider-roots': 'includeProviderRoots',
    '--exclude-pages': 'includePages',
    '--exclude-sites': 'includeSites',
    '--exclude-folder-counts': 'includeFolderCounts',
    '--exclude-onedrive': 'includeOneDrive',
    '--no-hydrate-folder-thumbnails': 'hydrateFolderThumbnails'
  },
  'library search': {
    '--not-trash': 'trash',
    '--exclude-native-files': 'includeNativeFiles',
    '--exclude-uploaded-files': 'includeUploadedFiles',
    '--exclude-imagegen-files': 'includeImagegenFiles',
    '--exclude-saved-entities': 'includeSavedEntities',
    '--exclude-pages': 'includePages',
    '--exclude-sites': 'includeSites',
    '--include-space-roots': 'excludeSpaceRoots'
  },
  'library providers materialize': { '--no-index': 'indexForRetrieval' },
  'library global-search': {
    '--exclude-sites': 'includeSites',
    '--exclude-pages': 'includePages',
    '--exclude-space-files': 'includeSpaceFiles'
  },
  'library references thumbnail': { '--no-overwrite': 'overwrite' }
};
for (const [name, aliases] of Object.entries(inverseFlags)) {
  for (const [flag, target] of Object.entries(aliases)) commands[name].flags[flag] = { target, type: 'boolean', value: false };
}
