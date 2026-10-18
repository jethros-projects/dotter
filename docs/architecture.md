# Architecture

Dotter runs directly from JavaScript modules. There is no transpilation or
framework layer.

| Location | Responsibility |
| --- | --- |
| `bin/dotter.mjs` | Process entrypoint, safe errors, and exit codes |
| `src/cli.mjs` | Established command parsing and orchestration |
| `src/help.mjs` | Short introduction and discovery from existing definitions |
| `src/commands.mjs` | Established message, file, and routine commands |
| `src/v3-commands.mjs` | Lifecycle, event, connection, and voice dispatch |
| `src/command-sets/` | Declarative definitions for extended commands |
| `src/v4-registry.json` | Generated command registry; do not edit by hand |
| `src/v4-commands.mjs` | Registry parsing, validation, and dispatch |
| `src/index.mjs` | Public programmatic exports |
| `src/*.mjs` | Focused clients for each service area |
| `src/transport.mjs`, `src/http*`, `src/stream-http*` | Fixed-origin requests and bounded Python HTTPS bridges |
| `test/` | Offline contract and regression tests |
| `scripts/` | Syntax, generated-artifact, and package checks |

Established parser layers retain existing argument contracts. New extended
commands belong in a focused command set instead of another parser layer. A
command set supplies its client factory, command definitions, flags, and target
methods; `npm run registry` merges those definitions and checks collisions.

The registry drives extended dispatch, help, and generated command references.
The source map in `docs/coverage.json` links commands to tests without carrying
private service-audit evidence.

Importing the public API or displaying help does not read credentials or perform
requests. The executable alone owns process exit behavior. Operation clients
accept dependencies so tests can exercise behavior without a live account.
