# Dotter 0.6.3-next.4 command reference

Generated from the installed command definitions. Run `npm run docs` after changing a command.

All API commands accept `--auth-file PATH` and `--json`. Account-wide operations use the current login; commands requiring `--account` must receive its exact account selector. `--help` on an extended command prints its flags without reading credentials.

## Established commands

```text
Dotter — Node.js 22+; Python 3 for advanced SSE

Usage:
  dotter auth status [--auth-file PATH] [--json]
  dotter auth login
  dotter auth logout
  dotter auth refresh [--auth-file PATH] [--json]
  dotter status [--json]
  dotter dots [--json]
  dotter history [--room ID] [--task ID] [--limit 1..20] [--pages 1..100] [--before CURSOR | --after CURSOR | --around MESSAGE_ID] [--json]
  dotter watch [--room ID | --all] [--interval SECONDS] [--duration SECONDS] [--from-start] [--cursor-file PATH] [--json]
  dotter send TEXT [--room ID] [--key UUID] [--json]
  dotter send --file FILE | --stdin [--room ID] [--key UUID] [--json]
  dotter send [TEXT] --attach FILE [--attach FILE...] [--reply-to ID] [--wait 0..300] [--room ID] [--key UUID]
  dotter send [TEXT] [--attachment-id ID...] [--task ID] [--page PAGE_ID [--page-thread THREAD_ID]] [--metadata-file JSON | --annotations-file JSON]
  dotter --help | --version

Quote message text as one argument. Use -- before text beginning with a dash.
All API commands accept --auth-file PATH; otherwise they reuse the Codex login.
Omitting --room selects the primary Dot. History defaults to 20 messages.
Watch defaults to a 3-second poll interval and new messages only; --from-start
includes available history. JSON watch output is one message per line (NDJSON).
Ctrl+C stops watching. Authentication credentials are never printed.

This uses an internal API which may change. Sending is explicit and is never
automatically retried. Keep the printed request key when checking an uncertain
send result. auth login runs the installed codex login command.
auth logout runs codex logout and signs out the shared Codex CLI session.
watch --all watches every discovered Dot room; it cannot use --room or --cursor-file.

History and files:
  dotter history [--room ID] [--pages 1..100] [--json]
  dotter search --query TEXT [--room ID | --all] [--pages N] [--since ISO] [--until ISO]
  dotter thread MESSAGE_ID [--room ID] [--pages N]
  dotter outline [--room ID] [--pages N]
  dotter export --output FILE [--format json|md] [--room ID] [--pages N] [--overwrite]
  dotter upload FILE [--room ID] [--state-file FILE]
  dotter download FILE_ID --output FILE [--room ID] [--overwrite]
  dotter artifacts [--room ID] [--pages N]
  dotter chat [--room ID] [--interval SECONDS]

Actions and Dot management:
  dotter actions [--room ID] [--limit 1..20] [--before CURSOR | --after CURSOR]
  dotter action inspect MESSAGE_ID [--room ID]
  dotter action respond MESSAGE_ID --request-id ID --fingerprint FP --action accept|decline|cancel
    [--content-file JSON] [--persist session|always] [--room ID]
  dotter react MESSAGE_ID (--emoji EMOJI | --clear) [--room ID]
  dotter read MESSAGE_ID [--room ID]
  dotter email MESSAGE_ID [--room ID]
  dotter profile [--dot ID]
  dotter rename NAME --dot ID
  dotter pause --dot ID
  dotter resume --dot ID
  dotter tasks [--dot ID] [--limit N] [--cursor CURSOR]
  dotter task ID [--dot ID]
  dotter threads all [--dot ID] [--limit N] [--cursor CURSOR]

Routines and connected apps:
  dotter routine list [--dot ID | --all] [--filter scheduled|paused|finished] [--limit N] [--cursor CURSOR]
  dotter routine get ID
  dotter routine create --spec FILE
  dotter routine update ID --spec FILE
  dotter routine enable|disable|delete ID
  dotter routine run ID [--key UUID]
  dotter routine runs ID [--limit N] [--cursor CURSOR]
  dotter routine result ID --run RUN_ID (RUN_ID from routine runs, not the run receipt)
  dotter connectors list [--connector ID]
  dotter tools CONNECTOR [--link ID] [--cursor CURSOR]
  dotter tool-call CONNECTOR NAME (--args JSON | --args-file FILE) [--link ID]
  dotter connector-actions CONNECTOR
  dotter resources CONNECTOR [--link ID] [--cursor CURSOR]
  dotter resource CONNECTOR URI [--link ID]
  dotter resource-templates CONNECTOR [--link ID] [--cursor CURSOR]
  dotter prompts CONNECTOR [--link ID] [--cursor CURSOR]
  dotter capabilities
  dotter auth refresh [--auth-file PATH]

These commands print JSON, except interactive chat. JSON input files must be
UTF-8 objects no larger than 256 KiB. Mutation commands execute only when
explicitly invoked. capabilities works offline without credentials.


Dot lifecycle and runtime:
  dotter dot create NAME [--spec JSON_FILE]
  dotter dot delete ID --confirm ID
  dotter dot primary ID
  dotter dot clear-primary --generation VALUE --confirm
  dotter dot avatar ID --spec JSON_FILE
  dotter dot avatar-upload FILE [--manifest JSON_FILE]
  dotter dot ensure-room|root [--dot ID]
  dotter dot reboot [--dot ID] --confirm ID
  dotter environment status [--dot ID] [--thread ID]
  dotter environment recreate [--dot ID] [--thread ID] --confirm ID
  dotter computer list [--dot ID] [--thread ID]
  dotter computer connect ENV_ID [--dot ID] [--thread ID]
  dotter computer replace|disconnect ENV_ID --confirm ENV_ID [--dot ID] [--thread ID]
  dotter doctor check-in --thread ID
  dotter doctor setup --thread ID --confirm
  dotter safety review [--dot ID]
  dotter safety resume [--dot ID] --fingerprint VALUE --confirm ID

Live events and room state:
  dotter room|typing|prepare [--room ID]
  dotter task-subscription TASK_ID [--room ID]
  dotter events watch [--room ID | --all] [--task ID] [--duration SECONDS] [--no-reconnect]
  dotter task-events watch [--dot ID] [--task ID] [--duration SECONDS] [--no-reconnect]
  dotter activity list [--dot ID] [--cursor CURSOR] [--limit N]
  dotter activity watch [--dot ID] [--duration SECONDS] [--no-reconnect]
  dotter activity room [--room ID] [--duration SECONDS] [--no-reconnect]

Email, meetings and voice:
  dotter email-channel status|options [--dot ID]
  dotter email-channel claim --local-part NAME --domain DOMAIN --consent [--dot ID]
  dotter email-channel link INBOX_ID --consent [--dot ID]
  dotter email-channel unlink --confirm [--dot ID]
  dotter meeting start GOOGLE_MEET_URL [--dot ID] [--key UUID]
  dotter voice chat [--dot ID] [--root-thread ID] [--listen-only] [--no-open]
  dotter voice allocate --sdp-file FILE [--dot ID] [--root-thread ID]
  dotter voice attach|stop CALL_ID [--dot ID]

More routines and connections:
  dotter routine threads ID [--cursor CURSOR] [--limit N]
  dotter routine mark-read ID --run RUN_ID
  dotter routine latest|batch ID
  dotter routine flush-batch ID [--key UUID]
  dotter routine policy [--service-account ID]
  dotter connector info|health ID [--link ID (health only)]
  dotter connection info ID
  dotter connection status ID [--link ID]
  dotter connection oauth ID [--spec JSON_FILE]
  dotter connection reauthorize ID --link ID [--spec JSON_FILE]
  dotter connection complete ID --redirect-file FILE_OR_DASH
  dotter connection api-key ID --key-file FILE_OR_DASH [--spec JSON_FILE]
  dotter connection no-auth ID
  dotter connection unlink ID --link ID --confirm

Account file library:
  dotter library browse [--directory ID] [--query TEXT] [--category TYPE] [--folders-only]
  dotter library search [--query TEXT] [--trash] [--limit N] [--cursor CURSOR]
  dotter library get FILE_ID [--include-trashed]
  dotter library rename FILE_ID NAME
  dotter library move FILE_ID --directory ID
  dotter library trash FILE_ID --confirm FILE_ID
  dotter library restore FILE_ID
  dotter library versions FILE_ID [--limit N] [--cursor CURSOR]
  dotter library restore-version FILE_ID --version N --expected-version N --confirm FILE_ID
  dotter library favorites|usage
  dotter library favorite FILE_ID
  dotter library unfavorite FAVORITE_ID
  dotter library favorite-status FILE_ID,FILE_ID
  dotter library directory-path DIRECTORY_ID
  dotter library rename-directory DIRECTORY_ID NAME
  dotter library move-directory DIRECTORY_ID --parent ID

Live commands emit NDJSON. task-events watches native task-state updates for
one Dot; events --task watches that task's room messages. A task-resync event
indicates that task-list reconciliation is needed, not an empty task list.
Explicit confirmation flags apply to the named
command only; they are not a global bypass. Connection secrets are read from
files or stdin, never passed as command arguments. All connection commands
accept --account ID to pin the account returned by the OAuth start command.
```

