// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDaasMissionOutput } from "@/lib/daas-mission-output";
import { DaasMissionStatusCard } from "./DaasMissionStatusCard";

/**
 * Mirrors the shape the server now persists into `issue.executionState`
 * (`PersistedDaasMissionState` under `daasMission`) so this test exercises the
 * real backend→UI evidence-link contract rather than a hand-shaped fixture.
 */
function executionStateWithEvidence(evidenceUrl: string | null) {
  return {
    daasMission: {
      route: "/api/missions",
      missionId: "mis_daas_1",
      requestFingerprint: "fp",
      target: { type: "server", id: "srv_1" },
      status: "accepted",
      outcome: "routed_accepted",
      ok: true,
      executionAuthority: "daas",
      evidenceUrl,
      httpStatus: 202,
      signals: ["infra.orchestration"],
      routedAt: new Date(0).toISOString(),
    },
    daasRouteStatus: "routed_to_daas",
    daasInternalExecution: "disabled",
  };
}

describe("getDaasMissionOutput evidence link", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DAAS_BASE_URL", "https://daas.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("surfaces a persisted DAAS evidence url", () => {
    const output = getDaasMissionOutput(
      executionStateWithEvidence("https://daas.example.test/missions/mis_daas_1/evidence"),
    );
    expect(output?.evidenceUrl).toBe("https://daas.example.test/missions/mis_daas_1/evidence");
  });

  it("surfaces a persisted DAAS evidence url from a configured non-example origin", () => {
    vi.stubEnv("VITE_DAAS_BASE_URL", "http://daas-api:8000");
    const output = getDaasMissionOutput(
      executionStateWithEvidence("http://daas-api:8000/missions/mis_daas_1/evidence"),
    );
    expect(output?.evidenceUrl).toBe("http://daas-api:8000/missions/mis_daas_1/evidence");
  });

  it("fails closed when no frontend DAAS base origin is configured", () => {
    vi.unstubAllEnvs();
    const output = getDaasMissionOutput(
      executionStateWithEvidence("https://daas.example.test/missions/mis_daas_1/evidence"),
    );
    expect(output?.evidenceUrl).toBeNull();
  });

  it("returns null evidence when none was persisted", () => {
    const output = getDaasMissionOutput(executionStateWithEvidence(null));
    expect(output?.evidenceUrl).toBeNull();
  });

  it("drops a tampered unsafe evidence url (userinfo, query, or fragment)", () => {
    for (const unsafe of [
      "https://user-info@daas.example.test/evidence",
      "https://daas.example.test/evidence?ref=opaque",
      "https://daas.example.test/evidence#section",
      "https://daas.example.test/token-or-secret/evidence",
      "https://daas.example.test/missions/mis_other/evidence",
      "https://daas.example.test/missions/mis_daas_1/evidence/opaque",
      "javascript:alert(1)",
    ]) {
      const output = getDaasMissionOutput(executionStateWithEvidence(unsafe));
      expect(output?.evidenceUrl).toBeNull();
    }
  });
});

describe("DaasMissionStatusCard evidence link rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubEnv("VITE_DAAS_BASE_URL", "https://daas.example.test");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
  });

  it("renders a DAAS evidence link when the persisted mission state carries one", () => {
    const output = getDaasMissionOutput(
      executionStateWithEvidence("https://daas.example.test/missions/mis_daas_1/evidence"),
    );
    expect(output).not.toBeNull();
    act(() => root.render(<DaasMissionStatusCard output={output!} />));

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      "https://daas.example.test/missions/mis_daas_1/evidence",
    );
    expect(link?.textContent).toContain("DAAS evidence");
  });

  it("renders no evidence link when the persisted mission state has none", () => {
    const output = getDaasMissionOutput(executionStateWithEvidence(null));
    expect(output).not.toBeNull();
    act(() => root.render(<DaasMissionStatusCard output={output!} />));

    expect(container.querySelector("a")).toBeNull();
  });
});
