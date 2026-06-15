import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issues } from "@paperclipai/db";
import { DAAS_PAPERCLIP_MISSIONS_ROUTE, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { detectDaasInfrastructureTaskIntent } from "../services/daas-infrastructure-task-guard.js";
import {
  buildDaasMissionRequestFingerprint,
  buildDaasMissionExecutionState,
  classifyDaasMissionStatus,
  DAAS_MISSION_DESTINATION_ROUTE,
  DAAS_MISSION_EVIDENCE_REQUIRED_STATUS,
  isAllowedDaasMissionOrigin,
  parseDaasEvidenceUrl,
} from "../services/daas-mission-adapter.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasLimitedMissionRoutePermission(agent: { permissions: unknown }): boolean {
  return readRecord(agent.permissions)?.trustPreset === LOW_TRUST_REVIEW_PRESET;
}

function readBearerToken(value: string | undefined): string | null {
  const token = value?.replace(/^Bearer\s+/i, "").trim();
  return token && token.length > 0 ? token : null;
}

export function readDaasMissionPrompt(body: Record<string, unknown>): string | null {
  return (
    readNonEmptyString(body.prompt) ??
    readNonEmptyString(body.instructions) ??
    readNonEmptyString(body.task) ??
    readNonEmptyString(body.title)
  );
}

export function detectDaasMissionRequestIntent(body: Record<string, unknown>) {
  return detectDaasInfrastructureTaskIntent(readDaasMissionPrompt(body), readNonEmptyString(body.title));
}

export function resolveDaasMissionHandoffUrl(): URL | null {
  const base = process.env.DAAS_BASE_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL("/api/missions", base);
    if (!isAllowedDaasMissionOrigin(url)) return null;
    return url;
  } catch {
    return null;
  }
}

export async function handoffMissionToDaas(input: {
  url: URL;
  companyId: string;
  agentId: string;
  missionId: string;
  requestFingerprint: string;
  prompt: string;
  issueId: string | null;
  title: string | null;
}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authValue = process.env.DAAS_API_SHARED_SECRET?.trim();
  if (!authValue) {
    return {
      ok: false as const,
      status: 0,
      daasMissionId: input.missionId,
      evidenceUrl: null,
    };
  }
  headers["x-paperclip-webhook-secret"] = authValue;
  headers["idempotency-key"] = `paperclip:${input.companyId}:${input.issueId}:${input.requestFingerprint}`;
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "paperclip",
        companyId: input.companyId,
        agentId: input.agentId,
        missionId: input.missionId,
        issueId: input.issueId,
        title: input.title,
        prompt: input.prompt,
        requestFingerprint: input.requestFingerprint,
      }),
    });
  } catch {
    return {
      ok: false as const,
      status: 0,
      daasMissionId: input.missionId,
      evidenceUrl: null,
    };
  }
	  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
	  const data = payload && typeof payload.data === "object" && !Array.isArray(payload.data)
	    ? payload.data as Record<string, unknown>
	    : null;
  const wrapperOk = typeof payload?.ok === "boolean" ? payload.ok : null;
  const returnedDaasMissionId =
    readNonEmptyString(data?.daas_mission_id) ??
    readNonEmptyString(payload?.missionId) ??
    readNonEmptyString(payload?.daas_mission_id);
  const daasStatus =
    readNonEmptyString(data?.status) ??
    readNonEmptyString(payload?.status);
  // Parse a DAAS-provided evidence link from the response, fail-closed: only a
  // safe http(s) URL with no credentials/query/fragment survives (see
  // readSafeEvidenceUrl). This is the limited agent's authoritative proof link.
  const evidenceUrl = parseDaasEvidenceUrl(payload, data, input.url.origin, returnedDaasMissionId);
  const classification = classifyDaasMissionStatus(daasStatus);
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId ?? input.missionId,
      daasStatus: classification === "routed_surfaced" ? daasStatus : undefined,
      evidenceUrl,
    };
  }
  const acceptedStatus = daasStatus;
  const acceptedClassification = classification === "routed_accepted";
  const evidenceRequiredFailure =
    returnedDaasMissionId && acceptedClassification && !evidenceUrl;
  if (wrapperOk === false || !returnedDaasMissionId || evidenceRequiredFailure || !acceptedClassification) {
    return {
      ok: false as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId ?? input.missionId,
      daasStatus: wrapperOk === false
        ? "daas_mission_handoff_failed"
        : evidenceRequiredFailure
        ? DAAS_MISSION_EVIDENCE_REQUIRED_STATUS
        : classification === "routed_surfaced" ? daasStatus : undefined,
      evidenceUrl,
    };
  }
  return {
      ok: true as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId,
      daasStatus: acceptedStatus,
      evidenceUrl,
  };
}