The extended definitions below replace any older synopsis for the same command, including Library browse, search, and folder moves.

## Extended commands (270)

### account capabilities

List the implemented account-scoped APIs.

```sh
dotter account capabilities
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### account memories capacity

Read saved-memory token capacity for the selected account.

```sh
dotter account memories capacity
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account memories clear

Clear saved account memories; confirm the exact account ID.

```sh
dotter account memories clear
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--delete-history` | sets true | `deleteHistory` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `accountId`.

### account memories delete

Delete one saved memory after confirming its exact ID.

```sh
dotter account memories delete MEMORYID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `memoryId`.

### account memories list

List visible saved memories for the selected account.

```sh
dotter account memories list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account memories warm

Restore normal priority to a saved memory.

```sh
dotter account memories warm MEMORYID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account notifications get

Read account notification categories and channels.

```sh
dotter account notifications get
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account notifications update

Update notification channels after fresh catalog validation.

```sh
dotter account notifications update
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--updates` | json | `updates` |
| `--file` | jsonFile | `updates` |

Required fields: `accountId`, `updates`.

### account personality traits

Read nondeprecated personality traits and levels.

```sh
dotter account personality traits
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account personality types

Read available personality choices.

```sh
dotter account personality types
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account personalization get

Read account custom instructions and personality preferences.

```sh
dotter account personalization get
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account personalization update

Patch instructions/preferences; personality choices are validated against fresh catalogs.

```sh
dotter account personalization update
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--update` | json | `update` |
| `--file` | jsonFile | `update` |

Required fields: `accountId`, `update`.

### account projects connections complete

Submit a matching private OAuth callback once and verify the exact active account link.

```sh
dotter account projects connections complete
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | secretPath | `stateFile` |
| `--redirect-file` | secretPath | `redirectFile` |

Required fields: `accountId`, `stateFile`, `redirectFile`.

### account projects connections get

Read native project-provider metadata for google_drive, slack or linear.

```sh
dotter account projects connections get PROJECTID CONNECTORTYPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects connections no-auth

Connect only when this native provider advertises no-auth, then verify its exact link.

```sh
dotter account projects connections no-auth PROJECTID CONNECTORTYPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | secretPath | `stateFile` |

Required fields: `accountId`, `stateFile`.

### account projects connections oauth

Start one browser authorization, bound to a private account/user/project journal.

```sh
dotter account projects connections oauth PROJECTID CONNECTORTYPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | secretPath | `stateFile` |
| `--actions` | list | `actionNames` |
| `--scopes` | list | `requestedScopes` |

Required fields: `accountId`, `stateFile`.

### account projects connections operation

Inspect or reconcile a private provider-operation journal without replaying auth requests.

```sh
dotter account projects connections operation
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | secretPath | `stateFile` |

Required fields: `accountId`, `stateFile`.

### account projects connections reauthorize

Reauthorize one exact existing provider link using a private handoff journal.

```sh
dotter account projects connections reauthorize PROJECTID CONNECTORTYPE LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | secretPath | `stateFile` |
| `--scopes` | list | `requestedScopes` |

Required fields: `accountId`, `stateFile`.

### account projects connections status

Read current project-SKU provider status; a supplied link is checked exactly.

```sh
dotter account projects connections status PROJECTID CONNECTORTYPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--link` | string | `linkId` |

Required fields: `accountId`.

### account projects connections tos

Read project-provider consent text and policy links without accepting or connecting.

```sh
dotter account projects connections tos PROJECTID CONNECTORTYPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects conversations

List visible conversations belonging to one readable account project; page size is 1–50.

```sh
dotter account projects conversations PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--limit` | number | `limit` |
| `--pages` | number | `pages` |
| `--cursor` | string | `cursor` |
| `--owned-only` | sets true | `ownedOnly` |
| `--all-accessible` | sets false | `ownedOnly` |

Required fields: `accountId`.

### account projects create

Create one private native account project and verify its persisted fields; creation memory scope is unset (default), global or project_v2.

```sh
dotter account projects create NAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--emoji` | string | `emoji` |
| `--theme` | string | `theme` |
| `--memory-scope` | string | `memoryScope` |

Required fields: `accountId`.

### account projects delete

Permanently delete a project and ALL its chats after fresh delete-permission checks. Saved Library/Space files are retained. Requires exact ID confirmation and --delete-chats.

```sh
dotter account projects delete PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--delete-chats` | sets true | `deleteChats` |

Required fields: `accountId`, `confirm`, `deleteChats`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects files attach-library

Attach existing ready native Library files after fresh identity, project permission, private/default-memory and file-limit checks.

```sh
dotter account projects files attach-library PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--ids` | list | `libraryFileIds` |

Required fields: `accountId`, `libraryFileIds`.

### account projects files list

List project file membership and current file capacity without reading file contents.

```sh
dotter account projects files list PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects files remove

Remove one exact project source. Sends no Library or general Files deletion; confirm its project file ID.

```sh
dotter account projects files remove PROJECTID FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `fileId`.

### account projects files upload

Upload a local file through the native project-specific reservation, transfer, processing and membership flow, recording a private recovery journal.

```sh
dotter account projects files upload PROJECTID FILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | path | `stateFile` |
| `--mime` | string | `mimeType` |
| `--resume-parts` | sets true | `resumeParts` |

Required fields: `accountId`, `stateFile`.

### account projects files upload-reconcile

Reconcile an uncertain native project upload through read-only checks; never reserve, process or attach again.

```sh
dotter account projects files upload-reconcile
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | path | `stateFile` |

Required fields: `accountId`, `stateFile`.

### account projects files upload-status

Inspect a private project-upload journal without replaying its writes.

```sh
dotter account projects files upload-status
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--state-file` | path | `stateFile` |

Required fields: `accountId`, `stateFile`.

### account projects get

Read one native g-p- project with safe file metadata and instructions.

```sh
dotter account projects get PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects list

List native account projects with cursor pagination; defaults to owned projects. Verified page-size range: 1–50.

```sh
dotter account projects list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--limit` | number | `limit` |
| `--pages` | number | `pages` |
| `--cursor` | string | `cursor` |
| `--owned-only` | sets true | `ownedOnly` |
| `--all-accessible` | sets false | `ownedOnly` |

Required fields: `accountId`.

### account projects memory get

Read project memory configuration and current service-readable eligibility.

```sh
dotter account projects memory get PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects memory set

Change an eligible private project to global or project_v2 memory and verify the stored setting; conversation behavior may propagate later.

```sh
dotter account projects memory set PROJECTID SCOPE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects pin

Pin a freshly verified readable project and confirm the pin list.

```sh
dotter account projects pin PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects pinned

List pinned native account projects.

```sh
dotter account projects pinned
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects saves create

Save an eligible visible assistant response from this project; an existing save is returned unchanged.

```sh
dotter account projects saves create PROJECTID CONVERSATIONID MESSAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects saves get

Read one saved response through its fully paginated project source collection.

```sh
dotter account projects saves get PROJECTID SAVEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects saves list

List native project saved-response metadata with cursor pagination and the native 100-item page size.

```sh
dotter account projects saves list PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--pages` | number | `pages` |
| `--cursor` | string | `cursor` |

Required fields: `accountId`.

### account projects saves remove

Remove a saved response from the project for everyone with access. Requires the exact saved-response ID.

```sh
dotter account projects saves remove PROJECTID SAVEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `saveId`.

### account projects saves rename

Rename one project saved response with a trimmed title of 1 to 200 characters.

```sh
dotter account projects saves rename PROJECTID SAVEID TITLE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects sharing access

Set private (invited people retain access), link, or workspace_link access. Work conversations block expansion. First sharing may detach Library sources after acknowledgment.

```sh
dotter account projects sharing access PROJECTID ACCESS
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--detach-library-files` | sets true | `detachLibraryFiles` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects sharing get

Read fresh project sharing subjects, roles, link audience and native workspace permissions.

```sh
dotter account projects sharing get PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects sharing invite

Invite explicit recipients using --subjects JSON [{"type":"email","email":"person@example.com"}] or workspace user/userId and group/groupId records; roles are chat or edit (default). May send invitations.

```sh
dotter account projects sharing invite PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--detach-library-files` | sets true | `detachLibraryFiles` |
| `--subjects` | json | `subjects` |
| `--subjects-file` | jsonFile | `subjects` |
| `--role` | string | `role` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects sharing remove

Remove a current user:, group: or email: subject. They lose access to all project content. Requires exact project confirmation.

```sh
dotter account projects sharing remove PROJECTID SUBJECT
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--detach-library-files` | sets true | `detachLibraryFiles` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects sharing role

Change a current user:, group: or email: subject to chat or edit after fresh owner and sharing-permission checks.

