import {
  DAAS_BLOCKED_INFRASTRUCTURE_ADAPTER_TYPES,
  DAAS_DANGEROUS_ADAPTER_CONFIG_KEYS,
} from "@paperclipai/shared";

const blockedAdapterTypes = new Set<string>(DAAS_BLOCKED_INFRASTRUCTURE_ADAPTER_TYPES);
const dangerousConfigKeys = new Set<string>(DAAS_DANGEROUS_ADAPTER_CONFIG_KEYS);

const dangerousConfigText =
  /\b(ssh|raw shell|shell command|shell execute|credential read|secret access|provider key|provider_key|private key|unrestricted infrastructure)\b|dangerously(?:skip|bypass)/i;

export function isDaasBlockedInfrastructureAdapterType(type: string): boolean {
  return blockedAdapterTypes.has(type);
}

export function isDaasBlockedInfrastructureConfigField(field: {
  key: string;
  label?: string;
  hint?: string;
}): boolean {
  if (dangerousConfigKeys.has(field.key)) return true;
  return dangerousConfigText.test([field.key, field.label, field.hint].filter(Boolean).join(" "));
}

export function filterDaasSafeAdapterOptions<T extends { value: string }>(options: T[]): T[] {
  return options.filter((option) => !isDaasBlockedInfrastructureAdapterType(option.value));
}
