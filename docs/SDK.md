# SDK

Dotter exposes one typed client from `@jethros-projects/dotter`. The CLI and applications use
this same API. It runs directly from JavaScript modules on Node.js 22.23.4+, 24.22.1+, or
26.12.1+ within those major lines. An unsupported runtime rejects the root and
advanced imports with `UNSUPPORTED_NODE_VERSION` before credential or network
access. Update Node.js and restart the host before importing Dotter.
TypeScript declarations are included; no compilation is needed to use the SDK.
For task-oriented CLI use, see the [agent runbook](agents.md).
Core requests and polled `watch()` use native Node HTTPS. Advanced activity,
room-live, and account-summary SSE workflows retain their Python 3 bridge.

## Start with a client

```ts
import { createClient, DotterError } from '@jethros-projects/dotter';

const dot = createClient();
try {
  const page = await dot.history({ limit: 20 });
  for (const message of page.messages) console.log(message);
  const sent = await dot.send({ text: 'Summarize our next steps.' });
  console.log(sent);
} catch (error: unknown) {
  if (error instanceof DotterError) console.error(error.code, error.message);
  else throw error;
} finally {
  await dot.close();
}
```

Creating a client, importing the package, and reading `capabilities()` are offline.
They do not load credentials, open a socket, or start a browser. Each client owns
its operation lifecycle; `close()` is idempotent and does not sign you out.

## Choose the target

Message and file methods accept `roomId` or `dotId`. Without either, Dotter
resolves the primary Dot. Keep those provider identifiers in your application;
there is no invented universal conversation ID.

```ts
const primary = await dot.primary();
const dots = await dot.listDots();
const page = await dot.history({ roomId: 'room-id', limit: 20 });
const results = await dot.search({ query: 'release plan', roomId: 'room-id' });
```

`history` supports `limit` (1–20), `before`, `after`, `around`, `pages`, and `taskId`.
`search` supports `query`, `all`, `roomId`, `dotId`, `pages`, `since`, and `until`.
Opaque native cursors and arbitrary message content retain their original
semantics. Common result fields use camelCase: messages expose `streaming` and
`replyToMessageId`. The advanced API retains native `inProgress` and `replyTo`.

## Send and files

```ts
const accepted = await dot.send({
  roomId: 'room-id',
  text: 'Review these notes.',
  attachments: [{ path: './notes.txt', name: 'notes.txt', mimeType: 'text/plain' }],
});
const reply = await dot.send({
  roomId: accepted.roomId,
  replyToMessageId: accepted.messageId,
  text: 'What should I do next?',
  wait: true,
});
```

A successful send means acceptance by default (`wait: false`). Waiting is
explicit. A reply or progress update does not mean every background task is
complete. `waitTimeoutMs` bounds reply waiting separately from request timeouts.
Local attachments accept paths or `{ path, name?, mimeType? }` objects;
`attachmentIds` refers to existing service attachments. Use `replyToMessageId`
for reply context; the deprecated `replyTo` alias remains accepted, but supplying
both fields is rejected.

```ts
const upload = await dot.upload({ path: './diagram.png', roomId: 'room-id' });
const saved = await dot.download({ fileId: 'file-id', output: './download.png' });
console.log(saved.output);
const artifacts = await dot.artifacts({ roomId: 'room-id' });
```

`upload` also accepts `name`, `mimeType`, and `stateFile`. Downloads accept an
explicit `output` path and `overwrite`; without `output`, the native filename
is used. The saved local path is returned as `saved.output`; the deprecated
`path` result alias remains available. There is no automatic retry of a write
after uncertain delivery; retain the error's request or receipt details.

## Follow a conversation

```ts
const subscription = await dot.watch({ roomId: 'room-id', bufferSize: 128 });
try {
  await subscription.ready;
  for await (const event of subscription) {
    if (event.type === 'message') console.log(event.message);
  }
} finally {
  await subscription.cancel();
  await subscription.done;
}
```

`watch()` returns a `Promise<Subscription<WatchEvent>>`. A subscription is an
async iterable with `cancel()`, `done`, `ready`, and a read-only cursor. The event
union includes `message`, `ready` (room and initial message count), and `cursor`
(room and anchor). Buffers are bounded. Overflow reports `RESYNC_REQUIRED` so a
client can reload history instead of silently losing messages.

Options include `all`, `intervalMs`, `fromStart`, `resumeAfter`, and `cursorFile`.
Cancellation settles the stream and `done`; service failures are observable
through iteration and `done`. Save a supported cursor to resume, and reload
history when continuity cannot be guaranteed.

## Authentication belongs to the host

