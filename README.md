<h1 align="center">dotter</h1>
<p align="center"><strong>Your dot. Your app. Your terminal.</strong></p>
<p align="center">A typed Node.js SDK and CLI for ChatGPT dots.</p>
<p align="center">
  <a href="https://github.com/jethros-projects/dotter/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-314f40?style=flat-square"></a>
  <a href="https://nodejs.org"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-314f40?style=flat-square"></a>
  <a href="https://github.com/jethros-projects/dotter/blob/main/docs/SDK.md"><img alt="Typed SDK" src="https://img.shields.io/badge/SDK-typed-314f40?style=flat-square"></a>
</p>
<p align="center">
  <a href="https://github.com/jethros-projects/dotter/blob/main/docs/SDK.md">SDK</a> ·
  <a href="https://github.com/jethros-projects/dotter/blob/main/docs/commands.md">CLI reference</a> ·
  <a href="https://github.com/jethros-projects/dotter/blob/main/docs/agents.md">For agents</a> ·
  <a href="https://github.com/jethros-projects/dotter/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![Dotter command overview in a terminal](https://raw.githubusercontent.com/jethros-projects/dotter/v0.6.3-next.2/docs/assets/dotter-terminal.png)](https://github.com/jethros-projects/dotter/blob/main/docs/commands.md)
<p align="center"><sub>Actual <code>dotter --help</code> output. No account data.</sub></p>

Build a client around your dot. Bring a conversation into a script. Give a coding agent a JSON interface to messages and files. One package provides the typed SDK and the CLI built on it.

### Installation

Requires **Node.js 22+**, the **Codex CLI with a ChatGPT login**, and eligible Dot access. Install the preview from npm:

```sh
npm install --global @jethros-projects/dotter@next --ignore-scripts

dotter --help
```

For an application, run `npm install @jethros-projects/dotter@next --ignore-scripts`. The package is `@jethros-projects/dotter`; the command is `dotter`. TypeScript declarations are included. No build step.

Core requests and polled streams use Node HTTPS. Advanced activity, room-live, and account-summary SSE workflows also require Python 3.

### Start a conversation

```sh
dotter auth login
dotter status --json
dotter history --limit 20 --json
dotter send "Turn our next steps into a three-item plan." --wait 30 --json
```

Already signed in through Codex? Start with `dotter auth status --json`. Message commands use your primary dot. Use `dotter dots --json` and `--room ID` to choose another one, or run `dotter chat` for an interactive conversation.

### Build your own client

```ts
import { createClient } from '@jethros-projects/dotter';

const dot = createClient();

try {
  const { roomId } = await dot.primary();
  const sent = await dot.send({
    roomId,
    text: 'Turn our next steps into a three-item plan.',
  });
  const page = await dot.history({ roomId, limit: 20 });

  console.log(sent.messageId, page.messages);
} finally {
  await dot.close();
}
```

The root SDK covers Dot discovery, messages, search, watching, uploads, downloads, and artifacts. It provides typed inputs, cancellation, bounded subscriptions, and structured errors. Keep it in a trusted Node host or backend for desktop, browser, and mobile clients. See the [SDK guide](https://github.com/jethros-projects/dotter/blob/main/docs/SDK.md) for streaming and credential ownership.

### Messages, files, and automation

```sh
dotter send "Make a plan from these notes." --attach ./notes.txt --wait 30 --json
dotter watch --from-start --duration 30 --json
dotter search --query "release plan" --pages 2 --json
dotter artifacts --pages 2 --json
```

Supply your own `./notes.txt` before running the attachment example. Sends return acceptance by default; waiting observes a later reply, not completion of every background task. Writes are never automatically retried. Keep the request key when reconciling an uncertain result.

Library, routines, account projects, and connected tools have specialist commands and advanced APIs. Start with `dotter library --help`, `dotter routine --help`, or `dotter account projects --help`; their scopes and verification limits differ from the core SDK.

### For agents

Use `dotter --help` to discover commands and `dotter help COMMAND` for exact arguments. Prefer `--json`, discover target IDs before using them, and bound watches with `--duration`. The [agent runbook](https://github.com/jethros-projects/dotter/blob/main/docs/agents.md) covers exit codes, file handling, cancellation, and recovery after uncertain writes. Repository agents should start with [AGENTS.md](https://github.com/jethros-projects/dotter/blob/main/AGENTS.md).

### Access and status

Dotter is an **independent, unofficial project** using an undocumented OpenAI API. It is not affiliated with or endorsed by OpenAI. A valid Codex login does not guarantee Dot access; plan, region, workspace, and rollout still apply. Check [OpenAI's current availability](https://learn.chatgpt.com/docs/dots#access).

The `next` channel is a public preview. Offline SDK and package checks pass, but a clean full real-account run remains blocked by intermittent Cloudflare challenges. Not every advanced operation has been verified live. See [service boundaries](https://github.com/jethros-projects/dotter/blob/main/docs/contracts.md) and the [release gate](https://github.com/jethros-projects/dotter/blob/main/docs/releasing.md) before relying on it in an application.

### Documentation

| Guide | Start here for |
| --- | --- |
| [SDK](https://github.com/jethros-projects/dotter/blob/main/docs/SDK.md) | Typed APIs, subscriptions, authentication, and errors |
| [CLI reference](https://github.com/jethros-projects/dotter/blob/main/docs/commands.md) | Commands, flags, and input formats |
| [For agents](https://github.com/jethros-projects/dotter/blob/main/docs/agents.md) | Bounded workflows and machine output |
| [Workflows](https://github.com/jethros-projects/dotter/blob/main/docs/workflows.md) | Library, routines, projects, and connected tools |
| [Architecture](https://github.com/jethros-projects/dotter/blob/main/docs/architecture.md) | Module boundaries and implementation map |

### Contributing

```sh
npm ci --ignore-scripts
npm run verify
```

Contributing also requires Python 3 for test fixtures. Verification runs offline: syntax, generated references, strict types, regressions, and a consumer of the packed npm package. Read [Contributing](https://github.com/jethros-projects/dotter/blob/main/CONTRIBUTING.md) before opening a pull request and [Security](https://github.com/jethros-projects/dotter/blob/main/SECURITY.md) for private reports.

---

[MIT](https://github.com/jethros-projects/dotter/blob/main/LICENSE) · [Third-party notices](https://github.com/jethros-projects/dotter/blob/main/THIRD_PARTY_NOTICES.md) · Built by [Jethro](https://github.com/jethros-projects) and contributors.
