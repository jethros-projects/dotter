# Dotter workflow guide

## Install and sign in

Requirements: Node.js 22+, Python 3, and Codex CLI signed in with ChatGPT. Dot
operations require a Dot in that account. Interactive voice and remote control
also require a browser with WebRTC support. Automatic browser opening uses
macOS `open`; use `--no-open` to open the printed local URL yourself.

```sh
npm install --global /path/to/dotter-cli-0.5.22.tgz
dotter --version
dotter auth status
dotter status
dotter --help
```

From source, run `npm ci --ignore-scripts` first, then use
`node bin/dotter.mjs` or `npm install --global .`. There are no install scripts. `capabilities` and the per-area capability commands work
without API calls.

```sh
dotter auth login
dotter auth refresh
dotter auth logout
```

Login/logout delegate to `codex`; logout affects its shared login. Refresh
uses the Codex app-server account API and checks the resulting cache. It is
explicit, never an automatic response to a failed write.

The credential cache is `$CODEX_HOME/auth.json`, defaulting to
`~/.codex/auth.json`. `--auth-file PATH` selects an existing cache. Refreshing a
custom cache requires the filename `auth.json`. Tokens are read for requests,
not copied into project files, printed, or accepted as command arguments.
Browser-cookie and OS-keychain extraction are not used for authentication.

## Scope, output, and confirmation

A Dot room, a ChatGPT conversation, and an account are different scopes:

- Room commands normally resolve the primary Dot. `--room ROOM_ID` selects a
  room; Dot management normally accepts `--dot DOT_ID`.
- `conversation ...`, `account ...`, `mail ...`, `plugin ...`, and Library
  operations affect account resources. They do not clone a Dot or transfer its
  identity.
- Account memory/settings commands require `--account ACCOUNT_ID`. Library
  permission commands also require `--user ACCOUNT_USER_ID`; obtain the actual
  server principal with `library sharing identity RESOURCE_ID --account ACCOUNT_ID`
  (add `--kind folder` for a folder). An OAuth subject is not this principal. Other commands
  that offer `--account` use it to pin the current login to the intended account.

`dotter auth status` prints the account selector as `accountId`, so account
commands do not require opening the credential cache. It never prints tokens.

Most commands return JSON. Basic history/polling commands also have readable
text output; native events and summary streams emit NDJSON. Stream commands
accept `--duration SECONDS` and stop on Ctrl+C. `--help` on an extended command
shows its specific flags.

JSON specs are UTF-8 objects limited to 256 KiB. Unknown fields are rejected.
`--value`/`--update` flags marked as JSON take JSON literals, including quoted
strings. Text-file inputs are bounded and decoded as UTF-8. Private credential
or callback inputs use a file or piped non-TTY stdin, never a direct secret flag.

Mutations run only when invoked. Destructive commands require the exact
resource ID where shown, for example `--confirm FILE_ID`; confirmation applies
to that command only. Library sharing can publish data or grant access, and
mail/tool commands can contact external services. Review their selected scope
and arguments before invoking them.

Writes are not automatically retried. Retain printed UUID request keys and
reconcile the original operation after an uncertain response. A transport
failure can happen after the server accepted a change. Local state/exports
use private file permissions and explicit overwrite controls.

## Messages, history, tasks, and events

```sh
dotter dots
dotter profile
dotter room --room ROOM_ID
dotter threads all --dot DOT_ID
dotter threads inventory --dot DOT_ID --include-hidden
dotter tasks --dot DOT_ID
dotter task TASK_ID --dot DOT_ID

dotter history --pages 5 --json
dotter history --task TASK_ID --json
dotter history --around MESSAGE_ID --json
dotter search --query Banana --all --pages 20
dotter thread ROOT_MESSAGE_ID --pages 10
dotter outline --pages 5
dotter export --output ./history.md --format md --pages 20

dotter send "Hello from the CLI"
dotter send --file ./message.txt
dotter send "Review this" --attach ./notes.txt --reply-to MESSAGE_ID
dotter send "Continue this task" --task TASK_ID --room ROOM_ID
dotter send "Use this page" --page PAGE_ID
dotter send "Review this annotation" --annotations-file ./annotations.json
dotter chat
```

History excludes hidden/deleted messages, internal analysis, tool-directed
content, and completion placeholders. JSON is a filtered representation, not
an unrestricted API dump. Hidden-thread inventory exposes metadata only.
History pages contain at most 20 API items, including filtered records;
`--pages` bounds work. Before/after/around selectors are mutually exclusive.
Search scans the requested pages and reports truncation.

Sends support up to ten attachments, task/page context, replies, and the
verified browser-annotation schema. `send --page PAGE_ID --page-thread THREAD_ID`
addresses an existing Page comment thread; the thread requires a Page ID.
Arbitrary metadata is not forwarded. History retains visible call cards as
call IDs, duration, outcome, summary text and summarizing state; it excludes
raw provider payloads and hidden call transcripts.
`--wait` reports later observed assistant messages; concurrent room activity
means this is not proof of correlation. `/attach PATH` queues an attachment in
interactive chat; `/help` and `/quit` are local chat commands. Start a line with
a space to send a slash command literally. Ctrl+C or SIGTERM cancels the chat
watcher and exits cleanly.

```sh
dotter events watch --room ROOM_ID --duration 60
dotter events watch --room ROOM_ID --task TASK_ID
dotter events watch --all
dotter task-events watch --dot DOT_ID --duration 60
dotter task-events watch --dot DOT_ID --task TASK_ID
dotter activity watch --dot DOT_ID
dotter activity room --room ROOM_ID
dotter task-subscription TASK_ID --room ROOM_ID

dotter watch --cursor-file ./dot-watch.json --json
dotter watch --all --json
```

