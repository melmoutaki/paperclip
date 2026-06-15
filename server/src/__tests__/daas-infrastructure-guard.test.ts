import { describe, expect, it } from "vitest";
import {
  collectDaasDirectInfrastructureConfigPaths,
  isDaasBlockedInfrastructureAdapterType,
  materializeDaasSafeAdapterDefaults,
} from "../services/daas-infrastructure-guard.js";

describe("DAAS direct infrastructure guard", () => {
  it("blocks direct infrastructure adapters", () => {
    expect(isDaasBlockedInfrastructureAdapterType("process")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("http")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("claude_local")).toBe(false);
  });

	  it("blocks true dangerous permission bypass flags", () => {
    expect(
      collectDaasDirectInfrastructureConfigPaths(
        {
          dangerouslySkipPermissions: true,
          dangerouslyBypassApprovalsAndSandbox: false,
          dangerouslyBypassSandbox: "true",
        },
        "adapterConfig",
      ),
    ).toEqual(["adapterConfig.dangerouslySkipPermissions", "adapterConfig.dangerouslyBypassSandbox"]);
	  });

	  it("materializes omitted local-adapter permission bypass defaults as false", () => {
	    for (const adapterType of ["claude_local", "opencode_local"]) {
	      expect(materializeDaasSafeAdapterDefaults(adapterType, {})).toEqual({
	        dangerouslySkipPermissions: false,
	      });
	      expect(materializeDaasSafeAdapterDefaults(adapterType, { dangerouslySkipPermissions: false })).toEqual({
	        dangerouslySkipPermissions: false,
	      });
	      expect(materializeDaasSafeAdapterDefaults(adapterType, { dangerouslySkipPermissions: true })).toEqual({
	        dangerouslySkipPermissions: true,
	      });
	    }
	    expect(materializeDaasSafeAdapterDefaults("codex_local", {})).toEqual({});
	  });

	  it("blocks direct SSH execution targets in nested runtime config", () => {
    expect(
      collectDaasDirectInfrastructureConfigPaths(
        {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                executionTarget: { kind: "remote", transport: "ssh" },
              },
            },
          },
        },
        "runtimeConfig",
      ),
    ).toEqual(["runtimeConfig.modelProfiles.cheap.adapterConfig.executionTarget"]);
  });

  it("allows sandbox execution targets", () => {
    expect(
      collectDaasDirectInfrastructureConfigPaths(
        {
          executionTarget: { kind: "remote", transport: "sandbox" },
        },
        "adapterConfig",
      ),
    ).toEqual([]);
  });
});
