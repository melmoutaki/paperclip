import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import {
  DAAS_MISSION_ID_CONTEXT_KEY,
  DAAS_MISSION_ROUTE_CONTEXT_KEY,
  DAAS_PAPERCLIP_MISSIONS_ROUTE,
} from "@paperclipai/shared";
import {
  guardDaasInfrastructureTaskDispatch,
  type DaasInfrastructureTaskGuardInput,
  type DaasInfrastructureTaskGuardResult,
} from "./daas-infrastructure-task-guard.js";

export const DAAS_MISSION_DESTINATION_ROUTE = "/api/missions";
const DEFAULT_DAAS_MISSION_HANDOFF_TIMEOUT_MS = 10_000;
const DAAS_HTTP_ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "daas-api",
]);

/**
 * T269 — Route detected infrastructure tickets through the DAAS mission adapter.
 *
 * The Paperclip ticket/work-item workflow must NEVER run an infrastructure
 * ticket through an internal executor / raw shell / SSH path. When the T258
 * routing guard classifies a ticket as infrastructure intent, this module
 * hands the ticket off to the configured DAAS adapter
 * (`POST /api/missions`), persists the DAAS-returned
 * mission id on the ticket, and surfaces the DAAS status verbatim — including
 * `rejected`, `blocked_by_policy`, and `awaiting_approval` — without ever
 * faking success.
 *
 * The outbound credential and origin validation mirror the inbound mission
 * handoff in `routes/daas-integrations.ts`, preserving the T259 outbound
 * defaults (HTTPS-only except explicit local/Docker sidecar development,
 * fail-closed when the shared secret is absent).
 */

/** DAAS statuses that mean the mission was accepted for governed execution. */
export const DAAS_MISSION_ACCEPTED_STATUSES = [
  "accepted",
  "queued",
  "created",
  "handoff_accepted",
  "requested",
  "planning",
  "policy_checking",
  "waiting_for_lock",
  "running",
  "verifying",
] as const;

/**
 * DAAS statuses that must be surfaced as-is. The mission reached DAAS but did
 * NOT succeed — Paperclip must not paper over them with a synthetic success.
 */
export const DAAS_MISSION_SURFACED_STATUSES = [
  "rejected",
  "blocked_by_policy",
  "awaiting_approval",
  "failed",
  "partial_success",
  "inconclusive",
  "cancelled",
  "timeout",
] as const;

export type DaasMissionRoutingOutcome =
  | "pending_daas_route"
  | "routed_accepted"
  | "routed_surfaced"
  | "adapter_unavailable"
  | "handoff_failed";

export interface DaasMissionAdapterDispatchResult {
  /** Coarse outcome used to drive the ticket workflow decision. */
  outcome: DaasMissionRoutingOutcome;
  /** true only when DAAS returns an accepted/running mission status. Never fabricated. */
  ok: boolean;
  /** Raw DAAS status (or a synthetic adapter status when DAAS was unreachable). */
  daasStatus: string;
  /** DAAS-owned mission id to persist on the ticket. */
  daasMissionId: string | null;
  httpStatus: number;
  /** Always false — this module never fakes a successful execution. */
  faked: false;
}

