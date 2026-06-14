import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents } from "@paperclipai/db";
import { DAAS_PAPERCLIP_MISSIONS_ROUTE } from "@paperclipai/shared";
import { detectDaasInfrastructureTaskIntent } from "../services/daas-infrastructure-task-guard.js";
import {
  classifyDaasMissionStatus,
  isAllowedDaasMissionOrigin,
} from "../services/daas-mission-adapter.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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

export function hasValidDaasMissionSecret(provided: string | undefined): boolean {
  const expected = process.env.PAPERCLIP_WEBHOOK_SECRET?.trim();
  const providedValue = provided?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || !providedValue) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(providedValue);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
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
    };
  }
  headers["x-paperclip-webhook-secret"] = authValue;
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
      }),
    });
  } catch {
    return {
      ok: false as const,
      status: 0,
      daasMissionId: input.missionId,
    };
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const data = payload && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : null;
  const returnedDaasMissionId =
    readNonEmptyString(data?.daas_mission_id) ??
    readNonEmptyString(payload?.missionId) ??
    readNonEmptyString(payload?.daas_mission_id);
  const daasStatus =
    readNonEmptyString(data?.status) ??
    readNonEmptyString(payload?.status);
  const classification = classifyDaasMissionStatus(daasStatus);
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId ?? input.missionId,
      daasStatus: classification === "routed_surfaced" ? daasStatus : undefined,
    };
  }
  const acceptedStatus = daasStatus;
  if (!returnedDaasMissionId || !["accepted", "queued", "created"].includes(acceptedStatus ?? "")) {
    return {
      ok: false as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId ?? input.missionId,
      daasStatus: classification === "routed_surfaced" ? daasStatus : undefined,
    };
  }
  return {
      ok: true as const,
      status: response.status,
      daasMissionId: returnedDaasMissionId,
      daasStatus: acceptedStatus,
  };
}

export function daasIntegrationRoutes(db: Db) {
  const router = Router();
  const routePath = DAAS_PAPERCLIP_MISSIONS_ROUTE.replace(/^\/api/, "");

  router.post(routePath, async (req, res) => {
    if (!hasValidDaasMissionSecret(req.get("authorization") ?? req.get("x-paperclip-webhook-secret"))) {
      res.status(401).json({ error: "daas_mission_secret_required" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const companyId = readNonEmptyString(body.companyId);
    const agentId = readNonEmptyString(body.agentId);
    const missionId = readNonEmptyString(body.missionId) ?? randomUUID();
    const prompt = readDaasMissionPrompt(body);
    if (!companyId || !agentId || !prompt) {
      res.status(400).json({ error: "companyId_agentId_prompt_required" });
      return;
    }

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }

    const intent = detectDaasMissionRequestIntent(body);
    if (!intent.isInfrastructureIntent) {
      res.status(400).json({ error: "infrastructure_mission_required" });
      return;
    }

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

    const handoff = await handoffMissionToDaas({
      url: handoffUrl,
      companyId,
      agentId,
      missionId,
      prompt,
      issueId: readNonEmptyString(body.issueId),
      title: readNonEmptyString(body.title),
    });
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
	      });
      return;
    }

    res.status(202).json({
      missionId: handoff.daasMissionId,
      status: "handoff_accepted",
      executionAuthority: "daas",
      paperclipRunId: null,
    });
  });

  return router;
}
