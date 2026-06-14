import { describe, expect, it } from "vitest";
import {
  defaultDaasCapabilitiesForRole,
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent permissions service", () => {
  it("keeps agent-creation authority least-privileged by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineering-manager").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
  });

  it("preserves explicit canCreateAgents overrides", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "cto").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "engineer").canCreateAgents).toBe(true);
  });

  it("assigns DAAS AgentOps capabilities without dangerous infrastructure actions", () => {
    expect(defaultDaasCapabilitiesForRole("daas_infra_planner")).toEqual([
      "daas.mission.create",
      "daas.mission.read",
      "daas.budget.read",
      "daas.ticket.update",
    ]);
    expect(defaultDaasCapabilitiesForRole("daas_evidence_auditor")).toEqual([
      "daas.mission.read",
      "daas.evidence.read",
    ]);
    expect(defaultPermissionsForRole("daas_operator")).toMatchObject({
      canCreateAgents: false,
      daasCapabilities: expect.arrayContaining(["daas.mission.create", "daas.evidence.read"]),
    });
  });

  it("normalizes explicit DAAS capabilities to the allowlist", () => {
    expect(normalizeAgentPermissions({
      daasCapabilities: ["daas.mission.create", "ssh.open", "daas.evidence.read"],
    }, "engineer").daasCapabilities).toEqual([
      "daas.mission.create",
      "daas.evidence.read",
    ]);
  });
});
