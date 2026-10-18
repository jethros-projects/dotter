import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// Native writing-block mail contract, writing-block-app-capabilities-dbd4f1709b5d.js.
// This is connected Gmail/Outlook mail, distinct from the read-only Botmail cards.
const ROOT = '/backend-api/aip/connectors';
const HEADERS = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'writing_blocks' };
export const mailProviders = Object.freeze({
  gmail: { connectorId: 'connector_2128aebfecb84f64a069897515042a44', scope: 'https://www.googleapis.com/auth/gmail.modify' },
  outlook: { connectorId: 'connector_4aaab2856305417b993eca9a216aaf6e', scope: 'mail.send' }
});
const CONTACTS = 'connector_c0f748249d6a42aea4b00fd375570ded';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message, details) { throw new DotError(code, message, details); }
function text(value, name, max = 4096, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', `${name} must be text of at most ${max} characters.`);
  return value;
}
function identifier(value, name) { text(value, name, 1024); if (!/^[A-Za-z0-9][A-Za-z0-9_.:~-]*$/.test(value)) fail('INVALID_ARGUMENT', `Use a valid ${name}.`); return value; }
function sendId(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_ARGUMENT', 'sendId must be a UUID from the original send attempt.'); return value; }
function addresses(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail('INVALID_ARGUMENT', `${name} must be an array of at most 100 email addresses.`);
  return [...new Set(value.map(entry => {
    text(entry, name, 254);
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(entry)) fail('INVALID_ARGUMENT', `${name} contains an invalid email address.`);
    return entry;
  }))];
}
function availableLink(link) { return isObject(link) && link.visibility !== 'HIDDEN' && !String(link.id).startsWith('implicit_link::'); }
function publicAccount(link, provider) {
  const required = mailProviders[provider]?.scope;
  return { linkId: link.id, provider, name: typeof link.name === 'string' ? link.name : null,
    email: typeof link.owner_profile?.email === 'string' ? link.owner_profile.email : null,
    connected: link.auth_status === 'ACTIVE' && !link.unavailable_reason && link.connector_status !== 'DISABLED_BY_ADMIN',
    hasSendScope: Array.isArray(link.scopes) && link.scopes.some(scope => typeof scope === 'string' && scope.trim().toLowerCase() === required) };
}
export class DotMail {
  constructor(client, { now = Date.now } = {}) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotMail requires a DotClient.');
    this.transport = client.transport; this.now = now;
  }
  async account(expectedAccountId) {
    if (expectedAccountId !== undefined) identifier(expectedAccountId, 'account ID');
    if (typeof this.transport.authLoader !== 'function') {
      if (!expectedAccountId) fail('AUTH_ACCOUNT_REQUIRED', 'Choose the account ID for connected mail.');
      return expectedAccountId;
    }
    const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
    if (!auth.accountId) fail('AUTH_ACCOUNT_REQUIRED', 'Connected mail requires an explicit Codex account selector.');
    if (expectedAccountId !== undefined && auth.accountId !== expectedAccountId) fail('ACCOUNT_CHANGED', 'The Codex account differs from the selected mail account.');
    this.transport.assertIdentity?.(auth);
    return auth.accountId;
  }
  request(method, route, options, accountId) { return this.transport.request(method, ROOT + route, { ...options, headers: HEADERS, expectedAccountId: accountId }); }
  async links(accountId, signal) {
    const value = await this.request('POST', '/links/list_accessible', { body: { principals: [], link_refresh_strategy: 'BLOCKING' }, signal }, accountId);
    if (!Array.isArray(value?.links)) fail('INVALID_RESPONSE', 'The connection catalog did not contain links.');
    return value.links.filter(availableLink);
  }
  async provider(provider, accountId, signal) {
    if (!Object.hasOwn(mailProviders, provider)) fail('INVALID_ARGUMENT', 'Mail provider must be gmail or outlook.');
    const connectorId = mailProviders[provider].connectorId;
    const value = await this.request('GET', `/${connectorId}`, { query: { include_actions: true }, signal }, accountId);
    if (value?.id !== connectorId || !Array.isArray(value.actions)) fail('INVALID_RESPONSE', 'The mail connector did not match the selected provider.');
    if (value.status === 'DISABLED_BY_ADMIN' || !value.actions.some(action => typeof action.name === 'string' && action.name.trim().toLowerCase() === 'send_email' && action.is_enabled !== false)) fail('MAIL_UNAVAILABLE', 'This provider does not currently allow the send_email action.');
    return value;
  }
  async accounts({ expectedAccountId, signal } = {}) {
    const accountId = await this.account(expectedAccountId);
    const links = await this.links(accountId, signal);
    return { accountId, accounts: links.flatMap(link => {
      const provider = Object.keys(mailProviders).find(key => mailProviders[key].connectorId === link.connector_id);
      return provider ? [publicAccount(link, provider)] : [];
    }), contacts: links.filter(link => link.connector_id === CONTACTS).map(link => ({ linkId: link.id, email: link.owner_profile?.email ?? null, connected: link.auth_status === 'ACTIVE' && !link.unavailable_reason })) };
  }
  async send({ provider, linkId, to, cc, bcc, subject, body, sendId: requestId = randomUUID(), replyTo, sourceId, sourceType, expectedAccountId, signal } = {}) {
    if (!Object.hasOwn(mailProviders, provider)) fail('INVALID_ARGUMENT', 'Mail provider must be gmail or outlook.');
    identifier(linkId, 'link ID'); sendId(requestId);
    const recipients = { to: addresses(to, 'to'), cc: addresses(cc, 'cc'), bcc: addresses(bcc, 'bcc') };
    if (!Object.values(recipients).some(list => list.length)) fail('INVALID_ARGUMENT', 'At least one email recipient is required.');
    text(subject, 'subject', 1000, true); if (/[\r\n]/.test(subject)) fail('INVALID_ARGUMENT', 'The subject must be one line.'); text(body, 'body', 1000000, true);
    if (sourceId !== undefined) identifier(sourceId, 'source ID');
    if (sourceType !== undefined) text(sourceType, 'source type', 100);
    if (replyTo !== undefined && (!isObject(replyTo) || replyTo.provider !== provider || replyTo.type !== 'reply')) fail('INVALID_ARGUMENT', 'A reply must name the same provider and use type reply.');
    if (replyTo !== undefined) identifier(replyTo.referenceMessageId, 'reply reference message ID');
    const accountId = await this.account(expectedAccountId);
    await this.provider(provider, accountId, signal);
    const link = (await this.links(accountId, signal)).find(link => link.id === linkId && link.connector_id === mailProviders[provider].connectorId);
    if (!link) fail('MAIL_UNAVAILABLE', 'The selected sender link is not accessible for this provider.');
    const selected = publicAccount(link, provider);
    if (!selected.connected || !selected.hasSendScope) fail('MAIL_UNAVAILABLE', 'The sender link needs active authentication and the required send scope.');
    signal?.throwIfAborted();
    const request = { send_id: requestId, link_id: linkId, ...recipients, subject, body,
      ...(sourceId === undefined ? {} : { source_id: sourceId }), ...(sourceType === undefined ? {} : { source_type: sourceType }),
      ...(replyTo === undefined ? {} : { email_action: 'reply', reference_message_id: replyTo.referenceMessageId }) };
    const result = await this.request('POST', '/email/send_email', { body: request, signal, idempotencyKey: requestId }, accountId);
    if (result?.send_id !== requestId) fail('MAIL_UNCONFIRMED', 'The send response did not confirm the original send ID. Query its status before taking further action.', { sendId: requestId, delivery: 'unknown' });
    if (result.unsend_expires_at != null && !Number.isFinite(Date.parse(result.unsend_expires_at))) fail('INVALID_RESPONSE', 'The send response contained an invalid undo deadline.', { sendId: requestId, delivery: 'unknown' });
    return { accountId, provider, linkId, sendId: requestId, status: 'accepted', unsendExpiresAt: result.unsend_expires_at ?? null };
  }
  async status({ sendId: requestId, expectedAccountId, signal } = {}) {
    sendId(requestId); const accountId = await this.account(expectedAccountId);
    const value = await this.request('POST', '/email/send_email_status', { body: { send_id: requestId }, signal }, accountId);
    if (!['pending', 'sending', 'sent', 'send_failed', 'unsent'].includes(value?.status)) fail('INVALID_RESPONSE', 'The email status response was unrecognized.');
    return { accountId, sendId: requestId, status: value.status };
  }
  async undo({ sendId: requestId, unsendExpiresAt, expectedAccountId, signal } = {}) {
    sendId(requestId);
    const deadline = Date.parse(unsendExpiresAt);
    if (!Number.isFinite(deadline) || deadline <= this.now()) fail('UNDO_EXPIRED', 'Use the unexpired unsendExpiresAt returned by the original send.');
    const accountId = await this.account(expectedAccountId);
    signal?.throwIfAborted();
    await this.request('POST', '/email/unsend_email', { body: { send_id: requestId }, signal }, accountId);
    return { accountId, sendId: requestId, status: 'undo_requested' };
  }
  async contacts({ linkId, query, expectedAccountId, signal } = {}) {
    identifier(linkId, 'contacts link ID'); text(query, 'contact query', 1000);
    const accountId = await this.account(expectedAccountId);
    const link = (await this.links(accountId, signal)).find(link => link.id === linkId && link.connector_id === CONTACTS);
    if (!link || link.auth_status !== 'ACTIVE' || link.unavailable_reason) fail('MAIL_UNAVAILABLE', 'That contacts link is not currently accessible and authenticated.');
    const value = await this.request('POST', '/google_contacts/search_contacts', { body: { limit: 10, link_id: linkId, query }, signal }, accountId);
    if (!Array.isArray(value?.contacts)) fail('INVALID_RESPONSE', 'The contact search did not return contacts.');
    return { accountId, contacts: value.contacts.filter(contact => isObject(contact) && typeof contact.email === 'string' && contact.email.trim()).map(contact => Object.fromEntries(['id', 'name', 'email'].filter(key => typeof contact[key] === 'string').map(key => [key, contact[key].trim()]))) };
  }
}
