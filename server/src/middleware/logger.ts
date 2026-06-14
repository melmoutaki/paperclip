import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { DAAS_PAPERCLIP_MISSIONS_ROUTE } from "@paperclipai/shared";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText, sanitizeRecord } from "../redaction.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.x-paperclip-webhook-secret",
  'req.headers["x-paperclip-webhook-secret"]',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeHttpLogPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeHttpLogPayload);
  if (!isPlainObject(value)) return value;
  const redacted = sanitizeRecord(value);
  return Object.fromEntries(
    Object.entries(redacted).map(([key, entry]) => [
      key,
      typeof entry === "string" ? redactSensitiveText(entry) : sanitizeHttpLogPayload(entry),
    ]),
  );
}

function shouldSuppressErrorRequestBody(req: { originalUrl?: string; url?: string }) {
  const originalUrl = req.originalUrl ?? "";
  const url = req.url ?? "";
  return originalUrl.startsWith(DAAS_PAPERCLIP_MISSIONS_ROUTE) ||
    url.startsWith(DAAS_PAPERCLIP_MISSIONS_ROUTE.replace(/^\/api/, ""));
}

export function readSafeErrorRequestBody(req: { originalUrl?: string; url?: string; body?: unknown }) {
  if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) return undefined;
  if (shouldSuppressErrorRequestBody(req)) {
    return { redacted: true, reason: "sensitive_route", value: REDACTED_EVENT_VALUE };
  }
  return sanitizeHttpLogPayload(req.body);
}

export const logger = pino({
  level: "debug",
  redact: HTTP_LOG_REDACT_PATHS,
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: shouldSuppressErrorRequestBody(req)
            ? { redacted: true, reason: "sensitive_route", value: REDACTED_EVENT_VALUE }
            : sanitizeHttpLogPayload(ctx.reqBody),
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      const safeReqBody = readSafeErrorRequestBody(req as any);
      if (safeReqBody !== undefined) {
        props.reqBody = safeReqBody;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