export interface DaasMissionTarget {
  type: "server" | "group" | "environment";
  id: string;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = readRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildDaasMissionRequestFingerprint(input: {
  companyId: string;
  agentId: string;
  issueId: string;
  prompt: string;
  target: DaasMissionTarget | null;
  signals: string[];
}): string {
  return createHash("sha256")
    .update(stableJson({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      prompt: input.prompt,
      target: input.target,
      signals: [...input.signals].sort(),
    }))
    .digest("hex");
}

export function isAllowedDaasMissionOrigin(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return DAAS_HTTP_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Resolve the configured DAAS adapter mission endpoint
 * (`<DAAS_BASE_URL>/api/missions`). Returns null when
 * DAAS is not configured or the origin is unsafe (HTTPS required except for
 * explicit local/Docker sidecar development), so callers fail closed.
 */
export function resolveDaasMissionAdapterUrl(): URL | null {
  const base = process.env.DAAS_BASE_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL(DAAS_MISSION_DESTINATION_ROUTE, base);
    if (!isAllowedDaasMissionOrigin(url)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Build the mission prompt from ticket fields using the same precedence the
 * inbound mission route applies (prompt/instruction/task/title).
 */
export function buildDaasMissionPrompt(input: {
  title?: string | null;
  description?: string | null;
  promptTexts?: Array<string | null | undefined>;
  instructionTexts?: Array<string | null | undefined>;
}): string | null {
  const candidates = [
    ...(input.promptTexts ?? []),
    input.description,
    input.title,
    ...(input.instructionTexts ?? []),
  ];
  for (const candidate of candidates) {
    const value = readNonEmptyString(candidate);
    if (value) return value;
  }
  return null;
}

export function resolveDaasMissionTarget(value?: unknown): DaasMissionTarget | null {
  const record = readRecord(value);
  const nested = readRecord(record?.daasTarget) ?? readRecord(record?.target);
  const type = readNonEmptyString(nested?.type);
  const id = readNonEmptyString(nested?.id);
  if (type && id && ["server", "group", "environment"].includes(type)) {
    return { type: type as DaasMissionTarget["type"], id };
  }

  const serverId =
    readNonEmptyString(record?.serverId) ??
    readNonEmptyString(record?.targetServerId) ??
    readNonEmptyString(record?.server_id) ??
    process.env.DAAS_DEFAULT_TARGET_SERVER_ID?.trim() ??
    null;
  return serverId ? { type: "server", id: serverId } : null;
}

export function classifyDaasMissionStatus(status: string | null): DaasMissionRoutingOutcome | null {
  if (!status) return null;
  if ((DAAS_MISSION_ACCEPTED_STATUSES as readonly string[]).includes(status)) return "routed_accepted";
  if ((DAAS_MISSION_SURFACED_STATUSES as readonly string[]).includes(status)) return "routed_surfaced";
  return null;
}

function resolveDaasMissionHandoffTimeoutMs(): number {
  const raw = Number.parseInt(process.env.DAAS_MISSION_HANDOFF_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 300_000);
  return DEFAULT_DAAS_MISSION_HANDOFF_TIMEOUT_MS;
}

/**
 * POST an infrastructure ticket to the configured DAAS adapter mission route.
 *
 * Fail-closed: missing outbound credential, an unreachable adapter, an HTTP
 * error, or an unrecognized acknowledgement all yield a non-ok result. A
 * `rejected` / `blocked_by_policy` / `awaiting_approval` status is surfaced
 * (ok=false) rather than treated as success.
 */
export async function postInfrastructureTicketToDaasAdapter(input: {
  url: URL;
  companyId: string;
  agentId: string;
  missionId: string;
  requestFingerprint: string;
  prompt: string;
	  issueId: string;
	  title: string | null;
	  target: DaasMissionTarget | null;
	  signals: string[];
	}): Promise<DaasMissionAdapterDispatchResult> {
  const adapterToken = process.env.DAAS_API_SHARED_SECRET?.trim();
  if (!adapterToken) {
    return {
      outcome: "adapter_unavailable",
      ok: false,
      daasStatus: "daas_mission_adapter_unavailable",
      daasMissionId: null,
      httpStatus: 0,
      faked: false,
    };
  }

  const body = JSON.stringify({
    companyId: input.companyId,
    agentId: input.agentId,
    missionId: input.missionId,
    issueId: input.issueId,
    title: input.title,
	    prompt: input.prompt,
	    target: input.target,
	    targetResolution: input.target ? "paperclip_resolved" : "daas_required",
	    signals: input.signals,
    requestFingerprint: input.requestFingerprint,
  });
  let response: Response;
  const timeoutMs = resolveDaasMissionHandoffTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paperclip-webhook-secret": adapterToken,
        "idempotency-key": `paperclip:${input.companyId}:${input.issueId}:${input.requestFingerprint}`,
      },
      body,
      signal: controller.signal,
    });
  } catch {
    return {
      outcome: "adapter_unavailable",
      ok: false,
      daasStatus: "daas_mission_adapter_unavailable",
      daasMissionId: null,
      httpStatus: 0,
      faked: false,
    };
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const data = readRecord(payload?.data);
  const wrapperOk = typeof payload?.ok === "boolean" ? payload.ok : null;
  const daasMissionId =
    readNonEmptyString(data?.daas_mission_id) ??
    readNonEmptyString(payload?.missionId) ??
    readNonEmptyString(payload?.daas_mission_id);
  const status =
    readNonEmptyString(data?.status) ??
    readNonEmptyString(payload?.status);
  const classification = classifyDaasMissionStatus(status);

  if (classification === "routed_surfaced") {
    return {
      outcome: classification,
      ok: false,
      daasStatus: status ?? classification,
      daasMissionId,
      httpStatus: response.status,
      faked: false,
    };
  }

  if (
    !classification ||
    wrapperOk === false ||
    (classification === "routed_accepted" && (!response.ok || !daasMissionId))
  ) {
    return {
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_handoff_failed",
      daasMissionId,
      httpStatus: response.status,
      faked: false,
    };
  }

  return {
    outcome: classification,
    ok: classification === "routed_accepted",
    daasStatus: status ?? classification,
    daasMissionId,
    httpStatus: response.status,
    faked: false,
  };
}

export interface PersistedDaasMissionState {
  route: string;
  missionId: string | null;
  requestFingerprint: string;
	  target: DaasMissionTarget | null;
  status: string;
  outcome: DaasMissionRoutingOutcome;
  ok: boolean;
  executionAuthority: "daas";
  httpStatus: number;
  signals: string[];
  routedAt: string;
}

type PaperclipDaasRouteStatus =
  | "pending_daas_route"
  | "routed_to_daas"
  | "blocked_by_policy"
  | "daas_route_failed";

function classifyPaperclipDaasRouteStatus(mission: PersistedDaasMissionState): PaperclipDaasRouteStatus {
  if (mission.outcome === "pending_daas_route") return "pending_daas_route";
  if (mission.ok && mission.outcome === "routed_accepted") return "routed_to_daas";
  return mission.status === "blocked_by_policy" ? "blocked_by_policy" : "daas_route_failed";
}

export interface PendingDaasMissionRouteInput {
  companyId: string;
  agentId: string;
  issueId: string;
  title: string | null;
  description: string | null;
  promptTexts?: Array<string | null | undefined>;
  instructionTexts?: Array<string | null | undefined>;
  contextSnapshot?: Record<string, unknown> | null;
  target?: DaasMissionTarget | null;
  signals: string[];
}

export interface DaasInfrastructureIntentState {
  classified: true;
  promptTextFingerprints: string[];
  signals: string[];
  classifiedAt: string;
}

function normalizeDaasInfrastructureIntentTexts(input: PendingDaasMissionRouteInput | RouteInfrastructureTicketInput): string[] {
  return [...new Set([
    ...(input.promptTexts ?? []),
    input.description,
    input.title,
    ...(input.instructionTexts ?? []),
  ]
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value)))];
}

