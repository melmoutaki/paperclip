import { afterEach, describe, expect, it, vi } from "vitest";
import { DAAS_PAPERCLIP_MISSIONS_ROUTE } from "@paperclipai/shared";
import {
  buildDaasMissionRequestFingerprint,
  buildDaasMissionExecutionState,
  buildDaasMissionPrompt,
  enforceInfrastructureTicketRouting,
  parseDaasEvidenceUrl,
  persistPendingDaasMissionRouteOnIssue,
  postInfrastructureTicketToDaasAdapter,
  readDaasInfrastructureIntentState,
  readDaasMissionState,
  resolveDaasMissionAdapterUrl,
  resolveDaasMissionTarget,
  routeInfrastructureTicketThroughDaasAdapter,
} from "../services/daas-mission-adapter.js";

interface FakeDbState {
  issueRow: { executionState: Record<string, unknown> | null } | null;
}

function createFakeDb(state: FakeDbState) {
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const insertValues = vi.fn(async () => undefined);
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(state.issueRow ? [state.issueRow] : []).then(onFulfilled, onRejected),
        }),
      }),
    })),
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return { db, updateSet, insertValues };
}

const INFRA_TICKET = {
  title: "Restart nginx in production",
  description: "Restart nginx in production after the deploy",
};

function routeFingerprint(input?: { description?: string; signals?: string[] }) {
  return buildDaasMissionRequestFingerprint({
    companyId: "company-1",
    agentId: "agent-1",
    issueId: "issue-1",
    prompt: input?.description ?? INFRA_TICKET.description,
    target: { type: "server", id: "srv_1" },
    signals: input?.signals ?? ["infra.orchestration"],
  });
}

describe("resolveDaasMissionAdapterUrl", () => {
  const previousBase = process.env.DAAS_BASE_URL;
  afterEach(() => {
    if (previousBase === undefined) delete process.env.DAAS_BASE_URL;
    else process.env["DAAS_BASE_URL"] = previousBase;
  });

  it("resolves the configured DAAS adapter missions route", () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    expect(resolveDaasMissionAdapterUrl()?.toString()).toBe(
      "https://daas.example.test/api/missions",
    );
    process.env["DAAS_BASE_URL"] = "http://localhost:8000";
    expect(resolveDaasMissionAdapterUrl()?.toString()).toBe(
      "http://localhost:8000/api/missions",
    );
    process.env["DAAS_BASE_URL"] = "http://host.docker.internal:8000";
    expect(resolveDaasMissionAdapterUrl()?.toString()).toBe(
      "http://host.docker.internal:8000/api/missions",
    );
    process.env["DAAS_BASE_URL"] = "http://daas-api:8000";
    expect(resolveDaasMissionAdapterUrl()?.toString()).toBe(
      "http://daas-api:8000/api/missions",
    );
  });

  it("fails closed on unsafe or missing origins", () => {
    delete process.env.DAAS_BASE_URL;
    expect(resolveDaasMissionAdapterUrl()).toBeNull();
    for (const value of ["http://daas.example.test", "file:///tmp/daas", "not a url"]) {
      process.env["DAAS_BASE_URL"] = value;
      expect(resolveDaasMissionAdapterUrl()).toBeNull();
    }
  });
});

describe("buildDaasMissionPrompt", () => {
  it("prefers explicit prompt text, then description, title, and only then instruction text", () => {
    expect(buildDaasMissionPrompt({
      title: "t",
      description: "d",
      promptTexts: ["restart nginx from comment"],
      instructionTexts: ["issue_assigned"],
    })).toBe("restart nginx from comment");
    expect(buildDaasMissionPrompt({ title: "t", description: "d", instructionTexts: ["issue_assigned"] })).toBe("d");
    expect(buildDaasMissionPrompt({ title: "t", description: "d" })).toBe("d");
    expect(buildDaasMissionPrompt({ title: "t" })).toBe("t");
    expect(buildDaasMissionPrompt({ instructionTexts: ["fallback task text"] })).toBe("fallback task text");
    expect(buildDaasMissionPrompt({})).toBeNull();
  });
});

