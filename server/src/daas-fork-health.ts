import {
  getOutboundConnectorStates,
  type OutboundConnectorState,
} from "@paperclipai/shared";
import { serverVersion } from "./version.js";

type DangerousConnectorId =
  | "direct-ssh-transport"
  | "ssh-environment-driver"
  | "ssh-execution-target"
  | "exe-dev-sandbox-provider"
  | "process-adapter-ssh-command";

export interface DaasForkDangerousConnectorState {
  id: DangerousConnectorId;
  title: string;
  enabled: boolean;
  reason: string;
}

export interface DaasForkHealthStatus {
  fork: "daas";
  paperclipVersion: string;
  daasPatchVersion: string;
  telemetry: {
    enabled: boolean;
    reason: OutboundConnectorState["reason"];
  };
  feedbackSharing: {
    enabled: boolean;
    reason: OutboundConnectorState["reason"];
  };
  nonRequiredOutbound: {
    enabledByDefault: false;
    enabledConnectorIds: string[];
  };
  dangerousConnectors: DaasForkDangerousConnectorState[];
  safe: boolean;
}

export interface BuildDaasForkHealthStatusInput {
  env?: NodeJS.ProcessEnv;
  paperclipVersion?: string;
  daasPatchVersion?: string;
  telemetryEnabled?: boolean;
  feedbackSharingEnabled?: boolean;
  dangerousConnectorOverrides?: Partial<Record<DangerousConnectorId, boolean>>;
}

const DEFAULT_DAAS_PATCH_VERSION = "daas/patches";

const DANGEROUS_CONNECTORS: readonly Omit<DaasForkDangerousConnectorState, "enabled" | "reason">[] = [
  { id: "direct-ssh-transport", title: "Generic direct SSH transport" },
  { id: "ssh-environment-driver", title: "SSH environment driver" },
  { id: "ssh-execution-target", title: "SSH execution target" },
  { id: "exe-dev-sandbox-provider", title: "exe.dev direct-SSH sandbox provider" },
  { id: "process-adapter-ssh-command", title: "Process adapter SSH command" },
] as const;

function stateById(states: readonly OutboundConnectorState[], id: string): OutboundConnectorState {
  const found = states.find((state) => state.id === id);
  if (!found) throw new Error(`Outbound connector state is missing required connector: ${id}`);
  return found;
}

function resolveDaasPatchVersion(env: NodeJS.ProcessEnv): string {
  return (
    env.DAAS_PATCH_VERSION?.trim() ||
    env.PAPERCLIP_DAAS_PATCH_VERSION?.trim() ||
    DEFAULT_DAAS_PATCH_VERSION
  );
}

export function buildDaasForkHealthStatus(
  input: BuildDaasForkHealthStatusInput = {},
): DaasForkHealthStatus {
  const env = input.env ?? process.env;
  const outboundStates = getOutboundConnectorStates({
    env,
    telemetryEnabled: input.telemetryEnabled,
    feedbackSharingEnabled: input.feedbackSharingEnabled,
  });
  const telemetry = stateById(outboundStates, "telemetry-ingest");
  const feedbackSharing = stateById(outboundStates, "feedback-trace-share");
  const nonRequiredEnabled = outboundStates
    .filter((state) => state.classification === "non_required" && state.enabled)
    .map((state) => state.id);

  const dangerousConnectors = DANGEROUS_CONNECTORS.map((connector) => {
    const enabled = input.dangerousConnectorOverrides?.[connector.id] === true;
    return {
      ...connector,
      enabled,
      reason: enabled
        ? "enabled_by_override"
        : "disabled_by_daas_fork_policy",
    };
  });

  // `safe` is the startup/deployment safety bit T260 gates on: telemetry must
  // stay off, and direct-infrastructure connectors must stay disabled. Feedback
  // sharing is still reported above as a non-required outbound connector, but it
  // is an explicit opt-in data-sharing path rather than a dangerous direct
  // infrastructure execution connector.
  const safe = !telemetry.enabled && !dangerousConnectors.some((connector) => connector.enabled);

  return {
    fork: "daas",
    paperclipVersion: input.paperclipVersion ?? serverVersion,
    daasPatchVersion: input.daasPatchVersion ?? resolveDaasPatchVersion(env),
    telemetry: {
      enabled: telemetry.enabled,
      reason: telemetry.reason,
    },
    feedbackSharing: {
      enabled: feedbackSharing.enabled,
      reason: feedbackSharing.reason,
    },
    nonRequiredOutbound: {
      enabledByDefault: false,
      enabledConnectorIds: nonRequiredEnabled,
    },
    dangerousConnectors,
    safe,
  };
}

export function assertDaasForkHealthSafe(status: DaasForkHealthStatus): void {
  if (status.telemetry.enabled) {
    throw new Error("DAAS fork startup safety check failed: telemetry is enabled.");
  }
  const enabledDangerous = status.dangerousConnectors.filter((connector) => connector.enabled);
  if (enabledDangerous.length > 0) {
    throw new Error(
      `DAAS fork startup safety check failed: dangerous connectors enabled (${enabledDangerous
        .map((connector) => connector.id)
        .join(", ")}).`,
    );
  }
}
