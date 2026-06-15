import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  assertDaasForkHealthSafe,
  buildDaasForkHealthStatus,
} from "../daas-fork-health.js";
import {
  collectDaasDirectInfrastructureConfigPaths,
  isDaasBlockedInfrastructureAdapterType,
  materializeDaasSafeAdapterDefaults,
} from "../services/daas-infrastructure-guard.js";
import {
  guardDaasInfrastructureTaskDispatch,
} from "../services/daas-infrastructure-task-guard.js";
import {
  buildDaasMissionRequestFingerprint,
  postInfrastructureTicketToDaasAdapter,
} from "../services/daas-mission-adapter.js";
import { daasIntegrationRoutes } from "../routes/daas-integrations.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

const SAVED_ENV = {
  DAAS_API_SHARED_SECRET: process.env.DAAS_API_SHARED_SECRET,
  DAAS_BASE_URL: process.env.DAAS_BASE_URL,
  PAPERCLIP_WEBHOOK_SECRET: process.env.PAPERCLIP_WEBHOOK_SECRET,
  PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET,
  PAPERCLIP_TELEMETRY_ENABLED: process.env.PAPERCLIP_TELEMETRY_ENABLED,
  PAPERCLIP_FEEDBACK_SHARING_ENABLED: process.env.PAPERCLIP_FEEDBACK_SHARING_ENABLED,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  CI: process.env.CI,
};

function resetEnv() {
  vi.unstubAllGlobals();
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createMissionRouteApp(
  agentRows: Array<{ id: string; permissions?: Record<string, unknown> }> = [
    { id: "agent-limited", permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET } },
  ],
  issueRows: Array<{ executionState: Record<string, unknown> | null; assigneeAgentId?: string | null }> = [
    { executionState: null, assigneeAgentId: "agent-limited" },
  ],
) {
  const insertValues = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const normalizedIssueRows = issueRows.map((row) => ({
    assigneeAgentId: "agent-limited",
    ...row,
  }));
  const db = {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: Array<{ id: string; permissions?: Record<string, unknown> }> | Array<{ executionState: Record<string, unknown> | null; assigneeAgentId?: string | null }>) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(Object.prototype.hasOwnProperty.call(selection, "executionState") ? normalizedIssueRows : agentRows)
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
  return { app, insertValues, updateSet };
}