```sh
dotter account projects sharing role PROJECTID SUBJECT ROLE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--detach-library-files` | sets true | `detachLibraryFiles` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `projectId`.

### account projects sources add

Add a website, google_drive, slack or linear source; verify persistence and start eligible connector sync.

```sh
dotter account projects sources add PROJECTID CONNECTORTYPE URL
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--wait` | sets true | `wait` |
| `--timeout` | number | `timeout` |
| `--interval` | number | `interval` |

Required fields: `accountId`.

### account projects sources get

Read one exact project source with current synchronization metadata.

```sh
dotter account projects sources get PROJECTID SCOPEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects sources list

List visible native connector and website project sources, 100 per page.

```sh
dotter account projects sources list PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--pages` | number | `pages` |
| `--cursor` | string | `cursor` |

Required fields: `accountId`.

### account projects sources providers

Check existing provider connections using the native CHATGPT_PROJECTS product scope.

```sh
dotter account projects sources providers PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--type` | string | `connectorType` |

Required fields: `accountId`.

### account projects sources remove

Remove a source from this project and verify absence. Shared changes affect every member.

```sh
dotter account projects sources remove PROJECTID SCOPEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |
| `--shared` | sets true | `shared` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `scopeId`.

### account projects sources sync

Request one native connector synchronization; accepted and completed states remain distinct.

```sh
dotter account projects sources sync PROJECTID SCOPEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--wait` | sets true | `wait` |
| `--timeout` | number | `timeout` |
| `--interval` | number | `interval` |

Required fields: `accountId`.

### account projects sources wait

Wait for an existing connector synchronization without restarting it; website sources do not synchronize.

```sh
dotter account projects sources wait PROJECTID SCOPEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--timeout` | number | `timeout` |
| `--interval` | number | `interval` |

Required fields: `accountId`.

### account projects unpin

Unpin a freshly verified readable project and confirm the pin list.

```sh
dotter account projects unpin PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account projects update

Update name, emoji, native palette color or instructions after fresh write-permission checks; existing memory scope is preserved.

```sh
dotter account projects update PROJECTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--emoji` | string | `emoji` |
| `--theme` | string | `theme` |
| `--name` | string | `name` |
| `--instructions` | string | `instructions` |
| `--instructions-file` | textFile | `instructions` |
| `--clear-emoji` | sets true | `clearEmoji` |
| `--clear-theme` | sets true | `clearTheme` |

Required fields: `accountId`.

### account reference-photos add

Upload and save a self or full_body_likeness reference photo.

```sh
dotter account reference-photos add FILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--kind` | string | `kind` |

### account reference-photos delete

Delete a saved reference-photo tag with exact ID confirmation.

```sh
dotter account reference-photos delete IMAGETAGID
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | string | `confirmImageTagId` |

Required fields: `confirmImageTagId`.

Exact confirmation: `confirmImageTagId` must equal `imageTagId`.

### account reference-photos list

List saved account reference-photo identities and asset pointers.

```sh
dotter account reference-photos list
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### account reference-photos replace

Replace the image in an existing account reference-photo tag.

```sh
dotter account reference-photos replace IMAGETAGID FILE
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### account settings get

Read supported account settings and their allowed feature names.

```sh
dotter account settings get
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account settings set

Set one verified account feature with a typed JSON value.

```sh
dotter account settings set FEATURE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--value` | json | `value` |

Required fields: `accountId`, `value`.

### account summary actions

Read the supported summary selection actions.

```sh
dotter account summary actions
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### account summary checksum

Read memory-summary cache freshness.

```sh
dotter account summary checksum
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |

Required fields: `accountId`.

### account summary clear

Disable account memory and clear its summary cache; confirm the account ID.

```sh
dotter account summary clear
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `accountId`.

### account summary correct

Correct the current memory summary with optional section/selection targeting.

```sh
dotter account summary correct
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |
| `--text` | string | `correction` |
| `--text-file` | textFile | `correction` |
| `--section` | string | `targetSectionId` |
| `--selection` | string | `targetText` |
| `--conversation` | string | `conversationId` |

Required fields: `accountId`, `correction`.

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### account summary forget

Ask memory to forget a selected section or topic; confirm its section or account ID.

```sh
dotter account summary forget
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |
| `--text` | string | `correction` |
| `--text-file` | textFile | `correction` |
| `--section` | string | `targetSectionId` |
| `--selection` | string | `targetText` |
| `--conversation` | string | `conversationId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `correction`, `confirm`.

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### account summary get

Retrieve the account memory summary; the API may generate its cache.

```sh
dotter account summary get
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |
| `--context` | json | `contextualHint` |
| `--context-file` | jsonFile | `contextualHint` |

Required fields: `accountId`.

### account summary regenerate

Explicitly regenerate the account memory summary once.

```sh
dotter account summary regenerate
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |
| `--context` | json | `contextualHint` |
| `--context-file` | jsonFile | `contextualHint` |

Required fields: `accountId`.

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### account summary stream

Stream the visible memory-summary sections once.

```sh
dotter account summary stream
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--source` | string | `source` |
| `--context` | json | `contextualHint` |
| `--context-file` | jsonFile | `contextualHint` |

Required fields: `accountId`.

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### account voices

Read voice choices and safe preview links for a language; mode is standard, advanced (default), or wingman. No audio is fetched.

```sh
dotter account voices
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--language` | string | `language` |
| `--mode` | string | `mode` |

Required fields: `accountId`, `language`.

### actions native approve-email-code

Approve the exact browser email-code request without reading or printing the code.

```sh
dotter actions native approve-email-code MESSAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--request` | string | `requestId` |
| `--fingerprint` | string | `requestFingerprint` |
| `--confirm` | string | `confirm` |

Required fields: `requestId`, `requestFingerprint`, `confirm`.

Exact confirmation: `confirm` must equal `requestId`.

### actions native complete

Verify that human review resolved the exact native request; performs no approval write.

```sh
dotter actions native complete
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--session-file` | path | `sessionFile` |

Required fields: `sessionFile`.

### actions native inspect

Inspect native approval metadata without exposing device challenges or email-code handles.

```sh
dotter actions native inspect MESSAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--request` | string | `requestId` |
| `--fingerprint` | string | `requestFingerprint` |

### actions native start

Open exact first-party human review for location, identity, wallet, or browser approval.

```sh
dotter actions native start MESSAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--request` | string | `requestId` |
| `--fingerprint` | string | `requestFingerprint` |
| `--session-file` | path | `sessionFile` |
| `--no-open` | sets true | `noOpen` |

Required fields: `requestId`, `requestFingerprint`, `sessionFile`.

### actions native status

Read the bound native request status without resending its response.

```sh
dotter actions native status
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--session-file` | path | `sessionFile` |

Required fields: `sessionFile`.

### connector admin get

Inspect the complete connector schema and actions.

```sh
dotter connector admin get CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin mcp-create

Create a personal custom MCP connector.

```sh
dotter connector admin mcp-create
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--name` | string | `name` |
| `--description` | string | `description` |
| `--target` | json | `target` |
| `--auth-config` | jsonFile | `authRequest` |
| `--client-secret-file` | secretPath | `clientSecretFile` |
| `--logo` | path | `logoFile` |

Accepts `--spec FILE` containing a JSON object with: `name`, `description`, `target`, `authRequest`. Explicit flags and spec fields cannot provide the same value.

Required fields: `name`, `target`, `authRequest`.

### connector admin mcp-update

Update a custom MCP name, description, or PNG logo.

```sh
dotter connector admin mcp-update CONNECTORID FIELD
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--value` | string | `value` |
| `--logo` | path | `logoFile` |

### connector admin mfa

Read connector MFA requirements.

```sh
dotter connector admin mfa CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin oauth

Start browser OAuth with explicit scopes and companion apps.

```sh
dotter connector admin oauth CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--actions` | list | `actionNames` |
| `--scopes` | list | `requestedScopes` |
| `--link-params` | json | `linkParams` |
| `--companions` | list | `companionConnectorIds` |
| `--slack-team` | string | `slackTeamId` |

Accepts `--spec FILE` containing a JSON object with: `actionNames`, `requestedScopes`, `linkParams`, `companionConnectorIds`, `slackTeamId`. Explicit flags and spec fields cannot provide the same value.

### connector admin oauth-callback

Get the registered MCP OAuth callback ID.

```sh
dotter connector admin oauth-callback
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--target` | json | `target` |

Accepts `--spec FILE` containing a JSON object with: `target`. Explicit flags and spec fields cannot provide the same value.

Required fields: `target`.

### connector admin oauth-clients

List existing OAuth client metadata for a service.

```sh
dotter connector admin oauth-clients SERVICE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin oauth-config

Discover MCP OAuth configuration.

```sh
dotter connector admin oauth-config
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--target` | json | `target` |

Accepts `--spec FILE` containing a JSON object with: `target`. Explicit flags and spec fields cannot provide the same value.

Required fields: `target`.

### connector admin privacy

Set the selected connection privacy policy.

