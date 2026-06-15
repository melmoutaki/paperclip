import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  daasIntegrationRoutes,
  detectDaasMissionRequestIntent,
  handoffMissionToDaas,
  readDaasMissionPrompt,
  resolveDaasMissionHandoffUrl,
} from "../routes/daas-integrations.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

function createMissionRouteApp(
  agentRows: Array<{ id: string; permissions?: Record<string, unknown> }> = [
    { id: "agent-1", permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET } },
  ],
  issueRows: Array<{ executionState: Record<string, unknown> | null; assigneeAgentId?: string | null }> = [
    { executionState: null, assigneeAgentId: "agent-1" },
  ],
) {
  const normalizedAgentRows = agentRows.map((row) => ({
    permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET },
    ...row,
  }));
  const normalizedIssueRows = issueRows.map((row) => ({
    assigneeAgentId: "agent-1",
    ...row,
  }));
  const insertValues = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const db = {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: Array<{ id: string; permissions?: Record<string, unknown> }> | Array<{ executionState: Record<string, unknown> | null; assigneeAgentId?: string | null }>) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(Object.prototype.hasOwnProperty.call(selection, "executionState") ? normalizedIssueRows : normalizedAgentRows)
              .then(onFulfilled, onRejected),
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
  };
  const app = express();
  app.use(express.json());
  app.use("/api", daasIntegrationRoutes(db as any));
  return { app, db, insertValues, updateSet };
}

function missionAuthHeader(agentId = "agent-1", companyId = "company-1") {
  process.env["PAPERCLIP_AGENT_JWT_SECRET"] =
    process.env.PAPERCLIP_AGENT_JWT_SECRET ?? ["paperclip", "local", "jwt", "test", "value"].join("-");
  const jwt = createLocalAgentJwt(agentId, companyId, "daas-limited", "run-daas-route");
  expect(jwt).toBeTruthy();
  return `Bearer ${jwt}`;
}

async function withLocalRequest<T>(
  app: express.Express,
  fn: (client: ReturnType<typeof request>) => Promise<T>,
): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(request(`http://127.0.0.1:${port}`));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("handoffMissionToDaas", () => {
  const previousInbound = process.env.PAPERCLIP_WEBHOOK_SECRET;
  const previousOutbound = process.env.DAAS_API_SHARED_SECRET;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousInbound === undefined) {
      delete process.env.PAPERCLIP_WEBHOOK_SECRET;
    } else {
      process.env["PAPERCLIP_WEBHOOK_SECRET"] = previousInbound;
    }
    if (previousOutbound === undefined) {
      delete process.env.DAAS_API_SHARED_SECRET;
    } else {
      process.env["DAAS_API_SHARED_SECRET"] = previousOutbound;
    }
  });

  it("uses the outbound DAAS credential and never forwards the inbound route secret", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      missionId: "mission-2",
      status: "accepted",
      evidence_url: "https://daas.example.test/missions/mission-2/evidence",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: "issue-1",
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toMatchObject({ ok: true, daasMissionId: "mission-2" });
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-paperclip-webhook-secret"]).toBe("outbound-daas-secret");
    expect(headers["idempotency-key"]).toBe("paperclip:company-1:issue-1:fingerprint-1");
    expect(JSON.parse(String(init.body))).toMatchObject({ requestFingerprint: "fingerprint-1" });
    expect(JSON.stringify(init)).not.toContain("inbound-route-secret");
  });

  it("fails closed when DAAS is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 0, daasMissionId: "mission-1", evidenceUrl: null });
  });

  it("fails closed before sending when outbound DAAS auth is not configured", async () => {
    delete process.env.DAAS_API_SHARED_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 0, daasMissionId: "mission-1", evidenceUrl: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when DAAS returns an invalid acknowledgement", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "success" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 202, daasMissionId: "mission-1", evidenceUrl: null });
  });

  it("returns a safe DAAS-provided evidence url on the accepted path", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      missionId: "mission-2",
      status: "accepted",
      evidence_url: "https://daas.example.test/missions/mission-2/evidence",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toMatchObject({
      ok: true,
      daasMissionId: "mission-2",
      evidenceUrl: "https://daas.example.test/missions/mission-2/evidence",
    });
  });

  it("omits an unsafe DAAS evidence url (userinfo), failing closed", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      missionId: "mission-2",
      status: "accepted",
      evidence_url: "https://user-info@daas.example.test/missions/mission-2/evidence",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      requestFingerprint: "fingerprint-1",
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 202,
      daasMissionId: "mission-2",
      daasStatus: "daas_mission_evidence_required",
      evidenceUrl: null,
    });
  });
});

