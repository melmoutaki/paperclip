---
title: Outbound Network
summary: Every outbound network connector in the DAAS fork, its classification, and how it is gated
---

The DAAS fork ships **fail-closed for non-required outbound traffic**: a default
install emits no telemetry and no non-required outbound network calls. This page
is the human-readable mirror of the code-level catalog in
`packages/shared/src/outbound/connectors.ts` (`OUTBOUND_CONNECTORS`). Every
outbound call the platform can make is listed here — none are undocumented.

The runtime enablement state of these connectors is exposed in code via
`getOutboundConnectorStates()` so it can be surfaced in the health endpoint.

## Classifications

- **required** — needed for the fork to function or to perform an explicitly
  requested action.
- **non_required** — optional data-sharing / convenience integrations. These are
  **off by default** and must be explicitly opted into.

Activation describes *when* a connector can emit:

- **default_off_opt_in** — never emits until explicitly enabled.
- **on_demand** — only emits in response to an explicit user/agent/plugin action,
  and only to the destination that action targets.
- **conditional** — only active when a specific provider/feature is configured.

## Non-required connectors (off by default)

| Connector | Destination | Activation | Gate |
|-----------|-------------|------------|------|
| Product telemetry | `telemetry.paperclip.ing/ingest`, AWS API Gateway ingest | default_off_opt_in | `PAPERCLIP_TELEMETRY_ENABLED`, `config.telemetry.enabled`; kill: `PAPERCLIP_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, CI; policy: `PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY` |
| Feedback trace sharing | `telemetry.paperclip.ing/feedback-traces` | default_off_opt_in | `PAPERCLIP_FEEDBACK_SHARING_ENABLED` (fails closed when off) |
| Plugin HTTP fetch | plugin-supplied public URL (SSRF-guarded; private IPs blocked) | on_demand | installed plugin + manifest capability |
| Plugin UI dev proxy | configured plugin UI dev-server URL | conditional | plugin UI dev-server configuration |
| HTTP agent adapter | user-configured adapter endpoint | conditional | agent adapter config (blocked for DAAS infra agents) |
| Cloud upstream sync | configured cloud upstream URL | conditional | cloud upstream connection config |
| OpenClaw gateway WebSocket | configured openclaw-gateway `ws://`/`wss://` URL | conditional | openclaw-gateway adapter config (url + headers) |

## Required connectors

| Connector | Destination | Activation | Gate |
|-----------|-------------|------------|------|
| DAAS governed mission handoff | `${DAAS_BASE_URL}/api/missions` | conditional | `DAAS_BASE_URL`, `DAAS_API_SHARED_SECRET` |
| GitHub content fetch | `api.github.com`, `raw.githubusercontent.com`, GHE `/api/v3` | on_demand | user-initiated import |
| Skills catalog GitHub fetch | `api.github.com`, `raw.githubusercontent.com`, GHE `/api/v3` + `/raw` | on_demand | user-supplied catalog source repo URL/hostname |
| Invite URL reachability probe | admin-supplied public base URL | on_demand | admin-initiated invite configuration |
| OpenAI model listing | `api.openai.com/v1/models` | conditional | `OPENAI_API_KEY` / `config.llm` |
| Anthropic model discovery | `api.anthropic.com/v1/models` (or `ANTHROPIC_BASE_URL`) | conditional | `ANTHROPIC_API_KEY` (Claude adapter) |
| Anthropic usage quota | `api.anthropic.com/api/oauth/usage` | conditional | local Claude OAuth credentials |
| ChatGPT/Codex usage quota | `chatgpt.com/backend-api/wham/usage` | conditional | local Codex/ChatGPT auth token |
| Cloudflare sandbox bridge | `${bridgeBaseUrl}/api/paperclip-sandbox/v1/*` | conditional | Cloudflare sandbox provider config |
| Kubernetes sandbox API | configured Kubernetes API server | conditional | Kubernetes sandbox provider kubeconfig / in-cluster |
| Paperclip MCP API client | `${PAPERCLIP_API_URL}` | conditional | `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` |
| AWS Secrets Manager | `secretsmanager.<region>.amazonaws.com` | conditional | `PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager` + AWS creds |
| Workspace runtime probe | user-defined workspace service URL (typically loopback) | on_demand | workspace runtime configuration |
| External adapter npm install | `registry.npmjs.org` (or configured npm registry) | on_demand | instance-admin adapter install/reinstall; `NPM_CONFIG_REGISTRY` / `.npmrc` |
| Plugin npm install | `registry.npmjs.org` (or configured npm registry) | on_demand | plugin install from npm (`--ignore-scripts`); `NPM_CONFIG_REGISTRY` / `.npmrc` |
| Adapter npm version check | `registry.npmjs.org/<package>/latest` | on_demand | admin-opened adapter reinstall dialog (browser fetch) |

## Disabled in the DAAS fork (direct SSH)

The upstream **exe.dev sandbox provider** is intentionally **absent** from the
catalog above. It executes commands by spawning `ssh` directly from the
Paperclip host to a leased VM, which violates the DAAS invariant that VMs are
reached only through the DAAS API and the DAAS SSH Executor
(Paperclip → DAAS API → DAAS SSH Executor → VM). The provider is disabled
fork-wide and fails closed: every provisioning (HTTPS) and execution (SSH)
operation refuses with a DAAS-invariant error
(`packages/plugins/sandbox-providers/exe-dev/src/plugin.ts`). Its direct SSH
egress must never be re-cataloged or blessed as allowed Paperclip outbound.

## Enterprise telemetry policy (fail-closed)

Set `PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY` to an enforce value
(`enforce_disabled`, `enforce`, `disabled`, `1`, `on`, `true`, or any unrecognized
value — unknown values fail safe toward enforce) to declare that telemetry must
stay off. If telemetry is then enabled (via `config.telemetry.enabled` or
`PAPERCLIP_TELEMETRY_ENABLED=1`), startup **fails closed**: telemetry resolution
throws and the server refuses to run with telemetry enabled rather than silently
emitting data. Use `allow` (or `off`/`0`/`false`) to permit opt-in.

## No secrets in configuration

None of the switches above take secret values. Tokens (e.g.
`PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN`) must be supplied via secret refs and
never committed to config, docs, tests, or logs.