```sh
dotter connector admin privacy CONNECTORID LINKID POLICY
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin refresh-actions

Refresh a custom MCP connection action catalog.

```sh
dotter connector admin refresh-actions CONNECTORID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin tos

Read connector terms of service.

```sh
dotter connector admin tos CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin tunnels

List available personal MCP tunnels.

```sh
dotter connector admin tunnels
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector admin unlink-all

Disconnect every account for one connector.

```sh
dotter connector admin unlink-all CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirmConnectorId` |

Required fields: `confirmConnectorId`.

Exact confirmation: `confirmConnectorId` must equal `connectorId`.

### connector service-account api-key

Connect a service account using a private API-key file.

```sh
dotter connector service-account api-key SERVICEACCOUNTUSERID CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--key-file` | secretPath | `keyFile` |
| `--actions` | list | `actionNames` |
| `--link-params` | json | `linkParams` |

Required fields: `keyFile`.

### connector service-account links

List visible connector links on one service account.

```sh
dotter connector service-account links SERVICEACCOUNTUSERID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector service-account no-auth

Connect a no-auth connector on one service account.

```sh
dotter connector service-account no-auth SERVICEACCOUNTUSERID CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector service-account oauth

Start OAuth for a selected service account.

```sh
dotter connector service-account oauth SERVICEACCOUNTUSERID CONNECTORID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--actions` | list | `actionNames` |
| `--scopes` | list | `requestedScopes` |
| `--link-params` | json | `linkParams` |

Accepts `--spec FILE` containing a JSON object with: `actionNames`, `requestedScopes`, `linkParams`. Explicit flags and spec fields cannot provide the same value.

### connector service-account read-only

Restrict a selected service-account connector link to reads.

```sh
dotter connector service-account read-only SERVICEACCOUNTUSERID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"readOnly":true}`.

### connector service-account read-write

Allow writes on a selected service-account connector link.

```sh
dotter connector service-account read-write SERVICEACCOUNTUSERID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"readOnly":false}`.

### connector service-account unlink

Disconnect a selected service-account link.

```sh
dotter connector service-account unlink SERVICEACCOUNTUSERID CONNECTORID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirmLinkId` |

Required fields: `confirmLinkId`.

Exact confirmation: `confirmLinkId` must equal `linkId`.

### connector service-account workspace-connections

List workspace connections assigned to one service account.

```sh
dotter connector service-account workspace-connections SERVICEACCOUNTUSERID TEAMID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### connector service-account workspace-disable

Disable a workspace connection on one service account.

```sh
dotter connector service-account workspace-disable SERVICEACCOUNTUSERID TEAMID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":false}`.

### connector service-account workspace-enable

Enable a workspace connection on one service account.

```sh
dotter connector service-account workspace-enable SERVICEACCOUNTUSERID TEAMID LINKID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":true}`.

### conversation archive

Archive an account conversation.

```sh
dotter conversation archive CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation batch

Read exact account conversation metadata.

```sh
dotter conversation batch
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--ids` | list | `conversationIds` |

Required fields: `conversationIds`.

### conversation clear-async-status

Clear account conversation unread activity status.

```sh
dotter conversation clear-async-status CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation delete

Delete an account conversation with exact-ID confirmation.

```sh
dotter conversation delete CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `conversationId`.

### conversation get

Read the selected visible account conversation branch.

```sh
dotter conversation get CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation history

Read visible account history with native pagination.

```sh
dotter conversation history CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--before` | string | `before` |
| `--turns` | number | `numTurns` |
| `--pages` | number | `pages` |

### conversation inbox list

Read the account activity inbox.

```sh
dotter conversation inbox list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--unread-only` | sets true | `unreadOnly` |
| `--all-items` | sets false | `unreadOnly` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

### conversation inbox mark-read

Mark exact account inbox items as read.

```sh
dotter conversation inbox mark-read
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--ids` | list | `itemIds` |

Required fields: `itemIds`.

### conversation list

List account conversations by last update with native filters; --order accepts updated only.

```sh
dotter conversation list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--offset` | number | `offset` |
| `--order` | string | `order` |
| `--origin` | string | `conversationOrigin` |
| `--exclude-origin` | string | `excludeConversationOrigin` |
| `--expand` | sets true | `expand` |
| `--hide-snorlax` | sets true | `hideSnorlax` |
| `--show-snorlax` | sets false | `hideSnorlax` |
| `--archived` | sets true | `archived` |
| `--not-archived` | sets false | `archived` |
| `--starred` | sets true | `starred` |
| `--not-starred` | sets false | `starred` |

### conversation move-project

Move an account conversation to a project or account root.

```sh
dotter conversation move-project CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--project` | string | `projectId` |
| `--root` | sets true | `root` |

### conversation pin

Pin an account conversation.

```sh
dotter conversation pin CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation rename

Rename an account conversation.

```sh
dotter conversation rename CONVERSATIONID TITLE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation responses

List visible response variants with their selected-branch state.

```sh
dotter conversation responses CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation search

Search account conversations; omit internal match snippets.

```sh
dotter conversation search QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--cursor` | string | `cursor` |

### conversation select-response

Select a visible assistant response branch.

```sh
dotter conversation select-response CONVERSATIONID NODEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation shares create

Create a visible conversation snapshot; --publish creates a public link.

```sh
dotter conversation shares create CONVERSATIONID NODEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--publish` | sets true | `publish` |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `conversationId`.

### conversation shares get

Read share metadata without exposing its raw transcript.

```sh
dotter conversation shares get SHAREID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation shares list

List the signed-in account’s owned conversation shares.

```sh
dotter conversation shares list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation shares revoke

Revoke an owned account conversation link.

```sh
dotter conversation shares revoke SHAREID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `shareId`.

### conversation shares update

Update a verified owned conversation share with exact-ID confirmation.

```sh
dotter conversation shares update SHAREID NODEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--title` | string | `title` |
| `--publish` | sets true | `publish` |
| `--unpublish` | sets false | `publish` |
| `--visible` | sets true | `visible` |
| `--hide` | sets false | `visible` |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `shareId`.

### conversation unarchive

Unarchive an account conversation.

```sh
dotter conversation unarchive CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### conversation unpin

Unpin an account conversation.

```sh
dotter conversation unpin CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### dot avatar-default

Set a legacy avatar only while the Dot still has its default avatar.

```sh
dotter dot avatar-default DOTID AVATAR
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

Defaults: `{"onlyIfDefault":true}`.

### dot onboarding create

Create and initialize a Dot using the native server flow, with a private recovery journal.

```sh
dotter dot onboarding create
```

| Option | Value | Field |
| --- | --- | --- |
| `--state-file` | path | `operationFile` |
| `--name` | string | `name` |
| `--avatar` | string | `avatar` |
| `--first-dot` | sets false | `createAdditional` |

Required fields: `operationFile`.

### dot onboarding eligibility

Read selected-account Dot availability. Eligibility does not establish permission to create a Dot.

```sh
dotter dot onboarding eligibility
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### dot onboarding resume

Reconcile a saved onboarding operation and finish its messaging room; never replay Dot creation.

```sh
dotter dot onboarding resume OPERATIONFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--dot` | string | `dotId` |
| `--confirm` | string | `confirmDotId` |
| `--retry-room` | sets true | `retryRoom` |

Exact confirmation: `confirmDotId` must equal `dotId`.

### dot onboarding status

Read onboarding recovery status and new candidate identities without creating or sending.

```sh
dotter dot onboarding status OPERATIONFILE
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### dot primary-thread

Select the primary Dot through the legacy thread-ID route.

```sh
dotter dot primary-thread THREADID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### dot recover-deletion

Retry pending deletion finalization; this does not restore deleted Dots.

```sh
dotter dot recover-deletion
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | sets true | `confirm` |

Required fields: `confirm`.

### library browse

Browse account Library files, folders, provider roots, and Pages.

```sh
dotter library browse
```

| Option | Value | Field |
| --- | --- | --- |
| `--directory` | string | `directoryId` |
| `--query` | string | `query` |
| `--cursor` | string | `cursor` |
| `--categories` | list | `categories` |
| `--category` | list | `categories` |
| `--folders-only` | sets true | `foldersOnly` |
| `--source` | string | `source` |
| `--include-files` | sets true | `includeFiles` |
| `--include-saved-entities` | sets true | `includeSavedEntities` |
| `--include-provider-roots` | sets true | `includeProviderRoots` |
| `--include-pages` | sets true | `includePages` |
| `--include-sites` | sets true | `includeSites` |
| `--include-folder-counts` | sets true | `includeFolderCounts` |
| `--include-onedrive` | sets true | `includeOneDrive` |
| `--hydrate-folder-thumbnails` | sets true | `hydrateFolderThumbnails` |
| `--files-and-folders` | sets false | `foldersOnly` |
| `--exclude-files` | sets false | `includeFiles` |
| `--exclude-saved-entities` | sets false | `includeSavedEntities` |
| `--exclude-provider-roots` | sets false | `includeProviderRoots` |
| `--exclude-pages` | sets false | `includePages` |
| `--exclude-sites` | sets false | `includeSites` |
| `--exclude-folder-counts` | sets false | `includeFolderCounts` |
| `--exclude-onedrive` | sets false | `includeOneDrive` |
| `--no-hydrate-folder-thumbnails` | sets false | `hydrateFolderThumbnails` |