function buildDaasInfrastructureIntentState(
  input: PendingDaasMissionRouteInput | RouteInfrastructureTicketInput,
): DaasInfrastructureIntentState {
	  return {
	    classified: true,
	    promptTextFingerprints: normalizeDaasInfrastructureIntentTexts(input).map((text) =>
	      createHash("sha256").update(text).digest("hex")
	    ),
	    signals: input.signals,
	    classifiedAt: new Date().toISOString(),
	  };
	}

export function readDaasInfrastructureIntentState(value: unknown): DaasInfrastructureIntentState | null {
  const record = readRecord(value);
  const state = readRecord(record?.daasInfrastructureIntent);
  if (state?.classified !== true) return null;
	  const promptTextFingerprints = Array.isArray(state.promptTextFingerprints)
	    ? state.promptTextFingerprints.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
	    : [];
	  return {
	    classified: true,
	    promptTextFingerprints,
	    signals: Array.isArray(state.signals)
	      ? state.signals.filter((entry): entry is string => typeof entry === "string")
      : [],
    classifiedAt: readNonEmptyString(state.classifiedAt) ?? new Date(0).toISOString(),
  };
}

export function summarizeDaasMissionRouting(
	  result: DaasMissionAdapterDispatchResult,
	  options: { requestFingerprint: string; target: DaasMissionTarget | null; signals: string[]; routedAt: Date },
): PersistedDaasMissionState {
  return {
    route: DAAS_MISSION_DESTINATION_ROUTE,
    missionId: result.daasMissionId,
    requestFingerprint: options.requestFingerprint,
    target: options.target,
    status: result.daasStatus,
    outcome: result.outcome,
    ok: result.ok,
    executionAuthority: "daas",
    httpStatus: result.httpStatus,
    signals: options.signals,
    routedAt: options.routedAt.toISOString(),
  };
}

