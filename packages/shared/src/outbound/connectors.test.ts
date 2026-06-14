import { describe, expect, it } from "vitest";
import {
  FEEDBACK_SHARING_ENABLE_ENV,
  OUTBOUND_CONNECTORS,
  getOutboundConnectorStates,
  isFeedbackSharingEnabled,
} from "./connectors.js";
import { ENTERPRISE_TELEMETRY_POLICY_ENV, TELEMETRY_ENABLE_ENV } from "../telemetry/config.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

function stateById(states: ReturnType<typeof getOutboundConnectorStates>, id: string) {
  const found = states.find((s) => s.id === id);
  if (!found) throw new Error(`connector ${id} not found`);
  return found;
}

/**
 * The current, manually-curated list of audited outbound network source paths.
 *
 * This list is NOT mechanically derived from the codebase — it is maintained by
 * hand as outbound-capable files are discovered and audited. The coverage test
 * below asserts that every path here is catalogued in {@link OUTBOUND_CONNECTORS}:
 * it guards against a connector's `source` being dropped from the catalog, but it
 * cannot by itself detect a brand-new outbound call site that nobody added here.
 * When new outbound traffic is introduced, both the catalog and this list must be
 * updated together (see docs/deploy/outbound-network.md).
 *
 * It is kept in sync with the known audited outbound source list as of the
 * DAAS-1053 / T259 outbound audit, including the paths the validator flagged.
 */
const REQUIRED_OUTBOUND_SOURCE_PATHS = [
  // Outbound paths flagged across the DAAS-1053 / T259 gate reviews.
  "packages/adapters/claude-local/src/server/models.ts",
  "packages/adapters/claude-local/src/server/quota.ts",
  "packages/adapters/codex-local/src/server/quota.ts",
  "packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts",
  "packages/skills-catalog/src/catalog-builder.ts",
  "packages/adapters/openclaw-gateway/src/server/execute.ts",
  // Additional outbound paths surfaced in the same audit.
  // NOTE: packages/plugins/sandbox-providers/exe-dev/src/plugin.ts is deliberately
  // NOT listed here. The exe.dev provider reaches VMs over direct SSH, which the
  // DAAS invariant forbids; it is disabled fork-wide and must not be cataloged as
  // allowed Paperclip egress (see the regression test below).
  "packages/plugins/sandbox-providers/kubernetes/src/kube-client.ts",
  "packages/mcp-server/src/client.ts",
  // Previously-catalogued outbound paths.
  "packages/shared/src/telemetry/client.ts",
  "server/src/services/feedback-share-client.ts",
  "server/src/routes/daas-integrations.ts",
  "server/src/services/github-fetch.ts",
  "server/src/routes/access.ts",
  "server/src/services/plugin-host-services.ts",
  "server/src/routes/plugin-ui-static.ts",
  "server/src/adapters/http/execute.ts",
  "server/src/adapters/codex-models.ts",
  "server/src/secrets/aws-secrets-manager-provider.ts",
  "server/src/services/cloud-upstreams.ts",
  "server/src/services/workspace-runtime.ts",
  // npm registry / external-adapter install paths flagged in the T259 gate
  // follow-up (fork-critical for external adapters such as Hermes).
  "server/src/routes/adapters.ts",
  "server/src/services/plugin-loader.ts",
  "ui/src/pages/AdapterManager.tsx",
] as const;

