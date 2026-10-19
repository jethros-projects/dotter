import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, captureCommand, completedMarkerReply, fixtureMessage, replyEvidence, requiredStages, runStatus } from './e2e-sdk-checks.mjs';

// This opt-in harness reads the real account and may send one labeled fixture
// message and one tiny file. It never modifies primary selection or settings.
if (process.env.DOTTER_E2E_CONFIRM !== '1') {
  console.error('Live E2E is opt-in. Set DOTTER_E2E_CONFIRM=1 after reviewing scripts/e2e-sdk.mjs.');
  process.exit(2);
}

const ownRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const root = await realpath(resolve(process.env.DOTTER_E2E_PACKAGE_ROOT ?? ownRoot));
if (root !== ownRoot) {
  // Execute the installed harness in its own package scope, so bare self-import
  // exercises the real conditional root export rather than its private main file.
  let child;
  const code = await bounded(new Promise((resolveCode, reject) => {
    child = spawn(process.execPath, [join(root, 'scripts/e2e-sdk.mjs')], { stdio: 'inherit' });
    child.once('error', reject); child.once('close', code => resolveCode(code));
  }), 6 * 60_000).catch(error => { child?.kill('SIGKILL'); throw error; });
  process.exit(code ?? 1);
}
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const { createClient } = await import('@jethros-projects/dotter');
const cli = resolve(process.env.DOTTER_E2E_CLI ?? join(root, 'bin/dotter.mjs'));
const work = resolve(process.env.DOTTER_E2E_WORK_DIR ?? join(process.cwd(), 'work/e2e-sdk'));
const fixture = join(work, randomUUID());
await mkdir(fixture, { recursive: true, mode: 0o700 });
const journalFile = join(fixture, 'journal.json');
const reportFile = resolve(process.env.DOTTER_E2E_REPORT ?? join(work, 'report.json'));
async function hashTree(hash, directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await hashTree(hash, join(directory, entry.name), relative);
    else if (entry.isFile()) hash.update(relative).update('\0').update(await readFile(join(directory, entry.name))).update('\0');
  }
}
async function sourceHash() {
  const hash = createHash('sha256');
  await hashTree(hash, join(root, 'src'), 'src');
  await hashTree(hash, join(root, 'bin'), 'bin');
  for (const name of ['package.json', 'scripts/e2e-sdk.mjs', 'scripts/e2e-sdk-checks.mjs']) hash.update(name).update('\0').update(await readFile(join(root, name))).update('\0');
  return hash.digest('hex');
}
const report = {
  service: 'dotter', version: metadata.version, node: process.version,
  transport: 'node:https',
  sourceSha256: await sourceHash(),
  runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  startedAt: new Date().toISOString(), steps: [],
  cleanup: { clientClosed: false, messageFixtures: 0, uploadFixtures: 0, remoteDeletionSupported: false },
};
if (process.env.DOTTER_E2E_TARBALL) report.packageSha256 = createHash('sha256').update(await readFile(resolve(process.env.DOTTER_E2E_TARBALL))).digest('hex');
const journal = { schemaVersion: 1, sourceSha256: report.sourceSha256, root, cli, fixtures: {}, steps: [] };
const saveJournal = () => writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
const safeError = error => ({ code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'FAILED',
  ...(typeof error?.nativeCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.nativeCode) ? { nativeCode: error.nativeCode } : {}),
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
const blocked = error => ['AUTH_REQUIRED', 'AUTH_FAILED', 'UNSUPPORTED_OPERATION'].includes(error?.code)
  || ['EDGE_CHALLENGE', 'FORBIDDEN', 'FORBIDDEN_HTML', 'AUTH_REJECTED'].includes(error?.nativeCode);
async function step(name, invoke) {
  try {
    const details = await invoke();
    report.steps.push({ name, status: 'passed', ...(details ? { details } : {}) });
    journal.steps.push({ name, status: 'passed' });
    await saveJournal();
    return true;
  } catch (error) {
    if (name === 'sdk.send.readback.watch' && error?.deliveryState === 'not_sent') report.cleanup.messageFixtures = 0;
    report.steps.push({ name, status: blocked(error) ? 'blocked' : 'failed', error: safeError(error) });
    journal.steps.push({ name, status: 'failed', error: safeError(error),
      ...(error?.requestId ? { requestId: error.requestId, deliveryState: error.deliveryState } : {}),
      ...(error?.receipt ? { receipt: error.receipt } : {}) });
    await saveJournal();
    return false;
  }
}
async function runCli(args, { ndjson = false, timeoutMs = 20_000 } = {}) {
  const { exitCode, stdout } = await captureCommand(process.execPath, [cli, ...args], { timeoutMs });
  if (exitCode !== 0) {
    let parsed; try { parsed = JSON.parse(stdout); } catch {}
    throw Object.assign(new Error('The installed CLI check failed.'), {
      code: exitCode === 3 ? 'AUTH_REQUIRED' : 'OPERATION_FAILED', nativeCode: parsed?.error?.code, status: parsed?.error?.status,
    });
  }
  try { return ndjson ? stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(stdout); }
  catch { throw Object.assign(new Error('The installed CLI returned invalid JSON.'), { code: 'OPERATION_FAILED' }); }
}

const client = createClient();
let subscription, observation, roomId, primaryRoomId;
let readyToWrite = false;
try {
  const auth = await step('sdk.auth', async () => { assert.equal((await client.auth.status({ timeoutMs: 10_000 })).status, 'ready'); });
  const discovery = auth && await step('sdk.discovery', async () => {
    const target = await client.primary({ timeoutMs: 15_000 });
    primaryRoomId = target.roomId;
    roomId = process.env.DOTTER_E2E_ROOM_ID ?? target.roomId;
    assert.equal(typeof roomId, 'string');
    journal.target = { roomId, primaryDotId: target.id };
  });
  if (discovery) {
    const cliReady = await step('cli.auth.discovery', async () => {
      assert.equal((await runCli(['auth', 'status', '--json'])).status, 'ready');
      assert.equal((await runCli(['status', '--json'])).roomId, primaryRoomId);
    });
    const readReady = await step('sdk.history', async () => {
      const page = await client.history({ roomId, limit: 1 }, { timeoutMs: 15_000 });
      return { visibleMessages: page.messages.length };
    });
    readyToWrite = cliReady && readReady;
    if (readyToWrite) readyToWrite = await step('cli.history', async () => {
      const page = await runCli(['history', '--room', roomId, '--limit', '1', '--json']);
      assert.equal(page.roomId, roomId);
      assert.ok(Array.isArray(page.messages));
      return { visibleMessages: page.messages.length };
    });
  }
  if (readyToWrite) {
    readyToWrite = await step('sdk.watch.ready', async () => {
      // Includes initial history, send/readback, and the reply observation budget.
      subscription = await client.watch({ roomId, bufferSize: 128 }, { timeoutMs: 180_000 });
      assert.equal(typeof subscription.ready?.then, 'function');
      await bounded(subscription.ready, 30_000);
      return { initialSnapshotReady: true, lifetimeBudgetMs: 180_000 };
    });
  }
  if (readyToWrite) {
    const marker = `DOTTER_E2E_${randomUUID().replaceAll('-', '')}`;
    const requestId = randomUUID();
    journal.fixtures.message = { requestId, marker, status: 'prepared' };
    await saveJournal();
    const sending = await step('sdk.send.readback.watch', async () => {
      report.cleanup.messageFixtures = 'unknown';
      const sent = await client.send({ roomId, idempotencyKey: requestId,
        text: `[Dotter end-to-end test fixture] Reply with ${marker} only. This is a synthetic SDK test; do not run tools or change saved state.` }, { timeoutMs: 20_000 });
      assert.equal(sent.accepted, true); assert.equal(sent.roomId, roomId); assert.equal(sent.idempotencyKey, requestId);
      assert.equal(typeof sent.messageId, 'string'); assert.ok(sent.messageId);
      report.cleanup.messageFixtures = 1;
      journal.fixtures.message = { ...journal.fixtures.message, status: 'accepted', receipt: sent };
      await saveJournal();
      observation = (async () => {
        let observedSend = false, completedReply;
        for await (const event of subscription) {
          if (event.type !== 'message') continue;
          observedSend ||= fixtureMessage(event.message, sent.messageId, marker);
          if (completedMarkerReply(event.message, marker)) completedReply = event.message;
          if (observedSend && completedReply) return completedReply;
        }
        throw Object.assign(new Error('The fixture was not observed before the watch ended.'), { code: 'OPERATION_FAILED' });
      })();
      observation.catch(() => {});
      const page = await client.history({ roomId, around: sent.messageId, limit: 20 }, { timeoutMs: 15_000 });
      assert.equal(page.roomId, roomId); assert.ok(page.messages.some(message => fixtureMessage(message, sent.messageId, marker)));
      const cliPage = await runCli(['history', '--room', roomId, '--around', sent.messageId, '--limit', '20', '--json']);
      assert.equal(cliPage.roomId, roomId); assert.ok(cliPage.messages.some(message => fixtureMessage(message, sent.messageId, marker)));
      const observedReply = await bounded(observation, 90_000);
      const replyPage = await client.history({ roomId, around: observedReply.id, limit: 20 }, { timeoutMs: 15_000 });
      assert.equal(replyPage.roomId, roomId);
      const reply = replyPage.messages.find(message => message.id === observedReply.id && completedMarkerReply(message, marker));
      assert.ok(reply);
      const evidence = replyEvidence(reply, sent.messageId);
      journal.fixtures.reply = { messageId: reply.id, ...evidence }; await saveJournal();
      assert.notEqual(evidence.correlation, 'native_parent_mismatch');
      return { accepted: true, requestKeyMatched: true, readback: true, cliReadback: true, watchedMessage: true,
        completedReplyReadback: true, replyCorrelation: evidence.correlation,
        nativeParentPresent: evidence.nativeParentPresent, nativeParentMatched: evidence.nativeParentMatched };
    });
    await step('sdk.watch.cancel', async () => {
      await subscription.cancel(); await bounded(subscription.done, 5_000);
      await bounded(Promise.allSettled([observation].filter(Boolean)), 5_000);
      subscription = undefined;
      return { doneSettled: true, observationSettled: true };
    });
    if (sending) {
      const sent = journal.fixtures.message.receipt, replyId = journal.fixtures.reply.messageId;
      await step('sdk.search', async () => {
        const result = await client.search({ roomId, query: marker, pages: 2 }, { timeoutMs: 20_000 });
        assert.ok(result.matches.some(message => message.roomId === roomId && fixtureMessage(message, sent.messageId, marker)));
        return { exactFixtureMessageFound: true, pagesBound: 2, truncated: result.truncated };
      });
      await step('cli.search', async () => {
        const result = await runCli(['search', '--room', roomId, '--query', marker, '--pages', '2', '--json']);
        assert.ok(result.matches.some(message => message.roomId === roomId && fixtureMessage(message, sent.messageId, marker)));
        return { exactFixtureMessageFound: true, pagesBound: 2, truncated: result.truncated };
      });
      await step('cli.watch', async () => {
        const messages = await runCli(['watch', '--room', roomId, '--from-start', '--duration', '4', '--json'], { ndjson: true, timeoutMs: 15_000 });
        assert.ok(messages.some(message => fixtureMessage(message, sent.messageId, marker)));
        assert.ok(messages.some(message => message.id === replyId && completedMarkerReply({ ...message, streaming: message.inProgress }, marker)));
        return { snapshotFixtureObserved: true, completedReplyObserved: true, durationSeconds: 4, stopped: true };
      });
      for (const [name, read] of [
        ['sdk.artifacts', () => client.artifacts({ roomId, pages: 2 }, { timeoutMs: 20_000 })],
        ['cli.artifacts', () => runCli(['artifacts', '--room', roomId, '--pages', '2', '--json'])],
      ]) await step(name, async () => {
        const catalog = await read();
        assert.equal(catalog.roomId, roomId); assert.ok(Array.isArray(catalog.artifacts));
        assert.ok(Number.isInteger(catalog.pagesRead) && catalog.pagesRead >= 0 && catalog.pagesRead <= 2);
        assert.equal(typeof catalog.truncated, 'boolean');
        assert.ok(catalog.artifacts.every(item => typeof item.messageId === 'string' && typeof item.type === 'string'));
        return { artifacts: catalog.artifacts.length, typedCatalog: true, pagesRead: catalog.pagesRead, truncated: catalog.truncated };
      });
      let uploaded;
      const bytes = Buffer.from(`Dotter synthetic E2E file\n${marker}\n`);
      const source = join(fixture, 'fixture.txt'), output = join(fixture, 'download.txt');
      await step('sdk.upload.download.hash', async () => {
        assert.equal(client.capabilities().upload, true); assert.equal(client.capabilities().download, true);
        await writeFile(source, bytes, { mode: 0o600 });
        journal.fixtures.file = { status: 'prepared', sha256: createHash('sha256').update(bytes).digest('hex') };
        await saveJournal();
        report.cleanup.uploadFixtures = 'unknown';
        uploaded = await client.upload({ roomId, path: source }, { timeoutMs: 20_000 });
        assert.equal(uploaded.roomId, roomId); assert.equal(typeof uploaded.fileId, 'string'); assert.ok(uploaded.fileId);
        report.cleanup.uploadFixtures = 1;
        journal.fixtures.file = { ...journal.fixtures.file, status: 'uploaded', fileId: uploaded.fileId };
        await saveJournal();
        const saved = await client.download({ roomId, fileId: uploaded.fileId, output }, { timeoutMs: 20_000 });
        assert.equal(saved.fileId, uploaded.fileId); assert.equal(saved.output, output); assert.equal(saved.sizeBytes, bytes.length);
        const downloaded = await readFile(saved.output);
        assert.equal(createHash('sha256').update(downloaded).digest('hex'), journal.fixtures.file.sha256);
        await rm(source); await rm(output);
        return { byteLength: bytes.length, byteHashMatched: true };
      });
      if (uploaded) await step('cli.download.hash', async () => {
        const cliOutput = join(fixture, 'cli-download.txt');
        const saved = await runCli(['download', uploaded.fileId, '--room', roomId, '--output', cliOutput, '--json']);
        assert.equal(saved.fileId, uploaded.fileId); assert.equal(saved.sizeBytes, bytes.length); assert.equal(saved.path, cliOutput);
        const downloaded = await readFile(saved.path);
        assert.equal(createHash('sha256').update(downloaded).digest('hex'), journal.fixtures.file.sha256);
        await rm(cliOutput);
        return { byteLength: bytes.length, byteHashMatched: true };
      });
    }
  }
  await step('sdk.abort', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.history({ ...(roomId ? { roomId } : {}), limit: 1 }, { signal: controller.signal }), { code: 'ABORTED' });
  });
} catch (error) {
  report.steps.push({ name: 'runner.unhandled', status: 'failed', error: safeError(error) });
  journal.steps.push({ name: 'runner.unhandled', status: 'failed', error: safeError(error) });
} finally {
  await step('runner.cleanup', async () => {
    try { await bounded(subscription?.cancel(), 5_000); }
    finally {
      await bounded(client.close(), 5_000);
      report.cleanup.clientClosed = true;
    }
    await bounded(Promise.allSettled([observation].filter(Boolean)), 5_000);
  });
  await step('sdk.closed', async () => { await assert.rejects(client.history(), { code: 'CLOSED' }); });
  await step('build.unchanged', async () => { assert.equal(await sourceHash(), report.sourceSha256); });
  // The supported messaging SDK has no remote message/file deletion operation.
  // Never invent a cleanup route or delete pre-existing account resources.
  if (report.cleanup.messageFixtures || report.cleanup.uploadFixtures) report.cleanup.remoteResidue = 'labeled fixtures retained; no supported deletion operation';
  journal.cleanup = report.cleanup;
  report.finishedAt = new Date().toISOString();
  for (const name of requiredStages) {
    if (!report.steps.some(step => step.name === name)) report.steps.push({ name, status: 'skipped', reason: 'a_required_prerequisite_did_not_pass' });
  }
  report.status = runStatus(report.steps);
  await saveJournal();
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'failed' ? 1 : report.status === 'blocked' ? 3 : 0;
}
