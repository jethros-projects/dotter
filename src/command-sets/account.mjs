import { DotAccount } from '../account.mjs';
export const createClient = client => new DotAccount(client);
const account = { '--account': { target: 'accountId', type: 'string' } };
const confirmation = { '--confirm': { target: 'confirm', type: 'string' } };
const summary = { ...account, '--source': { target: 'source', type: 'string' }, '--context': { target: 'contextualHint', type: 'json' }, '--context-file': { target: 'contextualHint', type: 'jsonFile' } };
const correction = { ...account, '--source': { target: 'source', type: 'string' },
  '--text': { target: 'correction', type: 'string' }, '--text-file': { target: 'correction', type: 'textFile' },
  '--section': { target: 'targetSectionId', type: 'string' }, '--selection': { target: 'targetText', type: 'string' },
  '--conversation': { target: 'conversationId', type: 'string' } };
export const commands = {
  'account capabilities': { method: 'capabilities', description: 'List the implemented account-scoped APIs.' },
  'account memories list': { method: 'memoryList', flags: account, required: ['accountId'], description: 'List visible saved memories for the selected account.' },
  'account memories capacity': { method: 'memoryCapacity', flags: account, required: ['accountId'], description: 'Read saved-memory token capacity for the selected account.' },
  'account memories delete': { method: 'memoryDelete', positionals: ['memoryId'], flags: { ...account, ...confirmation }, required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'memoryId']], description: 'Delete one saved memory after confirming its exact ID.' },
  'account memories warm': { method: 'memoryWarm', positionals: ['memoryId'], flags: account, required: ['accountId'], description: 'Restore normal priority to a saved memory.' },
  'account memories clear': { method: 'memoryClear', flags: { ...account, ...confirmation, '--delete-history': { target: 'deleteHistory', type: 'boolean' } }, required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'accountId']], description: 'Clear saved account memories; confirm the exact account ID.' },
  'account personalization get': { method: 'personalizationGet', flags: account, required: ['accountId'], description: 'Read account custom instructions and personality preferences.' },
  'account personalization update': { method: 'personalizationUpdate', flags: { ...account, '--update': { target: 'update', type: 'json' }, '--file': { target: 'update', type: 'jsonFile' } }, required: ['accountId', 'update'], description: 'Patch instructions/preferences; personality choices are validated against fresh catalogs.' },
  'account personality types': { method: 'personalityTypes', flags: account, required: ['accountId'], description: 'Read available personality choices.' },
  'account personality traits': { method: 'personalityTraitTypes', flags: account, required: ['accountId'], description: 'Read nondeprecated personality traits and levels.' },
  'account notifications get': { method: 'notificationGet', flags: account, required: ['accountId'], description: 'Read account notification categories and channels.' },
  'account notifications update': { method: 'notificationUpdate', flags: { ...account, '--updates': { target: 'updates', type: 'json' }, '--file': { target: 'updates', type: 'jsonFile' } }, required: ['accountId', 'updates'], description: 'Update notification channels after fresh catalog validation.' },
  'account voices': { method: 'voices', flags: { ...account, '--language': { target: 'language', type: 'string' }, '--mode': { target: 'mode', type: 'string' } }, required: ['accountId', 'language'], description: 'Read voice choices and safe preview links for a language; mode is standard, advanced (default), or wingman. No audio is fetched.' },
  'account settings get': { method: 'settingsGet', flags: account, required: ['accountId'], description: 'Read supported account settings and their allowed feature names.' },
  'account settings set': { method: 'settingsSet', positionals: ['feature'], flags: { ...account, '--value': { target: 'value', type: 'json' } }, required: ['accountId', 'value'], description: 'Set one verified account feature with a typed JSON value.' },
  'account summary checksum': { method: 'summaryChecksum', flags: { ...account, '--source': { target: 'source', type: 'string' } }, required: ['accountId'], description: 'Read memory-summary cache freshness.' },
  'account summary get': { method: 'summaryGet', flags: summary, required: ['accountId'], description: 'Retrieve the account memory summary; the API may generate its cache.' },
  'account summary actions': { method: 'summarySelectionActions', flags: account, required: ['accountId'], description: 'Read the supported summary selection actions.' },
  'account summary stream': { method: 'summaryStream', flags: summary, required: ['accountId'], stream: true, description: 'Stream the visible memory-summary sections once.' },
  'account summary regenerate': { method: 'summaryRegenerate', flags: summary, required: ['accountId'], stream: true, description: 'Explicitly regenerate the account memory summary once.' },
  'account summary correct': { method: 'summaryCorrect', flags: correction, required: ['accountId', 'correction'], stream: true, description: 'Correct the current memory summary with optional section/selection targeting.' },
  'account summary forget': { method: 'summaryForget', flags: { ...correction, ...confirmation }, required: ['accountId', 'correction', 'confirm'], stream: true, description: 'Ask memory to forget a selected section or topic; confirm its section or account ID.' },
  'account summary clear': { method: 'summaryClear', flags: { ...account, ...confirmation }, required: ['accountId', 'confirm'], confirmMatch: [['confirm', 'accountId']], description: 'Disable account memory and clear its summary cache; confirm the account ID.' },
};