### library content

Save Library content privately, with optional byte range.

```sh
dotter library content FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--output` | path | `output` |
| `--overwrite` | sets true | `overwrite` |
| `--max-bytes` | number | `maxBytes` |
| `--range` | string | `range` |
| `--page` | string | `pageId` |

Required fields: `output`.

### library conversation-favorites

List Library favorites originating from an account conversation.

```sh
dotter library conversation-favorites CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

### library create-directory

Create a Library folder; omitting --parent selects the root.

```sh
dotter library create-directory NAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--parent` | string | `parentDirectoryId` |

### library create-inline

Create a Library note from text, at most 1 MiB.

```sh
dotter library create-inline FILENAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--content-file` | textFile | `content` |
| `--content` | string | `content` |
| `--directory` | string | `directoryId` |
| `--create-key` | string | `createKey` |

Required fields: `content`.

Uses a UUID request key in `createKey`; the generated or supplied key is printed before the operation. No automatic mutation retries.

### library deep-research

Read visible saved-report preview state.

```sh
dotter library deep-research FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library deep-research-export

Request report export; optionally save filtered result JSON.

```sh
dotter library deep-research-export FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--args` | json | `args` |
| `--output` | path | `output` |
| `--overwrite` | sets true | `overwrite` |

### library deep-research-images

Read saved-report inline image data.

```sh
dotter library deep-research-images FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--args` | json | `args` |

### library deep-research-state

Read visible saved-report state through its native tool.

```sh
dotter library deep-research-state FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--args` | json | `args` |

### library delete-batch

Soft-delete up to 25 exact, explicitly confirmed Library file IDs.

```sh
dotter library delete-batch
```

| Option | Value | Field |
| --- | --- | --- |
| `--files` | list | `fileIds` |
| `--confirm-files` | list | `confirmFileIds` |

Required fields: `fileIds`, `confirmFileIds`.

### library delete-directory

Delete a Library folder using its exact ID confirmation.

```sh
dotter library delete-directory DIRECTORYID
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `directoryId`.

### library delete-permanently

Permanently delete one regular Library file or current, unshared native saved chat snapshot by exact ID; snapshot removal preserves its source conversation.

```sh
dotter library delete-permanently FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `fileId`.

### library directory-path

Read a folder path or the Library root path.

```sh
dotter library directory-path [DIRECTORYID]
```

| Option | Value | Field |
| --- | --- | --- |
| `--root` | sets true | `root` |

### library download

Save Library download bytes privately, up to 100 MiB.

```sh
dotter library download FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--output` | path | `output` |
| `--overwrite` | sets true | `overwrite` |
| `--max-bytes` | number | `maxBytes` |
| `--range` | string | `range` |
| `--page` | string | `pageId` |

Required fields: `output`.

### library empty-trash

Permanently clear Library file trash; requires EMPTY LIBRARY TRASH.

```sh
dotter library empty-trash
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

### library global-search

Run a federated Library, files, and Pages search.

```sh
dotter library global-search QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| `--query-id` | string | `queryId` |
| `--cursor` | string | `cursor` |
| `--limit` | number | `limit` |
| `--entrypoint` | string | `entrypoint` |
| `--providers` | list | `providers` |
| `--external-accounts` | json | `externalAccountKeys` |
| `--lanes` | list | `lanes` |
| `--directory` | string | `directoryId` |
| `--file-types` | list | `fileTypes` |
| `--source` | string | `source` |
| `--allowlist` | list | `allowlistIds` |
| `--include-sites` | sets true | `includeSites` |
| `--include-pages` | sets true | `includePages` |
| `--page-source` | string | `spaceSearchSource` |
| `--include-space-files` | sets true | `includeSpaceFiles` |
| `--ownership` | string | `ownership` |
| `--page-search-target` | string | `pageSearchTarget` |
| `--exclude-sites` | sets false | `includeSites` |
| `--exclude-pages` | sets false | `includePages` |
| `--exclude-space-files` | sets false | `includeSpaceFiles` |

### library image-favorites add

Save an image source to account Library favorites.

```sh
dotter library image-favorites add
```

| Option | Value | Field |
| --- | --- | --- |
| `--source` | json | `source` |

Required fields: `source`.

### library image-favorites status

Read favorite state for up to 50 image sources.

```sh
dotter library image-favorites status
```

| Option | Value | Field |
| --- | --- | --- |
| `--sources` | json | `sources` |

Required fields: `sources`.

### library move

Move an account file into a folder or to the Library root.

```sh
dotter library move FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--directory` | string | `directoryId` |
| `--root` | sets true | `root` |

### library move-directory

Move a folder into a parent or to the Library root.

```sh
dotter library move-directory DIRECTORYID
```

| Option | Value | Field |
| --- | --- | --- |
| `--parent` | string | `parentDirectoryId` |
| `--root` | sets true | `root` |

### library opened

Record a Library file as opened.

```sh
dotter library opened FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library plan-summary

Read a saved learning-plan summary.

```sh
dotter library plan-summary FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library providers capabilities

Inspect account-linked provider and link browsing capabilities.

```sh
dotter library providers capabilities
```

| Option | Value | Field |
| --- | --- | --- |
| `--provider` | string | `provider` |
| `--link` | string | `linkId` |

### library providers materialize

Materialize a mounted file; retrieval indexing is opt-in.

```sh
dotter library providers materialize FILEID NAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--mime` | string | `mimeType` |
| `--index` | sets true | `indexForRetrieval` |
| `--no-index` | sets false | `indexForRetrieval` |

### library providers metadata

Read provider metadata for an exact mounted file.

```sh
dotter library providers metadata PROVIDER FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library providers onedrive-status

Inspect the native OneDrive capability state.

```sh
dotter library providers onedrive-status
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library providers preview

Request a provider preview, exposing only sanitized source links.

```sh
dotter library providers preview PROVIDER FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library providers resolve

Resolve a provider URL or a Google Drive/Box native file ID.

```sh
dotter library providers resolve PROVIDER
```

| Option | Value | Field |
| --- | --- | --- |
| `--url` | string | `url` |
| `--native-id` | string | `nativeFileId` |

### library providers search

Search selected mounted file providers.

```sh
dotter library providers search QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| `--providers` | list | `providers` |
| `--limit` | number | `limit` |

Required fields: `providers`.

### library providers search-cache

Read one provider search cache without implicit live fallback.

```sh
dotter library providers search-cache QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| `--provider` | string | `provider` |
| `--limit` | number | `limit` |

Required fields: `provider`.

### library recents

List recently opened account Library files.

```sh
dotter library recents
```

| Option | Value | Field |
| --- | --- | --- |
| `--limit` | number | `limit` |
| `--providers` | list | `providers` |
| `--external-accounts` | json | `externalAccountKeys` |

### library references add

Save an already uploaded sediment image as a named reference.

```sh
dotter library references add ASSETPOINTER
```

| Option | Value | Field |
| --- | --- | --- |
| `--name` | string | `entityName` |
| `--type` | string | `entityType` |
| `--idempotency-key` | string | `idempotencyKey` |

Required fields: `entityName`, `entityType`.

Uses a UUID request key in `idempotencyKey`; the generated or supplied key is printed before the operation. No automatic mutation retries.

### library references add-suggestion

Save an exact account reference-image suggestion.

```sh
dotter library references add-suggestion
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

Accepts `--spec FILE` containing a JSON object with: `entityName`, `entityType`, `entityDescription`, `imageIndex`, `libraryFileId`, `sourceConversationId`, `sourceMessageId`, `suggestionMessageId`. Explicit flags and spec fields cannot provide the same value.

Required fields: `entityName`, `entityType`, `entityDescription`, `libraryFileId`, `sourceConversationId`, `sourceMessageId`, `suggestionMessageId`.

Defaults: `{"requestKind":"suggestion_library"}`.

### library references delete

Delete a saved reference image using exact-ID confirmation.

```sh
dotter library references delete REFERENCEIMAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--confirm` | string | `confirm` |

Required fields: `confirm`.

Exact confirmation: `confirm` must equal `referenceImageId`.

### library references list

List saved account reference-image metadata.

```sh
dotter library references list
```

| Option | Value | Field |
| --- | --- | --- |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

### library references thumbnail

Inspect thumbnail availability or save it privately.

```sh
dotter library references thumbnail REFERENCEIMAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--output` | path | `output` |
| `--overwrite` | sets true | `overwrite` |
| `--no-overwrite` | sets false | `overwrite` |

### library references update

Update an existing reference-image name and type.

```sh
dotter library references update REFERENCEIMAGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--name` | string | `entityName` |
| `--type` | string | `entityType` |

