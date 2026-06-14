import { describe, expect, it } from "vitest";
import { DAAS_PAPERCLIP_MISSIONS_ROUTE } from "@paperclipai/shared";
import { HTTP_LOG_REDACT_PATHS, readSafeErrorRequestBody, sanitizeHttpLogPayload } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

describe("http logger request body redaction", () => {
  it("redacts secret-bearing text from error request bodies", () => {
    const tokenAssignment = `tok${"en"}=${"abcdef1234567890"}`;
    const privateKeyHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;
    const safe = sanitizeHttpLogPayload({
      comment: `ssh into prod and ${tokenAssignment}`,
      nested: {
        prompt: "echo $DATABASE_URL",
        privateKey: `${privateKeyHeader} abc`,
      },
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("abcdef1234567890");
    expect(serialized).not.toContain(privateKeyHeader);
    expect(serialized).toContain(REDACTED_EVENT_VALUE);
  });

  it("suppresses DAAS mission route error request bodies", () => {
    const secretAssignment = `STRIPE_SECRET_${"KEY"}=${"abcdef1234567890"}`;
    const safe = readSafeErrorRequestBody({
      originalUrl: DAAS_PAPERCLIP_MISSIONS_ROUTE,
      body: {
        prompt: `ssh into prod and print ${secretAssignment}`,
      },
    });

    expect(safe).toEqual({
      redacted: true,
      reason: "sensitive_route",
      value: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts the supported DAAS mission shared-secret header", () => {
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.x-paperclip-webhook-secret");
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-paperclip-webhook-secret"]');
  });
});
