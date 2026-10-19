# Releasing Dotter

## Preview channel

The npm package is `@jethros-projects/dotter`; it contains the SDK and the `dotter`
executable. Public previews use a prerelease version such as `0.6.3-next.0` and
the explicit npm tag `next`. The source repository is
[jethros-projects/dotter](https://github.com/jethros-projects/dotter).

A preview exposes the current implementation with documented limits. It is not
a claim of complete live verification. Do not promote a release to `latest`
until the clean live gate below passes.

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
5. Pack the candidate with `npm pack --ignore-scripts`. Review its file list,
   bundled runtime dependencies and licenses. Check its exact archive in a
   fresh offline install, including CLI help and a strict SDK consumer.
6. Record the archive SHA-256 and the source commit. Publish that same archive
   rather than repacking an unchecked working directory.

The opt-in [live verification](SDK.md#opt-in-live-verification) is separate from
offline checks. Record actual tested steps and retained fixtures. Never replay
an uncertain send or upload to obtain a passing report.

## Publish a preview

Confirm `npm whoami`, package ownership and version availability. Complete
npm's normal browser login and 2FA flow; never put tokens or passwords in the
repository. The maintainer must authorize publication.

```sh
npm publish /path/to/tested-package.tgz --access public --tag next --ignore-scripts
```

GitHub private vulnerability reporting must be enabled on the public repository
before uploading the source. Confirm the [security reporting link](../SECURITY.md)
works, push the reviewed source and matching prerelease tag, and check CI.
GitHub publication and npm publication are distinct actions.

After publishing, verify the registry metadata and `next` tag, download the
published archive and compare its hash to the tested artifact. Test an install
by the published package/version and inspect the README image on npm.
A local terminal publish does not generate hosted CI provenance; do not claim it.

Do not silently add `latest`, publish another package name, or replay publication
after an uncertain result. Check the registry first: published name/version
pairs cannot be reused.
