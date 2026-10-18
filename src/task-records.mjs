import { DotError } from './errors.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
export const taskId = value => typeof value === 'string' && /^[A-Za-z0-9_.~:-]{1,1024}$/.test(value) && value !== '.' && value !== '..';
export const taskText = (value, maximum, nullable = false) => value === null ? nullable
  : typeof value === 'string' && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)
    && value.trim() !== '::SKIP_COMPLETION::';

export function taskHidden(value) {
  return !record(value) || value.deleted_at != null || value.hidden || value.is_hidden || value.is_visually_hidden_from_conversation
    || value.is_user_visible === false || value.metadata?.hidden || value.metadata?.is_hidden
    || value.metadata?.is_visually_hidden_from_conversation || value.metadata?.deleted_at != null || value.metadata?.is_user_visible === false
    || (value.channel != null && !['final', 'commentary'].includes(value.channel))
    || (value.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel))
    || (value.recipient != null && value.recipient !== 'all') || (value.metadata?.recipient != null && value.metadata.recipient !== 'all');
}

export function taskTime(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 && Number.isFinite(Date.parse(value));
}

export function taskPageCursor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new DotError('INVALID_RESPONSE', 'The task history returned an invalid pagination cursor.');
  }
  return value;
}

// The read API can omit optional summary fields. The task-state stream uses
// the same projection, but requires the complete native event schema.
export function projectTaskRecord(value, { dotId, complete = false } = {}) {
  const invalid = () => { throw new DotError('INVALID_RESPONSE', 'The API returned an invalid visible task summary.'); };
  if (!record(value)) return invalid();
  if (taskHidden(value)) return null;
  if (dotId !== undefined && own(value, 'tbo_id') && value.tbo_id !== dotId) {
    throw new DotError('IDENTITY_MISMATCH', 'The API returned a task for a different Dot.');
  }
  if (!taskId(value.id)) return invalid();
  const checks = {
    title: text => taskText(text, 1024), description: text => taskText(text, 64000, true),
    latest_update: text => taskText(text, 64000, true), emoji: text => taskText(text, 128, true),
    status: text => taskText(text, 128) && Boolean(text.trim()), created_at: taskTime, updated_at: taskTime
  };
  const result = { id: value.id };
  for (const [field, valid] of Object.entries(checks)) {
    if (!own(value, field)) { if (complete) return invalid(); continue; }
    if (!valid(value[field])) return invalid();
    result[field] = value[field];
  }
  return result;
}