Required fields: `entityName`, `entityType`.

### library register-upload

Finalize an external-provider upload in an eligible existing provider folder. Requires its general Files ID and --parent; native and room uploads are already registered. Provider finalization remains live-unverified.

```sh
dotter library register-upload FILEID FILENAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--parent` | string | `parentDirectoryId` |
| `--mime` | string | `mimeType` |

Required fields: `parentDirectoryId`.

### library saved capabilities

Describe native account Library saved-entity operations and typed constructors.

```sh
dotter library saved capabilities
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library saved get

Read one native saved-entity Library node and verify its current saved status.

```sh
dotter library saved get FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |

Required fields: `accountId`.

### library saved move

Move a saved entity to an accessible native folder or the Library root; verify status.

```sh
dotter library saved move FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--directory` | string | `directoryId` |
| `--root` | sets true | `root` |

Required fields: `accountId`.

### library saved remove

Remove a saved entity using its exact confirmed Library node; verify it is no longer saved.

```sh
dotter library saved remove FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `confirm`.

Exact confirmation: `confirm` must equal `fileId`.

### library saved save

Save one typed product/local-business spec and verify the returned Library ID.

```sh
dotter library saved save
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--file` | jsonFile | `spec` |

Required fields: `accountId`, `spec`.

### library saved status

Read saved status for 1 to 100 typed product/local-business specs.

```sh
dotter library saved status
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--specs-file` | jsonFile | `specs` |

Required fields: `accountId`, `specs`.

### library search

Search Library files; --providers selects external services and --include-native-files includes native entries.

```sh
dotter library search
```

| Option | Value | Field |
| --- | --- | --- |
| `--query` | string | `query` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |
| `--categories` | list | `categories` |
| `--category` | list | `categories` |
| `--trash` | sets true | `trash` |
| `--state` | string | `state` |
| `--source` | string | `source` |
| `--ranking` | string | `ranking` |
| `--providers` | list | `providers` |
| `--external-accounts` | json | `externalAccountKeys` |
| `--allowlist` | list | `allowlistIds` |
| `--include-native-files` | sets true | `includeNativeFiles` |
| `--include-uploaded-files` | sets true | `includeUploadedFiles` |
| `--include-imagegen-files` | sets true | `includeImagegenFiles` |
| `--include-saved-entities` | sets true | `includeSavedEntities` |
| `--include-pages` | sets true | `includePages` |
| `--include-sites` | sets true | `includeSites` |
| `--exclude-space-roots` | sets true | `excludeSpaceRoots` |
| `--not-trash` | sets false | `trash` |
| `--exclude-native-files` | sets false | `includeNativeFiles` |
| `--exclude-uploaded-files` | sets false | `includeUploadedFiles` |
| `--exclude-imagegen-files` | sets false | `includeImagegenFiles` |
| `--exclude-saved-entities` | sets false | `includeSavedEntities` |
| `--exclude-pages` | sets false | `includePages` |
| `--exclude-sites` | sets false | `includeSites` |
| `--include-space-roots` | sets false | `excludeSpaceRoots` |

### library shared-search

Search files and folders shared with the account.

```sh
dotter library shared-search QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library sharing accept

Accept one pending invitation; requires invitation confirmation.

```sh
dotter library sharing accept INVITATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--resource` | string | `resourceId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `accountUserId`, `confirm`.

Exact confirmation: `confirm` must equal `invitationId`.

### library sharing apply

Revalidate and apply a saved access preview; requires resource confirmation.

```sh
dotter library sharing apply RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--preview` | jsonFile | `preview` |

Accepts `--spec FILE` containing a JSON object with: `preview`. Explicit flags and spec fields cannot provide the same value.

Required fields: `accountId`, `accountUserId`, `confirm`, `preview`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing capabilities

Describe audited Library sharing capabilities and guards.

```sh
dotter library sharing capabilities
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### library sharing collaborators

Read collaborators and optional access-request context.

```sh
dotter library sharing collaborators RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--request-ids` | list | `accessRequestIds` |

Required fields: `accountId`, `accountUserId`.

Defaults: `{"resourceKind":"file"}`.

### library sharing decide

Approve or decline one pending recipient request; requires owner and resource confirmation.

```sh
dotter library sharing decide RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--request` | string | `requestId` |
| `--recipient` | json | `recipient` |
| `--decision` | string | `decision` |

Accepts `--spec FILE` containing a JSON object with: `requestId`, `recipient`, `decision`. Explicit flags and spec fields cannot provide the same value.

Required fields: `accountId`, `accountUserId`, `confirm`, `requestId`, `recipient`, `decision`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing decline

Decline one pending invitation; requires invitation confirmation.

```sh
dotter library sharing decline INVITATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--resource` | string | `resourceId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |

Required fields: `accountId`, `accountUserId`, `confirm`.

Exact confirmation: `confirm` must equal `invitationId`.

### library sharing effective

Read effective collaborator access.

```sh
dotter library sharing effective RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |

Required fields: `accountId`, `accountUserId`.

Defaults: `{"resourceKind":"file"}`.

### library sharing grant

Invite a recipient or update an observed direct share; requires resource confirmation.

```sh
dotter library sharing grant RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--recipient` | json | `recipient` |
| `--role` | string | `role` |
| `--expected-share` | string | `expectedInvitationId` |

Accepts `--spec FILE` containing a JSON object with: `recipient`, `role`, `expectedInvitationId`. Explicit flags and spec fields cannot provide the same value.

Required fields: `accountId`, `accountUserId`, `confirm`, `recipient`, `role`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing identity

Discover the actual server user principal for an accessible Library resource within the selected account.

```sh
dotter library sharing identity RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--kind` | string | `resourceKind` |

Required fields: `accountId`.

Defaults: `{"resourceKind":"file"}`.

### library sharing invitation

Inspect a received Library invitation.

```sh
dotter library sharing invitation INVITATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--resource` | string | `resourceId` |
| `--kind` | string | `resourceKind` |

Required fields: `accountId`, `accountUserId`.

### library sharing invitations

List received Library invitations in the selected account.

```sh
dotter library sharing invitations
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--cursor` | string | `cursor` |
| `--limit` | number | `limit` |

Required fields: `accountId`, `accountUserId`.

### library sharing leave

Leave a direct share or remove its Shared With Me entry; requires resource confirmation.

```sh
dotter library sharing leave RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--share` | string | `shareId` |

Required fields: `accountId`, `accountUserId`, `confirm`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing link

Set workspace or collaborators-only link access; requires owner and resource confirmation.

```sh
dotter library sharing link RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--mode` | string | `mode` |
| `--role` | string | `role` |
| `--workspace` | string | `workspaceId` |

Required fields: `accountId`, `accountUserId`, `confirm`, `mode`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing preview

Preview a permission change with a server fingerprint.

```sh
dotter library sharing preview RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--recipient` | json | `recipient` |
| `--role` | json | `desiredRole` |

Required fields: `accountId`, `accountUserId`, `recipient`, `desiredRole`.

Defaults: `{"resourceKind":"file"}`.

### library sharing request

Ask the owner to share with specified recipients; requires resource confirmation.

```sh
dotter library sharing request RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--recipients` | json | `recipients` |
| `--role` | string | `role` |

Accepts `--spec FILE` containing a JSON object with: `recipients`, `role`. Explicit flags and spec fields cannot provide the same value.

Required fields: `accountId`, `accountUserId`, `confirm`, `recipients`, `role`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing requests

List owner or requester access requests.

```sh
dotter library sharing requests RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--side` | string | `side` |
| `--cursor` | string | `cursor` |

Required fields: `accountId`, `accountUserId`.

Defaults: `{"resourceKind":"file"}`.

### library sharing resolve

Resolve an invitation recipient within the selected account.

```sh
dotter library sharing resolve EMAIL
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |

Required fields: `accountId`, `accountUserId`.

### library sharing revoke

Remove a current direct share; requires resource confirmation.

```sh
dotter library sharing revoke RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |
| `--confirm` | string | `confirm` |
| `--share` | string | `shareId` |

Required fields: `accountId`, `accountUserId`, `confirm`, `shareId`.

Defaults: `{"resourceKind":"file"}`.

Exact confirmation: `confirm` must equal `resourceId`.

### library sharing shares

List every page of direct shares with current owner validation.

```sh
dotter library sharing shares RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |

Required fields: `accountId`, `accountUserId`.

Defaults: `{"resourceKind":"file"}`.

### library sharing state

Read scoped file or folder permissions.

```sh
dotter library sharing state RESOURCEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `accountId` |
| `--user` | string | `accountUserId` |
| `--kind` | string | `resourceKind` |

Required fields: `accountId`, `accountUserId`.

Defaults: `{"resourceKind":"file"}`.

### library thumbnail

Save a Library thumbnail privately.

```sh
dotter library thumbnail FILEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--output` | path | `output` |
| `--overwrite` | sets true | `overwrite` |
| `--max-bytes` | number | `maxBytes` |
| `--range` | string | `range` |
| `--page` | string | `pageId` |

