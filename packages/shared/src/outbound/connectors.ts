import {
  TELEMETRY_ENABLE_ENV,
  isTelemetryRequested,
  resolveEnterpriseTelemetryPolicy,
} from "../telemetry/config.js";

/**
 * Outbound network policy for the DAAS fork.
 *
 * This module is the single, code-level source of truth for every outbound
 * network connector the platform can open. It exists so that:
 *
 *  1. Non-required outbound integrations are OFF by default (telemetry and
 *     feedback-trace sharing must be explicitly opted into).
 *  2. Every remaining allowed outbound call is documented here, with its
 *     destination, classification, and the env/config switches that gate it.
 *     No secret values are stored here — only switch names.
 *  3. Downstream code (e.g. the health surface in T260) can read the live
 *     enablement state via {@link getOutboundConnectorStates} without
 *     re-deriving the policy.
 */

/** Opt-in switch that enables outbound feedback-trace sharing (OFF by default). */
export const FEEDBACK_SHARING_ENABLE_ENV = "PAPERCLIP_FEEDBACK_SHARING_ENABLED";

/**
 * Whether the connector is needed for the fork to function (`required`) or is an
 * optional data-sharing / convenience integration (`non_required`). Non-required
 * connectors are disabled by default.
 */
export type OutboundConnectorClassification = "required" | "non_required";

/**
 * How a connector becomes active:
 * - `default_off_opt_in`: never emits until explicitly enabled.
 * - `on_demand`: only emits in response to an explicit user/agent/plugin action
 *   (and only to the destination that action targets).
 * - `conditional`: only active when a specific provider/feature is configured.
 */
export type OutboundConnectorActivation = "default_off_opt_in" | "on_demand" | "conditional";

export interface OutboundConnectorDescriptor {
  /** Stable identifier, also used as the health key. */
  id: string;
  title: string;
  /** What the connector talks to and why. */
  purpose: string;
  classification: OutboundConnectorClassification;
  activation: OutboundConnectorActivation;
  /** Documented destination hostnames / URL templates. Never secrets. */
  destinations: readonly string[];
  /** Env vars / config flags that gate or authenticate this connector. Names only. */
  controls: readonly string[];
  /** True only if a default fork install can emit this traffic with no extra config. */
  enabledByDefault: boolean;
  /** Where the connector is implemented, for auditability. */
  source: string;
}

