export function collectDaasInfrastructureIntentTexts(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectDaasInfrastructureIntentTexts(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["id", "companyId", "createdAt", "updatedAt"].includes(key))
      .flatMap(([, entry]) => collectDaasInfrastructureIntentTexts(entry));
  }
  return [];
}