describe("detectDaasMissionRequestIntent", () => {
  it("classifies ordinary infrastructure wording as mission-routable", () => {
    for (const prompt of [
      "Run ls on prod",
      "execute whoami on prod host",
      "run cat /etc/passwd on server",
      "kubectl get pods in prod",
      "print STRIPE_SECRET_KEY",
      "Restart the production database",
      "Rotate the prod TLS certificate",
      "Open the production database console",
      "Run rm -rf /var/www on prod",
      "Run chmod 777 /etc/passwd on the production server",
      "Open a shell on prod",
      "Use ssh to access prod",
      "Use Secure Shell to access prod",
      "Open a secure shell session to prod",
      "Start a secure shell to production",
      "Establish a Secure Shell connection to the production host",
      "log into staging host and restart nginx",
      "access the staging VM and inspect logs",
      "Connect to production and run uptime",
      "Log in to prod and check disk usage",
      "connect to server and run uptime",
      "log into server and tail logs",
      "run command on remote machine",
      "access VM and restart nginx",
      "Read env vars from production",
      "Restart nginx in production",
      "Restart the server",
      "Get the production database password",
      "Retrieve the production database password",
      "tail production logs",
      "view logs on prod",
      "scp ./dump.sql root@prod:/tmp/",
      "sftp deploy@prod",
      "Deploy the current release to production",
      "Deploy to prod",
      "Promote latest image to production",
      "Rollback production deploy",
      "Run the production database migration",
      "Backup the staging database",
      "Restore the production backup",
    ]) {
      const intent = detectDaasMissionRequestIntent({ prompt, title: "Infrastructure mission" });
      expect(intent.isInfrastructureIntent).toBe(true);
    }
  });

  it("reads the same prompt fields as the mission route", () => {
    expect(readDaasMissionPrompt({ instructions: "kubectl get pods in prod" })).toBe(
      "kubectl get pods in prod",
    );
    expect(detectDaasMissionRequestIntent({ task: "Run ls on prod" }).isInfrastructureIntent).toBe(true);
  });
});

describe("resolveDaasMissionHandoffUrl", () => {
  const previousBase = process.env.DAAS_BASE_URL;

  afterEach(() => {
    if (previousBase === undefined) {
      delete process.env.DAAS_BASE_URL;
    } else {
      process.env["DAAS_BASE_URL"] = previousBase;
    }
  });

  it("allows HTTPS and explicit local development DAAS origins", () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    expect(resolveDaasMissionHandoffUrl()?.toString()).toBe("https://daas.example.test/api/missions");

    process.env["DAAS_BASE_URL"] = "http://localhost:8000";
    expect(resolveDaasMissionHandoffUrl()?.toString()).toBe("http://localhost:8000/api/missions");

    process.env["DAAS_BASE_URL"] = "http://host.docker.internal:8000";
    expect(resolveDaasMissionHandoffUrl()?.toString()).toBe(
      "http://host.docker.internal:8000/api/missions",
    );

    process.env["DAAS_BASE_URL"] = "http://daas-api:8000";
    expect(resolveDaasMissionHandoffUrl()?.toString()).toBe("http://daas-api:8000/api/missions");
  });

  it("rejects unsafe or malformed DAAS origins", () => {
    for (const value of ["http://daas.example.test", "file:///tmp/daas", "not a url"]) {
      process.env["DAAS_BASE_URL"] = value;
      expect(resolveDaasMissionHandoffUrl()).toBeNull();
    }
  });
});

