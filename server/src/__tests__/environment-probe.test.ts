import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureSshWorkspaceReady = vi.hoisted(() => vi.fn());
const mockProbePluginEnvironmentDriver = vi.hoisted(() => vi.fn());
const mockProbePluginSandboxProviderDriver = vi.hoisted(() => vi.fn());
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  ensureSshWorkspaceReady: mockEnsureSshWorkspaceReady,
  DAAS_DIRECT_SSH_DISABLED_MESSAGE:
    "Direct SSH from Paperclip is disabled in the DAAS fork: remote hosts must be reached only through the DAAS API and DAAS SSH Executor, never via a direct SSH connection opened by Paperclip. Route this execution/probe/sync through the DAAS governed path instead of enabling direct SSH egress.",
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  probePluginEnvironmentDriver: mockProbePluginEnvironmentDriver,
  probePluginSandboxProviderDriver: mockProbePluginSandboxProviderDriver,
  resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
}));

import { probeEnvironment } from "../services/environment-probe.ts";

describe("probeEnvironment", () => {
  beforeEach(() => {
    mockEnsureSshWorkspaceReady.mockReset();
    mockProbePluginEnvironmentDriver.mockReset();
    mockProbePluginSandboxProviderDriver.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockResolvedValue(null);
  });

  it("reports local environments as immediately available", async () => {
    const result = await probeEnvironment({} as any, {
      id: "env-1",
      companyId: "company-1",
      name: "Local",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.ok).toBe(true);
    expect(result.driver).toBe("local");
    expect(result.summary).toContain("Local environment");
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });

  it("fails an SSH probe closed without opening a direct SSH connection", async () => {
    // DAAS fork invariant: an SSH probe would open a direct SSH connection to
    // the remote host, which is forbidden. The probe must report disabled and
    // never reach the SSH transport.
    const result = await probeEnvironment({} as any, {
      id: "env-ssh",
      companyId: "company-1",
      name: "SSH Fixture",
      description: null,
      driver: "ssh",
      status: "active",
      config: {
        host: "ssh.example.test",
        port: 2222,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.ok).toBe(false);
    expect(result.driver).toBe("ssh");
    expect(result.summary).toMatch(/disabled in the DAAS fork/i);
    expect(result.details).toEqual(
      expect.objectContaining({
        host: "ssh.example.test",
        port: 2222,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
      }),
    );
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });

  it("reports fake sandbox environments as ready without external calls", async () => {
    const result = await probeEnvironment({} as any, {
      id: "env-sandbox",
      companyId: "company-1",
      name: "Fake Sandbox",
      description: null,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result).toEqual({
      ok: true,
      driver: "sandbox",
      summary: "Fake sandbox provider is ready for image ubuntu:24.04.",
      details: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });

  it("routes plugin-backed sandbox provider probes through plugin workers", async () => {
    mockProbePluginSandboxProviderDriver.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake plugin probe passed.",
      details: {
        provider: "fake-plugin",
        metadata: { ready: true },
      },
    });
    const workerManager = {} as any;

    const result = await probeEnvironment({} as any, {
      id: "env-sandbox-plugin",
      companyId: "company-1",
      name: "Fake Plugin Sandbox",
      description: null,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { pluginWorkerManager: workerManager });

    expect(result.ok).toBe(true);
    expect(mockProbePluginSandboxProviderDriver).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager,
      companyId: "company-1",
      environmentId: "env-sandbox-plugin",
      provider: "fake-plugin",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    });
  });

  it("routes plugin environment probes through the plugin worker host", async () => {
    mockProbePluginEnvironmentDriver.mockResolvedValue({
      ok: true,
      driver: "plugin",
      summary: "Plugin probe passed.",
      details: {
        metadata: { ready: true },
      },
    });
    const workerManager = {} as any;

    const result = await probeEnvironment({} as any, {
      id: "env-plugin",
      companyId: "company-1",
      name: "Plugin Sandbox",
      description: null,
      driver: "plugin",
      status: "active",
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: { template: "base" },
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { pluginWorkerManager: workerManager });

    expect(result.ok).toBe(true);
    expect(mockProbePluginEnvironmentDriver).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager,
      companyId: "company-1",
      environmentId: "env-plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: { template: "base" },
      },
    });
  });

  it("reports the DAAS-disabled reason in the SSH probe details", async () => {
    const result = await probeEnvironment({} as any, {
      id: "env-ssh",
      companyId: "company-1",
      name: "SSH Fixture",
      description: null,
      driver: "ssh",
      status: "active",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.ok).toBe(false);
    expect((result.details as { error?: string }).error).toMatch(/disabled in the DAAS fork/i);
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });
});
