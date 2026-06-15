import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AddressInfo } from "node:net";
import {
  daasIntegrationRoutes,
  detectDaasMissionRequestIntent,
  handoffMissionToDaas,
  hasValidDaasMissionSecret,
  readDaasMissionPrompt,
  resolveDaasMissionHandoffUrl,
} from "../routes/daas-integrations.js";

function createMissionRouteApp(agentRows: Array<{ id: string }> = [{ id: "agent-1" }]) {
  const insertValues = vi.fn(async () => undefined);
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: Array<{ id: string }>) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(agentRows).then(onFulfilled, onRejected),
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  const app = express();
  app.use(express.json());
  app.use("/api", daasIntegrationRoutes(db as any));
  return { app, db, insertValues };
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

describe("hasValidDaasMissionSecret", () => {
  const previousInbound = process.env.PAPERCLIP_WEBHOOK_SECRET;

  afterEach(() => {
    if (previousInbound === undefined) {
      delete process.env.PAPERCLIP_WEBHOOK_SECRET;
    } else {
      process.env["PAPERCLIP_WEBHOOK_SECRET"] = previousInbound;
    }
  });

  it("requires the inbound Paperclip mission secret", () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    expect(hasValidDaasMissionSecret("Bearer inbound-route-secret")).toBe(true);
    expect(hasValidDaasMissionSecret("wrong-value")).toBe(false);
    expect(hasValidDaasMissionSecret(undefined)).toBe(false);
  });
});

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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ missionId: "mission-2", status: "accepted" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handoffMissionToDaas({
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      missionId: "mission-1",
      issueId: "issue-1",
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toMatchObject({ ok: true, daasMissionId: "mission-2" });
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-paperclip-webhook-secret"]).toBe("outbound-daas-secret");
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
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 0, daasMissionId: "mission-1" });
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
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 0, daasMissionId: "mission-1" });
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
      issueId: null,
      title: "Restart service",
      prompt: "ssh prod uptime",
    });

    expect(result).toEqual({ ok: false, status: 202, daasMissionId: "mission-1" });
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
  });

	  it("hands valid infrastructure missions to DAAS without creating a Paperclip run", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      missionId: "daas-mission-1",
      status: "accepted",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));
    const { app, insertValues } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", "Bearer inbound-route-secret")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        missionId: "paperclip-mission-1",
        prompt: "Restart nginx in production",
      }));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      missionId: "daas-mission-1",
      status: "handoff_accepted",
      executionAuthority: "daas",
      paperclipRunId: null,
    });
	    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
	      action: "daas.mission_handoff.accepted",
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
	    const { app, insertValues } = createMissionRouteApp();

	    const response = await withLocalRequest(app, (client) => client
	      .post("/api/integrations/paperclip/missions")
	      .set("authorization", "Bearer inbound-route-secret")
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
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
	      .set("authorization", "Bearer inbound-route-secret")
	      .send({
	        companyId: "company-1",
	        agentId: "agent-1",
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

	  it("rejects missing or invalid route secrets", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    const { app } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Restart nginx in production" }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "daas_mission_secret_required" });
  });

  it("rejects non-infrastructure mission payloads", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    const { app } = createMissionRouteApp();

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("x-paperclip-webhook-secret", "inbound-route-secret")
      .send({ companyId: "company-1", agentId: "agent-1", prompt: "Write a release note" }));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "infrastructure_mission_required" });
  });

  it("enforces company-scoped agent lookup", async () => {
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "inbound-route-secret";
    const { app } = createMissionRouteApp([]);

    const response = await withLocalRequest(app, (client) => client
      .post("/api/integrations/paperclip/missions")
      .set("authorization", "Bearer inbound-route-secret")
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
      .set("authorization", "Bearer inbound-route-secret")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
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
