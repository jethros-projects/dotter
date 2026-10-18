import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// Exact contracts from the installed app's state-2797f6ca8d5e,
// dialog-1ac8a91c160e and control-3e880dfb568c assets (2026-10-17).
const ID = /^[a-zA-Z0-9_.~:-]{1,1024}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_PART = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${name} must be an ID returned by the API.`);
  return value;
}
function object(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DotError('INVALID_RESPONSE', 'The channel API returned an unexpected response shape.');
  }
  return value;
}
function fields(value, names) {
  object(value);
  return Object.fromEntries(names.filter(name => Object.hasOwn(value, name)
    && (value[name] === null || ['string', 'number', 'boolean'].includes(typeof value[name])))
    .map(name => [name, value[name]]));
}
function safeInbox(value) {
  return fields(value, ['inbox_id', 'email_address', 'status', 'narrow_email_consent_version']);
}
function statusResponse(value) {
  object(value);
  if (!['linked', 'unlinked'].includes(value.status)) {
    throw new DotError('INVALID_RESPONSE', 'The email channel response did not contain a recognized status. Check email status before retrying a change.');
  }
  return safeInbox(value);
}
function mutationStatus(value) {
  try { return statusResponse(value); }
  catch (error) {
    if (error instanceof DotError) error.details = { ...error.details, delivery: 'unknown' };
    throw error;
  }
}
function optionsResponse(value) {
  object(value);
  if (!Array.isArray(value.available_domains) || !Array.isArray(value.inboxes)
    || typeof value.narrow_email_enabled !== 'boolean') {
    throw new DotError('INVALID_RESPONSE', 'The email options response did not contain eligibility, domains, and inboxes.');
  }
  const result = fields(value, ['default_domain', 'narrow_email_enabled', 'auto_allocate_work_address', 'suggested_email_address']);
  result.available_domains = value.available_domains.filter(domain => typeof domain === 'string' && DOMAIN.test(domain));
  result.inboxes = value.inboxes.map(safeInbox);
  if (value.current_claim != null) result.current_claim = safeInbox(value.current_claim);
  return result;
}
function consent(acceptedConsent) {
  if (acceptedConsent !== true) {
    throw new DotError('EMAIL_CONSENT_REQUIRED', 'Claiming or linking a Dot email address requires explicit acceptance of email consent version 1. Pass acceptedConsent: true after reviewing the email setup consent.');
  }
}
function enabled(options) {
  if (!options.narrow_email_enabled) throw new DotError('EMAIL_UNAVAILABLE', 'Email setup is not enabled for this Dot or workspace.');
}
function normalizeMeetingUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('meetingUrl must be a Google Meet link or meeting code.');
  // Match the app exactly: HTTP, alternate hosts, fragments and other meeting
  // providers are not supported; harmless query parameters are discarded.
  const match = /^(?:https:\/\/meet\.google\.com\/|meet\.google\.com\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/)?(?:\?[^\s]*)?$/.exec(value.trim());
  if (!match) fail('meetingUrl must be a Google Meet link such as https://meet.google.com/abc-defg-hij.');
  return `https://meet.google.com/${match[1]}`;
}

export class DotChannels {
  constructor(client) {
    if (!client?.transport?.request || typeof client.primary !== 'function') throw new TypeError('DotChannels requires a Dot client.');
    this.client = client;
    this.transport = client.transport;
  }

  async resolveDot(dotId, signal) {
    if (dotId != null) return identifier(dotId, 'dotId');
    const primary = await this.client.primary({ signal });
    if (!primary?.id) throw new DotError('DOT_UNAVAILABLE', 'No primary Dot is available. Specify dotId from the Dot list.');
    return identifier(primary.id, 'dotId');
  }

  async emailStatus({ dotId, signal } = {}) {
    const selected = await this.resolveDot(dotId, signal);
    return statusResponse(await this.transport.request('GET', `/backend-api/tbo/${selected}/channels/email`, { signal }));
  }