export const OUTBOUND_CONNECTORS: readonly OutboundConnectorDescriptor[] = [
  {
    id: "telemetry-ingest",
    title: "Product telemetry",
    purpose: "Anonymous usage events sent to Paperclip's telemetry ingest endpoint.",
    classification: "non_required",
    activation: "default_off_opt_in",
    destinations: [
      "https://telemetry.paperclip.ing/ingest",
      "https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest",
    ],
    controls: [
      TELEMETRY_ENABLE_ENV,
      "PAPERCLIP_TELEMETRY_DISABLED",
      "DO_NOT_TRACK",
      "PAPERCLIP_TELEMETRY_ENDPOINT",
      "PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY",
      "config.telemetry.enabled",
    ],
    enabledByDefault: false,
    source: "packages/shared/src/telemetry/client.ts",
  },
  {
    id: "feedback-trace-share",
    title: "Feedback trace sharing",
    purpose:
      "Uploads opt-in feedback trace bundles to the Paperclip feedback backend for model improvement.",
    classification: "non_required",
    activation: "default_off_opt_in",
    destinations: ["https://telemetry.paperclip.ing/feedback-traces"],
    controls: [
      FEEDBACK_SHARING_ENABLE_ENV,
      "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL",
      "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
    ],
    enabledByDefault: false,
    source: "server/src/services/feedback-share-client.ts",
  },
  {
    id: "daas-mission-handoff",
    title: "DAAS governed mission handoff",
    purpose:
      "Required fork integration: hands infrastructure-intent missions to the DAAS governed mission API.",
    classification: "required",
    activation: "conditional",
    destinations: ["${DAAS_BASE_URL}/api/missions"],
    controls: ["DAAS_BASE_URL", "DAAS_API_SHARED_SECRET"],
    enabledByDefault: false,
    source: "server/src/routes/daas-integrations.ts",
  },
  {
    id: "github-content",
    title: "GitHub content fetch",
    purpose:
      "Imports skills, companies, and catalog content from GitHub / GitHub Enterprise on explicit request.",
    classification: "required",
    activation: "on_demand",
    destinations: [
      "https://api.github.com",
      "https://raw.githubusercontent.com",
      "https://<github-enterprise-host>/api/v3",
    ],
    controls: ["(user-initiated import URL)"],
    enabledByDefault: true,
    source: "server/src/services/github-fetch.ts",
  },
  {
    id: "invite-resolution-probe",
    title: "Invite URL reachability probe",
    purpose: "HEAD probe that verifies an admin-supplied public invite URL resolves and is reachable.",
    classification: "required",
    activation: "on_demand",
    destinations: ["(admin-supplied public base URL)"],
    controls: ["(admin-initiated invite configuration)"],
    enabledByDefault: true,
    source: "server/src/routes/access.ts",
  },
  {
    id: "plugin-http-fetch",
    title: "Plugin HTTP fetch",
    purpose:
      "SSRF-guarded outbound HTTP requested by an installed plugin; private/reserved IP ranges are blocked.",
    classification: "non_required",
    activation: "on_demand",
    destinations: ["(plugin-supplied public URL)"],
    controls: ["(installed plugin + manifest capability)"],
    enabledByDefault: false,
    source: "server/src/services/plugin-host-services.ts",
  },
  {
    id: "plugin-ui-static-proxy",
    title: "Plugin UI dev proxy",
    purpose: "Proxies plugin UI assets from a configured dev server during plugin development.",
    classification: "non_required",
    activation: "conditional",
    destinations: ["(configured plugin UI dev-server URL)"],
    controls: ["(plugin UI dev-server configuration)"],
    enabledByDefault: false,
    source: "server/src/routes/plugin-ui-static.ts",
  },
  {
    id: "http-adapter",
    title: "HTTP agent adapter",
    purpose:
      "User-configured HTTP adapter calls. Disabled for DAAS infrastructure agents by the infrastructure guard.",
    classification: "non_required",
    activation: "conditional",
    destinations: ["(user-configured adapter endpoint)"],
    controls: ["(agent adapter configuration)"],
    enabledByDefault: false,
    source: "server/src/adapters/http/execute.ts",
  },
  {
    id: "openai-models",
    title: "OpenAI model listing",
    purpose: "Lists available OpenAI models for the Codex/OpenAI adapter when an API key is configured.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://api.openai.com/v1/models"],
    controls: ["OPENAI_API_KEY", "config.llm.provider", "config.llm.apiKey"],
    enabledByDefault: false,
    source: "server/src/adapters/codex-models.ts",
  },
  {
    id: "aws-secrets-manager",
    title: "AWS Secrets Manager",
    purpose: "Reads secrets from AWS Secrets Manager when that secret provider is selected.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://secretsmanager.<region>.amazonaws.com"],
    controls: ["PAPERCLIP_SECRETS_PROVIDER", "(AWS credentials)"],
    enabledByDefault: false,
    source: "server/src/secrets/aws-secrets-manager-provider.ts",
  },
  {
    id: "cloud-upstreams",
    title: "Cloud upstream sync",
    purpose: "Syncs with a configured cloud upstream on explicit connect/import actions.",
    classification: "non_required",
    activation: "conditional",
    destinations: ["(configured cloud upstream URL)"],
    controls: ["(cloud upstream connection configuration)"],
    enabledByDefault: false,
    source: "server/src/services/cloud-upstreams.ts",
  },
  {
    id: "workspace-runtime-probe",
    title: "Workspace runtime probe",
    purpose: "Health/asset probes against user-defined workspace runtime services (typically loopback).",
    classification: "required",
    activation: "on_demand",
    destinations: ["(user-defined workspace service URL)"],
    controls: ["(workspace runtime configuration)"],
    enabledByDefault: true,
    source: "server/src/services/workspace-runtime.ts",
  },
  {
    id: "anthropic-models",
    title: "Anthropic model discovery",
    purpose:
      "Lists available Claude models from the Anthropic API for the Claude adapter when an API key is configured.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://api.anthropic.com/v1/models", "${ANTHROPIC_BASE_URL}/v1/models"],
    controls: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"],
    enabledByDefault: false,
    source: "packages/adapters/claude-local/src/server/models.ts",
  },
  {
    id: "anthropic-quota",
    title: "Anthropic usage quota",
    purpose:
      "Polls the Anthropic OAuth usage endpoint to display Claude subscription quota windows when a local Claude session is present.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://api.anthropic.com/api/oauth/usage"],
    controls: ["(local Claude OAuth credentials)", "CLAUDE_CONFIG_DIR"],
    enabledByDefault: false,
    source: "packages/adapters/claude-local/src/server/quota.ts",
  },
  {
    id: "chatgpt-quota",
    title: "ChatGPT/Codex usage quota",
    purpose:
      "Polls the ChatGPT usage backend to display Codex/ChatGPT subscription quota windows when a local Codex session is present.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://chatgpt.com/backend-api/wham/usage"],
    controls: ["(local Codex/ChatGPT auth token)", "CODEX_HOME"],
    enabledByDefault: false,
    source: "packages/adapters/codex-local/src/server/quota.ts",
  },
  {
    id: "cloudflare-sandbox-bridge",
    title: "Cloudflare sandbox bridge",
    purpose:
      "Drives remote sandbox lifecycle (lease/probe/exec) via the configured Cloudflare sandbox bridge when the Cloudflare sandbox provider is selected.",
    classification: "required",
    activation: "conditional",
    destinations: ["${cloudflare.bridgeBaseUrl}/api/paperclip-sandbox/v1/*"],
    controls: ["(Cloudflare sandbox provider configuration: bridge base URL + auth token)"],
    enabledByDefault: false,
    source: "packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts",
  },
  {
    id: "exe-dev-sandbox",
    title: "exe.dev sandbox execution",
    purpose:
      "Provisions and executes commands in exe.dev remote sandboxes when the exe.dev sandbox provider is selected.",
    classification: "required",
    activation: "conditional",
    destinations: ["https://exe.dev/exec", "(per-lease exe.dev VM URL)"],
    controls: ["(exe.dev sandbox provider configuration: API URL + token)"],
    enabledByDefault: false,
    source: "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts",
  },
  {
    id: "kubernetes-sandbox",
    title: "Kubernetes sandbox API",
    purpose:
      "Talks to a configured Kubernetes API server to manage sandbox pods when the Kubernetes sandbox provider is selected.",
    classification: "required",
    activation: "conditional",
    destinations: ["(configured Kubernetes API server)"],
    controls: ["(Kubernetes sandbox provider kubeconfig / in-cluster configuration)"],
    enabledByDefault: false,
    source: "packages/plugins/sandbox-providers/kubernetes/src/kube-client.ts",
  },
  {
    id: "mcp-control-plane-client",
    title: "Paperclip MCP API client",
    purpose:
      "The Paperclip MCP server calls back to the configured Paperclip control-plane API on behalf of an agent.",
    classification: "required",
    activation: "conditional",
    destinations: ["${PAPERCLIP_API_URL}"],
    controls: ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY"],
    enabledByDefault: false,
    source: "packages/mcp-server/src/client.ts",
  },
] as const;