describe("resolveDaasMissionTarget", () => {
  const previousDefaultTarget = process.env.DAAS_DEFAULT_TARGET_SERVER_ID;
  afterEach(() => {
    if (previousDefaultTarget === undefined) delete process.env.DAAS_DEFAULT_TARGET_SERVER_ID;
    else process.env["DAAS_DEFAULT_TARGET_SERVER_ID"] = previousDefaultTarget;
  });

  it("resolves explicit DAAS target metadata without inventing a target", () => {
    expect(resolveDaasMissionTarget({ daasTarget: { type: "server", id: "srv_1" } })).toEqual({
      type: "server",
      id: "srv_1",
    });
    expect(resolveDaasMissionTarget({ targetServerId: "srv_2" })).toEqual({
      type: "server",
      id: "srv_2",
    });
    expect(resolveDaasMissionTarget({ daasTarget: { type: "server" } })).toBeNull();
  });

  it("uses an explicit default target only when configured", () => {
    delete process.env.DAAS_DEFAULT_TARGET_SERVER_ID;
    expect(resolveDaasMissionTarget({})).toBeNull();
    process.env["DAAS_DEFAULT_TARGET_SERVER_ID"] = "srv_default";
    expect(resolveDaasMissionTarget({})).toEqual({ type: "server", id: "srv_default" });
  });
});

	describe("postInfrastructureTicketToDaasAdapter", () => {
	  const previousToken = process.env.DAAS_API_SHARED_SECRET;
	  const previousWebhookSecret = process.env.PAPERCLIP_WEBHOOK_SECRET;
	  const previousTimeout = process.env.DAAS_MISSION_HANDOFF_TIMEOUT_MS;
	  afterEach(() => {
	    vi.unstubAllGlobals();
	    vi.useRealTimers();
	    if (previousToken === undefined) delete process.env.DAAS_API_SHARED_SECRET;
	    else process.env["DAAS_API_SHARED_SECRET"] = previousToken;
	    if (previousWebhookSecret === undefined) delete process.env.PAPERCLIP_WEBHOOK_SECRET;
	    else process.env["PAPERCLIP_WEBHOOK_SECRET"] = previousWebhookSecret;
	    if (previousTimeout === undefined) delete process.env.DAAS_MISSION_HANDOFF_TIMEOUT_MS;
	    else process.env["DAAS_MISSION_HANDOFF_TIMEOUT_MS"] = previousTimeout;
	  });

  function args() {
    const base = {
      url: new URL("https://daas.example.test/api/missions"),
      companyId: "company-1",
      agentId: "agent-1",
      prompt: "Restart nginx in production",
      issueId: "issue-1",
      title: "Restart nginx in production",
      target: { type: "server" as const, id: "srv_1" },
      signals: ["infra.orchestration"],
    };
    const requestFingerprint = buildDaasMissionRequestFingerprint(base);
    return {
      ...base,
      missionId: `paperclip-${requestFingerprint.slice(0, 32)}`,
      requestFingerprint,
    };
  }

  it("routes accepted missions through the adapter using the Paperclip mission route contract", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          daas_mission_id: "mis_daas_1",
          status: "waiting_for_lock",
          evidence_url: "https://daas.example.test/missions/mis_daas_1/evidence",
        },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({ outcome: "routed_accepted", ok: true, daasMissionId: "mis_daas_1" });
    const [calledUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(calledUrl.toString()).toBe("https://daas.example.test/api/missions");
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(`paperclip:company-1:issue-1:${args().requestFingerprint}`);
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["x-paperclip-adapter-token"]).toBeUndefined();
    expect(headers["x-paperclip-webhook-secret"]).toBe("outbound-daas-secret");
    expect(headers["x-paperclip-signature"]).toBeUndefined();
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      companyId: "company-1",
      agentId: "agent-1",
      missionId: expect.stringMatching(/^paperclip-[a-f0-9]{32}$/),
      issueId: "issue-1",
      title: "Restart nginx in production",
      prompt: "Restart nginx in production",
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
      requestFingerprint: args().requestFingerprint,
    });
  });

  it("surfaces blocked_by_policy / rejected / awaiting_approval without faking success", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    for (const status of ["rejected", "blocked_by_policy", "awaiting_approval"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ ok: true, data: { daas_mission_id: "mis_daas_1", status } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
	      const result = await postInfrastructureTicketToDaasAdapter(args());
	      expect(result.outcome).toBe("routed_surfaced");
      expect(result.ok).toBe(false);
      expect(result.faked).toBe(false);
      expect(result.daasStatus).toBe(status);
    }
  });

	  it("surfaces recognized DAAS policy statuses on non-2xx responses", async () => {
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
	    vi.stubGlobal(
	      "fetch",
	      vi.fn(async () =>
	        new Response(JSON.stringify({ ok: false, data: { daas_mission_id: "mis_daas_1", status: "blocked_by_policy" } }), {
	          status: 403,
	          headers: { "content-type": "application/json" },
	        }),
	      ),
	    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "routed_surfaced",
      ok: false,
      daasStatus: "blocked_by_policy",
      daasMissionId: "mis_daas_1",
	      httpStatus: 403,
	    });
	  });

	  it("fails closed when the DAAS handoff stalls past the timeout", async () => {
	    vi.useFakeTimers();
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
	    process.env["DAAS_MISSION_HANDOFF_TIMEOUT_MS"] = "25";
	    vi.stubGlobal(
	      "fetch",
	      vi.fn((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
	        init?.signal?.addEventListener("abort", () => {
	          reject(new DOMException("Aborted", "AbortError"));
	        });
	      })),
	    );

	    const pending = postInfrastructureTicketToDaasAdapter(args());
	    await vi.advanceTimersByTimeAsync(25);
	    const result = await pending;

	    expect(result).toMatchObject({
	      outcome: "adapter_unavailable",
	      ok: false,
	      daasStatus: "daas_mission_adapter_unavailable",
	      daasMissionId: null,
	      httpStatus: 0,
	      faked: false,
	    });
	  });

	  it("preserves DAAS surfaced statuses when the wrapper marks the response not ok", async () => {
	    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
	    for (const status of ["blocked_by_policy", "rejected", "awaiting_approval"]) {
	      vi.stubGlobal(
	        "fetch",
	        vi.fn(async () =>
	          new Response(JSON.stringify({ ok: false, data: { daas_mission_id: "mis_daas_1", status } }), {
	            status: status === "awaiting_approval" ? 202 : 403,
	            headers: { "content-type": "application/json" },
	          }),
	        ),
	      );

	      const result = await postInfrastructureTicketToDaasAdapter(args());

	      expect(result).toMatchObject({
	        outcome: "routed_surfaced",
	        ok: false,
	        daasStatus: status,
	        daasMissionId: "mis_daas_1",
	      });
	    }
	  });


  it("does not treat success as accepted without DAAS evidence proof", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: { daas_mission_id: "mis_daas_1", status: "success" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

	    expect(result.outcome).toBe("handoff_failed");
    expect(result.ok).toBe(false);
    expect(result.faked).toBe(false);
	    expect(result.daasStatus).toBe("daas_mission_handoff_failed");
  });


  it("fails closed when the DAAS outbound token is absent (no network call)", async () => {
    delete process.env.DAAS_API_SHARED_SECRET;
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result.outcome).toBe("adapter_unavailable");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require the Paperclip inbound webhook secret for outbound DAAS handoff", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    delete process.env.PAPERCLIP_WEBHOOK_SECRET;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        missionId: "mis_daas_1",
        status: "handoff_accepted",
        evidence_url: "https://daas.example.test/missions/mis_daas_1/evidence",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result.outcome).toBe("routed_accepted");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unrecognized acknowledgement", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: { status: "unexpected" } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await postInfrastructureTicketToDaasAdapter(args());
    expect(result).toMatchObject({
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_handoff_failed",
    });
  });

  it("fails closed when DAAS accepts without returning a mission id", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: { status: "requested" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_handoff_failed",
      daasMissionId: null,
    });
  });

  it("fails closed when the DAAS response envelope explicitly says ok false", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, data: { daas_mission_id: "mis_daas_1", status: "requested" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_handoff_failed",
      daasMissionId: "mis_daas_1",
    });
  });

  it("fails closed when a non-2xx DAAS response carries an accepted-looking body with evidence", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({
          ok: true,
          data: {
            daas_mission_id: "mis_daas_1",
            status: "accepted",
            evidence_url: "https://daas.example.test/missions/mis_daas_1/evidence",
          },
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_handoff_failed",
      daasMissionId: "mis_daas_1",
      evidenceUrl: "https://daas.example.test/missions/mis_daas_1/evidence",
      httpStatus: 500,
    });
  });

  it("captures a DAAS-provided http(s) evidence url from an accepted response", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              daas_mission_id: "mis_daas_1",
              status: "running",
              evidence_url: "https://daas.example.test/missions/mis_daas_1/evidence",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "routed_accepted",
      ok: true,
      daasMissionId: "mis_daas_1",
      evidenceUrl: "https://daas.example.test/missions/mis_daas_1/evidence",
    });
  });

  it("rejects an accepted DAAS response with an unsafe evidence url, failing closed", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              daas_mission_id: "mis_daas_1",
              status: "running",
              evidence_url: "javascript:alert(1)",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "handoff_failed",
      ok: false,
      daasStatus: "daas_mission_evidence_required",
      evidenceUrl: null,
    });
  });

  it("captures a surfaced mission's evidence url from the links/evidence shape", async () => {
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              daas_mission_id: "mis_daas_1",
              status: "blocked_by_policy",
              links: { evidence: "https://daas.example.test/missions/mis_daas_1/evidence" },
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await postInfrastructureTicketToDaasAdapter(args());

    expect(result).toMatchObject({
      outcome: "routed_surfaced",
      ok: false,
      evidenceUrl: "https://daas.example.test/missions/mis_daas_1/evidence",
    });
  });
});

