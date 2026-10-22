# October 2026 runtime security update

Dotter's `0.6.3-next.4` candidate requires Node.js **22.23.4+, 24.22.1+, or
26.12.1+ within those major lines**. Other major lines and prerelease runtimes
are unsupported. Update Node.js from its official distribution or your runtime
provider, then restart every CLI, application, worker, and container using it.
Updating Dotter alone cannot repair the Node executable.

The [Node.js October 21 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
reports ten vulnerabilities. This source review classifies Dotter's paths; it
does not establish that any account was attacked.

The releases also update built-in dependencies and the certificate store for
the reported eMudhra intermediate CA compromise. Keep the runtime provider's
trust-store updates current, including any separately managed custom CA store.
They include c-ares 1.34.9, covering eleven upstream advisories published on
October 20 without assigned CVE identifiers when reviewed. Dotter does not
directly call the c-ares DNS APIs; this is inherited runtime fix coverage, not
evidence of SDK exploitation. See the [c-ares changelog](https://c-ares.org/changelog.html)
and [upstream advisories](https://github.com/c-ares/c-ares/security/advisories).

| CVEs | Dotter exposure and action |
| --- | --- |
| CVE-2026-106069, CVE-2026-106072, CVE-2026-105483 | TLS hostname validation. Dotter uses Node HTTPS; upgrade Node even though core requests constrain service origins. The last CVE affects Node 24/26. |
| CVE-2026-105481 | Reused HTTP sockets. Dotter's Node HTTPS agent uses keep-alive; require the patched runtime. |
| CVE-2026-111497 | Brotli decoding can permit code execution. No direct Brotli decoder use was found in Dotter; another part of an SDK host can reach it. Upgrade the whole process. |
| CVE-2026-105482 | NUL-containing DNS names. No direct `dns.resolve` call was found in Dotter; update the shared runtime. |
| CVE-2026-106074 | UUID/integer entropy copied into custom startup snapshots or single executable applications. Dotter uses `randomUUID`; it does not distribute either packaging form. Embedded hosts still need the runtime fix. |
| CVE-2026-106070 | Node 26 ZIP validation. Dotter does not use Node's `ZipFile` API. |
| CVE-2026-106071, CVE-2026-106073 | Node Permission Model filesystem bypasses. Dotter does not treat that model as its isolation boundary; hosts using it must update. The first CVE affects Node 26. |

The SDK's root and advanced entrypoints and the executable reject unsupported
runtimes with `UNSUPPORTED_NODE_VERSION` before authentication or network work.
The npm engines range and exact CI versions enforce the same policy. Dependency
audit results do not cover Node's built-in libraries; continue applying later
runtime security updates. See the official release notes for
[22.23.4](https://nodejs.org/en/blog/release/v22.23.4),
[24.22.1](https://nodejs.org/en/blog/release/v24.22.1), and
[26.12.1](https://nodejs.org/en/blog/release/v26.12.1).

This change does not expand service access or live verification. Dotter remains
an unofficial preview with the [existing access and testing limits](contracts.md).