describe("OUTBOUND_CONNECTORS catalog", () => {
  it("catalogs every audited outbound source path in the curated list", () => {
    const sources = OUTBOUND_CONNECTORS.map((connector) => connector.source);
    for (const path of REQUIRED_OUTBOUND_SOURCE_PATHS) {
      expect(sources, `OUTBOUND_CONNECTORS is missing outbound source path: ${path}`).toContain(
        path,
      );
    }
  });

  it("has unique ids and documents every connector with a source and destination", () => {
    const ids = OUTBOUND_CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const connector of OUTBOUND_CONNECTORS) {
      expect(connector.source.length).toBeGreaterThan(0);
      expect(connector.destinations.length).toBeGreaterThan(0);
      expect(connector.purpose.length).toBeGreaterThan(0);
    }
  });

  it("disables every non-required connector by default", () => {
    for (const connector of OUTBOUND_CONNECTORS) {
      if (connector.classification === "non_required") {
        expect(connector.enabledByDefault).toBe(false);
      }
    }
  });

  it("never catalogs exe.dev direct-SSH execution as allowed Paperclip egress", () => {
    // DAAS invariant: Paperclip must never SSH directly to a VM. The exe.dev
    // provider does exactly that, so it must stay disabled and uncatalogued —
    // neither its plugin source nor its per-lease VM / exe.dev destinations may
    // ever reappear as a blessed outbound connector.
    for (const connector of OUTBOUND_CONNECTORS) {
      expect(
        connector.source,
        `exe.dev direct-SSH provider must not be cataloged as Paperclip egress (connector ${connector.id})`,
      ).not.toContain("sandbox-providers/exe-dev");
      expect(connector.id).not.toBe("exe-dev-sandbox");
      for (const destination of connector.destinations) {
        expect(
          destination.toLowerCase(),
          `exe.dev destination must not be cataloged as Paperclip egress (connector ${connector.id})`,
        ).not.toContain("exe.dev");
      }
    }
  });

  it("never embeds secret values in controls or destinations", () => {
    const secretish = /(secret|token|api[_-]?key|password)\s*[:=]\s*\S/i;
    for (const connector of OUTBOUND_CONNECTORS) {
      for (const text of [...connector.controls, ...connector.destinations]) {
        expect(text).not.toMatch(secretish);
      }
    }
  });
});

describe("getOutboundConnectorStates", () => {
  it("reports telemetry and feedback sharing disabled by default", () => {
    const states = getOutboundConnectorStates({ env: env() });
    expect(stateById(states, "telemetry-ingest").enabled).toBe(false);
    expect(stateById(states, "feedback-trace-share").enabled).toBe(false);
  });

  it("reports telemetry enabled when opted in", () => {
    const states = getOutboundConnectorStates({ env: env({ [TELEMETRY_ENABLE_ENV]: "1" }) });
    const telemetry = stateById(states, "telemetry-ingest");
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.reason).toBe("explicitly_enabled");
  });

  it("reports telemetry policy_enforced_disabled when opted in against the policy", () => {
    const states = getOutboundConnectorStates({
      env: env({
        [TELEMETRY_ENABLE_ENV]: "1",
        [ENTERPRISE_TELEMETRY_POLICY_ENV]: "enforce_disabled",
      }),
    });
    const telemetry = stateById(states, "telemetry-ingest");
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.reason).toBe("policy_enforced_disabled");
  });

  it("reports feedback sharing enabled when opted in", () => {
    const states = getOutboundConnectorStates({
      env: env({ [FEEDBACK_SHARING_ENABLE_ENV]: "1" }),
    });
    expect(stateById(states, "feedback-trace-share").enabled).toBe(true);
  });

  it("honours explicit resolved inputs over env", () => {
    const states = getOutboundConnectorStates({
      env: env(),
      telemetryEnabled: true,
      feedbackSharingEnabled: true,
    });
    expect(stateById(states, "telemetry-ingest").enabled).toBe(true);
    expect(stateById(states, "feedback-trace-share").enabled).toBe(true);
  });

  it("treats DAAS mission handoff as enabled only when fully configured", () => {
    expect(stateById(getOutboundConnectorStates({ env: env() }), "daas-mission-handoff").enabled).toBe(
      false,
    );
    const configured = getOutboundConnectorStates({
      env: env({ DAAS_BASE_URL: "https://daas.example.test", DAAS_API_SHARED_SECRET: "x" }),
    });
    expect(stateById(configured, "daas-mission-handoff").enabled).toBe(true);
  });
});

describe("isFeedbackSharingEnabled", () => {
  it("is false by default and true for 1/true", () => {
    expect(isFeedbackSharingEnabled(env())).toBe(false);
    expect(isFeedbackSharingEnabled(env({ [FEEDBACK_SHARING_ENABLE_ENV]: "1" }))).toBe(true);
    expect(isFeedbackSharingEnabled(env({ [FEEDBACK_SHARING_ENABLE_ENV]: "true" }))).toBe(true);
    expect(isFeedbackSharingEnabled(env({ [FEEDBACK_SHARING_ENABLE_ENV]: "no" }))).toBe(false);
  });
});