`events watch --task` now uses the native task topic and its task subscription,
instead of the general room topic. Event messages are resolved through the
filtered history reader. Native streams use bounded reconnects for eligible
transient failures; authentication, identity, permission, and edge challenges
stop them. `--no-reconnect` disables reconnects.

`task-events watch` subscribes to the distinct native global task-state feed.
It emits visible `task-upsert` summaries scoped to the selected Dot and optional
task. `task-resync` means subscription recovery requires reconciling with
`tasks`; readiness does not imply a task snapshot or a newly received task.

Polling `watch` remains separate. Its cursor file is private, single-room,
and protected by a lock. Resume is at least once, so consumers should dedupe
message IDs. `--all` discovers rooms at startup and cannot use a single-room
cursor file. These commands do not install a daemon or hosted webhook.

## Approvals and message continuations

```sh
dotter actions
dotter action inspect MESSAGE_ID
dotter action respond MESSAGE_ID --request-id REQUEST_ID --fingerprint FINGERPRINT --action accept --content-file ./response.json
dotter action respond MESSAGE_ID --request-id REQUEST_ID --fingerprint FINGERPRINT --action decline
dotter react MESSAGE_ID --emoji '👍'
dotter read MESSAGE_ID
dotter email MESSAGE_ID

dotter message plugins get MESSAGE_REFERENCE
dotter message plugins continue MESSAGE_REFERENCE --plugins PLUGIN_ID --fingerprint FINGERPRINT
dotter message auth get MESSAGE_REFERENCE
dotter message auth start MESSAGE_REFERENCE --fingerprint FINGERPRINT --session-file ./private-auth-session.json
dotter message auth complete MESSAGE_REFERENCE --session-file ./private-auth-session.json --callback-file ./private-callback.txt
```

Callback files must be owner-only regular files no larger than 64 KiB.
Symlinks, changed/replaced files and cancelled input are rejected before the
callback POST; input files are retained unchanged. Callback stdin reads are
abortable, and invalid input preserves the redirected session for recovery.

Approval forms validate the freshly retrieved request, schema, action ID,
and fingerprint. Ajv validates draft-2020-12, draft-2019-09 and draft-07 schemas
in a worker with a memory/time budget, including local references, composition,
conditionals, dependent fields, formats and patterns. Remote schema references
are never fetched. Validation neither coerces values nor inserts defaults.
Persistence choices are allowed only when the request advertises them.
Accepted form content defaults to an empty object when omitted; the submitted
content is the snapshot that passed validation. A form schema cannot override
a request that requires native human review. Sites
database approvals require a reviewable change summary and cannot be persisted
for future changes.

Server-provided resource/image selections are supported. Native Dot actions
explicitly reject local-file-picker `userOptions` and `image.file` handback:
a file path is not silently converted into an app-native selection. A schema
that cannot validate safely fails before any response is sent. Native device
or account approval follows the separate human-review flow below.

Message-bound plugin/authentication commands require the server-issued
reference. Authentication state contains a completion capability and is saved
privately. Provider authorization remains interactive. Only an explicit
`--resume` continues a supported interrupted completion state; uncertain starts
or provider callbacks are not blindly replayed. Do not share these state files
or callback URLs.

## Human review and private browser sign-in

```sh
dotter actions native inspect MESSAGE_ID --room ROOM_ID
dotter actions native start MESSAGE_ID --room ROOM_ID --request REQUEST_ID --fingerprint FINGERPRINT --session-file ./native-review.json
dotter actions native status --session-file ./native-review.json
dotter actions native complete --session-file ./native-review.json
dotter actions native approve-email-code MESSAGE_ID --room ROOM_ID --request REQUEST_ID --fingerprint FINGERPRINT --confirm REQUEST_ID
```

Native start opens the exact first-party review page and stores a private,
identity-bound journal. Biometrics, location permission, wallet enrollment,
passkeys and native SIWC steps are performed by the human in that page, with
whatever device/app support the service requires. The CLI does not manufacture
proofs or treat opening the page as approval. `complete` verifies resolution
of the same request, and does not claim whether the human accepted or declined
when that outcome is not exposed. Email-code approval is an explicit, separate
write allowing the browser to obtain/use its requested code; it does not read
or print the code.

```sh
dotter remote auth inspect --room ROOM_ID --message MESSAGE_ID
dotter remote auth claim ./sign-in.json --room ROOM_ID --message MESSAGE_ID --fingerprint FINGERPRINT --origin https://example.com
dotter remote auth fill ./sign-in.json --credentials ./private-fields.json
# Request saving only when the current challenge explicitly supports it:
dotter remote auth fill ./separate-sign-in.json --credentials ./private-fields.json --remember
dotter remote auth reuse ./another-sign-in.json CREDENTIAL_ID
dotter remote auth operation ./sign-in.json
dotter remote auth recover ./sign-in.json

# Alternative: after claiming a fresh ./manager-sign-in.json operation:
dotter remote auth password-manager start ./manager-sign-in.json
dotter remote auth password-manager open ./manager-sign-in.json
dotter remote auth password-manager status ./manager-sign-in.json
dotter remote auth password-manager use ./manager-sign-in.json
```

Claim binds the journal to the current visible request, exact HTTPS origin,
field IDs, signed-in user and operation ID. A credentials file is an owner-only
JSON object mapping the advertised field IDs to their values; `--credentials -`
reads private piped input. If the form advertises alternative groups, use an
advertised `--option ID`. Never place credential values in arguments or commit
credential/state files to source control.

