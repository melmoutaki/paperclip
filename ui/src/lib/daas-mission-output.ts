type RecordLike = Record<string, unknown>;

export type DaasMissionTone = "success" | "warning" | "danger" | "pending";

export interface DaasMissionOutput {
  missionId: string | null;
  status: string;
  routeStatus: string | null;
  evidenceUrl: string | null;
  tone: DaasMissionTone;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return null;
}

function normalizeEvidenceUrl(value: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function readEvidenceUrl(state: RecordLike, mission: RecordLike, routed: RecordLike | null): string | null {
  const links = isRecord(mission.links) ? mission.links : null;
  const evidence = isRecord(mission.evidence) ? mission.evidence : null;
  const routedLinks = routed && isRecord(routed.links) ? routed.links : null;

  return normalizeEvidenceUrl(readFirstString(
    mission.evidenceUrl,
    mission.evidence_url,
    mission.evidenceLink,
    mission.evidence_link,
    mission.evidenceHref,
    mission.evidence_href,
    links?.evidence,
    links?.evidenceUrl,
    links?.evidence_url,
    evidence?.url,
    evidence?.href,
    evidence?.link,
    routed?.evidenceUrl,
    routed?.evidence_url,
    routed?.evidenceLink,
    routed?.evidence_link,
    routedLinks?.evidence,
    state.daasEvidenceUrl,
    state.daasEvidenceLink,
  ));
}

function toneForStatus(status: string, routeStatus: string | null): DaasMissionTone {
  const normalized = `${status} ${routeStatus ?? ""}`.toLowerCase();
  if (
    normalized.includes("blocked") ||
    normalized.includes("failed") ||
    normalized.includes("reject") ||
    normalized.includes("cancel") ||
    normalized.includes("timeout")
  ) {
    return "danger";
  }
  if (
    normalized.includes("inconclusive") ||
    normalized.includes("partial") ||
    normalized.includes("approval") ||
    normalized.includes("policy")
  ) {
    return "warning";
  }
  if (normalized.includes("success") || normalized.includes("routed_to_daas")) {
    return "success";
  }
  return "pending";
}

export function formatDaasStatus(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function getDaasMissionOutput(executionState: unknown): DaasMissionOutput | null {
  if (!isRecord(executionState)) return null;
  const mission = isRecord(executionState.daasMission) ? executionState.daasMission : null;
  if (!mission) return null;
  if (readString(mission.executionAuthority) !== "daas") return null;

  const status = readString(mission.status);
  if (!status) return null;

  const routed = isRecord(executionState.daasMissionRouted) ? executionState.daasMissionRouted : null;
  const missionId = readFirstString(mission.missionId, routed?.daasMissionId);
  const routeStatus = readString(executionState.daasRouteStatus);
  const evidenceUrl = readEvidenceUrl(executionState, mission, routed);

  return {
    missionId,
    status,
    routeStatus,
    evidenceUrl,
    tone: toneForStatus(status, routeStatus),
  };
}