export interface OutboundConnectorState extends OutboundConnectorDescriptor {
  /** Whether the connector is currently permitted to emit traffic. */
  enabled: boolean;
  /** Machine-readable reason for the current `enabled` value. */
  reason:
    | "explicitly_enabled"
    | "disabled_by_default"
    | "policy_enforced_disabled"
    | "on_demand"
    | "conditional";
}

export interface OutboundConnectorStateInputs {
  env?: NodeJS.ProcessEnv;
  /** Resolved telemetry enablement, if the caller already computed it. */
  telemetryEnabled?: boolean;
  /** Resolved feedback-sharing enablement, if the caller already computed it. */
  feedbackSharingEnabled?: boolean;
}

/** Whether outbound feedback-trace sharing is enabled (OFF by default). */
export function isFeedbackSharingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FEEDBACK_SHARING_ENABLE_ENV];
  return raw === "1" || raw === "true";
}

function isDaasMissionHandoffConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DAAS_BASE_URL?.trim()) && Boolean(env.DAAS_API_SHARED_SECRET?.trim());
}

/**
 * Compute the live enablement state of every outbound connector. Pure and
 * non-throwing so it is safe to call from a health endpoint: a telemetry policy
 * violation surfaces as `enabled: false, reason: "policy_enforced_disabled"`
 * rather than an exception.
 */
export function getOutboundConnectorStates(
  inputs: OutboundConnectorStateInputs = {},
): OutboundConnectorState[] {
  const env = inputs.env ?? process.env;
  const policy = resolveEnterpriseTelemetryPolicy(env);
  const telemetryRequested = isTelemetryRequested(undefined, env);
  const telemetryEnabled =
    inputs.telemetryEnabled ??
    (telemetryRequested && policy !== "enforce_disabled");
  const feedbackSharingEnabled = inputs.feedbackSharingEnabled ?? isFeedbackSharingEnabled(env);

  return OUTBOUND_CONNECTORS.map((connector): OutboundConnectorState => {
    switch (connector.id) {
      case "telemetry-ingest": {
        if (policy === "enforce_disabled" && telemetryRequested) {
          return { ...connector, enabled: false, reason: "policy_enforced_disabled" };
        }
        return {
          ...connector,
          enabled: telemetryEnabled,
          reason: telemetryEnabled ? "explicitly_enabled" : "disabled_by_default",
        };
      }
      case "feedback-trace-share":
        return {
          ...connector,
          enabled: feedbackSharingEnabled,
          reason: feedbackSharingEnabled ? "explicitly_enabled" : "disabled_by_default",
        };
      case "daas-mission-handoff": {
        const configured = isDaasMissionHandoffConfigured(env);
        return {
          ...connector,
          enabled: configured,
          reason: configured ? "explicitly_enabled" : "conditional",
        };
      }
      default:
        return {
          ...connector,
          enabled: connector.enabledByDefault,
          reason:
            connector.activation === "on_demand"
              ? "on_demand"
              : connector.enabledByDefault
                ? "explicitly_enabled"
                : "conditional",
        };
    }
  });
}