A claimed operation permits one submission. Unknown results require status or
server reconciliation, not another fill. `--remember` requests saving only when
the service advertises the exact save fields. Reuse resolves a current,
unexpired selection for the same origin. The 1Password path checks the exact
access request, opens its verified native approval link, and uses the returned
handle only after the human approves. Neither saved selection handles nor
password-manager access handles appear in ordinary output. Manual fields,
saved-credential reuse and 1Password are alternatives; claim a fresh journal
for a different sign-in attempt. A shared private claim ledger prevents a
second journal from replaying the same claimed challenge. Its default is
`~/Library/Application Support/dot-cli/browser-auth-claims` on macOS and
`~/.local/state/dot-cli/browser-auth-claims` elsewhere; `DOT_CLI_STATE_DIR`
sets the parent directory. Shared claims never expire or reclaim automatically.

New operation locks record their local owner. Recovery reclaims a lock only
after confirming that process is gone; active, unverifiable and legacy locks
require inspection. Recovery never replays a submission. A 1Password start
whose response was lost cannot resume without its private access handle; the
CLI reports that limit and directs review of the original request. Tests
inject temporary claim-ledger directories.

```sh
dotter remote auth qr status CONVERSATION_ID CHALLENGE_ID
dotter remote auth qr open CONVERSATION_ID CHALLENGE_ID
dotter remote auth qr open CONVERSATION_ID CHALLENGE_ID --room ROOM_ID --message MESSAGE_ID --fingerprint FINGERPRINT
dotter remote browser legacy status CONVERSATION_ID
dotter remote browser legacy open CONVERSATION_ID
dotter remote config
dotter remote config set --policy always_ask --account ACCOUNT_ID --confirm ACCOUNT_ID
dotter remote cookies list --surface Orbit
dotter remote cookies delete example.com --surface Orbit --target-fingerprint FINGERPRINT --account ACCOUNT_ID --confirm example.com
dotter remote origins list --account ACCOUNT_ID
dotter remote origins set https://example.com --decision deny --account ACCOUNT_ID --confirm ACCOUNT_ID
dotter remote origins remove https://example.com --account ACCOUNT_ID --confirm ACCOUNT_ID
dotter remote passkeys list --account ACCOUNT_ID
dotter remote passkeys delete CREDENTIAL_ID --account ACCOUNT_ID --confirm CREDENTIAL_ID
```

QR and legacy noVNC viewers use private loopback sessions. QR payloads and
legacy authenticated viewer URLs are not dumped into ordinary status output;
QR rotation/disappearance is tracked locally. Keep the temporary local viewer
URL private. The initial QR comes from the matching visible request card;
specify its context when it is outside the current room's latest messages.
Legacy clipboard access is delegated only to the verified viewer origin and
still requires the browser's permission. `remote config set` changes the account browser approval policy
(`always_ask`, `auto_approve`, or `always_allow`) and requires the exact account
confirmation. Cookie listing exposes host counts, not cookie values. Delete
and clear require the reviewed store fingerprint and the documented exact
host/account confirmation, so a changed target is not silently used.
Origin rules use the native website-pattern grammar and verify the saved
allow/deny state after a change. Passkey commands expose metadata only and
require a current matching credential before deletion. These account browser
features depend on service availability; the tested account did not have
WebAuthn enabled.

Public widget interaction was retired in 0.5.22. The CLI no longer exposes
widget commands or a widget SDK client. `actions list` may still describe a
visible widget attachment as unavailable. Generic connector operations remain
separate and supported within their documented limits.

## Files, Library content, and providers

```sh
dotter upload ./notes.txt
dotter upload ./large.pdf --room ROOM_ID --state-file ./large-upload.json
dotter send "Use the uploaded file" --attachment-id FILE_ID
dotter download FILE_ID --output ./downloaded.pdf
dotter artifacts --pages 10

dotter library upload ./notes.txt --account ACCOUNT_ID --state-file ./library-upload.json
dotter library upload-status --account ACCOUNT_ID --state-file ./library-upload.json
dotter library upload-reconcile --account ACCOUNT_ID --state-file ./library-upload.json
dotter library browse --folders-only
dotter library search --query report --limit 20
dotter library search --query report --include-native-files
dotter library search --query report --providers google_drive
dotter library get FILE_ID
dotter library get FILE_ID --include-trashed
dotter library move FILE_ID --directory DIRECTORY_ID
dotter library create-directory "Research"
dotter library create-inline notes.md --content-file ./notes.md
dotter library update-inline FILE_ID notes.md --content-file ./revised.md --confirm FILE_ID
dotter library download FILE_ID --output ./report.pdf
dotter library content FILE_ID --output ./part.bin --range bytes=0-1023
dotter library versions FILE_ID
dotter library restore-version FILE_ID --version 2 --expected-version 5 --confirm FILE_ID
```

Room uploads accept regular, non-symlink files from 1 byte to 20 MiB. Stateful upload
recovery verifies the source identity/hash and room, checks remote completion,
and reuses completed uploads. It resumes whole-file reservation/completion,
not arbitrary byte chunks. Plain send attachments can upload again on a new
send attempt; upload once and use the returned file ID when reuse matters.
Downloads are bounded to 100 MiB and require explicit overwrite.

For `library search`, `--providers` accepts only `google_drive`, `box`,
`dropbox`, `sharepoint`, and `onedrive`. Use `--include-native-files` for native
Library files; `native` and `native_shared` are not provider values for this
command. The CLI rejects unsupported values before authentication. Other
search APIs retain their own provider contracts.

