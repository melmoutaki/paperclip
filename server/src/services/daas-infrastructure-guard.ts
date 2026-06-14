import {
  DAAS_BLOCKED_INFRASTRUCTURE_ADAPTER_TYPES,
  DAAS_DANGEROUS_ADAPTER_CONFIG_KEYS,
} from "@paperclipai/shared";

const blockedInfrastructureAdapterTypes = new Set<string>(
  DAAS_BLOCKED_INFRASTRUCTURE_ADAPTER_TYPES,
);
const dangerousAdapterConfigKeys = new Set<string>(
  DAAS_DANGEROUS_ADAPTER_CONFIG_KEYS,
);

export function isDaasBlockedInfrastructureAdapterType(adapterType: string | undefined): boolean {
  return Boolean(adapterType && blockedInfrastructureAdapterTypes.has(adapterType));
}

export function collectDaasDirectInfrastructureConfigPaths(
  value: unknown,
  path: string,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const blocked: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (dangerousAdapterConfigKeys.has(key) && nested !== false && nested !== null && nested !== undefined) {
      blocked.push(nextPath);
      continue;
    }
    if (key === "executionTarget" && isDirectInfrastructureExecutionTarget(nested)) {
      blocked.push(nextPath);
      continue;
    }
    blocked.push(...collectDaasDirectInfrastructureConfigPaths(nested, nextPath));
  }
  return blocked;
}

function isDirectInfrastructureExecutionTarget(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "remote" && record.transport !== "sandbox") return true;
  if (record.transport === "ssh") return true;
  return false;
}
