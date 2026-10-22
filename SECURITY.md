# Security

Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those major lines.
These minimums include the October 21, 2026 Node.js security fixes. Update the
runtime and restart running clients; installing a package update does not patch
Node.js. Dotter refuses unsupported versions before SDK imports or CLI work.
See the [October security notice](docs/security-2026-10.md) for the affected
paths and limits. The CLI and SDK report `UNSUPPORTED_NODE_VERSION`.

Do not post credentials, auth caches, callback files, private messages, or raw
service traces in public issues. Redact account identifiers and tokens before
sharing diagnostics.

For a suspected vulnerability, use GitHub's private
[Report a vulnerability](https://github.com/jethros-projects/dotter/security/advisories/new)
form. If that form is unavailable, do not put security details in a public
issue. A separate security email is not configured.

Include the version, a minimal synthetic reproduction, expected behavior, and
the potential impact. Avoid testing against accounts or resources you do not own.

Until a release support policy is established, fixes target the current source.