export function daasIntegrationRoutes(db: Db) {
  const router = Router();
  const routePath = DAAS_PAPERCLIP_MISSIONS_ROUTE.replace(/^\/api/, "");

  router.post(routePath, async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const companyId = readNonEmptyString(body.companyId);
    const agentId = readNonEmptyString(body.agentId);
    const prompt = readDaasMissionPrompt(body);
    if (!companyId || !agentId || !prompt) {
      res.status(400).json({ error: "companyId_agentId_prompt_required" });
      return;
    }
    const agentClaims = verifyLocalAgentJwt(readBearerToken(req.get("authorization")) ?? "");
    if (!agentClaims) {
      res.status(401).json({ error: "agent_jwt_required" });
      return;
    }
    if (agentClaims.company_id !== companyId || agentClaims.sub !== agentId) {
      res.status(403).json({ error: "agent_scope_mismatch" });
      return;
    }

    const agent = await db
      .select({ id: agents.id, permissions: agents.permissions })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    if (!hasLimitedMissionRoutePermission(agent)) {
      res.status(403).json({ error: "limited_agent_required" });
      return;
    }

    const intent = detectDaasMissionRequestIntent(body);
    if (!intent.isInfrastructureIntent) {
      res.status(400).json({ error: "infrastructure_mission_required" });
      return;
    }

    const issueId = readNonEmptyString(body.issueId);
    if (!issueId) {
      res.status(400).json({ error: "issueId_required" });
      return;
    }
    const requestFingerprint = buildDaasMissionRequestFingerprint({
      companyId,
      agentId,
      issueId,
      prompt,
      target: null,
      signals: intent.signals,
    });
    const missionId = readNonEmptyString(body.missionId) ?? `paperclip-${requestFingerprint.slice(0, 32)}`;

    const handoffUrl = resolveDaasMissionHandoffUrl();
    if (!handoffUrl) {
      res.status(503).json({
        missionId,
        status: "daas_mission_adapter_unavailable",
        executionAuthority: "daas",
        paperclipRunId: null,
      });
      return;
    }

    const existingIssue = await db
        .select({ executionState: issues.executionState, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .then((rows) => rows[0] ?? null);
    if (!existingIssue) {
      res.status(404).json({ error: "issue_not_found" });
      return;
    }
    if (existingIssue.assigneeAgentId !== agentId) {
      res.status(403).json({ error: "issue_agent_mismatch" });
      return;
    }
	    const handoff = await handoffMissionToDaas({
      url: handoffUrl,
      companyId,
      agentId,
      missionId,
      requestFingerprint,
      prompt,
	      issueId,
	      title: readNonEmptyString(body.title),
	    });
    if (issueId) {
      const previousExecutionState = existingIssue?.executionState &&
        typeof existingIssue.executionState === "object"
        ? existingIssue.executionState
        : null;
      const routeOutcome = handoff.ok
        ? "routed_accepted"
        : classifyDaasMissionStatus(handoff.daasStatus ?? null) === "routed_surfaced"
          ? "routed_surfaced"
          : "handoff_failed";
      await db
        .update(issues)
        .set({
          ...(!handoff.ok ? { status: "blocked" } : {}),
          executionState: buildDaasMissionExecutionState(previousExecutionState, {
            route: DAAS_MISSION_DESTINATION_ROUTE,
            missionId: handoff.daasMissionId,
            requestFingerprint,
            target: null,
            status: handoff.ok ? handoff.daasStatus ?? "accepted" : handoff.daasStatus ?? "daas_mission_handoff_failed",
            outcome: routeOutcome,
            ok: handoff.ok,
            executionAuthority: "daas",
            evidenceUrl: handoff.evidenceUrl,
            httpStatus: handoff.status,
            signals: intent.signals,
            routedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    }
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "daas",
      agentId,
      action: handoff.ok ? "daas.mission_handoff.accepted" : "daas.mission_handoff.failed",
      entityType: "agent",
      entityId: agentId,
      details: {
        route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
	        missionId: handoff.daasMissionId,
	        status: handoff.ok ? "handoff_accepted" : handoff.daasStatus ?? "handoff_failed",
	        responseStatus: handoff.status,
	        signals: intent.signals,
	      },
    });

	    if (!handoff.ok) {
	      const responseStatus = handoff.daasStatus && handoff.status >= 400 ? handoff.status : 409;
	      res.status(responseStatus).json({
	        missionId: handoff.daasMissionId,
	        status: handoff.daasStatus ?? "daas_mission_handoff_failed",
	        executionAuthority: "daas",
	        paperclipRunId: null,
	        ...(handoff.evidenceUrl ? { evidenceUrl: handoff.evidenceUrl } : {}),
	      });
      return;
    }

    res.status(202).json({
      missionId: handoff.daasMissionId,
      status: "handoff_accepted",
      executionAuthority: "daas",
      paperclipRunId: null,
      ...(handoff.evidenceUrl ? { evidenceUrl: handoff.evidenceUrl } : {}),
    });
  });

  return router;
}