`library upload` accepts 1 byte to 512 MiB using a bounded file-backed transfer
and the native Files processing flow. Its private journal binds the source,
account, signed-in user and optional `--directory`. Folder uploads first persist
at root, then move the acknowledged Library ID and verify its destination;
the file can briefly appear at root. The command returns separate general-file
and Library IDs after checking the persistent record. Reuse the same journal
to resume a known stage; use `upload-reconcile` after an uncertain write.
Reconciliation reads the exact file mapping and never repeats a reservation,
processing request, uncertain commit or move.
Native processing creates the Library entry, so do not register it again.
If retrieval indexing is unavailable but the native service confirms a usable
raw file, the result reports that limitation separately from file persistence.
When the server selects native Azure multipart, the journal records each
deterministic block and the ordered commit. `--resume-parts` explicitly repeats
only unchanged, uncommitted blocks after interruption; it does not replay an
uncertain commit. The configured transfer limit is 512 MiB. Multipart behavior is covered by
local contract tests; provider selection and acceptance depend on the service.

Room upload IDs and Library file IDs are different. Upload metadata exposes
the associated `libraryFileId` when available. The native
`library register-upload` caller finalizes an external-provider destination
upload and requires both its general Files ID and `--parent` pointing to an
eligible existing provider folder. The command validates current provider
browsing access and the exact folder before one finalization request; that
workflow remains live-unverified. Do not use it on an already
persisted room or native account upload. Newly saved, trashed or
restored Library items can take time to appear in search. Inspect the exact ID
before repeating a write. Inline content may not support byte ranges; a full
response is never silently saved as the requested range. A shorter range is
accepted only when the service declares that it reaches the file's end.
Cancellation before atomic publication leaves an existing output unchanged
and removes the temporary file; a successfully published file is committed.

The Library supports recents/opened markers, favorites (up to 50 per page), folders, note content,
version restore, thumbnails, plan/report previews and report export. File trash
is reversible; `delete-permanently` and `empty-trash` are irreversible.
`empty-trash --confirm 'EMPTY LIBRARY TRASH'` is deliberately distinct from
confirming a single file. Batch soft-delete requires the identical IDs in
`--files` and `--confirm-files`. Product-specific Page/site deletion is not
silently treated as ordinary file deletion.

```sh
dotter library providers capabilities
dotter library providers search "quarterly report" --providers google_drive
dotter library providers metadata google_drive PROVIDER_FILE_ID
dotter library providers preview google_drive PROVIDER_FILE_ID
dotter library providers materialize PROVIDER_FILE_ID "Report.pdf"
dotter library shared-search "planning"
dotter library global-search "planning"
dotter library references list
dotter account reference-photos list
```

Use provider IDs returned by capability discovery; availability varies by
account. Provider URL/native-ID resolution, cache search, and federated search
use verified contracts. Materialization's retrieval indexing is opt-in through
`--index`. Mounted provider IDs cannot be downloaded directly: materialize
first, retain the returned general `file_id`, then use `library download FILE_ID
--output PATH`. A timeout can leave an imported cache without a receipt; do not
repeat an uncertain materialization. Malformed, unavailable or conflicting
materialization/registration receipts are reported as unconfirmed; a minimal
valid returned identity is still accepted. Google Drive and Box preview commands
construct sanitized source URLs locally; they make no preview API request. Only
the Google Drive local branch was observed. Microsoft preview availability
requires a valid native preview URL; Dropbox source links do not imply an
embedded preview. Reference-image/photo commands and image/chat favorites operate on
account data. Remote asset URLs are filtered; signed transfers use bounded,
explicitly permitted hosts without forwarding account credentials.

```sh
dotter library saved capabilities
dotter library saved status --specs-file ./saved-targets.json --account ACCOUNT_ID
dotter library saved save --file ./product.json --account ACCOUNT_ID
dotter library saved get LIBRARY_FILE_ID --account ACCOUNT_ID
dotter library saved move LIBRARY_FILE_ID --directory DIRECTORY_ID --account ACCOUNT_ID
dotter library saved remove LIBRARY_FILE_ID --confirm LIBRARY_FILE_ID --account ACCOUNT_ID
```

Saved products and places are native Library entities. A product spec contains
`kind: "product"`, `name`, `productId`, `url`, `query` and `provider`; a place
uses `kind: "local-business"`, `name` and optional native identity fields such
as `entityLookupId` or the pair `provider`/`businessId`. Optional display and
source fields are `imageUrl` and `origin: {conversationId, messageId}`.
Products also accept `productLookupKey` (an object or null) and a
`rewrittenQueries` array; the lookup object supports `data`, `version`,
`last_variant_selection_group_id` and `variant_options_query` using the native
source values. The variant query is a bounded option-name-to-string map;
native labels containing spaces, hyphens or numeric names are preserved.
This path-specific behavior has local regression coverage; live provider
resolution and the remaining product variants are still unverified. Places
accept `entityKey` and `category` (`local_business`, `restaurant`, `hotel` or
`point_of_interest`). Use real provider identities from the source item.
Status accepts an array of 1–100 specs. Get, move and remove use the returned
Library ID and re-read the native saved status. Get returns a validated
conversation/message origin when the saved entity provides one. Creation does not accept
arbitrary backend targets.

## Library permissions and invitations

