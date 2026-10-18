import { DotError } from './errors.mjs';

// The native response supplies an opaque topic_id. Keep the direct command's
// existing 4096-character bound for both readers; never relabel a topic whose
// optional server-provided room or task identity contradicts the request.
export function taskSubscriptionTopic(value, { roomId, taskId }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.topic_id !== 'string' || !value.topic_id.length || value.topic_id.length > 4096
      || /[\x00-\x1f\x7f-\x9f]/.test(value.topic_id)) {
    throw new DotError('INVALID_RESPONSE', 'The task subscription did not return a valid topic ID.');
  }
  if (value.room_id != null && value.room_id !== roomId || value.task_id != null && value.task_id !== taskId) {
    throw new DotError('IDENTITY_MISMATCH', 'The task subscription belongs to a different task or room.');
  }
  return value.topic_id;
}