function missionAuthHeader(agentId = "agent-limited", companyId = "company-1") {
  process.env.PAPERCLIP_AGENT_JWT_SECRET =
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

function missionAdapterArgs() {
  const base = {
    url: new URL("https://daas.example.test/api/missions"),
    companyId: "company-1",
    agentId: "agent-limited",
    prompt: "Restart nginx in production",
    issueId: "issue-1",
    title: "Restart nginx in production",
    target: { type: "server" as const, id: "srv-1" },
    signals: ["infra.orchestration"],
  };
  const requestFingerprint = buildDaasMissionRequestFingerprint(base);
  return {
    ...base,
    missionId: `paperclip-${requestFingerprint.slice(0, 32)}`,
    requestFingerprint,
  };
}

describe("T274 DAAS fork security regression suite", () => {
  afterEach(resetEnv);

  it("allows a limited Paperclip agent to create a DAAS mission without creating an internal run", async () => {
    process.env.DAAS_API_SHARED_SECRET = "outbound-daas-shared";
    process.env.DAAS_BASE_URL = "https://daas.example.test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        missionId: "mis_daas_limited",
        status: "accepted",
        evidence_url: "https://daas.example.test/missions/mis_daas_limited/evidence",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { app, insertValues } = createMissionRouteApp();

    await withLocalRequest(app, async (client) => {
      const response = await client
        .post("/api/integrations/paperclip/missions")
        .set("authorization", missionAuthHeader())
        .send({
          companyId: "company-1",
          agentId: "agent-limited",
          issueId: "issue-1",
          title: "Restart nginx in production",
          prompt: "Restart nginx in production",
          permissions: { trustPreset: "limited" },
        });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        missionId: "mis_daas_limited",
        status: "handoff_accepted",
        executionAuthority: "daas",
        paperclipRunId: null,
        evidenceUrl: "https://daas.example.test/missions/mis_daas_limited/evidence",
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.stringify(init)).not.toContain("inbound-route-shared");
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "daas.mission_handoff.accepted",
      details: expect.objectContaining({
        status: "handoff_accepted",
      }),
    }));
  });

  it("denies direct SSH, raw shell, and secret-intent tasks outside the DAAS mission route", () => {
    for (const prompt of [
      "Use ssh to access the production server",
      "Open a raw shell on the production host",
      "Read secret material from production",
    ]) {
      const decision = guardDaasInfrastructureTaskDispatch({
        title: "Limited agent request",
        description: prompt,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.decision).toBe("deny_requires_mission_route");
      expect(decision.message).toBe(DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE);
      expect(decision.signals.length).toBeGreaterThan(0);
      expect(JSON.stringify(decision)).not.toContain(prompt);
    }
  });

  it("blocks raw process/http infrastructure adapters and dangerous execution config", () => {
    expect(isDaasBlockedInfrastructureAdapterType("process")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("http")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("claude_local")).toBe(false);
    expect(materializeDaasSafeAdapterDefaults("claude_local", {})).toEqual({
      dangerouslySkipPermissions: false,
    });
    expect(collectDaasDirectInfrastructureConfigPaths({
      executionTarget: { kind: "remote", transport: "ssh" },
      nested: { dangerouslyBypassSandbox: true },
    }, "adapterConfig")).toEqual([
      "adapterConfig.executionTarget",
      "adapterConfig.nested.dangerouslyBypassSandbox",
    ]);
  });

  it("asserts telemetry and dangerous connectors are disabled in the fork health check", () => {
    delete process.env.PAPERCLIP_TELEMETRY_ENABLED;
    delete process.env.PAPERCLIP_FEEDBACK_SHARING_ENABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;

    const status = buildDaasForkHealthStatus({ paperclipVersion: "0.3.1" });

    expect(status.safe).toBe(true);
    expect(status.telemetry.enabled).toBe(false);
    expect(status.feedbackSharing.enabled).toBe(false);
    expect(status.nonRequiredOutbound).toEqual({
      enabledByDefault: false,
      enabledConnectorIds: [],
    });
    expect(status.dangerousConnectors.every((connector) => connector.enabled === false)).toBe(true);
    expect(() => assertDaasForkHealthSafe(status)).not.toThrow();
    expect(() => assertDaasForkHealthSafe(buildDaasForkHealthStatus({
      dangerousConnectorOverrides: { "process-adapter-ssh-command": true },
    }))).toThrow(/process-adapter-ssh-command/);
  });

  it("uses a stable DAAS idempotency key for duplicate infrastructure handoffs", async () => {
    process.env.DAAS_API_SHARED_SECRET = "outbound-daas-shared";
    process.env.PAPERCLIP_WEBHOOK_SECRET = "inbound-route-shared";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { daas_mission_id: "mis_daas_idempotent", status: "waiting_for_lock" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const args = missionAdapterArgs();

    await postInfrastructureTicketToDaasAdapter(args);
    await postInfrastructureTicketToDaasAdapter(args);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((first.headers as Record<string, string>)["idempotency-key"]).toBe(
      `paperclip:company-1:issue-1:${args.requestFingerprint}`,
    );
    expect((second.headers as Record<string, string>)["idempotency-key"]).toBe(
      (first.headers as Record<string, string>)["idempotency-key"],
    );
    expect(first.body).toBe(second.body);
  });

  it("keeps provider context free of raw secrets while routing secret-intent work to DAAS", async () => {
    process.env.DAAS_API_SHARED_SECRET = "outbound-daas-shared";
    process.env.PAPERCLIP_WEBHOOK_SECRET = "inbound-route-shared";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          daas_mission_id: "mis_daas_secret_intent",
          status: "waiting_for_lock",
          evidence_url: "https://daas.example.test/missions/mis_daas_secret_intent/evidence",
        },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const args = {
      ...missionAdapterArgs(),
      prompt: "Read secret material from production",
      signals: ["secret.read"],
    };

    const result = await postInfrastructureTicketToDaasAdapter(args);

    expect(result).toMatchObject({ ok: true, daasMissionId: "mis_daas_secret_intent" });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = String(init.body);
    expect(body).toContain("secret.read");
    expect(body).not.toContain("inbound-route-shared");
    expect(body).not.toContain("outbound-daas-shared");
  });
});
