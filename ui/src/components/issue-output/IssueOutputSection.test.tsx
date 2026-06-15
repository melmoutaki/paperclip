import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { IssueOutputSection } from "./IssueOutputSection";

function makeWorkProduct(overrides: Partial<IssueWorkProduct> & { id: string }): IssueWorkProduct {
  return {
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "output",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-05-30T12:00:00Z"),
    updatedAt: new Date("2026-05-30T12:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

const UUIDS: Record<string, string> = {
  "att-1": "11111111-1111-4111-8111-111111111111",
  "att-vid": "22222222-2222-4222-8222-222222222222",
  "att-pdf": "33333333-3333-4333-8333-333333333333",
};

function metadata(key: string, contentType: string, filename: string) {
  const attachmentId = UUIDS[key] ?? key;
  return {
    attachmentId,
    contentType,
    byteSize: 19_293_798,
    contentPath: `/api/attachments/${attachmentId}/content`,
    openPath: `/api/attachments/${attachmentId}/content`,
    downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
    originalFilename: filename,
  };
}

describe("IssueOutputSection", () => {
  it("renders DAAS mission status and evidence link as the authoritative output", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[]}
        executionState={{
          daasMission: {
            executionAuthority: "daas",
            missionId: "mis_daas_270",
            status: "success",
            evidenceUrl: "https://daas.example/missions/mis_daas_270/evidence",
          },
          daasRouteStatus: "routed_to_daas",
          daasInternalExecution: "disabled",
        }}
      />,
    );

    expect(markup).toContain("Source: DAAS");
    expect(markup).toContain("Success");
    expect(markup).toContain("mis_daas_270");
    expect(markup).toContain("Route status: Routed To Daas");
    expect(markup).toContain("DAAS evidence");
    expect(markup).toContain("https://daas.example/missions/mis_daas_270/evidence");
  });

  it("keeps blocked and inconclusive DAAS statuses distinct", () => {
    const blockedMarkup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[]}
        executionState={{
          daasMission: {
            executionAuthority: "daas",
            status: "blocked_by_policy",
          },
          daasRouteStatus: "blocked_by_policy",
        }}
      />,
    );
    const inconclusiveMarkup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[]}
        executionState={{
          daasMission: {
            executionAuthority: "daas",
            missionId: "mis_daas_review",
            status: "inconclusive",
          },
          daasRouteStatus: "routed_to_daas",
        }}
      />,
    );

    expect(blockedMarkup).toContain("Blocked By Policy");
    expect(blockedMarkup).toContain("Route status: Blocked By Policy");
    expect(inconclusiveMarkup).toContain("Inconclusive");
    expect(inconclusiveMarkup).toContain("mis_daas_review");
  });

  it("does not render raw DAAS logs or unredacted adapter payload fields", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[]}
        executionState={{
          daasMission: {
            executionAuthority: "daas",
            missionId: "mis_daas_redacted",
            status: "running",
            logs: "SENSITIVE_LOG_SENTINEL_DO_NOT_RENDER",
            stdout: "raw server log",
            finalPrompt: "ssh root@example",
          },
          rawLogs: "private-key-material",
          stderr: "unredacted stderr",
        }}
      />,
    );

    expect(markup).toContain("Source: DAAS");
    expect(markup).toContain("Running");
    expect(markup).not.toContain("SENSITIVE_LOG_SENTINEL");
    expect(markup).not.toContain("raw server log");
    expect(markup).not.toContain("ssh root@example");
    expect(markup).not.toContain("private-key-material");
    expect(markup).not.toContain("unredacted stderr");
  });

  it("omits unsafe DAAS evidence URLs", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[]}
        executionState={{
          daasMission: {
            executionAuthority: "daas",
            missionId: "mis_daas_link_guard",
            status: "success",
            evidenceUrl: "javascript:alert(1)",
          },
          daasRouteStatus: "routed_to_daas",
        }}
      />,
    );

    expect(markup).toContain("Source: DAAS");
    expect(markup).toContain("mis_daas_link_guard");
    expect(markup).not.toContain("DAAS evidence");
    expect(markup).not.toContain("javascript:");
  });

  it("renders a playable, downloadable video as the primary output", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-1",
            title: "Demo walkthrough",
            isPrimary: true,
            metadata: metadata("att-1", "video/mp4", "demo.mp4"),
          }),
        ]}
      />,
    );

    // Native video player present
    expect(markup).toContain("<video");
    expect(markup).toContain("controls");
    expect(markup).toContain(`/api/attachments/${UUIDS["att-1"]}/content`);
    // Filename surfaced and download/open wired
    expect(markup).toContain("demo.mp4");
    expect(markup).toContain(`/api/attachments/${UUIDS["att-1"]}/content?download=1`);
    expect(markup).toContain("Download");
    expect(markup).toContain("Open");
    // Section header + size formatting
    expect(markup).toContain("Output");
    expect(markup).toContain("18.4 MB");
  });

  it("renders nothing when the issue has no artifact outputs (empty state)", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({ id: "pr-1", type: "pull_request" }),
        ]}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders nothing for markdown-only artifact work products", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-markdown",
            title: "plan.md",
            isPrimary: true,
            metadata: metadata("att-1", "text/markdown", "plan.md"),
          }),
        ]}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders the primary card plus an Also produced list for multiple outputs", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-primary",
            isPrimary: true,
            createdAt: new Date("2026-05-30T12:00:00Z"),
            metadata: metadata("att-vid", "video/mp4", "summary.mp4"),
          }),
          makeWorkProduct({
            id: "wp-pdf",
            createdAt: new Date("2026-05-30T11:00:00Z"),
            metadata: metadata("att-pdf", "application/pdf", "talking-points.pdf"),
          }),
        ]}
      />,
    );

    expect(markup).toContain("Also produced");
    expect(markup).toContain("summary.mp4");
    expect(markup).toContain("talking-points.pdf");
    // PDF glyph tile label appears for the secondary row
    expect(markup).toContain("PDF");
  });

  it("surfaces an output with failed/invalid attachment metadata without crashing", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-broken",
            title: "broken-output.mp4",
            isPrimary: true,
            // Missing required path fields → fails the shared metadata schema
            metadata: { attachmentId: "att-x", contentType: "video/mp4" } as Record<string, unknown>,
          }),
        ]}
      />,
    );

    expect(markup).toContain("broken-output.mp4");
    expect(markup).toContain("metadata is unavailable");
    // No video element and no download link can be built from invalid metadata
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("download=1");
  });
});