The default provider loads an existing Codex cache only when an operation needs
it. It reads `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default. Select
another cache with `createClient({ authFile: '/path/to/auth.json' })`.

```ts
const dot = createClient({ authFile: '/path/to/auth.json' });
const status = await dot.auth.status();
```

`auth.status()` is an explicit operation. Applications can supply the typed
`ClientOptions.auth` provider with `load({ authFile, signal })` to manage their
own credential lifecycle. The SDK never launches interactive login during
construction. The CLI's explicit login, refresh, and logout commands delegate
to Codex; logout affects the shared Codex session.

For existing installations, replace the former `dot-chat` executable name with
`dotter`. Command arguments and authentication remain compatible. Browser-auth
claims keep their existing `dot-cli` storage directory; `DOTTER_STATE_DIR` takes
precedence over the legacy `DOT_CLI_STATE_DIR` override.

Keep credentials and the SDK in a trusted Node process or backend. Browser and
mobile UIs should call that host through their own authenticated bridge. Do not
send provider credentials into a renderer or bundle this Node SDK into a page.

## Cancellation, timeouts, and ownership

```ts
const controller = new AbortController();
const dot = createClient({ requestTimeoutMs: 30_000 });
try {
  const page = await dot.history({ limit: 20 }, {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  console.log(page);
} finally {
  await dot.close();
}
```

`requestTimeoutMs` defaults to 30 seconds per native network request and accepts
1–600,000 milliseconds. An explicit
`RequestOptions.timeoutMs` bounds the entire operation, including startup,
authentication, connection waits, and active requests. For `watch`, an explicit
timeout also bounds the subscription lifetime. `close()` cancels the client's
pending operations and subscriptions. Subsequent operations fail with `CLOSED`. Injected transports
remain caller-owned unless you explicitly transfer ownership; consult the
`ClientOptions` declaration for the injection contract.

The default transport lazily creates a bounded Node HTTPS connection pool and
reuses connections and TLS sessions. `close()` releases that pool. An explicit
advanced `Transport` also has `close()`; a supplied `fetchImpl` remains
caller-owned. Connection reuse does not retry requests or bypass service gates.

## Handle errors by code

`DotterError` has a stable `code` and a safe message. Depending on the failure,
`status`, `requestId`, `receipt`, or `deliveryState` supplies additional context.
Use the exported `ErrorCode` type instead of parsing message text. Common
categories include `INVALID_ARGUMENT`, `AUTH_REQUIRED`, `AUTH_FAILED`,
`UNSUPPORTED_OPERATION`, `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`, `CLOSED`,
`RESYNC_REQUIRED`, and `OPERATION_FAILED`.

Unsupported or invalid operations fail before credentials, files, or the network
are accessed. Send errors caused by cancellation, timeouts, or closing the
client preserve `requestId` and `deliveryState`: `not_sent`, `unknown`, or
`accepted`. If acceptance is known, `receipt` contains the accepted result.
Inspect history before retrying; a timeout or disconnected client does not
establish that the message was never accepted. The SDK does not automatically
replay a write.

## Public names and advanced APIs

The root exports `createClient`, `DotterClient`, `DotterError`, and types including
`ClientOptions`, `RequestOptions`, `SendInput`, `SendResult`, `HistoryInput`,
`HistoryPage`, `WatchInput`, `WatchEvent`, `Subscription`, `Message`, and
`Capabilities`. The same naming conventions are used by Botter and Muser, while
target identifiers and supported features stay service-specific.

`capabilities()` describes the implemented surface without credentials or a
service request. Its `upload` and `download` flags reflect the injected
transport's multipart and binary request support. Missing transport support
fails with `UNSUPPORTED_OPERATION` before file, authentication, or account
access. Actual service availability still depends on your account and the
upstream service.

The existing service-specific clients are an explicit lower-level entrypoint:

```ts
import { DotClient, FullDotClient } from '@jethros-projects/dotter/advanced';
```

Move previous root imports of `DotClient`, `FullDotClient`, `Transport`, or other
specialist helpers to `@jethros-projects/dotter/advanced`. The root deliberately exposes a
small client contract. The advanced entrypoint preserves native names and
provider data shapes; it is intended for integrations that understand those
contracts. It does not turn unverified upstream operations into supported ones.

## Opt-in live verification

Review [`scripts/e2e-sdk.mjs`](../scripts/e2e-sdk.mjs) before running it against a
real account. From the checkout, run `DOTTER_E2E_CONFIRM=1 npm run test:e2e`.
The harness checks authentication, discovery, history and installed-CLI reads
before sending one labeled message and uploading one tiny synthetic file.
Confirmed edge challenges stop the flow; no fixture writes follow a blocked
read preflight. It never changes primary selection, settings, or routines.

To verify an installed release, set `DOTTER_E2E_PACKAGE_ROOT` to its package
directory and `DOTTER_E2E_CLI` to its installed executable. Optional
`DOTTER_E2E_TARBALL` binds the report to an archive SHA-256. Use
`DOTTER_E2E_WORK_DIR` and `DOTTER_E2E_REPORT` to choose local evidence paths.
`DOTTER_E2E_ROOM_ID` explicitly selects a room instead of the primary Dot.

The public report contains build hashes, step statuses, and fixture counts.
Private IDs and receipts stay in a mode-0600 journal under `work/e2e-sdk/` by
default. The supported messaging API has no message/file deletion operation;
accepted fixtures remain labeled and are reported as residue. A skipped or
blocked step is not live verification of that feature.
