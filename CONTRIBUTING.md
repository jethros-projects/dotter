# Contributing

Use Node.js 22 or newer and Python 3 for legacy/SSE and terminal test fixtures.
Core requests use Node HTTPS. Install with `npm ci --ignore-scripts`, then
run `npm run verify`. No build step or credentials are needed for offline checks.

Keep changes focused. Prefer small modules and existing service clients over new
abstraction layers. Put shared behavior in the SDK; CLI adapters should parse,
call the client, and render. Keep `src/index.d.ts` aligned with the root runtime
exports and `src/advanced.d.ts` aligned with the advanced entrypoint. Maintain exact identity checks, bounded input, private file
permissions, cancellation behavior, and the rule against retrying mutations.

Add behavior-focused regressions for meaningful fixes. Use synthetic IDs and
responses. Cover public API changes with a strict consumer fixture in
`test/types/`, including `@ts-expect-error` cases for invalid input.
`npm run typecheck` validates the checkout; `npm run test:package` also compiles
the fixtures against the actual installed release tarball. Never include credentials, account data, callback URLs, local audit
traces, or personal filesystem paths in fixtures or documentation.

After changing a command definition, run:

```sh
npm run registry
npm run docs
npm run coverage:docs
npm run verify
```

Update `docs/coverage.json` when adding or removing extended commands. Review
`npm pack --dry-run` before a release: it must contain only runtime modules,
selected usage documentation, declarations, notices, and bundled runtime
dependencies. TypeScript must remain a development dependency; users should not
need a build step or compiler to run Dotter.

Keep README screenshots tied to real offline CLI output. Include referenced
assets in the package allowlist and its installed-package checks. See the
[asset notes](docs/assets/README.md) and [release guide](docs/releasing.md) for
preview status, source hygiene and publication gates.

Live tests must be separately authorized and scoped to disposable resources.
Passing local tests is not evidence of live service acceptance.
The opt-in [live SDK harness](docs/SDK.md#opt-in-live-verification) records exact
tested steps and fixture residue without publishing account data.