```sh
dotter library sharing state FILE_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID
dotter library sharing shares FILE_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID
dotter library sharing grant FILE_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID --recipient '{"recipient_type":"email","email":"person@example.com"}' --role viewer --confirm FILE_ID
dotter library sharing preview FILE_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID --recipient '{"principal_type":"user","principal_id":"RECIPIENT_ID"}' --role '"viewer"'
dotter library sharing apply FILE_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID --preview ./access-preview.json --confirm FILE_ID
dotter library sharing invitations --account ACCOUNT_ID --user ACCOUNT_USER_ID
dotter library sharing accept INVITATION_ID --account ACCOUNT_ID --user ACCOUNT_USER_ID --confirm INVITATION_ID
```

Permission operations verify the resource, current viewer/owner, capabilities,
and allowed roles. `--kind folder` selects folder permissions. Grant/revoke,
workspace-link changes, owner access-request decisions, and leaving a received
share require exact confirmation. Applying a preview requires its unchanged
server fingerprint. Library links support workspace or collaborators-only
access; the audited Library contract does not add public links.

## Dot lifecycle, remote computers, and voice

```sh
dotter dot create "My Dot"
dotter dot primary DOT_ID
dotter dot avatar DOT_ID --spec ./appearance.json
dotter dot avatar-default DOT_ID default
dotter dot ensure-room --dot DOT_ID
dotter pause --dot DOT_ID
dotter resume --dot DOT_ID
dotter dot reboot --dot DOT_ID --confirm DOT_ID
dotter dot delete DOT_ID --confirm DOT_ID

dotter environment status --dot DOT_ID
dotter computer list --dot DOT_ID
dotter computer connect ENVIRONMENT_ID --dot DOT_ID
dotter computer disconnect ENVIRONMENT_ID --dot DOT_ID --confirm ENVIRONMENT_ID
dotter remote computer --dot DOT_ID
dotter remote browser CONVERSATION_ID --no-open
```

Lifecycle operations check current identities and root threads. Appearance
requires a valid avatar/manifest; `avatar-default` makes its change conditional
on the current default avatar. `dot recover-deletion --confirm` retries pending
deletion finalization; it does not restore deleted Dots. Doctor setup creates
health checks, and reviewed safety resume requires an unchanged fingerprint.

Remote control opens an ephemeral loopback WebRTC viewer. Click **Connect** to
view, then explicitly **Take control** for mouse/keyboard input. Clipboard
transfer and supported browser-tab handoff are explicit actions. **Return
control**, closing the page, or Ctrl+C ends local participation. The CLI
implements the observed signaling/data-channel protocol; a real session still
requires the service's remote-computer/browser backend and its permissions.
This does not install a local machine agent or replace first-party human
permission, biometric or passkey checks. Explicit browser credential workflows
are described below. End-to-end remote control has not been live-verified.

```sh
dotter remote auth prepare CONVERSATION_ID CHALLENGE_ID
dotter remote auth availability CONVERSATION_ID CHALLENGE_ID
dotter remote auth candidates CONVERSATION_ID CHALLENGE_ID
dotter remote auth reconcile CONVERSATION_ID CHALLENGE_ID OPERATION_ID

dotter email-channel options --dot DOT_ID
dotter email-channel claim --dot DOT_ID --local-part HANDLE --domain DOMAIN --consent
dotter meeting start https://meet.google.com/abc-defg-hij --dot DOT_ID
dotter voice chat --dot DOT_ID
dotter voice chat --dot DOT_ID --listen-only
```

The original browser-auth metadata commands expose safe availability,
candidate labels and recovery status. The private operation workflow below
adds explicit credential fill/reuse without printing credential values or
selection capabilities. Dot email setup requires its versioned consent and
available domain/owned inbox. It is separate from connected Gmail/Outlook
mail below.

Meeting start uses the observed Google Meet invite contract; acceptance does
not establish attendance. Voice uses a separate loopback page for microphone
capture and WebRTC audio. `--listen-only` skips microphone access and sends
no audio track. `voice allocate/attach/stop` supports callers that
manage their own peer connection. Local URLs contain temporary capabilities:
keep them private. Physical microphone capture, permission prompts, playback,
and real remote computer control require separately authorized integration tests.

## Native Dot onboarding and recovery

```sh
dotter dot onboarding eligibility
dotter dot onboarding create --name "My Dot" --state-file ./dot-onboarding.json
dotter dot onboarding status ./dot-onboarding.json
dotter dot onboarding resume ./dot-onboarding.json
# An unknown create result needs an explicitly confirmed new candidate:
dotter dot onboarding resume ./dot-onboarding.json --dot DOT_ID --confirm DOT_ID
```

This follows the observed native creation flow: create with
`should_initialize: true`, confirm the returned Dot/root, and ensure its
messaging room. A private journal is reserved before mutation and binds the
request and before/after identities to the signed-in user. Creation is never
replayed automatically. Status can list new matching candidates after an
uncertain result; resume requires their exact identity when the original
create response did not confirm one. An uncertain room request can be retried
only with explicit `--retry-room` after inspection.

Ready means the Dot/root and messaging room are confirmed and server-side
initialization was requested. It does not mean a greeting was delivered or
that a full end-to-end onboarding chat was observed. The CLI does not send a
second first message. The separate orphan `/onboarding/initialize` adapter has
no request assembler in the inspected client and is not invoked with an
invented body. `--first-dot` selects the native first-Dot creation option;
normal onboarding creation requests an additional Dot.

Creation first checks the selected account's Dot availability. A positive
eligibility result does not establish creation permission. Rejected and
uncertain operations retain safe failure diagnostics in their private journal.

## Routines