describe("parseDaasEvidenceUrl", () => {
  it("reads common DAAS evidence field shapes and accepts only http(s)", () => {
    expect(parseDaasEvidenceUrl(null, { evidence_url: "https://d.example.test/missions/mis_1/evidence" }, null, "mis_1")).toBe(
      "https://d.example.test/missions/mis_1/evidence",
    );
    expect(parseDaasEvidenceUrl(null, { evidenceUrl: "http://localhost:9000/missions/mis_1/e" }, null, "mis_1")).toBe(
      "http://localhost:9000/missions/mis_1/e",
    );
    expect(parseDaasEvidenceUrl(null, { evidence: { link: "https://d.example.test/api/missions/mis_1/evidence" } }, null, "mis_1")).toBe(
      "https://d.example.test/api/missions/mis_1/evidence",
    );
    expect(parseDaasEvidenceUrl(null, { evidence: { href: "https://d.example.test/missions/mis_1/proof" } }, null, "mis_1")).toBe(
      "https://d.example.test/missions/mis_1/proof",
    );
    expect(parseDaasEvidenceUrl(null, { links: { evidenceUrl: "https://d.example.test/missions/mis_1/evidence" } }, null, "mis_1")).toBe(
      "https://d.example.test/missions/mis_1/evidence",
    );
    expect(parseDaasEvidenceUrl({ evidence_url: "https://d.example.test/missions/mis_1/evidence" }, null, null, "mis_1")).toBe(
      "https://d.example.test/missions/mis_1/evidence",
    );
  });

  it("fails closed on unsafe schemes, relative paths, and missing values", () => {
    for (const unsafe of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "/relative/evidence",
      "ftp://daas.example.test/e",
      "not a url",
      "",
    ]) {
      expect(parseDaasEvidenceUrl(null, { evidence_url: unsafe })).toBeNull();
    }
    expect(parseDaasEvidenceUrl(null, null)).toBeNull();
    expect(parseDaasEvidenceUrl(null, { status: "running" })).toBeNull();
  });

  it("rejects http(s) urls carrying userinfo, query, or fragment components", () => {
    for (const unsafe of [
      "https://user-info@daas.example.test/evidence",
      "https://daas.example.test/evidence?ref=opaque",
      "https://daas.example.test/evidence#section",
    ]) {
      expect(parseDaasEvidenceUrl(null, { evidence_url: unsafe })).toBeNull();
    }
  });

  it("rejects cross-origin evidence urls, wrong mission ids, and extra path-token segments when an origin is required", () => {
    expect(parseDaasEvidenceUrl(
      null,
      { evidence_url: "https://not-daas.example.test/missions/mis_1/evidence" },
      "https://daas.example.test",
      "mis_1",
    )).toBeNull();
    expect(parseDaasEvidenceUrl(
      null,
      { evidence_url: "https://daas.example.test/missions/mis_1/evidence/opaque" },
      "https://daas.example.test",
      "mis_1",
    )).toBeNull();
    expect(parseDaasEvidenceUrl(
      null,
      { evidence_url: "https://daas.example.test/token-or-secret/evidence" },
      "https://daas.example.test",
      "mis_1",
    )).toBeNull();
    expect(parseDaasEvidenceUrl(
      null,
      { evidence_url: "https://daas.example.test/missions/mis_other/evidence" },
      "https://daas.example.test",
      "mis_1",
    )).toBeNull();
    expect(parseDaasEvidenceUrl(
      null,
      { evidence_url: "https://daas.example.test/missions/mis_1/evidence" },
      "https://daas.example.test",
      "mis_1",
    )).toBe("https://daas.example.test/missions/mis_1/evidence");
  });
});

