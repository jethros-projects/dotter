# Service boundaries

Dotter is an independent client of an undocumented OpenAI Dot API. It is not
an official OpenAI SDK and cannot guarantee service availability or contract
stability. Access depends on the account, workspace, connected provider, and
service rollout.

## Authentication and scope

Authentication uses a ChatGPT Codex login. API-key login is unsupported. No
browser-cookie extraction or OS-keychain extraction is used. Requests stay on
the fixed service origins enforced by the transport.

Rooms, Dots, ChatGPT conversations, account resources, and project files have
different scopes. Account-wide commands with `--account` require the server's
account selector; Library sharing also requires its actual account principal.
Use the discovery commands before selecting an ID.

## Writes and recovery

Mutations are explicit and are not automatically retried. An interrupted request
can have an unknown result after the server receives it. Retain request keys and
reconcile the original operation before issuing another write. Exact resource
confirmation and account checks apply to the named operation.

Secret and callback inputs use bounded private files or documented piped stdin.
Exports and recovery records use private permissions and explicit overwrite
controls. Browser viewers bind to a local session and require an explicit action
to connect or take control.

## Verification limits

The regression suite checks request shapes, validation, identity guards, hidden
data filtering, recovery, cancellation, browser signaling, and response framing
with synthetic fixtures. It does not establish live support for every endpoint.
Voice, remote control, external OAuth, provider materialization, and destructive
account operations need separate authorized integration testing.

Capability commands describe the implemented surface and its known gates;
metadata alone does not prove live eligibility. iManage metadata is preserved
when reported by the service, but iManage operations are unsupported. Public
widget commands and standalone custom-MCP deletion are intentionally absent.

Private audit traces and historical account-specific evidence are excluded from
the public source distribution and npm package. Never run integration tests
against an existing account without reviewing their exact effects.
