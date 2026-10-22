# Working on Dotter

## Find the right layer

- [README](README.md): capabilities, install, and quick start.
- [Agent runbook](docs/agents.md): operating the CLI and SDK in a task.
- [SDK guide](docs/SDK.md): public contracts, cancellation, and ownership.
- [Architecture](docs/architecture.md): module navigation and boundaries.
- [Contributing](CONTRIBUTING.md): changes, fixtures, and release checks.

## Setup and checks

Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those major lines; Python 3 runs legacy/SSE and terminal test fixtures. No build step.

```sh
npm ci --ignore-scripts
npm run verify
```

`verify` covers syntax, generated command documentation, strict types, offline
regressions, and a TypeScript consumer of the packed/installed npm package.
Use `npm run typecheck` or `npm run test:package` for those focused checks.
After command-definition changes, run `npm run registry`, `npm run docs`, and
`npm run coverage:docs`, then verify again.

## Keep changes within the architecture

Put shared behavior in the SDK. Keep CLI code to argument/input handling,
client calls, terminal output, and process signals. Reuse existing native domain
clients; avoid duplicate protocol code or a new general framework.
Keep `src/index.d.ts` aligned with `src/index.mjs` and `src/advanced.d.ts` with
`src/native.mjs`. Preserve public camelCase names and explicit native shapes.
Maintain bounded inputs/streams, identity guards, cancellation, private file
permissions, and the existing rule against retrying mutations automatically.
Use synthetic, offline fixtures by default. For live integration work, follow
[existing contribution guidance](CONTRIBUTING.md) and
[verification limits](docs/contracts.md#verification-limits).
