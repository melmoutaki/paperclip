import {
  DAAS_AGENTOPS_CAPABILITIES,
  type DaasAgentOpsCapability,
} from "@paperclipai/shared";

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  daasCapabilities?: DaasAgentOpsCapability[];
};

const DAAS_CAPABILITY_DEFAULTS_BY_ROLE: Record<string, DaasAgentOpsCapability[]> = {
  daas_cto_agent: [...DAAS_AGENTOPS_CAPABILITIES],
  daas_infra_planner: [
    "daas.mission.create",
    "daas.mission.read",
    "daas.budget.read",
    "daas.ticket.update",
  ],
  daas_security_reviewer: [
    "daas.mission.read",
    "daas.evidence.read",
    "daas.approval.propose",
  ],
  daas_evidence_auditor: [
    "daas.mission.read",
    "daas.evidence.read",
  ],
  daas_cost_controller: [
    "daas.mission.read",
    "daas.budget.read",
  ],
  daas_operator: [
    "daas.mission.create",
    "daas.mission.read",
    "daas.evidence.read",
    "daas.budget.read",
    "daas.ticket.update",
  ],
};

const validDaasCapabilities = new Set<string>(DAAS_AGENTOPS_CAPABILITIES);

function roleKey(role: string) {
  return role.trim().toLowerCase();
}

export function defaultDaasCapabilitiesForRole(role: string): DaasAgentOpsCapability[] {
  return [...(DAAS_CAPABILITY_DEFAULTS_BY_ROLE[roleKey(role)] ?? [])];
}

function normalizeDaasCapabilities(value: unknown, role: string): DaasAgentOpsCapability[] | undefined {
  const explicit = Array.isArray(value)
    ? value.filter((entry): entry is DaasAgentOpsCapability =>
      typeof entry === "string" && validDaasCapabilities.has(entry),
    )
    : null;
  const capabilities = explicit ?? defaultDaasCapabilitiesForRole(role);
  return capabilities.length > 0 ? [...new Set(capabilities)] : undefined;
}

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  const daasCapabilities = defaultDaasCapabilitiesForRole(role);
  return {
    canCreateAgents: roleKey(role) === "ceo",
    ...(daasCapabilities.length > 0 ? { daasCapabilities } : {}),
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const { daasCapabilities: _ignoredDaasCapabilities, ...preserved } = record;
  const daasCapabilities = normalizeDaasCapabilities(record.daasCapabilities, role);
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    ...(daasCapabilities ? { daasCapabilities } : {}),
  };
}
