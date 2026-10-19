import { spawn } from 'node:child_process';

export const requiredStages = Object.freeze([
  'sdk.auth', 'sdk.discovery', 'cli.auth.discovery', 'sdk.history', 'cli.history',
  'sdk.watch.ready', 'sdk.send.readback.watch', 'sdk.search', 'cli.search', 'sdk.artifacts', 'cli.artifacts',
  'cli.watch', 'sdk.watch.cancel', 'sdk.upload.download.hash', 'cli.download.hash',
  'sdk.abort', 'runner.cleanup', 'sdk.closed', 'build.unchanged',
]);

const failure = code => Object.assign(new Error('The bounded verification check failed.'), { code });

export function runStatus(steps) {
  if (steps.some(step => step.status === 'failed')) return 'failed';
  if (steps.some(step => step.status === 'blocked')) return 'blocked';
  return requiredStages.every(name => steps.some(step => step.name === name && step.status === 'passed')) ? 'passed' : 'failed';
}

export function fixtureMessage(message, messageId, marker) {
  return message?.id === messageId && message.role === 'user' && typeof message.text === 'string' && message.text.includes(marker);
}

export function completedMarkerReply(message, marker) {
  return typeof message?.id === 'string' && message.role === 'assistant' && message.streaming === false
    && typeof message.text === 'string' && message.text.includes(marker);
}

export function replyEvidence(message, messageId) {
  const nativeParents = Object.fromEntries(['replyToMessageId', 'replyRootMessageId']
    .filter(key => typeof message[key] === 'string' && message[key]).map(key => [key, message[key]]));
  const nativeParentPresent = Object.keys(nativeParents).length > 0;
  const nativeParentMatched = Object.values(nativeParents).includes(messageId);
  return { nativeParents, nativeParentPresent, nativeParentMatched,
    correlation: nativeParentMatched ? 'native_parent_link_and_unique_marker'
      : nativeParentPresent ? 'native_parent_mismatch' : 'unique_marker_no_native_parent_link' };
}

export async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('TIMEOUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Private subprocess output is bounded and never copied into an exception. */
export function captureCommand(executable, args, { timeoutMs = 20_000, maxOutputBytes = 1024 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, outputBytes = 0, errorBytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        try { child?.kill('SIGKILL'); } catch {}
        reject(error);
      } else resolve(result);
    };
    timer = setTimeout(() => finish(failure('TIMEOUT')), timeoutMs);
    try { child = spawnImpl(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(failure('OPERATION_FAILED')); return; }
    child.once('error', () => finish(failure('OPERATION_FAILED')));
    child.stdout.on('error', () => finish(failure('OPERATION_FAILED')));
    child.stderr.on('error', () => finish(failure('OPERATION_FAILED')));
    child.stdout.on('data', bytes => {
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) finish(failure('OUTPUT_TOO_LARGE'));
      else if (!settled) chunks.push(Buffer.from(bytes));
    });
    child.stderr.on('data', bytes => {
      errorBytes += bytes.length;
      if (errorBytes > maxOutputBytes) finish(failure('OUTPUT_TOO_LARGE'));
    });
    child.once('close', code => finish(undefined, { exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}
