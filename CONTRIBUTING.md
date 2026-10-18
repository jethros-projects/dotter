# Contributing

Use Node.js 22 or newer and Python 3. Install with `npm ci --ignore-scripts`, then
run `npm run verify`. No build step or credentials are needed for offline checks.

Keep changes focused. Prefer small modules and existing service clients over new
abstraction layers. Maintain exact identity checks, bounded input, private file
permissions, cancellation behavior, and the rule against retrying mutations.

Add behavior-focused regressions for meaningful fixes. Use synthetic IDs and
responses. Never include credentials, account data, callback URLs, local audit
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
selected usage documentation, notices, and bundled runtime dependencies.

Live tests must be separately authorized and scoped to disposable resources.
Passing local tests is not evidence of live service acceptance.
