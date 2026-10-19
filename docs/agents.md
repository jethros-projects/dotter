# Dotter for agents

Use Dotter to bring an existing Dot conversation into a task, send a specific
question or file, and follow visible replies. For application code, start with
the [SDK guide](SDK.md). For repository changes, read [AGENTS.md](../AGENTS.md).

## Discover before choosing an operation

```sh
dotter --help
dotter help send
dotter library --help
dotter routine --help
dotter account projects --help
dotter capabilities
```

Help and capabilities work offline. Capability metadata describes implemented
contracts; it does not establish live eligibility. Read the selected command's
help and [service boundaries](contracts.md) for account scope and known gates.
Advanced imports preserve provider contracts and verification limits.

## Authentication and target discovery

```sh
dotter auth status --json
dotter status --json
dotter dots --json
```

The host needs Node.js 22+ and a Codex CLI ChatGPT login with Dot access.
Advanced SSE workflows also need Python 3. If the login is unavailable, `dotter auth login`
starts the explicit Codex login flow. API-key authentication is unsupported.

`status` reads the primary Dot; `dots` lists discovered Dots. Use a returned
`roomId` with `--room ID` for message/file commands. A Dot's `id`, its `roomId`,
a ChatGPT conversation ID, and an account ID are different identifiers.
Account operations use `--account ACCOUNT_ID`; obtain `accountId` from
`auth status`. Do not guess IDs or derive them from names.

## A bounded read → send → follow workflow

The commands below use the primary Dot. Supply an existing regular file at
`./notes.txt` before sending; room attachments accept 1 byte to 20 MiB, up to
ten attachments per message.

```sh
dotter history --limit 20 --json
dotter send "Turn these notes into a plan for tomorrow" --attach ./notes.txt --wait 30 --json
dotter watch --from-start --duration 30 --json
dotter artifacts --pages 2 --json
```

`send` normally returns acceptance. `--wait 30` observes later assistant messages
for at most 30 seconds; a reply is not proof of background task completion.
Concurrent room activity can include replies unrelated to that send.
`watch --from-start` includes the current snapshot, then new messages and edits;
repeated records are possible. `--duration` bounds the watch; Ctrl+C also stops it.
History defaults to 20 messages, with `--limit 1..20` and `--pages 1..100`.

To find earlier context, scan a bounded number of history pages:

```sh
dotter search --query "release plan" --pages 2 --json
```

Use a real `fileId` returned by `artifacts` or `upload` in the next command;
`FILE_ID` is a placeholder, not a valid resource to invent:

```sh
dotter download FILE_ID --output ./received.txt --json
```

For attachment reuse, `dotter upload ./notes.txt --json` returns a file ID for
`send --attachment-id ID`; a fresh `--attach` attempt can upload the file again.
Room uploads and Library file IDs have different scopes. Run `dotter help upload`
and `dotter help download` before selecting another transfer workflow.

## Machine output and recovery

Most commands emit JSON. Add `--json` for basic history/watch and error output;
watch emits one message per line (NDJSON). Parse stdout separately from stderr:
sends print their request key on stderr. JSON errors contain an `error` object;
`auth status` can return `status: "unavailable"` with an error and exit 3.

| Exit | Meaning |
| --- | --- |
| 0 | Successful command |
| 2 | CLI usage error |
| 3 | Authentication or login problem |
| 4 | Permission, forbidden, or edge rejection |
| 5 | Network failure or timeout |
| 1 | Other failure |

CLI errors can retain native codes. SDK code uses `DotterError.code`; do not
parse human messages. After an uncertain write, keep the request key/receipt,
inspect targeted history or the operation's recovery command, and reconcile
before sending again. There is no automatic write retry. Read exact resource
confirmation flags from help for commands that require them.

## Building an agent client

Use `createClient()` from `@jethros-projects/dotter`. Construction and `capabilities()` are
offline; `client.auth.status()` explicitly checks the host login. Choose
`roomId` or `dotId`, or omit both for the primary Dot. Pass cancellation and a
whole-operation deadline as the second argument, such as
`{ signal, timeoutMs: 10_000 }`. Always `await client.close()` in `finally`;
closing never logs the account out.

SDK sends default to `wait: false`; `wait: true` and `waitTimeoutMs` are explicit.
Messages use `streaming` and `replyToMessageId`. File downloads return `output`.
`await client.watch()` returns an async iterable with `ready`, `done`, `cancel()`, and a native
cursor advanced on consumption. Cancel it when leaving the loop. Cancellation
before readiness rejects `ready`; overflow reports `RESYNC_REQUIRED`. Reload
history and restart when continuity is lost; cursor replay is at-least-once.
Send errors can include `requestId`, `deliveryState`, and an accepted `receipt`.
Keep credentials in a trusted Node host, behind an authenticated API/IPC bridge.
