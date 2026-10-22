# Architecture

Dotter is SDK-first. A small typed public client owns common application
operations; the CLI parses arguments, calls that client, and renders results.
JavaScript modules run directly, with matching declarations for TypeScript.
There is no transpilation or framework layer.

| Location | Responsibility |
| --- | --- |
| `src/runtime.mjs` | Internal Node security floor, evaluated before SDK and CLI logic |
| `src/index.mjs`, `src/index.d.ts` | Canonical typed SDK entrypoint |
| `src/native.mjs`, `src/advanced.d.ts` | Explicit lower-level service APIs |
| `bin/dotter.mjs` | Process entrypoint, safe errors, and exit codes |
| `src/cli.mjs` | Argument dispatch and terminal interaction |
| `src/help.mjs` | Short introduction and discovery from existing definitions |
| `src/commands.mjs` | Message and file command adapters |
| `src/v3-commands.mjs` | Lifecycle, event, connection, and voice dispatch |
| `src/command-sets/` | Declarative definitions for extended commands |
| `src/v4-registry.json` | Generated command registry; do not edit by hand |
| `src/v4-commands.mjs` | Registry parsing, validation, and dispatch |
| `src/*.mjs` | Focused clients and shared domain behavior |
| `src/transport.mjs`, `src/node-http.mjs`, `src/http-node/` | Fixed-origin Node HTTPS, bounded responses, and verified file streams |
| `src/sdk-guards.mjs` | Cached native client facades with explicit cancellation call shapes |
| `src/stream-http*`, `src/http.mjs`, `src/http.py` | Optional advanced Python SSE and explicit legacy transport compatibility |
| `test/` | Offline contract, SDK, and regression tests |
| `test/types/` | Strict TypeScript consumer fixtures with negative cases |
| `scripts/` | Syntax, generated-artifact, type, and packed-package checks |

`createClient()` returns `DotterClient`. Importing or constructing it does not
read credentials or start work. Each request validates its public input before
resolving authentication and service dependencies. The SDK owns normalization,
common errors, request cancellation, and bounded subscriptions. `close()` ends
that client's work without logging out. Injected resources remain host-owned
unless ownership is explicitly transferred.

Core commands call the public client instead of implementing a separate domain
path. CLI adapters may project camelCase SDK results into the established CLI
output format. Native commands use explicit service modules for provider-specific
operations. The executable alone owns process exit behavior.

Established parser layers retain existing argument contracts. New extended
commands belong in a focused command set instead of another parser layer. A
command set supplies its client factory, command definitions, flags, and target
methods; `npm run registry` merges those definitions and checks collisions.
The registry drives extended dispatch, help, and generated command references.
The source map in `docs/coverage.json` links commands to tests without carrying
private service-audit evidence.

Runtime tests use synthetic transports and authentication providers; no live
account is needed. `npm run typecheck` compiles public consumer fixtures in
strict NodeNext mode. `npm run test:package` packs and installs the release into
an isolated directory, then compiles those same fixtures against the installed
exports and exercises imports and CLI behavior. TypeScript is a development
dependency, not a runtime requirement.

Ordinary requests never launch a subprocess or base64-encode HTTP bodies. They
use Node HTTPS with no redirects, challenge bypass, browser impersonation, or
automatic write retries. Source identity, hashes, framing, response limits, and
credential origin guards remain enforced. Advanced SSE retains its existing
Python bridge; core `watch()` polls through the Node transport.
Each default transport lazily owns a bounded HTTPS connection pool, released by
its `close()` method. Standalone `nodeFetch` calls retain isolated connections;
injected fetch functions remain caller-owned.
