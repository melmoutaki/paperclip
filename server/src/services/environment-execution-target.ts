import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { DAAS_DIRECT_SSH_DISABLED_MESSAGE } from "@paperclipai/adapter-utils/ssh";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  // DAAS fork invariant: Paperclip must never reach a remote host over a direct
  // SSH connection (hosts are reached only through the DAAS API + DAAS SSH
  // Executor). Resolving an execution target for the `ssh` driver would emit a
  // `transport: "ssh"` target/spec that opens exactly that direct session, so
  // fail closed before any SSH target/spec can be built. Legacy `ssh`
  // environment rows can still be parsed/inspected elsewhere; they just can
  // never resolve to a runnable SSH execution target here.
  if (input.environment.driver === "ssh") {
    throw new Error(DAAS_DIRECT_SSH_DISABLED_MESSAGE);
  }

  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    if (
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "codex_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      runner: input.environmentRuntime && input.lease
        ? {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          }
        : undefined,
    };
  }

  // Only `local` and `sandbox` drivers resolve to runnable execution targets in
  // the DAAS fork; `ssh` already failed closed above, and any other driver has
  // no direct execution transport here.
  return null;
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
