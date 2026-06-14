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

describe("OUTBOUND_CONNECTORS catalog", () => {
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
