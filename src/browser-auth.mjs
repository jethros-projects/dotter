import { DotError } from './errors.mjs';

const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
function id(value, name) { if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `${name} must be an ID returned by the API.`); return value; }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_RESPONSE', 'The browser-auth service returned an unexpected response.'); return value; }
function text(value, max = 2048) { return typeof value === 'string' && value.length <= max ? value : null; }
function timestamp(value) { return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? value : null; }
function origin(value) { try { const result = new URL(value); return ['http:', 'https:'].includes(result.protocol) && !result.username && !result.password && result.pathname === '/' && !result.search && !result.hash ? result.origin : null; } catch { return null; } }
function candidate(value) {
  object(value);
  // selection_id is an ephemeral credential-fill capability. Never include it
  // (or credential values) in ordinary CLI output.
  return { credentialId: text(value.credential_id), origin: origin(value.origin), accountLabel: text(value.account_label), createdAt: timestamp(value.created_at), expiresAt: timestamp(value.expires_at) };
}
function operation(value, expected) {
  object(value);
  if (value.operation_id !== expected) throw new DotError('BROWSER_AUTH_IDENTITY_MISMATCH', 'The browser-auth response belongs to another operation.');
  const statuses = ['submitted', 'declined', 'cancelled', 'unavailable', 'expired', 'origin_changed', 'page_changed', 'locator_invalid', 'submission_failed', 'unknown'];
  const saves = ['not_requested', 'saved', 'failed', 'unknown'];
  return { operationId: expected, fillStatus: statuses.includes(value.fill_status) ? value.fill_status : 'unknown', saveStatus: saves.includes(value.save_status) ? value.save_status : 'unknown' };
}
function availability(value) {
  object(value);
  if (!['available', 'save_enabled', 'reuse_enabled'].every(key => typeof value[key] === 'boolean') || !Array.isArray(value.items)) throw new DotError('INVALID_RESPONSE', 'The browser-auth service did not return credential availability.');
  return { available: value.available, saveEnabled: value.save_enabled, reuseEnabled: value.reuse_enabled,
    manualSaveSupported: value.manual_save_supported === true, manualFillRecoverySupported: value.manual_fill_recovery_supported === true,
    items: value.items.map(candidate), nextCursor: text(value.next_cursor) };
}
async function account(transport, expectedAccountId) {
  if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !expectedAccountId)) throw new DotError('INVALID_ARGUMENT', 'expectedAccountId must be a nonempty account ID.');
  const auth = typeof transport.authLoader === 'function' ? await transport.authLoader({ authFile: transport.authFile }) : null;
  if (auth && (!auth.accountId || (expectedAccountId && auth.accountId !== expectedAccountId))) throw new DotError('ACCOUNT_CHANGED', 'The current Codex account differs from the selected browser-auth account.');
  if (auth) transport.assertIdentity?.(auth);
  const selected = auth?.accountId ?? expectedAccountId;
  if (!selected) throw new DotError('ACCOUNT_REQUIRED', 'Browser-auth requests require an account selector from the Codex login.');
  return selected;
}
export function browserAuthCapabilities() {
  return { browserAuth: ['prepare challenge', 'credential availability metadata', 'candidate metadata', 'reconcile existing operation'], browserAuthNativeWorkflows: ['durable operation claim', 'private manual fill/save', 'saved credential reuse', '1Password approval and fill'], browserAuthUnsupported: ['native passkey/biometric/SIWC proofs require first-party human completion'], browserAuthLiveTested: false };
}
export class DotBrowserAuth {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('DotBrowserAuth requires a Dot client.'); this.transport = client.transport; }
  async context(options) {
    id(options.conversationId, 'conversationId'); id(options.challengeId, 'challengeId');
    return { conversationId: options.conversationId, challengeId: options.challengeId, expectedAccountId: await account(this.transport, options.expectedAccountId), signal: options.signal };
  }
  async prepare(options = {}) {
    const scope = await this.context(options);
    const value = object(await this.transport.request('POST', '/backend-api/flora/browser/auth/prepare', { body: { conversation_id: scope.conversationId, challenge_id: scope.challengeId }, expectedAccountId: scope.expectedAccountId, signal: scope.signal }));
    if (typeof value.manual_fill_recovery_supported !== 'boolean' || !Array.isArray(value.password_managers)) throw new DotError('INVALID_RESPONSE', 'The browser-auth service did not return challenge preparation.');
    return { conversationId: scope.conversationId, challengeId: scope.challengeId, manualFillRecoverySupported: value.manual_fill_recovery_supported,
      operation: value.operation ? operation(value.operation, id(value.operation_id, 'operation_id')) : null,
      passwordManagers: value.password_managers.filter(item => ['openai_passwords', 'onepassword'].includes(item?.provider)).map(item => ({ provider: item.provider, interaction: ['inline', 'external'].includes(item.interaction) ? item.interaction : null,
        ...(item.provider === 'openai_passwords' ? { saveEnabled: item.save_enabled === true, items: Array.isArray(item.items) ? item.items.map(candidate) : [], nextCursor: text(item.next_cursor) } : { state: ['disconnected', 'connecting', 'connected', 'failed', 'reconnect_required'].includes(item.state) ? item.state : 'unknown' }) })) };
  }
  async availability(options = {}) {
    const trigger = options.trigger ?? 'explicit_recheck';
    if (!['explicit_recheck', 'other_refetch'].includes(trigger)) throw new DotError('INVALID_ARGUMENT', 'trigger must be explicit_recheck or other_refetch.');
    const scope = await this.context(options);
    return availability(await this.transport.request('GET', '/backend-api/flora/browser/credential-availability', {
      query: { conversation_id: scope.conversationId, challenge_id: scope.challengeId },
      headers: { 'X-OpenAI-Cloud-Vault-Check-Trigger': trigger, 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2' }, expectedAccountId: scope.expectedAccountId, signal: scope.signal }));
  }
  async candidates(options = {}) {
    if (options.cursor != null && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 4096 || /[\0\r\n]/.test(options.cursor))) throw new DotError('INVALID_ARGUMENT', 'cursor must be a bounded opaque cursor returned by the service.');
    const scope = await this.context(options);
    return availability(await this.transport.request('POST', '/backend-api/flora/browser/credential-candidates', {
      body: { conversation_id: scope.conversationId, challenge_id: scope.challengeId, ...(options.cursor == null ? {} : { cursor: options.cursor }) },
      headers: { 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2' }, expectedAccountId: scope.expectedAccountId, signal: scope.signal }));
  }
  async reconcile(options = {}) {
    id(options.operationId, 'operationId');
    if (options.selectionId != null) id(options.selectionId, 'selectionId');
    const scope = await this.context(options);
    return operation(await this.transport.request('POST', `/backend-api/flora/browser/credential-operations/${encodeURIComponent(options.operationId)}/reconcile`, {
      body: { conversation_id: scope.conversationId, challenge_id: scope.challengeId, ...(options.selectionId == null ? {} : { selection_id: options.selectionId }) }, expectedAccountId: scope.expectedAccountId, signal: scope.signal }), options.operationId);
  }
}
