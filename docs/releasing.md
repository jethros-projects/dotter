# Releasing Dotter

## Preview channel

The npm package is `@jethros-projects/dotter`; it contains the SDK and the `dotter`
executable. Public previews use a prerelease version such as `0.6.3-next.3` and
the explicit npm tag `next`. The source repository is
[jethros-projects/dotter](https://github.com/jethros-projects/dotter).

A preview exposes the current implementation with documented limits. It is not
a claim of complete live verification. Do not deliberately promote a release
to `latest` until the clean live gate below passes.

On the first publication, npm automatically assigned both `next` and `latest`
to `0.6.3-next.2`, despite the explicit `--tag next`. Removing `latest` after
authentication returned HTTP 400, matching [npm/cli issue #8490](https://github.com/npm/cli/issues/8490).
The version remains a preview; use the explicit `@next` install instructions.
Record actual registry tags rather than treating a tag as proof of live verification.

## Clean live gate

As of 19 October 2026, the earlier 0.6.2 runtime passed 3,840 offline tests on
each of Node 22 and Node 24, plus strict types and installed-package checks.
Its full 19-stage real-account run did not pass: seven stages passed, one was
blocked at CLI discovery by an upstream challenge, and eleven were skipped.
That run created no new messages or files. A package rename or version change
is not a new real-account test.

Subsequent read-only diagnostics recorded successful reads, an explicit
Cloudflare challenge 403, and a separate JSON 404 without a challenge header.
These are different failure classes. The selected plan and exact Cloudflare
rule remain unconfirmed; the samples do not establish a failure rate or prove
a geographic decision. See [access boundaries](contracts.md#availability).

An eligible plan and region with supported access, or provider confirmation,
is needed before another full live run. Do not claim universal support based
on offline tests. Public previews must keep this limitation visible in the README.

## Verify an exact candidate

1. Review `git status` and the intended diff, including untracked files. Keep
   credentials, auth caches, account traces and private fixture data out of
   source history and the package.
2. Update `package.json` and the root version fields in `package-lock.json`.
   Run `npm run docs` to refresh the versioned command reference.
3. Run `npm ci --ignore-scripts` and `npm run verify`. CI checks Node 22 and 24
   on Linux and macOS. Run remote CI for the exact source commit.
4. Check the README and its screenshot. Use actual offline CLI output. Verify
   that image and documentation links work from both GitHub and npm.
5. Use npm 11.11.1 and run `npm run release:check` from the clean, complete
   source checkout. Review `work/releases/<version>/verification.json` and
   `publication-metadata.json`, plus the exact archive in that directory. The
   check scans all reachable Git authors, committers and annotated taggers,
   historical source, current tracked files, archive headers and content, and
   the complete prepared and final npm metadata. It performs no authentication
   or registry requests. Repacking must produce identical bytes.
6. Review bundled runtime dependencies and licenses. Check that exact archive
   in a fresh offline install, including CLI help and a strict SDK consumer.
   Record its SHA-256 and source commit; do not modify the release directory.

The opt-in [live verification](SDK.md#opt-in-live-verification) is separate from
offline checks. Record actual tested steps and retained fixtures. Never replay
an uncertain send or upload to obtain a passing report.

## Publish a preview

Confirm `npm whoami`, package ownership and version availability. Complete
npm's normal browser login and 2FA flow; never put tokens or passwords in the
repository. The maintainer must authorize publication.

```sh
npm run release:check
npm run release:publish
```

These maintainer commands exist in a source checkout, not the installed npm
package. The publisher accepts a directory only, rechecks the candidate, then
starts npm's ordinary browser/2FA flow. Before the outgoing registry PUT, it
compares actual metadata and archive bytes with the reviewed snapshot. Public
npm source fingerprints lock the adapter to the reviewed implementation; a
changed npm version or source requires an adapter review before publishing.
The wrapper neither reads nor logs credentials. Do not bypass it with a raw
publish command.

With npm 11.11.1,
publishing a local tarball adds its absolute path to public `_from` and
`_resolved` metadata. A relative tarball argument still adds an absolute
`_resolved` path. An archive-content scan alone does not check that metadata.
Directory publication avoids those injected source paths; inspect the prepared
manifest as well as the archive. Check Git identities and any author,
contributor or maintainer fields separately. npm also associates registry
account data with publications. The local guard cannot change that server-side
identity or promise anonymity; review the public npm account profile separately.

## Maintainer Git setup

In this repository only, configure the public identity and tracked pre-push
hook before creating commits or tags:

```sh
git config --local user.name Jethro
git config --local user.email jethros-projects@users.noreply.github.com
git config --local core.hooksPath .githooks
```

The hook checks complete reachable author, committer and tagger metadata and
source history before a push. Its identity policy permits `Jethro` or
`jethros-projects` and that account's GitHub noreply address, including GitHub's
numeric-ID prefix. Source and history checks reject the local username without
storing it in source; common CI usernames are excluded. Optional private terms
can be supplied locally as newline-separated `DOTTER_PRIVATE_TERMS` values.
Never commit those values. Metadata and archive checks additionally reject
generic home paths and local file URLs. Source tests may contain synthetic
unsafe URLs to test input validation. This is a maintainer publication policy;
ordinary contributor tests do not impose that identity on contributors.
Hooks are local and can be bypassed: review public metadata as part of release
approval as well. These checks cannot remove shared copies or detect every
possible personal detail.

## Verify publication

GitHub private vulnerability reporting must be enabled on the public repository
before uploading the source. Confirm the [security reporting link](../SECURITY.md)
works, push the reviewed source and matching prerelease tag, and check CI.
GitHub publication and npm publication are distinct actions.

npm scans uploaded versions before making them installable. A successful
publish can temporarily return 404 from package queries while the version
page shows `Validating`; wait for review before retrying. See the
[publish-time scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

After publishing, verify the registry metadata and actual tags, download the
published archive and compare its hash to the tested artifact. Test an install
by the published package/version and inspect the README image on npm.
A local terminal publish does not generate hosted CI provenance; do not claim it.

Do not silently add `latest`, publish another package name, or replay publication
after an uncertain result. Check the registry first: published name/version
pairs cannot be reused.
