import { DotNativeActions } from '../native-actions.mjs';
export const createClient = client => new DotNativeActions(client);
const account = { '--account': { target: 'expectedAccountId', type: 'string' } };
const request = { ...account, '--room': { target: 'roomId', type: 'string' }, '--request': { target: 'requestId', type: 'string' }, '--fingerprint': { target: 'requestFingerprint', type: 'string' } };
const session = { ...account, '--session-file': { target: 'sessionFile', type: 'path' } };
export const commands = {
  'actions native inspect': { method: 'inspect', positionals: ['messageId'], flags: request, description: 'Inspect native approval metadata without exposing device challenges or email-code handles.' },
  'actions native start': { method: 'start', positionals: ['messageId'], flags: { ...request, '--session-file': { target: 'sessionFile', type: 'path' }, '--no-open': { target: 'noOpen', type: 'boolean' } }, required: ['requestId', 'requestFingerprint', 'sessionFile'], description: 'Open exact first-party human review for location, identity, wallet, or browser approval.' },
  'actions native status': { method: 'status', positionals: [], flags: session, required: ['sessionFile'], description: 'Read the bound native request status without resending its response.' },
  'actions native complete': { method: 'complete', positionals: [], flags: session, required: ['sessionFile'], description: 'Verify that human review resolved the exact native request; performs no approval write.' },
  'actions native approve-email-code': { method: 'approveEmailOtp', positionals: ['messageId'], flags: { ...request, '--confirm': { target: 'confirm', type: 'string' } }, required: ['requestId', 'requestFingerprint', 'confirm'], confirmMatch: [['confirm', 'requestId']], description: 'Approve the exact browser email-code request without reading or printing the code.' }
};
