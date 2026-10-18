import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const HELP = 'Enter a message to send. /attach PATH queues a file for the next message. /help shows this help. /quit exits.\n';

// Remote messages should not be able to send terminal control sequences.
function printable(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function assistantText(message) {
  if (!message || message.role !== 'assistant' || message.hidden || message.is_hidden
    || message.deletedAt || message.deleted_at
    || (message.channel && !['final', 'commentary'].includes(message.channel))
    || (message.recipient && message.recipient !== 'all')
    || message.metadata?.hidden || message.metadata?.is_hidden
    || message.metadata?.is_visually_hidden_from_conversation) return null;
  const text = typeof message.text === 'string' ? message.text : '';
  if (text.trim() === '::SKIP_COMPLETION::') return null;
  const attachments = (message.attachments ?? []).map(file => `[attachment: ${file.name || file.fileId || file.type || 'file'}]`);
  const body = [text, ...attachments].filter(Boolean).join('\n');
  return body ? printable(body) : null;
}

/** Interactively send only entered lines, while reading visible Dot replies. */
export async function runChat(client, {
  roomId, input = process.stdin, output = process.stdout, error = process.stderr,
  signal, intervalMs = 5000, signals = process,
} = {}) {
  if (signal?.aborted) return { sentCount: 0, reason: 'aborted' };
  const controller = new AbortController();
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output: terminal ? output : undefined, terminal, crlfDelay: Infinity });
  // Register the iterator before asynchronous work so piped input is buffered.
  const lines = rl[Symbol.asyncIterator]();
  const queuedFiles = [];
  let sentCount = 0, reason = 'eof', watchError;
  const stop = () => { controller.abort(); rl.close(); };
  const abort = () => { reason = 'aborted'; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  signals.once('SIGINT', abort); signals.once('SIGTERM', abort);
  rl.once('SIGINT', abort);
  const prompt = () => { if (!controller.signal.aborted) output.write('You> '); };
  const watch = Promise.resolve().then(() => client.watch({
    roomId, intervalMs, signal: controller.signal,
    onMessage(message) {
      if (controller.signal.aborted) return;
      const body = assistantText(message);
      if (body == null) return;
      output.write(`\nDot${message.inProgress ? ' (updating)' : ''}> ${body}\n`);
      prompt();
    },
  })).catch(cause => {
    if (!controller.signal.aborted) { watchError = cause; stop(); }
  });
  output.write(HELP);
  prompt();
  try {
    for (;;) {
      const next = await lines.next();
      if (next.done || controller.signal.aborted) break;
      const text = next.value;
      // A leading space is the documented escape for a literal slash message.
      const command = text.trimEnd();
      if (command === '/quit') { reason = 'quit'; break; }
      if (command === '/help') { output.write(HELP); prompt(); continue; }
      if (/^\/attach(?:\s|$)/.test(text)) {
        let file = text.slice('/attach'.length).trim();
        if (file.length >= 2 && ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'")))) file = file.slice(1, -1);
        if (!file || file.includes('\0')) error.write('Use /attach PATH to queue a local file.\n');
        else { queuedFiles.push(file); output.write(`Queued attachment: ${printable(file)}\n`); }
        prompt(); continue;
      }
      if (text.startsWith('/')) { error.write('Unknown command. Use /help or prefix a message with a space to send a literal slash.\n'); prompt(); continue; }
      if (!text.trim()) { prompt(); continue; }
      const idempotencyKey = randomUUID();
      // The key is displayed before any upload or send can reach the service.
      error.write(`Request key: ${idempotencyKey}\n`);
      // Clear once attempted: an uncertain send must never reuse attachments
      // implicitly, nor re-send a line without a fresh explicit user action.
      const files = queuedFiles.splice(0);
      try {
        await client.send({ roomId, text, files, idempotencyKey, signal: controller.signal });
        sentCount++;
      } catch (cause) {
        if (controller.signal.aborted) break;
        error.write(`Send failed: ${printable(cause?.message || 'Unknown error')}. Check history before retrying; request key ${idempotencyKey}.\n`);
      }
      prompt();
    }
  } finally {
    stop();
    signal?.removeEventListener('abort', abort);
    signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort);
    rl.removeListener('SIGINT', abort);
    await watch;
  }
  if (watchError) throw watchError;
  return { sentCount, reason };
}
