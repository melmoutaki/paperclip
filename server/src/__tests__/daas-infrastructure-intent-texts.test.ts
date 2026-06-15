import { describe, expect, it } from "vitest";
import { detectDaasInfrastructureTaskIntent } from "../services/daas-infrastructure-task-guard.js";
import { collectDaasInfrastructureIntentTexts } from "../services/daas-infrastructure-intent-texts.js";

describe("collectDaasInfrastructureIntentTexts", () => {
  it("detects infrastructure intent that appears only in acceptance criteria", () => {
    const texts = collectDaasInfrastructureIntentTexts({
      title: "Follow deployment checklist",
      description: "Routine follow-up",
      acceptanceCriteria: [
        "Restart nginx on the production server",
        "Confirm service health",
      ],
    });

    expect(detectDaasInfrastructureTaskIntent(...texts).isInfrastructureIntent).toBe(true);
  });

  it("detects infrastructure intent in suggested and decomposed child task text", () => {
    const texts = collectDaasInfrastructureIntentTexts({
      planBody: "Split this accepted plan into child tasks",
      suggestedChildTasks: [
        { title: "Document outcome", body: "Write summary" },
        { title: "Apply server change", body: "Restart nginx on the production server" },
      ],
      renderedSummary: "Second child mutates server state",
    });

    expect(detectDaasInfrastructureTaskIntent(...texts).isInfrastructureIntent).toBe(true);
  });

  it("keeps non-infrastructure accepted plan text on the normal Paperclip path", () => {
    const texts = collectDaasInfrastructureIntentTexts({
      planBody: "Prepare release notes",
      suggestedChildTasks: [
        { title: "Summarize changelog", body: "Write customer-facing notes" },
      ],
    });

    expect(detectDaasInfrastructureTaskIntent(...texts).isInfrastructureIntent).toBe(false);
  });
});
