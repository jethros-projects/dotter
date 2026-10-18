# Dotter

Your Dot, from the terminal. Send messages, follow conversations, manage files,
and work with connected apps through a small, discoverable command-line interface.

Dotter is an independent, unofficial client for OpenAI Dot. It uses your existing
Codex login and an internal API that can change without notice. A ChatGPT account
with access to Dot is required.

## Get started

Requirements: Node.js 22+, Python 3, and the Codex CLI.

```sh
npm ci --ignore-scripts
npm install --global .
dotter auth login
dotter status
dotter send "Hello from the terminal"
dotter history
```

This is installation from a source checkout. Registry publication is separate.
Already signed in to Codex? Start with `dotter auth status`.

## Find your way

```sh
dotter                     # A short introduction
dotter help send           # Message options
dotter library --help      # Commands in an area
dotter help library browse # A specific command
dotter --help-all          # The complete reference
dotter chat                # Interactive conversation
dotter watch               # Follow new messages
dotter history --json      # Structured output for scripts
```

Message commands select your primary Dot. Use `--room ID` to choose another room;
management commands use `--dot ID`. Most commands return JSON; event streams
return one JSON object per line. Quote message text as one argument, or use
`--file FILE` / `--stdin`. Put `--` before text beginning with a dash.

Commands run only when you invoke them. Writes are never automatically retried.
Keep printed request keys if a response is uncertain. Destructive operations
require the confirmation shown in their help.

## Authentication and compatibility

Dotter reads `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`, in place.
`--auth-file PATH` selects another existing Codex cache. Login, logout, and
explicit refresh delegate to Codex; **logout signs out the shared Codex session**.
Tokens are not copied into the project or printed.

The command previously called `dot-chat` is now `dotter`. Replace that executable
name in scripts; command arguments and existing authentication stay compatible.
The browser-auth claim ledger retains its existing `dot-cli` storage directory
to preserve one-time claims. `DOTTER_STATE_DIR` takes precedence over the legacy
`DOT_CLI_STATE_DIR` override.

## Documentation

- [Workflow guide](docs/workflows.md): messages, Library, routines, connected apps, projects, and voice.
- [Command reference](docs/commands.md): generated flags and input types.
- [Architecture](docs/architecture.md): a map for contributors.
- [Service boundaries](docs/contracts.md): supported contracts and verification limits.
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md). The source checkout
  also includes `docs/testing.md` with source/test mappings.

## Develop

```sh
npm ci --ignore-scripts
npm run verify
```

No build step is required. Runtime code is standard JavaScript modules; Python
provides the bounded HTTPS bridge. Tests run offline with synthetic fixtures.

Licensed under [MIT](LICENSE). Vendored and bundled dependencies retain their
own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