```sh
dotter routine list
dotter routine query --scope personal --query review
dotter routine create --spec ./examples/routine.json
dotter routine update ROUTINE_ID --spec ./changes.json
dotter routine run ROUTINE_ID
dotter routine runs ROUTINE_ID
dotter routine result ROUTINE_ID --run RUN_ID
dotter routine latest ROUTINE_ID
dotter routine threads ROUTINE_ID
dotter routine policy
dotter routine batch ROUTINE_ID
dotter routine flush-batch ROUTINE_ID
dotter routine share current ROUTINE_ID
```

Cloud schedules use iCalendar VEVENT/RRULE, not Unix cron. Creation is account
scoped and does not assign a Dot through the observed save API. Local
desktop-owned Codex automations require their own runtime.

The receipt from `routine run` can contain a dispatch `run_id` that differs from
the persisted result ID. Use `runs[].id` from `routine runs` with
`routine result --run`; an empty `routine latest` is a valid no-run result.
Execution-thread behavior depends on available native run metadata and the
service response; an empty result does not prove that a routine never ran.

Routine specs support title/prompt, schedule/time zone, timing mode,
notifications/email, model/reasoning, emoji, thread mode, and optional team
scope on creation. Updates preserve omitted configuration.

Event-trigger authoring is unavailable. The CLI rejects a `triggers` spec
before authentication instead of reporting a working event routine. Existing trigger data and pending batches remain readable.

`routine share create/refresh` publishes a public routine link; `revoke`
withdraws it. `routine shared` reads shared metadata, while `import-prompt`
prepares text and does not itself create/run a routine. Batch flush operates
on events already pending for a routine; it does not provision a generic
webhook listener, gateway, or credentials.

## Connected mail, connectors, and plugins

```sh
dotter mail accounts --account ACCOUNT_ID
dotter mail send --account ACCOUNT_ID --provider gmail --link LINK_ID --to person@example.com --subject "Update" --body-file ./email.txt
dotter mail status SEND_ID --account ACCOUNT_ID
dotter mail undo SEND_ID --account ACCOUNT_ID --expires UNDO_DEADLINE
dotter mail contacts "Alex" --link CONTACTS_LINK_ID --account ACCOUNT_ID
```

Mail sends use a selected active Gmail/Outlook link with the required scope and
advertised `send_email` action. A send ID is generated once; inspect that ID's
status after an uncertain result. Undo is available only within the original
receipt's deadline. This is connected-provider mail, separate from a Dot's
email channel and rendered email cards. Do not use a new send ID to retry an
uncertain send without reconciling it first.

```sh
dotter connectors list
dotter connection oauth CONNECTOR_ID --spec ./oauth.json
dotter connection complete CONNECTOR_ID --redirect-file ./private-callback.txt --account ACCOUNT_ID
dotter connection api-key CONNECTOR_ID --key-file ./private-key.txt
dotter tools CONNECTOR_ID --link LINK_ID
dotter tool-call CONNECTOR_ID EXACT_TOOL_NAME --link LINK_ID --args-file ./args.json
dotter resources CONNECTOR_ID --link LINK_ID
dotter resource CONNECTOR_ID ui://provider/resource --link LINK_ID

dotter connector admin get CONNECTOR_ID
dotter connector admin privacy CONNECTOR_ID LINK_ID POLICY
dotter connector admin mcp-create --name "My server" --target '{"mcp_url":"https://example.com/mcp"}' --auth-config ./auth-config.json
dotter connector admin refresh-actions CONNECTOR_ID LINK_ID

dotter plugin list
dotter plugin catalog
dotter plugin get PLUGIN_ID
dotter plugin resolve-app APP_ID
dotter plugin install PLUGIN_ID
dotter plugin skill-enable PLUGIN_ID SKILL_NAME
dotter plugin export PLUGIN_ID --out ./plugin.zip
dotter plugin import --file ./plugin.zip --state-file ./private-import.json
dotter plugin import-status --state-file ./private-import.json
dotter plugin import --file ./plugin.zip --plugin PLUGIN_ID --confirm PLUGIN_ID --state-file ./private-update.json
```

`tools` fetches a native catalog scoped to one connector, with a 32 MiB response
limit and validated account routing. Existing short tool names remain valid;
ambiguous names across catalog pages are rejected before invocation. Other
catalogs use the same response limit, while ordinary calls and resource reads
retain a 10 MiB limit. A larger catalog does not grant additional permissions.

When a validated catalog descriptor declares a UI template, `tool-call` uses its
qualified native name and routing metadata with the UI source marker. Ordinary
generic tools keep their existing route. `resource` uses the native reader for
valid `ui://` URIs and requires an explicit `--link` that is still active and
visible; dynamic resources do not have to appear in a static catalog. Other URI
schemes keep their existing route. Native continuations are bounded, and requests
for interactive input remain pending. These adapters do not create a Dot widget;
live provider execution requires separately authorized integration testing.

Discovery, tool calls, resources/templates/prompts, connection health, OAuth,
API-key/no-auth links, privacy, custom MCP metadata/action refresh, and selected
service-account connection operations are implemented. API-key stdin respects
cancellation and account-scoped principals; credential values are redacted from
schema output. PNG icon validation checks bounded file structure, not decoded
pixels or CRCs. These are local contract checks, not live credential setup proof.
Use the returned
connector target/auth schema, not an invented one; custom-MCP setup details are
in the command reference. Provider consent remains interactive, and native
app-password flows remain outside the implementation.