function readPersistedDaasMissionState(value: unknown): PersistedDaasMissionState | null {
  const record = readRecord(value);
  const mission = readRecord(record?.daasMission);
  if (!mission) return null;
  const missionId = readNonEmptyString(mission?.missionId);
	  const requestFingerprint = readNonEmptyString(mission?.requestFingerprint);
	  const targetRecord = readRecord(mission?.target);
	  const targetType = readNonEmptyString(targetRecord?.type);
	  const targetId = readNonEmptyString(targetRecord?.id);
	  const target = targetRecord === null
	    ? null
	    : targetType && targetId && ["server", "group", "environment"].includes(targetType)
	      ? { type: targetType as DaasMissionTarget["type"], id: targetId }
	      : undefined;
	  const status = readNonEmptyString(mission?.status);
  const outcome = readNonEmptyString(mission?.outcome);
  const route = readNonEmptyString(mission?.route);
  const executionAuthority = readNonEmptyString(mission?.executionAuthority);
  const statusClassification = status === "pending_daas_route"
    ? "pending_daas_route"
    : classifyDaasMissionStatus(status);
  if (
	    !status ||
	    !requestFingerprint ||
	    target === undefined ||
	    !outcome ||
    route !== DAAS_MISSION_DESTINATION_ROUTE ||
    executionAuthority !== "daas" ||
    statusClassification !== outcome ||
    !["pending_daas_route", "routed_accepted", "routed_surfaced"].includes(outcome)
  ) {
    return null;
  }
  if (outcome === "routed_accepted" && !missionId) return null;
  return {
	    route,
	    missionId,
	    requestFingerprint,
	    target,
    status,
    outcome: outcome as DaasMissionRoutingOutcome,
    ok: mission.ok === true && outcome === "routed_accepted",
    executionAuthority: "daas",
    httpStatus: typeof mission.httpStatus === "number" ? mission.httpStatus : 0,
    signals: Array.isArray(mission.signals)
      ? mission.signals.filter((entry): entry is string => typeof entry === "string")
      : [],
    routedAt: readNonEmptyString(mission.routedAt) ?? new Date(0).toISOString(),
  };
}

export function readDaasMissionState(value: unknown): PersistedDaasMissionState | null {
  return readPersistedDaasMissionState(value);
}

function buildPendingDaasMissionRoute(input: PendingDaasMissionRouteInput): PersistedDaasMissionState | null {
  const prompt = buildDaasMissionPrompt({
    title: input.title,
    description: input.description,
    promptTexts: input.promptTexts,
    instructionTexts: input.instructionTexts,
  });
	  const target = input.target ?? resolveDaasMissionTarget(input.contextSnapshot);
	  if (!prompt) return null;
  const requestFingerprint = buildDaasMissionRequestFingerprint({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    prompt,
    target,
    signals: input.signals,
  });
  return {
    route: DAAS_MISSION_DESTINATION_ROUTE,
    missionId: null,
    requestFingerprint,
    target,
    status: "pending_daas_route",
    outcome: "pending_daas_route",
    ok: false,
    executionAuthority: "daas",
    httpStatus: 0,
    signals: input.signals,
    routedAt: new Date().toISOString(),
  };
}

async function readExistingDaasMissionForIssue(
  db: Db,
  input: { companyId: string; issueId: string; requestFingerprint: string },
): Promise<PersistedDaasMissionState | null> {
  const existing = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .then((rows) => rows[0] ?? null);
  const mission = readPersistedDaasMissionState(existing?.executionState);
  return mission?.requestFingerprint === input.requestFingerprint &&
    mission.outcome !== "pending_daas_route"
    ? mission
    : null;
}

export function buildPendingDaasMissionExecutionState(
  previousState: Record<string, unknown> | null | undefined,
  input: PendingDaasMissionRouteInput,
): Record<string, unknown> {
  const pending = buildPendingDaasMissionRoute(input) ?? {
	    route: DAAS_MISSION_DESTINATION_ROUTE,
	    missionId: null,
	    requestFingerprint: "unavailable",
	    target: null,
    status: "pending_daas_route",
    outcome: "pending_daas_route" as const,
    ok: false,
    executionAuthority: "daas" as const,
    httpStatus: 0,
    signals: input.signals,
    routedAt: new Date().toISOString(),
  };
  return {
    ...buildDaasMissionExecutionState(previousState, pending),
    daasInfrastructureIntent: buildDaasInfrastructureIntentState(input),
  };
}

