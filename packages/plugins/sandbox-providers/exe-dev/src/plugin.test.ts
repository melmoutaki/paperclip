import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const spawnMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import plugin, { DAAS_EXE_DEV_DISABLED_MESSAGE, validateSshPrivateKey } from "./plugin.js";

describe("exe.dev sandbox provider plugin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    spawnMock.mockReset();
    delete process.env.EXE_API_KEY;
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "exe.dev sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes config and emits SSH guidance warnings", async () => {
    process.env.EXE_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "https://exe.dev",
        namePrefix: " Paperclip Sandbox ",
        image: " ubuntu:22.04 ",
        cpu: "4.8",
        memory: " 8GB ",
        disk: " 50GB ",
        env: {
          FOO: " bar ",
        },
        integrations: [" github "],
        tags: "prod, sandbox",
        timeoutMs: "450000.9",
        reuseLease: true,
        sshPort: "2222",
      },
    });

    expect(result).toEqual({
      ok: true,
      warnings: [
        "The Paperclip host must have SSH access to the created exe.dev VM, and its SSH key must be registered with exe.dev. The API token only covers provisioning.",
        "reuseLease keeps the VM alive between runs; this provider does not suspend retained VMs.",
      ],
      normalizedConfig: {
        apiKey: null,
        apiUrl: "https://exe.dev/exec",
        namePrefix: "paperclip-sandbox",
        image: "ubuntu:22.04",
        command: null,
        cpu: 4,
        memory: "8GB",
        disk: "50GB",
        comment: null,
        env: { FOO: "bar" },
        integrations: ["github"],
        tags: ["prod", "sandbox"],
        setupScript: null,
        prompt: null,
        timeoutMs: 450000,
        reuseLease: true,
        sshUser: null,
        sshPrivateKey: null,
        sshIdentityFile: null,
        sshPort: 2222,
        strictHostKeyChecking: "accept-new",
      },
    });
  });

  it("normalizes trailing /exec apiUrl inputs without duplication", async () => {
    process.env.EXE_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "https://exe.dev/exec/",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedConfig: {
        apiUrl: "https://exe.dev/exec",
      },
    });
  });

  it("rejects invalid config", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "not-a-url",
        cpu: 0,
        env: {
          "BAD-KEY": "value",
        },
        sshPort: 70000,
        strictHostKeyChecking: "",
        timeoutMs: 0,
      },
    })).resolves.toEqual({
      ok: false,
      warnings: [
        "The Paperclip host must have SSH access to the created exe.dev VM, and its SSH key must be registered with exe.dev. The API token only covers provisioning.",
      ],
      errors: [
        "apiUrl must be a valid URL.",
        "timeoutMs must be between 1 and 86400000.",
        "cpu must be greater than 0 when provided.",
        "sshPort must be between 1 and 65535.",
        "exe.dev environments require an API key in config or EXE_API_KEY.",
        "env contains an invalid key: BAD-KEY",
        "strictHostKeyChecking cannot be empty.",
      ],
    });
  });

  describe("sshPrivateKey validation", () => {
    const VALID_OPENSSH = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
      "ZWQyNTUxOQAAACBPzMxQp4Y6XCfDV2t6oWmqHkKx0K7C7w7q9F6gQ3jPbgAAAJjJ8jjE",
      "yfI4xAAAAAtzc2gtZWQyNTUxOQAAACBPzMxQp4Y6XCfDV2t6oWmqHkKx0K7C7w7q9F6g",
      "Q3jPbgAAAEDqLhB4kV1tw8m4gE9oNCkF2cJv0YnHQ8E5sHU3xKnD5k/MzFCnhjpcJ8NX",
      "a3qhaaoeQrHQrsLvDur0XqBDeM9uAAAAFXVzZXJAaG9zdAECAwQ=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const VALID_RSA_PEM = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
      "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
      "o3qGy0t6z5tZbcgvflRslzu1HxXLpwYqQq2gMNw9UQAoHs3rDl+EzBjF6trBV5wF",
      "wQIhANwiwDR7TVlIRk5kbgPMd2dDgY8mAU1cQ8KbWvjVMmKxAiEAxYTUyVjwhfQy",
      "VJoR7T0n4XdR1n+W8Eth7AEPxnHfaQECIB5cNuqB9F1qC2pSyf6e+UAyl9rmKQXp",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    it("accepts a valid OpenSSH PEM block", () => {
      expect(validateSshPrivateKey(VALID_OPENSSH)).toBeNull();
    });

    it("accepts a valid PKCS#1 RSA PEM block", () => {
      expect(validateSshPrivateKey(VALID_RSA_PEM)).toBeNull();
    });

    it("accepts UUID-like secret reference values from the save-time schema stage", async () => {
      process.env.EXE_API_KEY = "host-key";

      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        driverKey: "exe-dev",
        config: {
          apiKey: "api-key",
          sshPrivateKey: "11111111-1111-4111-8111-111111111111",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        normalizedConfig: {
          sshPrivateKey: "11111111-1111-4111-8111-111111111111",
        },
      });
      expect(result?.errors ?? []).toEqual([]);
    });

    it("treats empty / whitespace-only input as valid (falls back to on-host key)", () => {
      expect(validateSshPrivateKey("")).toBeNull();
      expect(validateSshPrivateKey("   \n\n  ")).toBeNull();
    });

    it("rejects a pasted public key", () => {
      expect(
        validateSshPrivateKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE+gT9 user@host"),
      ).toMatch(/looks like a PUBLIC key/);
    });

    it("rejects a PuTTY PPK file paste", () => {
      const ppk = [
        "PuTTY-User-Key-File-3: ssh-ed25519",
        "Encryption: none",
        "Comment: imported-openssh-key",
        "Public-Lines: 2",
        "AAAAC3NzaC1lZDI1NTE5AAAAIE+gT9zMxQp4Y6XCfDV2t6oWmqHkKx0K7C7w7q9F6g",
        "Q3jP",
      ].join("\n");
      expect(validateSshPrivateKey(ppk)).toMatch(/PuTTY \.ppk/);
    });

    it("rejects a missing END marker (truncated paste)", () => {
      const truncated = VALID_OPENSSH.split("\n").slice(0, -1).join("\n");
      expect(validateSshPrivateKey(truncated)).toMatch(/missing its '-----END/);
    });

    it("rejects a body with non-base64 characters", () => {
      const garbled = [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "this is not base64!!",
        "-----END OPENSSH PRIVATE KEY-----",
      ].join("\n");
      expect(validateSshPrivateKey(garbled)).toMatch(/non-base64/);
    });

    it("rejects a header/footer label mismatch", () => {
      const mismatched = [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "Zm9vYmFy",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      expect(validateSshPrivateKey(mismatched)).toMatch(/header\/footer mismatch/);
    });

    it("returns the sshPrivateKey error from onEnvironmentValidateConfig on save", async () => {
      process.env.EXE_API_KEY = "host-key";

      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        driverKey: "exe-dev",
        config: {
          sshPrivateKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE+gT9 user@host",
        },
      });

      expect(result?.ok).toBe(false);
      expect(result?.errors ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/sshPrivateKey looks like a PUBLIC key/)]),
      );
    });
  });

  // DAAS invariant regression: Paperclip must never SSH directly to a leased VM
  // (Paperclip → DAAS API → DAAS SSH Executor → VM is the only sanctioned path).
  // The exe.dev provider's only execution mechanism is direct SSH, so it is
  // disabled fork-wide: every outbound lifecycle/execution operation must fail
  // closed WITHOUT spawning `ssh` or opening the exe.dev HTTPS provisioning API.
  describe("DAAS fork: disabled (no direct SSH egress)", () => {
    const baseConfig = { apiKey: "api-key", timeoutMs: 300000 };

    function expectNoOutbound() {
      expect(spawnMock, "must never spawn ssh from Paperclip").not.toHaveBeenCalled();
      expect(fetchMock, "must never open the exe.dev provisioning API").not.toHaveBeenCalled();
    }

    it("fails closed when acquiring a lease (no VM provisioning, no SSH)", async () => {
      await expect(plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        runId: "run-1",
        config: baseConfig,
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("fails closed when executing a command (never spawns ssh)", async () => {
      await expect(plugin.definition.onEnvironmentExecute?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        config: baseConfig,
        lease: {
          providerLeaseId: "vm-1",
          metadata: { sshDest: "vm-1.exe.xyz" },
        },
        command: "node",
        args: ["-v"],
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("reports the DAAS-invariant failure from a probe without provisioning", async () => {
      const result = await plugin.definition.onEnvironmentProbe?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        config: baseConfig,
      });

      expect(result).toMatchObject({ ok: false, summary: "exe.dev environment probe failed." });
      expect(String(result?.metadata?.error ?? "")).toBe(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("fails closed when resuming a retained lease (no lookup)", async () => {
      await expect(plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "vm-1",
        config: baseConfig,
        leaseMetadata: { sshDest: "vm-1.exe.xyz" },
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("fails closed when releasing a non-reusable lease (no rm call)", async () => {
      await expect(plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "vm-1",
        config: { ...baseConfig, reuseLease: false },
        leaseMetadata: {},
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("fails closed when destroying a lease (no rm call)", async () => {
      await expect(plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "vm-2",
        config: baseConfig,
        leaseMetadata: {},
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("fails closed when realizing a workspace that requires SSH", async () => {
      await expect(plugin.definition.onEnvironmentRealizeWorkspace?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        config: baseConfig,
        lease: {
          providerLeaseId: "vm-1",
          metadata: { sshDest: "vm-1.exe.xyz", remoteCwd: "/srv/paperclip/run-1" },
        },
        workspace: { localPath: "/local/paperclip", remotePath: undefined },
      })).rejects.toThrow(DAAS_EXE_DEV_DISABLED_MESSAGE);
      expectNoOutbound();
    });

    it("resolves a workspace cwd without egress when no VM metadata requires SSH", async () => {
      const result = await plugin.definition.onEnvironmentRealizeWorkspace?.({
        driverKey: "exe-dev",
        companyId: "company-1",
        environmentId: "env-1",
        config: baseConfig,
        lease: {
          providerLeaseId: null,
          metadata: { remoteCwd: "/srv/paperclip/no-vm" },
        },
        workspace: { localPath: "/local/paperclip" },
      });

      expect(result?.cwd).toBe("/srv/paperclip/no-vm");
      expectNoOutbound();
    });
  });
});