Plugin imports require exactly one private journal: `--state-file FILE` creates
or resumes an import, while `--reservation-file FILE` resumes an existing
captured reservation. The journal binds the account, signed-in user, archive
name/content/size, and update target. Resume with the same file and arguments.
`import-status` reads the local journal after authentication-identity checks,
without HTTP or a server refresh, and reports the phase without exposing the
signed upload URL.
An interrupted reservation, upload, or finalization reports an unknown outcome
and stops; inspect the receipt and existing resource before any new attempt.
A completed journal returns its recorded plugin ID without uploading again.
Do not delete or replace a journal to retry an uncertain write.

Hosted plugin commands cover catalog/search, installed/created/shared views,
skills, install/enable/disable, sharing, ZIP import/export, deletion, and
service-account installation. They manage hosted plugins through the account
APIs, not arbitrary local desktop plugin folders. Destructive operations
require exact IDs. Plugin installation and connector authorization remain
separate steps.

## Account memory, settings, and conversations

```sh
dotter account memories list --account ACCOUNT_ID
dotter account memories capacity --account ACCOUNT_ID
dotter account memories warm MEMORY_ID --account ACCOUNT_ID
dotter account memories delete MEMORY_ID --account ACCOUNT_ID --confirm MEMORY_ID
dotter account personalization get --account ACCOUNT_ID
dotter account personalization update --account ACCOUNT_ID --file ./instructions.json
dotter account personality types --account ACCOUNT_ID
dotter account personality traits --account ACCOUNT_ID
dotter account notifications get --account ACCOUNT_ID
dotter account notifications update --account ACCOUNT_ID --updates '{"responses":{"push":true}}'
dotter account settings get --account ACCOUNT_ID
dotter account settings set response_presentation --account ACCOUNT_ID --value '{"mode":"standard"}'
dotter account voices --account ACCOUNT_ID --language en --mode advanced
dotter account settings set voice_main_language --account ACCOUNT_ID --value '"en"'
dotter account summary checksum --account ACCOUNT_ID
dotter account summary get --account ACCOUNT_ID
dotter account summary stream --account ACCOUNT_ID
dotter account summary correct --account ACCOUNT_ID --text "I now prefer tea." --section SECTION_ID
```

These change account-level context, not one Dot's local memory. Personalization
accepts verified instruction fields and fresh catalog-validated personality
choices. Notification channels are checked against current settings. Settings
have a fixed typed allowlist; arbitrary account feature names are rejected.
The presentation wire values are `rich` and `standard` (the UI labels the
latter Simple).
`account voices` lists shared-account voice choices for an explicit language
and standard, advanced or wingman mode; it returns safe preview links without
fetching audio. `voice_main_language` accepts the native language codes,
including `auto`. These preferences are separate from Dot call allocation.

Memory summary retrieval itself uses POST and may generate a cache. Stream,
regenerate, correction, and forget expose visible sections only. Optional
context is JSON shaped as `{"source":"dream_citation","hints":["..."]}`.
Forget requires the target section ID as confirmation, or the account ID for
an untargeted topic. `account summary clear` requires account confirmation,
disables memory toggles, and clears the summary cache. `account memories clear`
is a separate saved-memory deletion; `--delete-history` explicitly requests
that additional API behavior.

```sh
dotter account projects list --account ACCOUNT_ID
dotter account projects get g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects create "Research" --theme blue --account ACCOUNT_ID
dotter account projects update g-p-PROJECT_ID --instructions-file ./instructions.txt --account ACCOUNT_ID
dotter account projects conversations g-p-PROJECT_ID --pages 5 --account ACCOUNT_ID
dotter account projects pinned --account ACCOUNT_ID
dotter account projects pin g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects unpin g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects delete g-p-PROJECT_ID --account ACCOUNT_ID --confirm g-p-PROJECT_ID --delete-chats
```

These commands manage native account projects identified by `g-p-` IDs,
separately from Dot identities, local repositories and custom GPTs. List defaults
to owned projects; `--all-accessible` includes projects shared with the account.
Sidebar list pages are capped at 50, the largest size verified against the service.
Project-conversation pages have a separately confirmed server maximum of 50.
Creation verifies a private owned project. Changes check current native
permissions and require exact readback; uncertain writes are not replayed.
Deletion permanently removes the project and its contained chats, so both
`--delete-chats` and exact ID confirmation are required. Saved Library and
Space files are retained by the native service.

Project updates support name, emoji, palette theme and instructions. Theme
names are black, blue, green, orange, pink, purple, red and yellow. Creation
accepts memory scope `unset`, `global` or `project_v2`.

```sh
dotter account projects files list g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects files upload g-p-PROJECT_ID ./notes.txt --state-file ./project-upload.json --account ACCOUNT_ID
dotter account projects files upload-status --state-file ./project-upload.json --account ACCOUNT_ID
dotter account projects files upload-reconcile --state-file ./project-upload.json --account ACCOUNT_ID
dotter account projects files attach-library g-p-PROJECT_ID --ids LIBRARY_FILE_ID --account ACCOUNT_ID
dotter account projects files remove g-p-PROJECT_ID FILE_ID --confirm FILE_ID --account ACCOUNT_ID
dotter account projects sources providers g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sources list g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sources add g-p-PROJECT_ID website https://example.com --account ACCOUNT_ID
dotter account projects sources sync g-p-PROJECT_ID SCOPE_ID --wait --account ACCOUNT_ID
dotter account projects sources wait g-p-PROJECT_ID SCOPE_ID --account ACCOUNT_ID
dotter account projects saves list g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects saves create g-p-PROJECT_ID CONVERSATION_ID MESSAGE_ID --account ACCOUNT_ID
dotter account projects saves rename g-p-PROJECT_ID SAVE_ID "Research note" --account ACCOUNT_ID
dotter account projects saves remove g-p-PROJECT_ID SAVE_ID --confirm SAVE_ID --account ACCOUNT_ID
dotter account projects memory get g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects memory set g-p-PROJECT_ID global --confirm g-p-PROJECT_ID --account ACCOUNT_ID
```

