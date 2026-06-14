import { describe, expect, it } from "vitest";
import type { AdapterConfigSchema, ConfigFieldSchema } from "@paperclipai/adapter-utils";
import { fieldMatchesVisibleWhen } from "./schema-config-fields";
import {
  filterDaasSafeAdapterOptions,
  isDaasBlockedInfrastructureAdapterType,
  isDaasBlockedInfrastructureConfigField,
} from "./daas-safety";

const sourceField: ConfigFieldSchema = {
  key: "provider",
  label: "Provider",
  type: "select",
  options: [
    { label: "Claude", value: "claude" },
    { label: "Codex", value: "codex" },
  ],
};

const schema: AdapterConfigSchema = {
  fields: [sourceField],
};

function targetWithVisibleWhen(visibleWhen: Record<string, unknown>): ConfigFieldSchema {
  return {
    key: "model",
    label: "Model",
    type: "text",
    meta: { visibleWhen },
  };
}

describe("fieldMatchesVisibleWhen", () => {
  it("treats an empty values array as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("treats all non-string values as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [null, 42] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("matches non-empty string values", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: ["claude"] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(true);
    expect(fieldMatchesVisibleWhen(field, () => "codex", schema)).toBe(false);
  });
});

describe("DAAS adapter safety helpers", () => {
  it("blocks direct infrastructure adapter choices", () => {
    expect(isDaasBlockedInfrastructureAdapterType("process")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("http")).toBe(true);
    expect(isDaasBlockedInfrastructureAdapterType("codex_local")).toBe(false);

    expect(
      filterDaasSafeAdapterOptions([
        { value: "process", label: "Process" },
        { value: "codex_local", label: "Codex" },
      ]),
    ).toEqual([{ value: "codex_local", label: "Codex" }]);
  });

  it("blocks direct infrastructure schema fields", () => {
    expect(
      isDaasBlockedInfrastructureConfigField({
        key: "dangerouslySkipPermissions",
        label: "Skip permissions",
      }),
    ).toBe(true);
    expect(
      isDaasBlockedInfrastructureConfigField({
        key: "providerKeyPath",
        label: "Provider key",
        hint: "Secret access for external connector",
      }),
    ).toBe(true);
    expect(
      isDaasBlockedInfrastructureConfigField({
        key: "model",
        label: "Model",
      }),
    ).toBe(false);
  });
});
