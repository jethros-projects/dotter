import { DotOnboarding } from '../onboarding.mjs';

export const createClient = client => new DotOnboarding(client);
export const commands = {
  'dot onboarding eligibility': {
    method: 'eligibility', positionals: [], flags: {},
    description: 'Read selected-account Dot availability. Eligibility does not establish permission to create a Dot.'
  },
  'dot onboarding create': {
    method: 'create', positionals: [],
    flags: { '--state-file': { target: 'operationFile', type: 'path' }, '--name': { target: 'name', type: 'string' }, '--avatar': { target: 'avatar', type: 'string' }, '--first-dot': { target: 'createAdditional', type: 'boolean', value: false } },
    required: ['operationFile'],
    description: 'Create and initialize a Dot using the native server flow, with a private recovery journal.'
  },
  'dot onboarding status': {
    method: 'status', positionals: ['operationFile'], flags: {},
    description: 'Read onboarding recovery status and new candidate identities without creating or sending.'
  },
  'dot onboarding resume': {
    method: 'resume', positionals: ['operationFile'],
    flags: { '--dot': { target: 'dotId', type: 'string' }, '--confirm': { target: 'confirmDotId', type: 'string' }, '--retry-room': { target: 'retryRoom', type: 'boolean' } },
    confirmMatch: [['confirmDotId', 'dotId']],
    description: 'Reconcile a saved onboarding operation and finish its messaging room; never replay Dot creation.'
  }
};