describe("buildDaasMissionExecutionState", () => {
  it("does not mint DAAS route provenance from an unsafe evidence url even when ok is true", () => {
    const state = buildDaasMissionExecutionState(null, {
      route: "/api/missions",
      missionId: "mis_unsafe_provenance",
      requestFingerprint: routeFingerprint(),
      target: { type: "server", id: "srv_1" },
      status: "accepted",
      outcome: "routed_accepted",
      ok: true,
      executionAuthority: "daas",
      evidenceUrl: "https://user-info@daas.example.test/missions/mis_unsafe_provenance/evidence",
      httpStatus: 202,
      signals: ["infra.orchestration"],
      routedAt: new Date(0).toISOString(),
    });

    expect(state.daasRouteStatus).toBe("daas_route_failed");
    expect(state.daasMissionRouted).toBeUndefined();
    expect(state.daasMissionId).toBeUndefined();
  });
});

describe("readDaasMissionState", () => {
  function persistedMission(overrides: Record<string, unknown>) {
    return {
      daasMission: {
        route: "/api/missions",
        missionId: null,
        requestFingerprint: routeFingerprint(),
        target: { type: "server", id: "srv_1" },
        status: "daas_mission_handoff_failed",
        outcome: "handoff_failed",
        ok: false,
        executionAuthority: "daas",
        evidenceUrl: null,
        httpStatus: 409,
        signals: ["infra.orchestration"],
        routedAt: new Date(0).toISOString(),
        ...overrides,
      },
    };
  }

  it("round-trips daas_mission_evidence_required fail-closed state for audit read-back", () => {
    const state = readDaasMissionState(persistedMission({
      missionId: "mis_missing_evidence",
      status: "daas_mission_evidence_required",
      outcome: "handoff_failed",
      evidenceUrl: null,
    }));

    expect(state).toMatchObject({
      missionId: "mis_missing_evidence",
      status: "daas_mission_evidence_required",
      outcome: "handoff_failed",
      ok: false,
      evidenceUrl: null,
    });
  });

  it("round-trips generic handoff_failed state for audit read-back", () => {
    const state = readDaasMissionState(persistedMission({
      missionId: "mis_failed",
      status: "daas_mission_handoff_failed",
      outcome: "handoff_failed",
      httpStatus: 502,
    }));

    expect(state).toMatchObject({
      missionId: "mis_failed",
      status: "daas_mission_handoff_failed",
      outcome: "handoff_failed",
      ok: false,
      httpStatus: 502,
    });
  });

  it("round-trips adapter_unavailable state for audit read-back", () => {
    const state = readDaasMissionState(persistedMission({
      status: "daas_mission_adapter_unavailable",
      outcome: "adapter_unavailable",
      httpStatus: 0,
    }));

    expect(state).toMatchObject({
      missionId: null,
      status: "daas_mission_adapter_unavailable",
      outcome: "adapter_unavailable",
      ok: false,
      httpStatus: 0,
    });
  });

  it("rejects negative terminal persisted states that claim ok true", () => {
    expect(readDaasMissionState(persistedMission({
      status: "daas_mission_handoff_failed",
      outcome: "handoff_failed",
      ok: true,
    }))).toBeNull();
  });

  it("rejects accepted persisted states with cross-origin evidence urls", () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    expect(readDaasMissionState(persistedMission({
      missionId: "mis_cross_origin",
      status: "accepted",
      outcome: "routed_accepted",
      ok: true,
      evidenceUrl: "https://attacker.example.test/missions/mis_cross_origin/evidence",
      httpStatus: 202,
    }))).toBeNull();
  });

  it("rejects accepted persisted states with a non-2xx HTTP status", () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    expect(readDaasMissionState(persistedMission({
      missionId: "mis_http_failure",
      status: "accepted",
      outcome: "routed_accepted",
      ok: true,
      evidenceUrl: "https://daas.example.test/missions/mis_http_failure/evidence",
      httpStatus: 500,
    }))).toBeNull();
  });
});