describe("POST /api/integrations/paperclip/missions", () => {
  const previousInbound = process.env.PAPERCLIP_WEBHOOK_SECRET;
  const previousOutbound = process.env.DAAS_API_SHARED_SECRET;
  const previousBase = process.env.DAAS_BASE_URL;
  const previousAgentJwt = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousInbound === undefined) {
      delete process.env.PAPERCLIP_WEBHOOK_SECRET;
    } else {
      process.env["PAPERCLIP_WEBHOOK_SECRET"] = previousInbound;
    }
    if (previousOutbound === undefined) {
      delete process.env.DAAS_API_SHARED_SECRET;
    } else {
      process.env["DAAS_API_SHARED_SECRET"] = previousOutbound;
    }
    if (previousBase === undefined) {
      delete process.env.DAAS_BASE_URL;
    } else {
      process.env["DAAS_BASE_URL"] = previousBase;
    }
    if (previousAgentJwt === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env["PAPERCLIP_AGENT_JWT_SECRET"] = previousAgentJwt;
    }
  });

	  it("hands valid infrastructure missions to DAAS without creating a Paperclip run", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      missionId: "daas-mission-1",
      status: "accepted",
      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));
	    const { app, insertValues, updateSet } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", missionAuthHeader())
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
	        issueId: "issue-1",
	        missionId: "paperclip-mission-1",
	        prompt: "Restart nginx in production",
	      }));

    expect(response.status).toBe(202);
		    expect(response.body).toMatchObject({
		      missionId: "daas-mission-1",
		      status: "handoff_accepted",
		      executionAuthority: "daas",
		      paperclipRunId: null,
		      evidenceUrl: "https://daas.example.test/missions/daas-mission-1/evidence",
		    });
		    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
		      action: "daas.mission_handoff.accepted",
		    }));
	    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
	    expect(persisted.executionState.daasMission).toMatchObject({
	      missionId: "daas-mission-1",
	      status: "accepted",
	      outcome: "routed_accepted",
	      ok: true,
	      evidenceUrl: "https://daas.example.test/missions/daas-mission-1/evidence",
	    });
	    expect(persisted.executionState.daasMissionRouted).toMatchObject({
	      daasMissionId: "daas-mission-1",
	    });
		  });

  it("uses a stable mission id and DAAS idempotency key for duplicate limited-route requests", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { missionId: string };
      return new Response(JSON.stringify({
        missionId: body.missionId,
        status: "accepted",
        evidence_url: `https://daas.example.test/missions/${body.missionId}/evidence`,
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { app } = createMissionRouteApp();
    const payload = {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      prompt: "Restart nginx in production",
    };

    for (let index = 0; index < 2; index += 1) {
      const response = await withLocalRequest(app, (client) => client
        .post("/api/integrations/paperclip/missions")
        .set("authorization", missionAuthHeader())
        .send(payload));
      expect(response.status).toBe(202);
    }

    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    const firstBody = JSON.parse(String(first.body)) as { missionId: string; requestFingerprint: string };
    const secondBody = JSON.parse(String(second.body)) as { missionId: string; requestFingerprint: string };
    expect(firstBody.missionId).toBe(secondBody.missionId);
    expect(firstBody.requestFingerprint).toBe(secondBody.requestFingerprint);
    expect((first.headers as Record<string, string>)["idempotency-key"]).toBe(
      (second.headers as Record<string, string>)["idempotency-key"],
    );
    expect((first.headers as Record<string, string>)["idempotency-key"]).toContain(firstBody.requestFingerprint);
  });

  it("preserves existing issue execution state when persisting limited-route DAAS provenance", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      missionId: "daas-mission-1",
      status: "accepted",
      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));
    const { app, updateSet } = createMissionRouteApp(
      [{ id: "agent-1" }],
      [{ executionState: { monitor: { state: "paused" }, previous: true } }],
    );

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(202);
    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
    expect(persisted.executionState).toMatchObject({
      monitor: { state: "paused" },
      previous: true,
      daasMission: {
        missionId: "daas-mission-1",
        outcome: "routed_accepted",
      },
    });
  });

  it("fails closed before DAAS handoff when a supplied issue id is not company-scoped", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app, updateSet } = createMissionRouteApp([{ id: "agent-1" }], []);

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "missing-or-cross-company",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: "issue_not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects issue ids assigned to a different agent before DAAS handoff", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app, updateSet, insertValues } = createMissionRouteApp(
      [{ id: "agent-1" }],
      [{ executionState: null, assigneeAgentId: "agent-other" }],
    );

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "issue_agent_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects spoofed limited permissions when the persisted agent is not limited", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app, updateSet } = createMissionRouteApp([{ id: "agent-1", permissions: { trustPreset: "full_access" } }]);

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
        permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET },
      }));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "limited_agent_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires issueId before DAAS handoff so accepted missions are durably persisted", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app, updateSet } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "issueId_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

		  it("exposes a safe DAAS evidence link on the limited-agent mission route", async () => {
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
	      missionId: "daas-mission-1",
	      status: "accepted",
	      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence",
	    }), {
	      status: 202,
	      headers: { "content-type": "application/json" },
	    })));
	    const { app } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", missionAuthHeader())
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
	        issueId: "issue-1",
	        missionId: "paperclip-mission-1",
	        prompt: "Restart nginx in production",
	      }));

	    expect(response.status).toBe(202);
	    expect(response.body).toMatchObject({
	      missionId: "daas-mission-1",
	      status: "handoff_accepted",
	      executionAuthority: "daas",
	      paperclipRunId: null,
	      evidenceUrl: "https://daas.example.test/missions/daas-mission-1/evidence",
		    });
		  });

		  it("accepts shared DAAS in-progress statuses on the limited-agent mission route when safe evidence is present", async () => {
		    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
		    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
		    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
		    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
		      missionId: "daas-mission-1",
		      status: "waiting_for_lock",
		      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence",
		    }), {
		      status: 202,
		      headers: { "content-type": "application/json" },
		    })));
		    const { app } = createMissionRouteApp();

		    const response = await withLocalRequest(app, (client) => client
		      .post("/api/integrations/paperclip/missions")
		      .set("authorization", missionAuthHeader())
		      .send({
		        companyId: "company-1",
		        agentId: "agent-1",
		        issueId: "issue-1",
		        missionId: "paperclip-mission-1",
		        prompt: "Restart nginx in production",
		      }));

		    expect(response.status).toBe(202);
		    expect(response.body).toMatchObject({
		      missionId: "daas-mission-1",
		      status: "handoff_accepted",
		      executionAuthority: "daas",
		      paperclipRunId: null,
		      evidenceUrl: "https://daas.example.test/missions/daas-mission-1/evidence",
		    });
		  });

		  it("omits an unsafe DAAS evidence link with a query param from the route response", async () => {
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
	      missionId: "daas-mission-1",
	      status: "accepted",
	      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence?ref=opaque",
	    }), {
	      status: 202,
	      headers: { "content-type": "application/json" },
	    })));
	    const { app } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", missionAuthHeader())
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
	        issueId: "issue-1",
	        missionId: "paperclip-mission-1",
	        prompt: "Restart nginx in production",
	      }));

	    expect(response.status).toBe(409);
	    expect(response.body).toMatchObject({
	      missionId: "daas-mission-1",
	      status: "daas_mission_evidence_required",
	      executionAuthority: "daas",
	      paperclipRunId: null,
	    });
		    expect(response.body).not.toHaveProperty("evidenceUrl");
			    expect(JSON.stringify(response.body)).not.toContain("ref=opaque");
			  });

		  it("fails closed when DAAS returns a cross-origin evidence link", async () => {
		    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
		    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
		    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
		    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
		      missionId: "daas-mission-1",
		      status: "accepted",
		      evidence_url: "https://not-daas.example.test/missions/daas-mission-1/evidence",
		    }), {
		      status: 202,
		      headers: { "content-type": "application/json" },
		    })));
		    const { app } = createMissionRouteApp();

		    const response = await withLocalRequest(app, (client) => client
		      .post("/api/integrations/paperclip/missions")
		      .set("authorization", missionAuthHeader())
		      .send({
		        companyId: "company-1",
		        agentId: "agent-1",
		        issueId: "issue-1",
		        missionId: "paperclip-mission-1",
		        prompt: "Restart nginx in production",
		      }));

		    expect(response.status).toBe(409);
		    expect(response.body).toMatchObject({
		      missionId: "daas-mission-1",
		      status: "daas_mission_evidence_required",
		      executionAuthority: "daas",
		      paperclipRunId: null,
		    });
		    expect(response.body).not.toHaveProperty("evidenceUrl");
		  });

		  it("fails closed when DAAS returns an evidence link with an extra path token segment", async () => {
		    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
		    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
		    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
		    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
		      missionId: "daas-mission-1",
		      status: "accepted",
		      evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence/opaque",
		    }), {
		      status: 202,
		      headers: { "content-type": "application/json" },
		    })));
		    const { app } = createMissionRouteApp();

		    const response = await withLocalRequest(app, (client) => client
		      .post("/api/integrations/paperclip/missions")
		      .set("authorization", missionAuthHeader())
		      .send({
		        companyId: "company-1",
		        agentId: "agent-1",
		        issueId: "issue-1",
		        missionId: "paperclip-mission-1",
		        prompt: "Restart nginx in production",
		      }));

		    expect(response.status).toBe(409);
		    expect(response.body).toMatchObject({
		      missionId: "daas-mission-1",
		      status: "daas_mission_evidence_required",
		      executionAuthority: "daas",
		      paperclipRunId: null,
		    });
		    expect(response.body).not.toHaveProperty("evidenceUrl");
		  });

			  it("fails closed when the DAAS response envelope is not ok despite accepted-looking status", async () => {
		    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
		    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
		    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
		    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
		      ok: false,
		      data: {
		        daas_mission_id: "daas-mission-1",
		        status: "accepted",
		        evidence_url: "https://daas.example.test/missions/daas-mission-1/evidence",
		      },
		    }), {
		      status: 202,
		      headers: { "content-type": "application/json" },
		    })));
		    const { app, insertValues } = createMissionRouteApp();

		    const response = await withLocalRequest(app, (client) => client
		      .post("/api/integrations/paperclip/missions")
		      .set("authorization", missionAuthHeader())
		      .send({
		        companyId: "company-1",
		        agentId: "agent-1",
		        issueId: "issue-1",
		        missionId: "paperclip-mission-1",
		        prompt: "Restart nginx in production",
		      }));

		    expect(response.status).toBe(409);
		    expect(response.body).toMatchObject({
		      missionId: "daas-mission-1",
		      status: "daas_mission_handoff_failed",
		      executionAuthority: "daas",
		      paperclipRunId: null,
		      evidenceUrl: "https://daas.example.test/missions/daas-mission-1/evidence",
		    });
		    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
		      action: "daas.mission_handoff.failed",
		    }));
		  });

		  it("surfaces DAAS policy statuses on failed wrapper responses", async () => {
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
	      ok: false,
	      data: {
	        daas_mission_id: "daas-mission-1",
	        status: "blocked_by_policy",
	      },
	    }), {
	      status: 403,
	      headers: { "content-type": "application/json" },
	    })));
	    const { app, insertValues, updateSet } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", missionAuthHeader())
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
	        issueId: "issue-1",
	        missionId: "paperclip-mission-1",
	        prompt: "Restart nginx in production",
	      }));

	    expect(response.status).toBe(403);
	    expect(response.body).toMatchObject({
	      missionId: "daas-mission-1",
	      status: "blocked_by_policy",
	      executionAuthority: "daas",
	      paperclipRunId: null,
	    });
    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBe("blocked");
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "daas-mission-1",
      status: "blocked_by_policy",
      outcome: "routed_surfaced",
      ok: false,
    });
    expect(persisted.executionState.daasRouteStatus).toBe("blocked_by_policy");
	    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
	      action: "daas.mission_handoff.failed",
	      details: expect.objectContaining({
	        missionId: "daas-mission-1",
	        status: "blocked_by_policy",
	        responseStatus: 403,
	      }),
	    }));
	  });

	  it("returns non-2xx when DAAS reports a surfaced failure status over HTTP 200", async () => {
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
	      ok: true,
	      data: {
	        daas_mission_id: "daas-mission-1",
	        status: "rejected",
	      },
	    }), {
	      status: 200,
	      headers: { "content-type": "application/json" },
	    })));
	    const { app } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", missionAuthHeader())
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
	        issueId: "issue-1",
	        missionId: "paperclip-mission-1",
	        prompt: "Restart nginx in production",
	      }));

	    expect(response.status).toBe(409);
	    expect(response.body).toMatchObject({
	      missionId: "daas-mission-1",
	      status: "rejected",
	      executionAuthority: "daas",
	      paperclipRunId: null,
	    });
	  });

	  it("rejects missing route agent JWTs", async () => {
    const { app } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Restart nginx in production" }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "agent_jwt_required" });
  });

  it("rejects route agent JWTs scoped to a different company or agent", async () => {
    const { app } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader("agent-other", "company-1"))
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Restart nginx in production" }));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "agent_scope_mismatch" });
  });

  it("rejects non-infrastructure mission payloads", async () => {
    const { app } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Write a release note" }));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "infrastructure_mission_required" });
  });

  it("enforces company-scoped agent lookup", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    const { app } = createMissionRouteApp([]);

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Restart nginx in production" }));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "agent_not_found" });
  });

  it("fails closed when DAAS is unavailable", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    delete process.env.DAAS_BASE_URL;
    const { app, insertValues } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", missionAuthHeader())
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      missionId: "paperclip-mission-1",
      status: "daas_mission_adapter_unavailable",
      executionAuthority: "daas",
      paperclipRunId: null,
    });
    expect(insertValues).not.toHaveBeenCalled();
  });
});
