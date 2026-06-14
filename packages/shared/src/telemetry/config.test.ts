import { describe, expect, it } from "vitest";
import {
  ENTERPRISE_TELEMETRY_POLICY_ENV,
  TELEMETRY_ENABLE_ENV,
  TelemetryPolicyViolationError,
  isTelemetryRequested,
  resolveEnterpriseTelemetryPolicy,
  resolveTelemetryConfig,
} from "./config.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Start from a clean slate so the host CI environment never leaks in.
  return overrides as NodeJS.ProcessEnv;
}

describe("resolveTelemetryConfig — DAAS fork defaults", () => {
  it("is disabled by default with no config and no env", () => {
    expect(resolveTelemetryConfig(undefined, env())).toEqual({ enabled: false });
  });

  it("stays disabled when file config omits the flag", () => {
    expect(resolveTelemetryConfig({}, env())).toEqual({ enabled: false });
  });

  it("enables only when explicitly opted in via config", () => {
    expect(resolveTelemetryConfig({ enabled: true }, env())).toEqual({ enabled: true });
  });

  it("enables only when explicitly opted in via env", () => {
    expect(resolveTelemetryConfig(undefined, env({ [TELEMETRY_ENABLE_ENV]: "1" }))).toEqual({
      enabled: true,
    });
  });

  it("passes through a configured endpoint when enabled", () => {
    expect(
      resolveTelemetryConfig(
        { enabled: true },
        env({ PAPERCLIP_TELEMETRY_ENDPOINT: "https://collector.example.test/ingest" }),
      ),
    ).toEqual({ enabled: true, endpoint: "https://collector.example.test/ingest" });
  });
});

describe("resolveTelemetryConfig — kill switches", () => {
  it("honours PAPERCLIP_TELEMETRY_DISABLED even when opted in", () => {
    expect(
      resolveTelemetryConfig(
        { enabled: true },
        env({ PAPERCLIP_TELEMETRY_DISABLED: "1" }),
      ),
    ).toEqual({ enabled: false });
  });

  it("honours DO_NOT_TRACK", () => {
    expect(
      resolveTelemetryConfig({ enabled: true }, env({ DO_NOT_TRACK: "1" })),
    ).toEqual({ enabled: false });
  });

  it("disables telemetry in CI", () => {
    expect(resolveTelemetryConfig({ enabled: true }, env({ CI: "true" }))).toEqual({
      enabled: false,
    });
  });
});

describe("resolveEnterpriseTelemetryPolicy", () => {
  it("is unset when the env var is absent or empty", () => {
    expect(resolveEnterpriseTelemetryPolicy(env())).toBe("unset");
    expect(resolveEnterpriseTelemetryPolicy(env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: "" }))).toBe(
      "unset",
    );
  });

  it("recognises explicit allow values", () => {
    for (const value of ["allow", "off", "0", "false"]) {
      expect(
        resolveEnterpriseTelemetryPolicy(env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: value })),
      ).toBe("allow");
    }
  });

  it("recognises enforce values and fails safe on unknown values", () => {
    for (const value of ["enforce_disabled", "enforce", "1", "true", "banana"]) {
      expect(
        resolveEnterpriseTelemetryPolicy(env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: value })),
      ).toBe("enforce_disabled");
    }
  });
});

describe("resolveTelemetryConfig — enterprise fail-closed", () => {
  it("throws when telemetry is enabled against an enforcing policy", () => {
    expect(() =>
      resolveTelemetryConfig(
        { enabled: true },
        env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: "enforce_disabled" }),
      ),
    ).toThrow(TelemetryPolicyViolationError);
  });

  it("throws when env opts in against an enforcing policy", () => {
    expect(() =>
      resolveTelemetryConfig(
        undefined,
        env({
          [TELEMETRY_ENABLE_ENV]: "1",
          [ENTERPRISE_TELEMETRY_POLICY_ENV]: "enforce_disabled",
        }),
      ),
    ).toThrow(/fail-closed/);
  });

  it("does not throw when policy enforces disabled and telemetry is not requested", () => {
    expect(
      resolveTelemetryConfig(
        { enabled: false },
        env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: "enforce_disabled" }),
      ),
    ).toEqual({ enabled: false });
  });

  it("allows telemetry when the policy explicitly allows it", () => {
    expect(
      resolveTelemetryConfig(
        { enabled: true },
        env({ [ENTERPRISE_TELEMETRY_POLICY_ENV]: "allow" }),
      ),
    ).toEqual({ enabled: true });
  });
});

describe("isTelemetryRequested", () => {
  it("reflects config and env opt-in", () => {
    expect(isTelemetryRequested(undefined, env())).toBe(false);
    expect(isTelemetryRequested({ enabled: true }, env())).toBe(true);
    expect(isTelemetryRequested(undefined, env({ [TELEMETRY_ENABLE_ENV]: "1" }))).toBe(true);
  });
});