  async emailOptions({ dotId, signal } = {}) {
    const selected = await this.resolveDot(dotId, signal);
    return optionsResponse(await this.transport.request('GET', `/backend-api/tbo/${selected}/channels/email/options`, { signal }));
  }

  async claimEmail({ dotId, localPart, domain, acceptedConsent, signal } = {}) {
    consent(acceptedConsent);
    if (typeof localPart !== 'string' || localPart.length > 64 || !LOCAL_PART.test(localPart)) {
      fail('localPart must contain lowercase letters, digits, hyphens, and single interior dots.');
    }
    if (typeof domain !== 'string' || !DOMAIN.test(domain)) fail('domain must be a lowercase email domain returned by emailOptions.');
    const selected = await this.resolveDot(dotId, signal);
    const options = await this.emailOptions({ dotId: selected, signal });
    enabled(options);
    const fixed = options.current_claim?.email_address
      ?? (options.auto_allocate_work_address ? options.suggested_email_address : undefined);
    if (fixed != null && `${localPart}@${domain}` !== fixed) {
      throw new DotError('EMAIL_ADDRESS_FIXED', 'The server has assigned an email address. Use the current or suggested address returned by emailOptions.');
    }
    if (fixed == null && !options.available_domains.includes(domain)) {
      throw new DotError('EMAIL_DOMAIN_UNAVAILABLE', 'The selected email domain is not available for this Dot.');
    }
    if (fixed == null && localPart.length > 30) fail('A custom email localPart must contain 1 to 30 characters.');
    return mutationStatus(await this.transport.request('POST', `/backend-api/tbo/${selected}/channels/email/claim`, {
      body: { local_part: localPart, domain, narrow_email_consent_version: 1 }, signal
    }));
  }

  async linkEmail({ dotId, inboxId, acceptedConsent, signal } = {}) {
    consent(acceptedConsent);
    identifier(inboxId, 'inboxId');
    const selected = await this.resolveDot(dotId, signal);
    const options = await this.emailOptions({ dotId: selected, signal });
    enabled(options);
    // A currently linked inbox may need its consent version renewed; the app
    // supports this even when it is absent from the list of unlinked inboxes.
    if (!options.inboxes.some(inbox => inbox.inbox_id === inboxId)) {
      const current = await this.emailStatus({ dotId: selected, signal });
      if (current.status !== 'linked' || current.inbox_id !== inboxId) {
        throw new DotError('EMAIL_INBOX_UNAVAILABLE', 'The selected inbox is not an available owned inbox or the current linked inbox.');
      }
    }
    return mutationStatus(await this.transport.request('PUT', `/backend-api/tbo/${selected}/channels/email`, {
      body: { inbox_id: inboxId, narrow_email_consent_version: 1 }, signal
    }));
  }

  async removeEmail({ dotId, signal } = {}) {
    const selected = await this.resolveDot(dotId, signal);
    await this.transport.request('DELETE', `/backend-api/tbo/${selected}/channels/email`, { signal });
    return { status: 'unlinked', dotId: selected };
  }

  async startMeeting({ dotId, meetingUrl, idempotencyKey = randomUUID(), signal } = {}) {
    const normalizedUrl = normalizeMeetingUrl(meetingUrl);
    if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) fail('idempotencyKey must be a UUID.');
    const selected = await this.resolveDot(dotId, signal);
    const response = await this.transport.request('POST', `/backend-api/tbo/${selected}/meeting-sessions`, {
      body: { meeting_url: normalizedUrl }, headers: { 'Idempotency-Key': idempotencyKey }, idempotencyKey, signal
    });
    // Successful invitation is not evidence that the Dot has joined the call.
    // Never return arbitrary response objects containing provider credentials.
    let session;
    try { session = fields(response, ['id', 'meeting_session_id', 'status', 'created_at', 'updated_at']); }
    catch (error) {
      if (error instanceof DotError) error.details = { ...error.details, delivery: 'unknown', idempotencyKey };
      throw error;
    }
    return { status: 'accepted', dotId: selected, meetingUrl: normalizedUrl, idempotencyKey, session };
  }
}
