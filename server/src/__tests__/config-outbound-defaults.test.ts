import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(),
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: readConfigFileMock,
}));

vi.mock("../worktree-config.js", () => ({
  maybeRepairLegacyWorktreeConfigAndEnvFiles: vi.fn(),
}));

import { loadConfig } from "../config.js";

const TELEMETRY_ENV_KEYS = [
  "PAPERCLIP_TELEMETRY_ENABLED",
  "PAPERCLIP_TELEMETRY_DISABLED",
  "PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY",
  "PAPERCLIP_FEEDBACK_SHARING_ENABLED",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
  "PAPERCLIP_TELEMETRY_BACKEND_URL",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
] as const;

const saved: Record<string, string | undefined> = {};

describe("loadConfig — DAAS outbound defaults", () => {
  beforeEach(() => {
    for (const key of TELEMETRY_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    readConfigFileMock.mockReset();
    readConfigFileMock.mockReturnValue(null);
  });

  afterEach(() => {
    for (const key of TELEMETRY_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("disables telemetry and feedback sharing by default", () => {
    const config = loadConfig();
    expect(config.telemetryEnabled).toBe(false);
    expect(config.feedbackSharingEnabled).toBe(false);
    expect(config.feedbackExportBackendUrl).toBeUndefined();
    expect(config.feedbackExportBackendToken).toBeUndefined();
  });

  it("enables telemetry only when the config file opts in", () => {
    readConfigFileMock.mockReturnValue({
      database: { mode: "embedded-postgres" },
      server: {},
      telemetry: { enabled: true },
    });
    expect(loadConfig().telemetryEnabled).toBe(true);
  });

  it("enables feedback sharing only when the env opts in", () => {
    process.env.PAPERCLIP_FEEDBACK_SHARING_ENABLED = "1";
    expect(loadConfig().feedbackSharingEnabled).toBe(true);
  });
});