describe("routeInfrastructureTicketThroughDaasAdapter", () => {
  const previousBase = process.env.DAAS_BASE_URL;
  const previousToken = process.env.DAAS_API_SHARED_SECRET;
  const previousWebhookSecret = process.env.PAPERCLIP_WEBHOOK_SECRET;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousBase === undefined) delete process.env.DAAS_BASE_URL;
    else process.env["DAAS_BASE_URL"] = previousBase;
    if (previousToken === undefined) delete process.env.DAAS_API_SHARED_SECRET;
    else process.env["DAAS_API_SHARED_SECRET"] = previousToken;
    if (previousWebhookSecret === undefined) delete process.env.PAPERCLIP_WEBHOOK_SECRET;
    else process.env["PAPERCLIP_WEBHOOK_SECRET"] = previousWebhookSecret;
  });

  it("persists durable pending route state without calling DAAS", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet, insertValues } = createFakeDb({ issueRow: { executionState: { existing: true } } });

    const pending = await persistPendingDaasMissionRouteOnIssue(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pending).toMatchObject({
      status: "pending_daas_route",
      outcome: "pending_daas_route",
      ok: false,
      missionId: null,
    });
    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
    expect(persisted.executionState).toMatchObject({
      existing: true,
      daasMission: {
        status: "pending_daas_route",
        outcome: "pending_daas_route",
        route: "/api/missions",
      },
	      daasInfrastructureIntent: {
	        classified: true,
	        promptTextFingerprints: [expect.any(String), expect.any(String)],
	        signals: ["infra.orchestration"],
	      },
	    });
	    expect(readDaasInfrastructureIntentState(persisted.executionState)).toMatchObject({
	      classified: true,
	      promptTextFingerprints: [expect.any(String), expect.any(String)],
	    });
    expect(persisted.executionState.daasMissionRouted).toBeUndefined();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: "daas.mission_route.pending" }),
    );
  });

  it("dispatches a pending route after commit and saves the DAAS mission id without internal execution", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        missionId: "mis_after_commit",
        status: "handoff_accepted",
        evidence_url: "https://daas.example.test/missions/mis_after_commit/evidence",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({
      issueRow: {
        executionState: {
          daasMission: {
            route: "/api/missions",
            missionId: null,
            requestFingerprint: routeFingerprint(),
            target: { type: "server", id: "srv_1" },
            status: "pending_daas_route",
            outcome: "pending_daas_route",
            ok: false,
            executionAuthority: "daas",
            httpStatus: 0,
            signals: ["infra.orchestration"],
            routedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const routed = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routed.dispatch).toMatchObject({ ok: true, daasMissionId: "mis_after_commit" });
    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "mis_after_commit",
      status: "handoff_accepted",
      outcome: "routed_accepted",
      evidenceUrl: "https://daas.example.test/missions/mis_after_commit/evidence",
    });
    expect(persisted.executionState.daasMissionRouted).toMatchObject({
      route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
      daasMissionId: "mis_after_commit",
    });
  });

  it("persists a DAAS evidence url into executionState.daasMission for the UI to render", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          missionId: "mis_with_evidence",
          status: "accepted",
          evidence_url: "https://daas.example.test/missions/mis_with_evidence/evidence",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({ issueRow: { executionState: null } });

    const routed = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(routed.dispatch).toMatchObject({
      ok: true,
      daasMissionId: "mis_with_evidence",
      evidenceUrl: "https://daas.example.test/missions/mis_with_evidence/evidence",
    });
    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "mis_with_evidence",
      status: "accepted",
      outcome: "routed_accepted",
      evidenceUrl: "https://daas.example.test/missions/mis_with_evidence/evidence",
    });
    // The persisted state round-trips through the reader the issue load path uses.
    expect(readDaasMissionState(persisted.executionState)?.evidenceUrl).toBe(
      "https://daas.example.test/missions/mis_with_evidence/evidence",
    );
  });

  it("omits an unsafe DAAS evidence url from the persisted mission state", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            missionId: "mis_unsafe_evidence",
            status: "accepted",
            evidence: { url: "file:///etc/passwd" },
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { db, updateSet } = createFakeDb({ issueRow: { executionState: null } });

    await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBe("blocked");
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "mis_unsafe_evidence",
      status: "daas_mission_evidence_required",
      outcome: "handoff_failed",
      ok: false,
      evidenceUrl: null,
    });
    expect(persisted.executionState.daasRouteStatus).toBe("daas_route_failed");
    expect(persisted.executionState.daasMissionRouted).toBeUndefined();
  });

  it("uses explicit task/comment prompt text instead of wake metadata for DAAS handoff", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        missionId: "mis_prompt",
        status: "handoff_accepted",
        evidence_url: "https://daas.example.test/missions/mis_prompt/evidence",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { db } = createFakeDb({ issueRow: null });

    await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: "Deployment follow-up",
      description: "General issue description",
      promptTexts: ["Restart nginx because the production health check failed"],
      instructionTexts: ["issue_assigned", "issue_commented"],
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
	  expect(JSON.parse(String(init.body))).toMatchObject({
	    prompt: "Restart nginx because the production health check failed",
	    title: "Deployment follow-up",
	  });
	});

	it("calls DAAS with an unresolved target instead of failing locally", async () => {
	  process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	  process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	  const fetchMock = vi.fn(async () =>
	    new Response(JSON.stringify({ missionId: "mis_unresolved_target", status: "blocked_by_policy" }), {
	      status: 403,
	      headers: { "content-type": "application/json" },
	    }),
	  );
	  vi.stubGlobal("fetch", fetchMock);
	  const { db } = createFakeDb({ issueRow: null });

	  const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
	    companyId: "company-1",
	    agentId: "agent-1",
	    issueId: "issue-1",
	    title: "Restart nginx on the production server",
	    description: "Restart nginx on the production server after deploy",
	    signals: ["infra.orchestration"],
	  });

	  expect(fetchMock).toHaveBeenCalledTimes(1);
	  const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
	  expect(JSON.parse(String(init.body))).toMatchObject({
	    prompt: "Restart nginx on the production server after deploy",
	    target: null,
	    targetResolution: "daas_required",
	  });
	  expect(result.dispatch).toMatchObject({
	    outcome: "routed_surfaced",
	    daasStatus: "blocked_by_policy",
	  });
	});

	it("persists rejected DAAS route status and keeps the internal routed marker absent", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ missionId: "mis_rejected", status: "blocked_by_policy" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { db, updateSet } = createFakeDb({ issueRow: { executionState: null } });

    const routed = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(routed.dispatch).toMatchObject({ ok: false, daasStatus: "blocked_by_policy" });
    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBe("blocked");
    expect(persisted.executionState.daasMission).toMatchObject({
      status: "blocked_by_policy",
      outcome: "routed_surfaced",
      ok: false,
    });
    expect(persisted.executionState.daasRouteStatus).toBe("blocked_by_policy");
    expect(persisted.executionState.daasInternalExecution).toBe("disabled");
    expect(persisted.executionState.daasMissionRouted).toBeUndefined();
  });

  it("posts to the adapter and persists the returned mission id on the ticket", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          daas_mission_id: "mis_daas_9",
          status: "waiting_for_lock",
          evidence_url: "https://daas.example.test/missions/mis_daas_9/evidence",
        },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet, insertValues } = createFakeDb({ issueRow: { executionState: { existing: true } } });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    const [calledUrl] = fetchMock.mock.calls[0] as [URL];
    expect(calledUrl.toString()).toBe("https://daas.example.test/api/missions");
    expect(result.dispatch).toMatchObject({ ok: true, daasMissionId: "mis_daas_9" });

    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBeUndefined();
    expect(persisted.executionState.existing).toBe(true);
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "mis_daas_9",
      requestFingerprint: routeFingerprint(),
      target: { type: "server", id: "srv_1" },
      status: "waiting_for_lock",
      executionAuthority: "daas",
      route: "/api/missions",
    });
    expect(persisted.executionState.daasRouteStatus).toBe("routed_to_daas");
    expect(persisted.executionState.daasInternalExecution).toBe("disabled");
    expect(persisted.executionState.daasMissionRouted).toMatchObject({
      route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
      daasMissionId: "mis_daas_9",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: "daas.mission_route.accepted" }),
    );
  });

  it("surfaces a blocked DAAS status on the ticket without faking success", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: { daas_mission_id: "mis_daas_9", status: "blocked_by_policy" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { db, updateSet, insertValues } = createFakeDb({
      issueRow: {
        executionState: {
	          daasMissionRouted: {
	            route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
	            daasMissionId: "mis_stale",
	          },
        },
      },
    });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(result.dispatch.ok).toBe(false);
    expect(result.dispatch.daasStatus).toBe("blocked_by_policy");
    expect(result.cancellationReason).toContain("blocked_by_policy");
    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBe("blocked");
    expect(persisted.executionState.daasMission).toMatchObject({ status: "blocked_by_policy", ok: false });
    expect(persisted.executionState.daasRouteStatus).toBe("blocked_by_policy");
    expect(persisted.executionState.daasInternalExecution).toBe("disabled");
    expect(persisted.executionState.daasMissionRouted).toBeUndefined();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: "daas.mission_route.surfaced" }),
    );
  });

  it("fails closed when the DAAS adapter is not configured (no network call)", async () => {
    delete process.env.DAAS_BASE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({ issueRow: { executionState: null } });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.dispatch.outcome).toBe("adapter_unavailable");
    expect(result.dispatch.ok).toBe(false);
    const persisted = updateSet.mock.calls[0][0] as { status?: string; executionState: Record<string, unknown> };
    expect(persisted.status).toBe("blocked");
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: null,
      outcome: "adapter_unavailable",
      ok: false,
    });
    expect(persisted.executionState.daasRouteStatus).toBe("daas_route_failed");
    expect(persisted.executionState.daasInternalExecution).toBe("disabled");
    expect(persisted.executionState.daasMissionRouted).toBeUndefined();
  });

	it("delegates missing DAAS mission target decisions to DAAS", async () => {
	  process.env["DAAS_BASE_URL"] = "https://daas.example.test";
	  process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
	  process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
	  const fetchMock = vi.fn(async () =>
	    new Response(JSON.stringify({ missionId: "mis_missing_target", status: "blocked_by_policy" }), {
	      status: 403,
	      headers: { "content-type": "application/json" },
	    }),
	  );
	  vi.stubGlobal("fetch", fetchMock);
	  const { db } = createFakeDb({ issueRow: { executionState: null } });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      signals: ["infra.orchestration"],
    });

	  expect(fetchMock).toHaveBeenCalledTimes(1);
	  const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
	  expect(JSON.parse(String(init.body))).toMatchObject({
	    target: null,
	    targetResolution: "daas_required",
	  });
	  expect(result.dispatch.outcome).toBe("routed_surfaced");
	  expect(result.dispatch.daasMissionId).toBe("mis_missing_target");
	});

  it("fails closed when no stable Paperclip issue id is available", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({ issueRow: { executionState: null } });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: null,
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(result.dispatch.outcome).toBe("adapter_unavailable");
  });

  it("reuses an existing DAAS mission instead of posting a duplicate mission", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({
      issueRow: {
        executionState: {
          daasMission: {
            route: "/api/missions",
            missionId: "mis_existing",
            requestFingerprint: routeFingerprint(),
            target: { type: "server", id: "srv_1" },
            status: "requested",
            outcome: "routed_accepted",
            ok: true,
            evidenceUrl: "https://daas.example.test/missions/mis_existing/evidence",
            executionAuthority: "daas",
            httpStatus: 201,
            signals: ["infra.orchestration"],
            routedAt: new Date(0).toISOString(),
          },
	          daasMissionRouted: {
	            route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
	            daasMissionId: "mis_existing",
	          },
        },
      },
    });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(result.dispatch).toMatchObject({
      outcome: "routed_accepted",
      ok: true,
      daasMissionId: "mis_existing",
      daasStatus: "requested",
    });
  });

  it("posts a new DAAS mission when the persisted mission fingerprint does not match the current request", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        missionId: "mis_new",
        status: "handoff_accepted",
        evidence_url: "https://daas.example.test/missions/mis_new/evidence",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({
      issueRow: {
        executionState: {
          daasMission: {
            route: "/api/missions",
            missionId: "mis_existing",
            requestFingerprint: routeFingerprint({ description: "Restart postgres in production" }),
            target: { type: "server", id: "srv_1" },
            status: "requested",
            outcome: "routed_accepted",
            ok: true,
            evidenceUrl: "https://daas.example.test/missions/mis_existing/evidence",
            executionAuthority: "daas",
            httpStatus: 201,
            signals: ["infra.orchestration"],
            routedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.dispatch).toMatchObject({ outcome: "routed_accepted", ok: true, daasMissionId: "mis_new" });
    const persisted = updateSet.mock.calls[0][0] as { executionState: Record<string, unknown> };
    expect(persisted.executionState.daasMission).toMatchObject({
      missionId: "mis_new",
      requestFingerprint: routeFingerprint(),
    });
  });

  it("reuses persisted surfaced outcomes without reposting to DAAS", async () => {
    process.env["DAAS_BASE_URL"] = "https://daas.example.test";
    process.env["DAAS_API_SHARED_SECRET"] = "outbound-daas-secret";
    process.env["PAPERCLIP_WEBHOOK_SECRET"] = "webhook-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, updateSet } = createFakeDb({
      issueRow: {
        executionState: {
          daasMission: {
            route: "/api/missions",
            missionId: null,
            requestFingerprint: routeFingerprint(),
            target: { type: "server", id: "srv_1" },
            status: "blocked_by_policy",
            outcome: "routed_surfaced",
            ok: false,
            executionAuthority: "daas",
            httpStatus: 200,
            signals: ["infra.orchestration"],
            routedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const result = await routeInfrastructureTicketThroughDaasAdapter(db as never, {
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      title: INFRA_TICKET.title,
      description: INFRA_TICKET.description,
      target: { type: "server", id: "srv_1" },
      signals: ["infra.orchestration"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(result.dispatch).toMatchObject({
      outcome: "routed_surfaced",
      ok: false,
      daasMissionId: null,
      daasStatus: "blocked_by_policy",
    });
  });
});

describe("enforceInfrastructureTicketRouting", () => {
  it("routes infrastructure tickets to the DAAS adapter and never calls the internal executor", async () => {
    const routeToDaasAdapter = vi.fn(async () => undefined);
    const runInternalExecutor = vi.fn(async () => "EXECUTED");

    const outcome = await enforceInfrastructureTicketRouting(
      { title: "Restart nginx in production", description: "Restart nginx in production" },
      { routeToDaasAdapter, runInternalExecutor },
    );

    expect(outcome).toEqual({ routedToDaas: true });
    expect(routeToDaasAdapter).toHaveBeenCalledTimes(1);
    expect(runInternalExecutor).not.toHaveBeenCalled();
    expect(routeToDaasAdapter.mock.calls[0][0]).toMatchObject({ allowed: false });
  });

  it("lets ordinary tickets proceed to the internal executor without calling the adapter", async () => {
    const routeToDaasAdapter = vi.fn(async () => undefined);
    const runInternalExecutor = vi.fn(async () => "EXECUTED");

    const outcome = await enforceInfrastructureTicketRouting(
      { title: "Write release notes", description: "Summarize the changelog for the release" },
      { routeToDaasAdapter, runInternalExecutor },
    );

    expect(outcome).toEqual({ routedToDaas: false, result: "EXECUTED" });
    expect(runInternalExecutor).toHaveBeenCalledTimes(1);
    expect(routeToDaasAdapter).not.toHaveBeenCalled();
  });
});