Library attachment uses existing ready files with distinct Library and general
Files IDs. It requires an eligible writable private project with default memory,
current country availability and enough file capacity. Removing a file removes
project membership; it sends no Library or general Files deletion.

Direct project upload uses the native project-specific reservation, transfer,
processing and membership flow for regular files up to 512 MiB. Its private
journal binds the account, project and local source. Library persistence is
optional, so a successful project upload can have no Library ID. Completion
requires exact project membership and checks returned metadata; it does not
claim a remote download/hash verification. Use the same state file for recovery.
Uncertain reservation, commit, processing or attachment is not replayed;
`--resume-parts` explicitly resumes unchanged uncommitted multipart blocks.
An unsuccessful operation can retain a general file or reservation, and no
unverified storage cleanup is attempted.

Project sources support website, Google Drive, Slack and Linear sources using
current project permissions and existing provider connections. Website URLs
follow native normalization. A synchronization request can be accepted before
it completes; `--wait` observes completion, while `sources wait` observes an
existing request without starting another one. Website sources do not have
connector synchronization: adding one with `--wait` reports `not_applicable`,
and `sources wait` returns `SOURCE_NOT_SYNCABLE` after its first exact lookup.
Project provider setup uses the
separate commands below; general connector commands retain their CODEX scope.

```sh
dotter account projects connections get g-p-PROJECT_ID google_drive --account ACCOUNT_ID
dotter account projects connections status g-p-PROJECT_ID google_drive --account ACCOUNT_ID
dotter account projects connections tos g-p-PROJECT_ID google_drive --account ACCOUNT_ID
dotter account projects connections oauth g-p-PROJECT_ID google_drive --state-file ./project-auth.json --account ACCOUNT_ID
dotter account projects connections complete --state-file ./project-auth.json --redirect-file ./callback.txt --account ACCOUNT_ID
dotter account projects connections operation --state-file ./project-auth.json --account ACCOUNT_ID
```

The project wrapper fixes the product scope to `CHATGPT_PROJECTS` and supports
Google Drive, Slack and Linear. OAuth, exact-link reauthorization and advertised
no-auth setup use an owner-only journal bound to the account, user, project,
provider and callback state. Provider consent and required native security steps
remain interactive. A callback acknowledgement is not a connection: completion
requires fresh verification of the exact active link. Unknown writes are not
replayed; inspect the saved operation.

Provider credentials are account connections, not private project credentials.
This wrapper has no unlink operation or API-key/app-password form setup.
Reading terms does not accept them. After verifying the link, add the intended
source separately with `account projects sources add`.

Project saves retain eligible visible assistant responses from an account
conversation in the same project. They are separate from Library saved products
and places. Create validates the selected response and its native save permission;
rename and remove affect the shared project source. Project-memory changes
apply only to the selected eligible private project and preserve its other
metadata. Stored settings may take hours to affect conversation behavior; no
bulk account-memory change is made.

```sh
dotter account projects sharing get g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sharing access g-p-PROJECT_ID private --confirm g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sharing invite g-p-PROJECT_ID --subjects '[{"type":"email","email":"person@example.com"}]' --role chat --confirm g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sharing role g-p-PROJECT_ID email:person@example.com edit --confirm g-p-PROJECT_ID --account ACCOUNT_ID
dotter account projects sharing remove g-p-PROJECT_ID email:person@example.com --confirm g-p-PROJECT_ID --account ACCOUNT_ID
```

Project sharing checks current native permissions and workspace policy. Roles
are `chat` and `edit`; access audiences are `private`, `link` and `workspace_link`.
Private access retains invited members. Invitations can notify recipients.
The first sharing change can detach Library files and requires explicit
`--detach-library-files` acknowledgment. Work conversations block sharing
expansion, and workspace projects do not support public-link access. Member
removal affects access to all project content. Join, leave and ownership-transfer
operations have no audited implementation.

```sh
dotter conversation list --account ACCOUNT_ID
dotter conversation search "planning" --account ACCOUNT_ID
dotter conversation history CONVERSATION_ID --pages 5 --account ACCOUNT_ID
dotter conversation responses CONVERSATION_ID --account ACCOUNT_ID
dotter conversation select-response CONVERSATION_ID NODE_ID --account ACCOUNT_ID
dotter conversation inbox list --all-items --account ACCOUNT_ID
dotter conversation shares create CONVERSATION_ID NODE_ID --publish --confirm CONVERSATION_ID --account ACCOUNT_ID
dotter conversation shares update SHARE_ID NODE_ID --unpublish --confirm SHARE_ID --account ACCOUNT_ID
```

Conversation output filters hidden/internal messages and includes only visible
text/file metadata. Response selection, project moves, archive,
pinning, inbox read markers, and owned share management are implemented.
Shared conversation links are different from Library workspace permissions.
Publication/revocation requires exact confirmation; share updates preserve
publication/visibility when those options are omitted.

Conversation branch creation is unavailable: the native branch endpoint only
prepares a snapshot for a later completion request. Its returned ID is not a
persisted chat, and the CLI does not provide that native continuation workflow.

