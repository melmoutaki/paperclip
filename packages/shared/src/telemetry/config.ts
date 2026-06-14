import type { TelemetryConfig } from "./types.js";

const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];

/** Opt-in switch that turns telemetry on in the DAAS fork (telemetry is OFF by default). */
export const TELEMETRY_ENABLE_ENV = "PAPERCLIP_TELEMETRY_ENABLED";

/**
 * Enterprise policy switch. When set to an "enforce" value, the deployment has
 * declared that telemetry must stay off; any attempt to enable telemetry then
 * becomes a fail-closed condition instead of silently emitting data.
 */
export const ENTERPRISE_TELEMETRY_POLICY_ENV = "PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY";

export type EnterpriseTelemetryPolicy = "unset" | "allow" | "enforce_disabled";

const POLICY_ENFORCE_VALUES = new Set([
  "enforce_disabled",
  "enforce",
  "disabled",
  "require_disabled",
  "1",
  "on",
  "true",
]);
const POLICY_ALLOW_VALUES = new Set(["allow", "allowed", "off", "0", "false"]);

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  return typeof raw === "string" ? raw : undefined;
}

function isCI(env: NodeJS.ProcessEnv): boolean {
  return CI_ENV_VARS.some((key) => env[key] === "true" || env[key] === "1");
}

/**
 * Resolve the enterprise telemetry policy from the environment. Unknown,
 * non-empty values fail safe toward `enforce_disabled` so a typo never silently
 * weakens the policy.
 */
export function resolveEnterpriseTelemetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseTelemetryPolicy {
  const raw = readEnv(env, ENTERPRISE_TELEMETRY_POLICY_ENV)?.trim().toLowerCase();
  if (!raw) return "unset";
  if (POLICY_ALLOW_VALUES.has(raw)) return "allow";
  if (POLICY_ENFORCE_VALUES.has(raw)) return "enforce_disabled";
  return "enforce_disabled";
}

/**
 * Thrown when telemetry is requested while the enterprise policy forbids it.
 * Surfacing this as an error (rather than silently disabling) is the
 * fail-closed contract: the operator must reconcile the conflicting config.
 */
export class TelemetryPolicyViolationError extends Error {
  readonly code = "telemetry_policy_violation";
  constructor(message: string) {
    super(message);
    this.name = "TelemetryPolicyViolationError";
  }
}

/**
 * Whether telemetry has been explicitly requested on, via persisted config
 * (`telemetry.enabled: true`) or the opt-in env switch. In the DAAS fork
 * telemetry is never on implicitly — this is the only path to `enabled: true`.
 */
export function isTelemetryRequested(
  fileConfig?: { enabled?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return fileConfig?.enabled === true || readEnv(env, TELEMETRY_ENABLE_ENV) === "1";
}

/**
 * Resolve the effective telemetry configuration.
 *
 * DAAS fork behaviour:
 * - Telemetry is OFF by default. It only turns on when explicitly requested.
 * - Universal kill switches (`PAPERCLIP_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, CI)
 *   force it off.
 * - When the enterprise policy enforces "disabled" and telemetry is requested
 *   on, this throws {@link TelemetryPolicyViolationError} (fail-closed).
 */
export function resolveTelemetryConfig(
  fileConfig?: { enabled?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig {
  const requested = isTelemetryRequested(fileConfig, env);
  const policy = resolveEnterpriseTelemetryPolicy(env);

  // Fail-closed: an explicit request to enable telemetry against an enforcing
  // enterprise policy is a configuration error, not a silent no-op.
  if (requested && policy === "enforce_disabled") {
    throw new TelemetryPolicyViolationError(
      `Telemetry was enabled but ${ENTERPRISE_TELEMETRY_POLICY_ENV} forbids it. ` +
        "Refusing to start with telemetry enabled (fail-closed). Disable telemetry " +
        `or change ${ENTERPRISE_TELEMETRY_POLICY_ENV}.`,
    );
  }

  if (readEnv(env, "PAPERCLIP_TELEMETRY_DISABLED") === "1") return { enabled: false };
  if (readEnv(env, "DO_NOT_TRACK") === "1") return { enabled: false };
  if (isCI(env)) return { enabled: false };

  // DAAS fork default: telemetry stays off unless explicitly opted in.
  if (!requested) return { enabled: false };

  const endpoint = readEnv(env, "PAPERCLIP_TELEMETRY_ENDPOINT") || undefined;
  return { enabled: true, endpoint };
}
