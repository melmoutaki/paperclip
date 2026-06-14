import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { DAAS_DIRECT_SSH_DISABLED_MESSAGE } from "@paperclipai/adapter-utils/ssh";
import {
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: { pluginWorkerManager?: PluginWorkerManager; resolvedConfig?: ParsedEnvironmentConfig } = {},
): Promise<EnvironmentProbeResult> {
  const parsed = options.resolvedConfig ?? await resolveEnvironmentDriverConfigForRuntime(db, environment.companyId, environment);

  if (parsed.driver === "local") {
    return {
      ok: true,
      driver: "local",
      summary: "Local environment is available on this Paperclip host.",
      details: {
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
    };
  }

  if (parsed.driver === "sandbox") {
    if (!isBuiltinSandboxProvider(parsed.config.provider)) {
      if (!options.pluginWorkerManager) {
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox provider "${parsed.config.provider}" requires a running provider plugin.`,
          details: {
            provider: parsed.config.provider,
          },
        };
      }
      return await probePluginSandboxProviderDriver({
        db,
        workerManager: options.pluginWorkerManager,
        companyId: environment.companyId,
        environmentId: environment.id,
        provider: parsed.config.provider,
        config: parsed.config as unknown as Record<string, unknown>,
      });
    }
    return await probeSandboxProvider(parsed.config);
  }

  if (parsed.driver === "plugin") {
    if (!options.pluginWorkerManager) {
      return {
        ok: false,
        driver: "plugin",
        summary: `Plugin environment probes require a plugin worker manager for "${parsed.config.pluginKey}:${parsed.config.driverKey}".`,
        details: {
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      };
    }
    return await probePluginEnvironmentDriver({
      db,
      workerManager: options.pluginWorkerManager,
      companyId: environment.companyId,
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  // DAAS fork invariant: probing an SSH environment opens a direct SSH
  // connection from Paperclip to the remote host, which is forbidden (hosts are
  // reached only through the DAAS API + DAAS SSH Executor). Fail closed without
  // attempting the connection.
  return {
    ok: false,
    driver: "ssh",
    summary: "SSH environment probes are disabled in the DAAS fork.",
    details: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      error: DAAS_DIRECT_SSH_DISABLED_MESSAGE,
    },
  };
}
