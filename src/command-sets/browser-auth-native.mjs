import { DotBrowserAuthNative } from '../browser-auth-native.mjs';
export const createClient = client => new DotBrowserAuthNative(client);
const account = { '--account': { target: 'expectedAccountId', type: 'string' } };
const target = { ...account, '--room': { target: 'roomId', type: 'string' }, '--message': { target: 'messageId', type: 'string' } };
export const commands = {
  'remote auth inspect': { method: 'inspectChallenge', positionals: [], flags: target, required: ['roomId', 'messageId'], description: 'Inspect a current visible browser-auth request and its authoritative origin, fields, and fingerprint.' },
  'remote auth claim': { method: 'claim', positionals: ['stateFile'], flags: { ...target, '--fingerprint': { target: 'requestFingerprint', type: 'string' }, '--origin': { target: 'expectedOrigin', type: 'string' } }, required: ['roomId', 'messageId', 'requestFingerprint', 'expectedOrigin'], description: 'Claim an owner-only durable operation bound to the current challenge, exact web origin and signed-in user.' },
  'remote auth fill': { method: 'fill', positionals: ['stateFile'], flags: { ...account, '--credentials': { target: 'credentialsFile', type: 'secretPath' }, '--option': { target: 'selectedOption', type: 'string' }, '--remember': { target: 'remember', type: 'boolean' } }, required: ['credentialsFile'], description: 'Submit one private field-ID JSON input to the claimed challenge; remember explicitly requests supported credential saving.' },
  'remote auth reuse': { method: 'reuse', positionals: ['stateFile', 'credentialId'], flags: account, description: 'Use an unexpired saved-credential selection for the exact claimed origin, without exposing its capability.' },
  'remote auth operation': { method: 'state', positionals: ['stateFile'], flags: account, description: 'Read safe status from a private browser-auth operation; never prints credential values or access handles.' },
  'remote auth recover': { method: 'recover', positionals: ['stateFile'], flags: account, description: 'Reconcile an attempted operation with the server without resubmitting its credentials.' },
  'remote auth password-manager start': { method: 'startManager', positionals: ['stateFile'], flags: account, description: 'Request 1Password access for the current claimed challenge and save its capability privately.' },
  'remote auth password-manager status': { method: 'managerStatus', positionals: ['stateFile'], flags: account, description: 'Check this exact 1Password approval request once; does not submit credentials.' },
  'remote auth password-manager open': { method: 'openManagerApproval', positionals: ['stateFile'], flags: account, description: 'Open the verified onepassword approval deep link in the native password manager.' },
  'remote auth password-manager use': { method: 'useManager', positionals: ['stateFile'], flags: account, description: 'Recheck approval and submit the approved 1Password access handle once to the claimed challenge.' },
};