export async function persistPendingDaasMissionRouteOnIssue(
  db: Db,
  input: PendingDaasMissionRouteInput,
): Promise<PersistedDaasMissionState | null> {
  const existing = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .then((rows) => rows[0] ?? null);
  if (!existing) return null;
  const previousState =
    existing.executionState && typeof existing.executionState === "object"
      ? existing.executionState as Record<string, unknown>
      : {};
  const pending = buildPendingDaasMissionRoute(input);
  await db
    .update(issues)
    .set({
      executionState: buildPendingDaasMissionExecutionState(previousState, input),
      updatedAt: new Date(),
    })
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "daas",
    agentId: input.agentId,
    action: "daas.mission_route.pending",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      route: DAAS_MISSION_DESTINATION_ROUTE,
      status: "pending_daas_route",
      signals: input.signals,
      executionAuthority: "daas",
      note: "durable pending route before DAAS call; no internal execution before DAAS acceptance",
    },
  });
  return pending;
}

/**
 * Persist the DAAS mission id + status onto the ticket's execution state so the
 * work item carries the governed mission provenance. The provenance object is
 * keyed identically to the server-minted routing context so downstream guards
 * recognize it as genuinely mission-routed.
 */
export async function persistDaasMissionOnIssue(
  db: Db,
  input: { companyId: string; issueId: string; mission: PersistedDaasMissionState },
): Promise<void> {
  const existing = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .then((rows) => rows[0] ?? null);
  if (!existing) return;

  const previousState =
    existing.executionState && typeof existing.executionState === "object"
      ? existing.executionState
      : {};

  await db
    .update(issues)
    .set({
      ...(!input.mission.ok && input.mission.outcome !== "pending_daas_route" ? { status: "blocked" } : {}),
      executionState: buildDaasMissionExecutionState(previousState, input.mission),
      updatedAt: new Date(),
    })
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
}

export function buildDaasMissionExecutionState(
  previousState: Record<string, unknown> | null | undefined,
  mission: PersistedDaasMissionState,
): Record<string, unknown> {
  const missionWasAcknowledged =
    Boolean(mission.missionId) &&
    mission.outcome === "routed_accepted" &&
    mission.ok;

  const nextState: Record<string, unknown> = {
    ...(previousState ?? {}),
    daasMission: mission,
    daasRouteStatus: classifyPaperclipDaasRouteStatus(mission),
    daasInternalExecution: "disabled",
  };
  delete nextState[DAAS_MISSION_ROUTE_CONTEXT_KEY];
  delete nextState[DAAS_MISSION_ID_CONTEXT_KEY];
  if (missionWasAcknowledged) {
    nextState[DAAS_MISSION_ROUTE_CONTEXT_KEY] = {
      route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
      [DAAS_MISSION_ID_CONTEXT_KEY]: mission.missionId,
    };
  }
  return nextState;
}

export interface RouteInfrastructureTicketInput {
  companyId: string;
  agentId: string;
  issueId: string | null;
  title: string | null;
  description: string | null;
  /** Text that should become the DAAS mission prompt; detection-only metadata stays in instructionTexts. */
  promptTexts?: Array<string | null | undefined>;
  instructionTexts?: Array<string | null | undefined>;
  signals: string[];
  contextSnapshot?: Record<string, unknown> | null;
  target?: DaasMissionTarget | null;
  /** Optional Paperclip-side mission id retained for callers that already carry one. */
  missionId?: string | null;
}

export interface RouteInfrastructureTicketResult {
  dispatch: DaasMissionAdapterDispatchResult;
  mission: PersistedDaasMissionState;
  /** Human-readable reason for cancelling the internal run, surfacing DAAS status. */
  cancellationReason: string;
}

function buildCancellationReason(result: DaasMissionAdapterDispatchResult): string {
  const missionRef = result.daasMissionId ? ` (DAAS mission ${result.daasMissionId})` : "";
  switch (result.outcome) {
    case "routed_accepted":
      return `Infrastructure ticket routed to the DAAS mission adapter${missionRef}; status ${result.daasStatus}. Internal execution is not used for infrastructure tickets.`;
    case "routed_surfaced":
      return `Infrastructure ticket routed to the DAAS mission adapter${missionRef}; DAAS status: ${result.daasStatus}. Internal execution is not used for infrastructure tickets.`;
    case "adapter_unavailable":
      return "Infrastructure ticket blocked fail-closed: the DAAS mission adapter is unavailable. Infrastructure work must be routed through the DAAS governed mission API; internal execution is not used.";
    case "handoff_failed":
    default:
      return `Infrastructure ticket blocked fail-closed: the DAAS mission adapter rejected the handoff (status ${result.daasStatus}). Internal execution is not used for infrastructure tickets.`;
  }
}