Required fields: `output`.

### library update-inline

Replace a Library note with explicit file ID confirmation.

```sh
dotter library update-inline FILEID FILENAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--content-file` | textFile | `content` |
| `--content` | string | `content` |
| `--confirm` | string | `confirm` |

Required fields: `content`, `confirm`.

Exact confirmation: `confirm` must equal `fileId`.

### library upload

Upload up to512 MiB to Library with private recovery state; folder destinations stage at root before a verified move. Explicit --resume-parts repeats only unchanged uncommitted blocks; uncertain commit, processing or move is never replayed.

```sh
dotter library upload FILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--state-file` | path | `stateFile` |
| `--directory` | string | `directoryId` |
| `--mime` | string | `mimeType` |
| `--resume-parts` | sets true | `resumeParts` |

Required fields: `expectedAccountId`, `stateFile`.

### library upload-reconcile

Read back the exact uploaded file mapping after interruption; never retry an uncertain write.

```sh
dotter library upload-reconcile
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--state-file` | path | `stateFile` |

Required fields: `expectedAccountId`, `stateFile`.

### library upload-status

Inspect a private Library upload journal without replaying a request.

```sh
dotter library upload-status
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--state-file` | path | `stateFile` |

Required fields: `expectedAccountId`, `stateFile`.

### mail accounts

List connected Gmail, Outlook and contacts account readiness.

```sh
dotter mail accounts
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### mail contacts

Search recipient suggestions through an explicitly selected contacts link.

```sh
dotter mail contacts QUERY
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--link` | string | `linkId` |

Required fields: `linkId`.

### mail send

Send mail once through an explicitly selected authorized Gmail or Outlook account.

```sh
dotter mail send
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--provider` | string | `provider` |
| `--link` | string | `linkId` |
| `--to` | list | `to` |
| `--cc` | list | `cc` |
| `--bcc` | list | `bcc` |
| `--subject` | string | `subject` |
| `--body-file` | textFile | `body` |
| `--send-id` | string | `sendId` |
| `--reply` | json | `replyTo` |
| `--source-id` | string | `sourceId` |
| `--source-type` | string | `sourceType` |

Accepts `--spec FILE` containing a JSON object with: `provider`, `linkId`, `to`, `cc`, `bcc`, `subject`, `body`, `sendId`, `replyTo`, `sourceId`, `sourceType`. Explicit flags and spec fields cannot provide the same value.

Required fields: `provider`, `linkId`, `subject`, `body`.

Uses a UUID request key in `sendId`; the generated or supplied key is printed before the operation. No automatic mutation retries.

### mail status

Reconcile the original mail send ID without resending.

```sh
dotter mail status SENDID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### mail undo

Request undo inside the original send receipt’s undo deadline.

```sh
dotter mail undo SENDID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--expires` | string | `unsendExpiresAt` |

Required fields: `unsendExpiresAt`.

### message auth complete

Verify a private provider callback and continue the original message.

```sh
dotter message auth complete REFERENCE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--session-file` | path | `sessionFile` |
| `--callback-file` | secretPath | `callbackFile` |
| `--resume` | sets true | `resume` |

Required fields: `sessionFile`.

### message auth get

Inspect a message-bound connect or reauthentication request.

```sh
dotter message auth get REFERENCE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--connect` | sets true | `connect` |

### message auth start

Start message-bound OAuth and save its capability privately.

```sh
dotter message auth start REFERENCE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--connect` | sets true | `connect` |
| `--fingerprint` | string | `requestFingerprint` |
| `--session-file` | path | `sessionFile` |

Required fields: `requestFingerprint`, `sessionFile`.

### message plugins continue

Continue the exact message with selected connected plugin IDs.

```sh
dotter message plugins continue REFERENCE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--plugins` | list | `pluginIds` |
| `--fingerprint` | string | `requestFingerprint` |

Required fields: `pluginIds`, `requestFingerprint`.

### message plugins get

Inspect plugins requested by a message continuation.

```sh
dotter message plugins get REFERENCE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin batch

Inspect up to 50 hosted plugins.

```sh
dotter plugin batch
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--ids` | list | `pluginIds` |

Required fields: `pluginIds`.

### plugin catalog

Browse the hosted plugin catalog.

```sh
dotter plugin catalog
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |
| `--scope` | string | `scope` |

Defaults: `{"view":"catalog"}`.

### plugin created

List plugins created in this workspace.

```sh
dotter plugin created
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

Defaults: `{"view":"created"}`.

### plugin delete

Delete a plugin owned by the selected account.

```sh
dotter plugin delete PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirmPluginId` |

Required fields: `confirmPluginId`.

Exact confirmation: `confirmPluginId` must equal `pluginId`.

### plugin disable

Disable an installed hosted plugin.

```sh
dotter plugin disable PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":false}`.

### plugin enable

Enable an installed hosted plugin.

```sh
dotter plugin enable PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":true}`.

### plugin export

Download a hosted plugin ZIP into a private local file.

```sh
dotter plugin export PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--out` | path | `output` |
| `--overwrite` | sets true | `overwrite` |

Required fields: `output`.

### plugin get

Inspect a hosted plugin.

```sh
dotter plugin get PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin home

Read featured plugin catalog sections.

```sh
dotter plugin home
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin import

Import a bounded archive; exactly one of --state-file or --reservation-file is required.

```sh
dotter plugin import
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--file` | path | `file` |
| `--plugin` | string | `pluginId` |
| `--confirm` | string | `confirmPluginId` |
| `--state-file` | secretPath | `stateFile` |
| `--reservation-file` | secretPath | `reservationFile` |

Required fields: `file`.

### plugin import-status

Read a private upload journal without exposing its signed URL.

```sh
dotter plugin import-status
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--state-file` | secretPath | `stateFile` |

Required fields: `stateFile`.

### plugin install

Install a hosted plugin; provider authorization remains separate.

```sh
dotter plugin install PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--request-id` | string | `installAttemptId` |

Uses a UUID request key in `installAttemptId`; the generated or supplied key is printed before the operation. No automatic mutation retries.

### plugin list

List hosted plugins installed on the selected account.

```sh
dotter plugin list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |
| `--include-extensions` | sets true | `includeExtensions` |

Defaults: `{"view":"installed"}`.

### plugin resolve-app

Resolve the hosted plugin belonging to an exact app or connector ID.

```sh
dotter plugin resolve-app APPID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin search

Search the hosted plugin catalog.

```sh
dotter plugin search Q
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |
| `--scope` | string | `scope` |

Defaults: `{"view":"catalog"}`.

### plugin service-account install

Install a plugin for a selected team service account.

```sh
dotter plugin service-account install SERVICEACCOUNTUSERID TEAMID PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin service-account list

List plugins installed on a selected team service account.

```sh
dotter plugin service-account list SERVICEACCOUNTUSERID TEAMID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin service-account uninstall

Uninstall a plugin from a selected team service account.

```sh
dotter plugin service-account uninstall SERVICEACCOUNTUSERID TEAMID PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirmPluginId` |

Required fields: `confirmPluginId`.

Exact confirmation: `confirmPluginId` must equal `pluginId`.

### plugin share

Replace plugin share targets and discoverability.

```sh
dotter plugin share PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--targets` | json | `targets` |
| `--discoverability` | string | `discoverability` |

Accepts `--spec FILE` containing a JSON object with: `targets`, `discoverability`. Explicit flags and spec fields cannot provide the same value.

Required fields: `targets`.

### plugin shared

List plugins shared in this workspace.

```sh
dotter plugin shared
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

Defaults: `{"view":"shared"}`.

### plugin shares

Inspect a plugin sharing policy.

```sh
dotter plugin shares PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin skill

Read one plugin skill without download tokens.

```sh
dotter plugin skill PLUGINID SKILLNAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### plugin skill-disable

Disable one hosted plugin skill.

```sh
dotter plugin skill-disable PLUGINID SKILLNAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":false}`.

### plugin skill-enable

Enable one hosted plugin skill.

```sh
dotter plugin skill-enable PLUGINID SKILLNAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

Defaults: `{"enabled":true}`.

### plugin uninstall

Uninstall a hosted plugin from the selected account.

```sh
dotter plugin uninstall PLUGINID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirmPluginId` |

Required fields: `confirmPluginId`.

Exact confirmation: `confirmPluginId` must equal `pluginId`.

### remote auth availability

Read credential availability metadata for an existing browser sign-in challenge.

```sh
dotter remote auth availability CONVERSATIONID CHALLENGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--trigger` | string | `trigger` |

### remote auth candidates

List candidate account labels and origins without secret values or selection capabilities.

```sh
dotter remote auth candidates CONVERSATIONID CHALLENGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--cursor` | string | `cursor` |

### remote auth claim

Claim an owner-only durable operation bound to the current challenge, exact web origin and signed-in user.

```sh
dotter remote auth claim STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--message` | string | `messageId` |
| `--fingerprint` | string | `requestFingerprint` |
| `--origin` | string | `expectedOrigin` |

Required fields: `roomId`, `messageId`, `requestFingerprint`, `expectedOrigin`.

### remote auth fill

Submit one private field-ID JSON input to the claimed challenge; remember explicitly requests supported credential saving.

```sh
dotter remote auth fill STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--credentials` | secretPath | `credentialsFile` |
| `--option` | string | `selectedOption` |
| `--remember` | sets true | `remember` |

Required fields: `credentialsFile`.

### remote auth inspect

Inspect a current visible browser-auth request and its authoritative origin, fields, and fingerprint.

```sh
dotter remote auth inspect
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--message` | string | `messageId` |

Required fields: `roomId`, `messageId`.

### remote auth operation

Read safe status from a private browser-auth operation; never prints credential values or access handles.

```sh
dotter remote auth operation STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth password-manager open

