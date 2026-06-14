import { afterEach, describe, expect, it } from "vitest";
import {
  assertDaasForkHealthSafe,
  buildDaasForkHealthStatus,
} from "../daas-fork-health.js";

const SAVED_ENV = {
  PAPERCLIP_TELEMETRY_ENABLED: process.env.PAPERCLIP_TELEMETRY_ENABLED,
  PAPERCLIP_FEEDBACK_SHARING_ENABLED: process.env.PAPERCLIP_FEEDBACK_SHARING_ENABLED,
  DAAS_PATCH_VERSION: process.env.DAAS_PATCH_VERSION,
  PAPERCLIP_DAAS_PATCH_VERSION: process.env.PAPERCLIP_DAAS_PATCH_VERSION,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  CI: process.env.CI,
};

function resetEnv() {
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("DAAS fork health status", () => {
  afterEach(resetEnv);

  it("reports default telemetry and dangerous connectors disabled", () => {
    delete process.env.PAPERCLIP_TELEMETRY_ENABLED;
    delete process.env.PAPERCLIP_FEEDBACK_SHARING_ENABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.DAAS_PATCH_VERSION = "daas-test-patch";

    const status = buildDaasForkHealthStatus({ paperclipVersion: "0.3.1" });

    expect(status).toMatchObject({
      fork: "daas",
      paperclipVersion: "0.3.1",
      daasPatchVersion: "daas-test-patch",
      telemetry: { enabled: false, reason: "disabled_by_default" },
      feedbackSharing: { enabled: false, reason: "disabled_by_default" },
      nonRequiredOutbound: {
        enabledByDefault: false,
        enabledConnectorIds: [],
      },
      safe: true,
    });
    expect(status.dangerousConnectors.every((connector) => connector.enabled === false)).toBe(true);
    expect(() => assertDaasForkHealthSafe(status)).not.toThrow();
  });

  it("fails the startup safety check when telemetry is enabled", () => {
    const status = buildDaasForkHealthStatus({
      paperclipVersion: "0.3.1",
      telemetryEnabled: true,
    });

    expect(status.telemetry.enabled).toBe(true);
    expect(status.safe).toBe(false);
    expect(() => assertDaasForkHealthSafe(status)).toThrow(/telemetry is enabled/i);
  });

  it("fails the startup safety check when a dangerous connector is enabled", () => {
    const status = buildDaasForkHealthStatus({
      paperclipVersion: "0.3.1",
      dangerousConnectorOverrides: {
        "process-adapter-ssh-command": true,
      },
    });

    expect(status.safe).toBe(false);
    expect(() => assertDaasForkHealthSafe(status)).toThrow(/process-adapter-ssh-command/);
  });
});