/**
 * Route a detected infrastructure ticket through the configured DAAS adapter,
 * persist the returned mission id/status on the ticket, and log the routing —
 * without ever invoking an internal executor / shell / SSH path.
 */
export async function routeInfrastructureTicketThroughDaasAdapter(
  db: Db,
  input: RouteInfrastructureTicketInput,
): Promise<RouteInfrastructureTicketResult> {
  const prompt = buildDaasMissionPrompt({
    title: input.title,
    description: input.description,
    promptTexts: input.promptTexts,
    instructionTexts: input.instructionTexts,
  });
  const target = input.target ?? resolveDaasMissionTarget(input.contextSnapshot);
  const issueId = readNonEmptyString(input.issueId);
	  const requestFingerprint = prompt && issueId
    ? buildDaasMissionRequestFingerprint({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId,
        prompt,
        target,
        signals: input.signals,
      })
    : null;
  const missionId = requestFingerprint ? `paperclip-${requestFingerprint.slice(0, 32)}` : null;

  if (issueId && requestFingerprint) {
    const existingMission = await readExistingDaasMissionForIssue(db, {
      companyId: input.companyId,
      issueId,
      requestFingerprint,
    });
    if (existingMission) {
      const dispatch: DaasMissionAdapterDispatchResult = {
        outcome: existingMission.outcome,
        ok: existingMission.ok,
        daasStatus: existingMission.status,
        daasMissionId: existingMission.missionId,
        httpStatus: existingMission.httpStatus,
        faked: false,
      };
      return { dispatch, mission: existingMission, cancellationReason: buildCancellationReason(dispatch) };
    }
  }

  const url = resolveDaasMissionAdapterUrl();
	  const dispatch: DaasMissionAdapterDispatchResult = url && prompt && issueId && requestFingerprint && missionId
    ? await postInfrastructureTicketToDaasAdapter({
        url,
        companyId: input.companyId,
        agentId: input.agentId,
        missionId,
        requestFingerprint,
        prompt,
        issueId,
        title: input.title,
        target,
        signals: input.signals,
      })
    : {
        outcome: "adapter_unavailable",
        ok: false,
        daasStatus: "daas_mission_adapter_unavailable",
        daasMissionId: null,
        httpStatus: 0,
        faked: false,
      };

	  const mission = summarizeDaasMissionRouting(dispatch, {
	    requestFingerprint: requestFingerprint ?? "unavailable",
	    target,
    signals: input.signals,
    routedAt: new Date(),
  });

  if (issueId) {
    await persistDaasMissionOnIssue(db, {
      companyId: input.companyId,
      issueId,
      mission,
    });
  }

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "daas",
    agentId: input.agentId,
    action: dispatch.ok ? "daas.mission_route.accepted" : "daas.mission_route.surfaced",
    entityType: issueId ? "issue" : "agent",
    entityId: issueId ?? input.agentId,
    details: {
      route: DAAS_MISSION_DESTINATION_ROUTE,
      missionId: dispatch.daasMissionId,
      status: dispatch.daasStatus,
      outcome: dispatch.outcome,
      ok: dispatch.ok,
      responseStatus: dispatch.httpStatus,
      signals: input.signals,
      executionAuthority: "daas",
      securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
    },
  });

  return { dispatch, mission, cancellationReason: buildCancellationReason(dispatch) };
}

/**
 * The single ticket-workflow decision seam: infrastructure tickets are routed
 * to the DAAS adapter and the internal executor is NEVER invoked; only
 * non-infrastructure tickets reach internal execution.
 *
 * Returns `routedToDaas: true` when the ticket was handed to DAAS (the caller
 * must then stop - no internal run), or `false` when the ticket is ordinary
 * work that may proceed through the internal executor.
 */
export async function enforceInfrastructureTicketRouting<T>(
  guardInput: DaasInfrastructureTaskGuardInput,
  handlers: {
    routeToDaasAdapter: (guard: DaasInfrastructureTaskGuardResult) => Promise<void>;
    runInternalExecutor: () => Promise<T>;
  },
): Promise<{ routedToDaas: true } | { routedToDaas: false; result: T }> {
  const guard = guardDaasInfrastructureTaskDispatch(guardInput);
  if (!guard.allowed) {
    await handlers.routeToDaasAdapter(guard);
    return { routedToDaas: true };
  }
  const result = await handlers.runInternalExecutor();
  return { routedToDaas: false, result };
}