Open the verified onepassword approval deep link in the native password manager.

```sh
dotter remote auth password-manager open STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth password-manager start

Request 1Password access for the current claimed challenge and save its capability privately.

```sh
dotter remote auth password-manager start STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth password-manager status

Check this exact 1Password approval request once; does not submit credentials.

```sh
dotter remote auth password-manager status STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth password-manager use

Recheck approval and submit the approved 1Password access handle once to the claimed challenge.

```sh
dotter remote auth password-manager use STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth prepare

Prepare an existing browser sign-in challenge; returns metadata without credentials or fill capabilities.

```sh
dotter remote auth prepare CONVERSATIONID CHALLENGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth qr open

Open a private rotating QR viewer, including its current verified request-card payload.

```sh
dotter remote auth qr open CONVERSATIONID CHALLENGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--no-open` | sets true | `noOpen` |
| `--room` | string | `roomId` |
| `--message` | string | `messageId` |
| `--fingerprint` | string | `requestFingerprint` |

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### remote auth qr status

Read QR availability without printing its payload; resolve a matching current request card or specify its room/message.

```sh
dotter remote auth qr status CONVERSATIONID CHALLENGEID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--room` | string | `roomId` |
| `--message` | string | `messageId` |
| `--fingerprint` | string | `requestFingerprint` |

### remote auth reconcile

Recover the fill/save status of an existing browser-auth operation.

```sh
dotter remote auth reconcile CONVERSATIONID CHALLENGEID OPERATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth recover

Reconcile an attempted operation with the server without resubmitting its credentials.

```sh
dotter remote auth recover STATEFILE
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote auth reuse

Use an unexpired saved-credential selection for the exact claimed origin, without exposing its capability.

```sh
dotter remote auth reuse STATEFILE CREDENTIALID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote browser

Open a local WebRTC viewer for an existing cloud browser conversation.

```sh
dotter remote browser CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--no-open` | sets true | `noOpen` |

Defaults: `{"source":"flora"}`.

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### remote browser legacy open

Open the authenticated legacy noVNC browser inside a private local viewer.

```sh
dotter remote browser legacy open CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--no-open` | sets true | `noOpen` |

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### remote browser legacy status

Check legacy noVNC availability without printing its authenticated URL.

```sh
dotter remote browser legacy status CONVERSATIONID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote computer

Open a local WebRTC viewer for the Dot computer; taking control requires an explicit browser click.

```sh
dotter remote computer
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--no-open` | sets true | `noOpen` |
| `--dot` | string | `dotId` |
| `--thread` | string | `threadId` |
| `--handoff-conversation` | string | `handoffConversationId` |
| `--handoff-tab` | string | `handoffTabId` |

Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.

### remote config

Read the cloud browser approval policy, per-site origins and WebAuthn availability.

```sh
dotter remote config
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote config set

Set always_ask, auto_approve or always_allow browser policy; confirm the exact account ID.

```sh
dotter remote config set
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--policy` | string | `policy` |
| `--approval-mode` | string | `approvalMode` |
| `--disable-auto-review` | sets true | `disableAutoReview` |
| `--enable-auto-review` | sets false | `disableAutoReview` |
| `--confirm` | string | `confirm` |

Required fields: `expectedAccountId`, `confirm`.

Exact confirmation: `confirm` must equal `expectedAccountId`.

### remote cookies clear

Clear a fingerprint-pinned cookie store; confirm the exact account ID.

```sh
dotter remote cookies clear
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--surface` | string | `surface` |
| `--target-fingerprint` | string | `targetFingerprint` |
| `--confirm` | string | `confirm` |

Required fields: `expectedAccountId`, `targetFingerprint`, `confirm`.

Exact confirmation: `confirm` must equal `expectedAccountId`.

### remote cookies delete

Delete one reviewed cookie host from a fingerprint-pinned store; confirm the exact hostname.

```sh
dotter remote cookies delete HOSTNAME
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--surface` | string | `surface` |
| `--include-subdomains` | sets true | `includeSubdomains` |
| `--target-fingerprint` | string | `targetFingerprint` |
| `--confirm` | string | `confirm` |

Required fields: `expectedAccountId`, `targetFingerprint`, `confirm`.

Exact confirmation: `confirm` must equal `hostname`.

### remote cookies list

List cookie host counts and a target fingerprint; default surface is Orbit (Dot).

```sh
dotter remote cookies list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--surface` | string | `surface` |

### remote origins list

List saved website origin patterns and allow/deny permissions.

```sh
dotter remote origins list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### remote origins remove

Remove one existing website origin permission; confirm the exact account ID.

```sh
dotter remote origins remove PATTERN
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirm` |

Required fields: `expectedAccountId`, `confirm`.

Exact confirmation: `confirm` must equal `expectedAccountId`.

### remote origins set

Set one native website origin permission to allow or deny; confirm the exact account ID.

```sh
dotter remote origins set PATTERN
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--decision` | string | `decision` |
| `--confirm` | string | `confirm` |

Required fields: `decision`, `expectedAccountId`, `confirm`.

Exact confirmation: `confirm` must equal `expectedAccountId`.

### remote passkeys delete

Delete one freshly verified saved browser passkey and check its absence; confirm the exact credential ID.

```sh
dotter remote passkeys delete CREDENTIALID
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |
| `--confirm` | string | `confirm` |

Required fields: `expectedAccountId`, `confirm`.

Exact confirmation: `confirm` must equal `credentialId`.

### remote passkeys list

List saved cloud-browser passkey metadata without credential key material.

```sh
dotter remote passkeys list
```

| Option | Value | Field |
| --- | --- | --- |
| `--account` | string | `expectedAccountId` |

### routine import-prompt

Prepare a shared-routine creation prompt; this does not create or run a routine.

```sh
dotter routine import-prompt POSTID
```

| Option | Value | Field |
| --- | --- | --- |
| `--title` | string | `title` |
| `--prompt` | string | `prompt` |
| `--prompt-file` | textFile | `prompt` |
| `--schedule` | string | `schedule` |
| `--timing-mode` | string | `timingMode` |

Accepts `--spec FILE` containing a JSON object with: `title`, `prompt`, `schedule`, `timingMode`. Explicit flags and spec fields cannot provide the same value.

Required fields: `title`, `prompt`, `schedule`, `timingMode`.

### routine query

Search, filter and sort personal, team or all accessible cloud routines.

```sh
dotter routine query
```

| Option | Value | Field |
| --- | --- | --- |
| `--scope` | string | `scope` |
| `--query` | string | `query` |
| `--status` | string | `status` |
| `--sort` | string | `sort` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

### routine share create

Publish a public share link for the selected routine.

```sh
dotter routine share create ROUTINEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### routine share current

Read the selected routine’s current public share.

```sh
dotter routine share current ROUTINEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### routine share refresh

Refresh the public share for the selected routine.

```sh
dotter routine share refresh ROUTINEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### routine share revoke

Revoke the selected routine’s public share.

```sh
dotter routine share revoke ROUTINEID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### routine shared

Read a shared routine’s source and import metadata.

```sh
dotter routine shared POSTID
```

| Option | Value | Field |
| --- | --- | --- |
| — | — | — |

### threads inventory

List Dot thread identities; hidden threads expose metadata only.

```sh
dotter threads inventory
```

| Option | Value | Field |
| --- | --- | --- |
| `--dot` | string | `dotId` |
| `--include-hidden` | sets true | `includeHidden` |
| `--limit` | number | `limit` |
| `--cursor` | string | `cursor` |

## Input types

- `json`: inline JSON, at most 256 KiB. `jsonFile`: a UTF-8 JSON file with the same limit; its top-level shape depends on the option. A `--spec` file must be an object.
- `textFile`: a regular UTF-8 file of at most 1 MiB. `secretPath`: a private credential or callback file; only commands documenting stdin accept `-`.
- `list`: comma-separated values. Boolean flags take no value; use the documented negative alias to select false.
- Numbers are nonnegative; each operation applies its own integer/range checks. IDs must come from the corresponding account API.

See [workflows](workflows.md) for examples and [contracts](contracts.md) for service limits. Testing and source/test mappings are documented in the source checkout.
