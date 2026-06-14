import {
  DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE,
  DAAS_MISSION_ID_CONTEXT_KEY,
  DAAS_MISSION_ROUTE_CONTEXT_KEY,
  DAAS_PAPERCLIP_MISSIONS_ROUTE,
} from "@paperclipai/shared";

/**
 * T258 — Central DAAS infrastructure task-routing guard.
 *
 * Paperclip must never execute direct SSH / raw shell / secret / credential /
 * provider-key infrastructure work. Any task whose intent is infrastructure
 * work must be routed through the DAAS governed mission API
 * (`DAAS_PAPERCLIP_MISSIONS_ROUTE`). This module provides a reusable,
 * dependency-free helper for:
 *   1. detecting infrastructure intent from task text,
 *   2. making a fail-closed policy decision about whether the dispatch may
 *      proceed, and
 *   3. logging denials WITHOUT leaking secret material.
 *
 * It complements (and does not replace) the T257 direct-infrastructure adapter
 * guard in `daas-infrastructure-guard.ts`.
 */

/**
 * Infra-intent signals. Each maps to one of the canonical
 * `DAAS_DANGEROUS_INFRASTRUCTURE_ACTIONS` families. The signal *names* are the
 * only detection detail that may be logged — never the matched substring, which
 * could contain secret material.
 */
const INFRASTRUCTURE_INTENT_SIGNALS: ReadonlyArray<{
  signal: string;
  patterns: RegExp[];
}> = [
  {
    // Intent-shaped patterns only — bare "ssh" is avoided so system strings like
    // "ssh: connection reset" (run errors, environment names) do not false-positive.
    signal: "ssh.open",
    patterns: [
      /\bssh\s+(?!into\b|to\b|connection\b|session\b|access\b|tunnel\b|key\b)(-[A-Za-z0-9]+\s+)*([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]{1,}\b/i,
      /\bssh\s+(?!into\b|to\b)(-[A-Za-z0-9]+\s+)*([A-Za-z0-9._-]+@)?\[[0-9A-Fa-f:]{3,}\]/i,
      /\bssh\s+((-[A-Za-z0-9]+\s+)*)([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{2,}\b/i,
      /\bssh\s+((-[A-Za-z0-9]+\s+)*)(root|admin|ubuntu|ec2-user|deploy)@[A-Za-z0-9._-]+\b/i,
      /\b(scp|sftp)\b[^\n]{0,120}([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{2,}\b/i,
      /\b(scp|sftp)\b[^\n]{0,120}([A-Za-z0-9._-]+@)?(prod|production|staging|server|host|vm|node)[A-Za-z0-9._-]*(:|\/|\s|$)/i,
      /\bconnect\b[^.\n]{0,40}\b(with|using|via)\s+ssh\b/i,
      /\b(log\s*in|login|log\s+into|connect|access)\b[^.\n]{0,60}\b(prod|production|staging|stage)\b[^.\n]{0,40}\b(host|box|server|vm|node)\b/i,
      /\bconnect\b[^.\n]{0,60}\b(prod|production|staging|stage)\b[^.\n]{0,40}\bbox\b/i,
      /\b(connect|access|log\s*in|login|log\s+into)\b[^.\n]{0,80}\b(prod|production|staging|stage)\b/i,
      /\b(connect|access|log\s*in|login|log\s+into)\b[^.\n]{0,80}\b(server|host|vm|node|remote\s+machine|machine)\b/i,
      /\buse\s+ssh\b[^.\n]{0,80}\b(access|connect|log\s*in|login)\b[^.\n]{0,80}\b(prod|production|server|host|vm|node)\b/i,
      /\buse\s+secure\s+shell\b[^.\n]{0,80}\b(access|connect|log\s*in|login)\b[^.\n]{0,80}\b(prod|production|server|host|vm|node)\b/i,
      /\b(open|start|establish|create)\b[^.\n]{0,40}\bsecure\s+shell\b[^.\n]{0,40}\b(session|connection)?\b[^.\n]{0,50}\b(to|with|on|in)?\b[^.\n]{0,40}\b(prod|production|server|host|vm|node)\b/i,
      /\bssh(\s+|-)(into|in\s+to|to)\b/i,
      /\b(open|establish|start|create)\s+(an?\s+)?ssh\b/i,
      /\b(via|using|over)\s+ssh\b/i,
      /\bssh\s+(connection|session|access|tunnel|key)\b/i,
      /\b(scp|sftp)\s+(into|to|files?)\b/i,
    ],
  },
  {
    signal: "shell.execute",
    patterns: [
      /\braw\s+shell\b/i,
      /\bshell\s+access\b/i,
      /\bremote\s+shell\b/i,
      /\b(open|start|launch)\s+(a\s+)?terminal\b[^.\n]{0,40}\b(on|to|in)\b[^.\n]{0,40}\b(prod|production|server|host|vm|node)\b/i,
      /\b(open|start|launch|access)\b[^.\n]{0,50}\b(shell|terminal|console)\b[^.\n]{0,50}\b(on|to|in)?\b[^.\n]{0,40}\b(prod|production|server|host|vm|node)\b/i,
      /\b(run|execute)\s+(a\s+)?shell\s+command\b/i,
      /\b(run|execute)\b[^.\n]{0,120}\b(on|in|from)\b[^.\n]{0,50}\b(prod|production|server|host|vm|node|box)\b/i,
      /\b(run|execute)\b[^.\n]{0,80}\b(command|shell|bash|sh|uptime|script)\b[^.\n]{0,80}\b(on|in|from)\b[^.\n]{0,50}\b(remote\s+machine|server|host|vm|node|machine)\b/i,
      /\b(connect|access|log\s*in|login|log\s+into)\b[^.\n]{0,80}\b(server|host|vm|node|remote\s+machine|machine)\b[^.\n]{0,80}\b(run|execute|check|inspect|read|view|tail|restart|reload|stop|start)\b/i,
      /\b(connect|access|log\s*in|login|log\s+into)\b[^.\n]{0,80}\b(prod|production|staging|stage)\b[^.\n]{0,80}\b(run|execute|check|inspect|read|view|tail)\b/i,
      /\b(read|view|check|inspect)\b[^.\n]{0,80}\b(env|environment|vars?|variables?|disk|logs?)\b[^.\n]{0,80}\b(from|on|in)?\b[^.\n]{0,40}\b(prod|production|staging|stage)\b/i,
      /\b(run|execute)\b[^.\n]{0,40}\buptime\b[^.\n]{0,40}\b(on|in)\b[^.\n]{0,40}\b(prod|production|server|host|vm|node)\b/i,
      /\btail\b[^.\n]{0,40}\blogs?\b[^.\n]{0,60}\b(on|in|from)\b[^.\n]{0,40}\b(prod|production|server|host|box|vm|node)\b/i,
      /\b(tail|view|read|show|inspect|check)\b[^.\n]{0,50}\b(prod|production|staging|stage)\b[^.\n]{0,50}\blogs?\b/i,
      /\b(tail|view|read|show|inspect|check)\b[^.\n]{0,50}\blogs?\b[^.\n]{0,70}\b(on|in|from)?\b[^.\n]{0,40}\b(server|host|vm|node|remote\s+machine|machine)\b/i,
      /\b(tail|view|read|show|inspect|check)\b[^.\n]{0,50}\blogs?\b[^.\n]{0,60}\b(on|in|from)?\b[^.\n]{0,40}\b(prod|production|server|host|box|vm|node)\b/i,
      /\binspect\b[^.\n]{0,60}\b(prod|production)\b[^.\n]{0,40}\b(host|box|server|vm|node)\b/i,
      /\binspect\b[^.\n]{0,60}\b(nginx|postgres|mysql|redis|systemd)\b[^.\n]{0,40}\blogs?\b/i,
      /\b(run|execute)\s+(a\s+)?(bash|sh)\s+(command|script)\s+on\b/i,
      /\b(run|execute)\b[^.\n]{0,80}\b(ls|whoami|cat|tail|grep|awk|sed|ps|df|du|free|top|journalctl|systemctl|docker|podman|kubectl)\b[^.\n]{0,80}\b(on|in|from)\b[^.\n]{0,50}\b(prod|production|server|host|vm|node|box)\b/i,
      /\b(execute|run)\b[^.\n]{0,40}\b(systemctl|service|journalctl|docker|podman)\b[^.\n]{0,40}\b(on|server|host|vm|node|prod|production)\b/i,
      /\bcat\s+\/etc\/(passwd|shadow)\b/i,
      /\b(open|launch|connect\s+to|start)\b[^.\n]{0,60}\b(prod|production)\b[^.\n]{0,40}\b(database|db)\b[^.\n]{0,30}\b(console|shell|cli|terminal|session)\b/i,
      /\b(systemctl|service)\s+(restart|reload|stop|start)\b/i,
    ],
  },
  {
    signal: "credential.read",
    patterns: [
      /\b(read|fetch|retrieve|dump|exfiltrate|print|reveal)\b[^.\n]{0,40}\bcredentials?\b/i,
      /\bcredential\s+(read|value|material)\b/i,
    ],
  },
  {
    signal: "secret.read",
    patterns: [
      /\b(read|fetch|retrieve|dump|exfiltrate|print|reveal)\b[^.\n]{0,40}\bsecrets?\b/i,
      /\bsecret\s+(read|value|material)\b/i,
      /\b(get|read|fetch|retrieve|show|display)\b[^.\n]{0,80}\b(prod|production)\b[^.\n]{0,60}\b(database|db)\b[^.\n]{0,30}\b(password|passphrase|secret|token)\b/i,
      /\b(aws|gcloud|az)\b[^.\n]{0,80}\b(secretsmanager|get-secret-value|secret-manager|keyvault|vault)\b/i,
      /\bread\b[^.\n]{0,40}\b[A-Z][A-Z0-9_]{2,}\b[^.\n]{0,20}\b(env|environment)\b/i,
      /\b(read|fetch|print|reveal)\b[^.\n]{0,40}\bDATABASE_URL\b/i,
      /\b(get|show|display|echo)\b[^.\n]{0,40}\$?DATABASE_URL\b/i,
      /\b(read|fetch|retrieve|dump|exfiltrate|print|reveal|show|get)\b[^.\n]{0,60}\b[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\b/i,
      /\b(echo|print|show|display|cat)\b[^.\n]{0,80}\$[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*\b/i,
      /\b(display|show|print|get|read)\b[^.\n]{0,60}\b(env|environment)\b[^.\n]{0,30}\b(secret|token|password|key)\b/i,
      /\b(get|read|fetch|retrieve|print)\b[^.\n]{0,40}\bDATABASE_URL\b[^.\n]{0,40}\b(prod|production)\b/i,
      /\b(cat|read|print|fetch|retrieve)\b[^.\n]{0,80}\b(~\/\.ssh\/id_rsa|id_rsa|id_ed25519|\.pem|private\s+key|\/etc\/shadow)\b/i,
      /\b(~\/\.ssh\/id_rsa|id_rsa|id_ed25519|\.pem|private\s+key|\/etc\/shadow)\b/i,
      /\brotate\b[^.\n]{0,40}\b(database|db|root|admin)\s+password\b/i,
    ],
  },
  {
    signal: "provider_key.read",
    patterns: [
      /\bprovider\s+(api\s+)?key\b/i,
      /\b(aws|gcp|azure|cloud)\s+(access\s+)?(key|credential)s?\b/i,
      /\b(read|fetch|retrieve|dump|reveal)\b[^.\n]{0,40}\bapi\s+keys?\b/i,
    ],
  },
  {
    signal: "infra.orchestration",
    patterns: [
      /\b(kubectl|helm)\b[^.\n]{0,40}\b(apply|delete|exec|rollout|scale|cordon|drain)\b/i,
      /\bkubectl\b[^.\n]{0,60}\b(get|describe|list)\b[^.\n]{0,40}\bsecrets?\b[^.\n]{0,40}\b(prod|production)?\b/i,
      /\bkubectl\b[^.\n]{0,80}\b(get|describe|list)\b[^.\n]{0,80}\b(pods?|deployments?|services?|nodes?|namespaces?|secrets?)\b[^.\n]{0,80}\b(prod|production)\b/i,
      /\bdeploy\b[^.\n]{0,80}\b(prod|production)\b[^.\n]{0,80}\b(kubectl|helm|terraform|ansible|aws|gcloud|az)\b/i,
      /\b(kubectl|helm|terraform|ansible|aws|gcloud|az)\b[^.\n]{0,80}\bdeploy\b[^.\n]{0,80}\b(prod|production)\b/i,
      /\b(deploy|promote|release|roll\s*back|rollback|migrate|backup|restore)\b[^.\n]{0,90}\b(to|in|on|for|from)?\b[^.\n]{0,40}\b(prod|production|staging|stage)\b/i,
      /\b(prod|production|staging|stage)\b[^.\n]{0,90}\b(deploy|deployment|promotion|release|roll\s*back|rollback|migration|backup|restore)\b/i,
      /\bpromote\b[^.\n]{0,80}\b(latest|current|new)?\b[^.\n]{0,40}\b(image|build|release|artifact|version)\b[^.\n]{0,80}\b(to|into|for)?\b[^.\n]{0,40}\b(prod|production|staging|stage)\b/i,
      /\broll\s*back\b[^.\n]{0,80}\b(latest|current|last)?\b[^.\n]{0,40}\b(deploy|deployment|release|image|build)\b[^.\n]{0,80}\b(prod|production|staging|stage)?\b/i,
      /\brollback\b[^.\n]{0,80}\b(latest|current|last)?\b[^.\n]{0,40}\b(deploy|deployment|release|image|build)\b[^.\n]{0,80}\b(prod|production|staging|stage)?\b/i,
      /\bterraform\s+(apply|destroy|plan)\b/i,
      /\b(aws|gcloud|az)\b[^.\n]{0,80}\b(ec2|compute|vm|instance|server)\b[^.\n]{0,80}\b(reboot|restart|start|stop|terminate)\b/i,
      /\b(aws|gcloud|az)\b[^.\n]{0,80}\b(reboot|restart|start|stop|terminate)\b[^.\n]{0,80}\b(ec2|compute|vm|instance|server)\b/i,
      /\b(reboot|restart|stop|start)\b[^.\n]{0,60}\b(prod|production)\b[^.\n]{0,40}\b(server|host|vm|node|instance)\b/i,
      /\b(reboot|restart|stop|start)\b[^.\n]{0,40}\b(server|host|vm|node|instance)\b/i,
      /\b(restart|reload|stop|start|rotate|renew|replace)\b[^.\n]{0,70}\b(prod|production)\b[^.\n]{0,50}\b(database|db|postgres|mysql|redis|service|tls|ssl|certificate|cert)\b/i,
      /\b(restart|reload|stop|start|rotate|renew|replace|delete|remove|chmod|chown)\b[^.\n]{0,80}\b(nginx|apache|postgres|mysql|redis|database|db|service|tls|ssl|certificate|cert)\b[^.\n]{0,80}\b(in|on|for)?\b[^.\n]{0,30}\b(prod|production|staging|stage)\b/i,
      /\b(reboot|restart|stop|start)\b[^.\n]{0,40}\b(prod|production)\b[^.\n]{0,40}\b(nginx|postgres|mysql|redis|systemd|service)\b/i,
      /\b(ansible-playbook|ansible)\b[^.\n]{0,40}\b(server|host|inventory|prod|production)\b/i,
      /\b(restart|reload|stop|start)\b[^.\n]{0,40}\b(nginx|postgres|mysql|redis|systemd)\b[^.\n]{0,40}\b(on|server|host|prod|production)\b/i,
    ],
  },
  {
    signal: "infra.provision",
    patterns: [
      /\b(provision|spin\s+up|tear\s+down|destroy)\b[^.\n]{0,40}\b(server|host|vm|droplet|instance|cluster|node)s?\b/i,
      /\bssh\s+into\s+the\s+(server|host|box|vm)\b/i,
    ],
  },
];

export interface DaasInfrastructureIntentResult {
  isInfrastructureIntent: boolean;
  /** Canonical signal names that matched. Safe to log (no secret material). */
  signals: string[];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function collectDaasInfrastructureTaskInstructionTexts(input: {
  contextSnapshot?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  reason?: string | null;
}): string[] {
  const context = input.contextSnapshot ?? {};
  const payload = input.payload ?? {};
  return [
    input.reason,
    readNonEmptyString(context.wakeReason),
    readNonEmptyString(context.prompt),
    readNonEmptyString(context.task),
    readNonEmptyString(context.instruction),
    readNonEmptyString(context.instructions),
    readNonEmptyString(context.userPrompt),
    readNonEmptyString(context.paperclipWake),
    readNonEmptyString(payload.prompt),
    readNonEmptyString(payload.task),
    readNonEmptyString(payload.instruction),
    readNonEmptyString(payload.instructions),
    readNonEmptyString(payload.userPrompt),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * Detect infrastructure intent from free-form task text (title/description/
 * reason). Returns the matched canonical signal names only — never the matched
 * substrings — so callers can log the result safely.
 */
export function detectDaasInfrastructureTaskIntent(
  ...texts: Array<string | null | undefined>
): DaasInfrastructureIntentResult {
  const haystack = texts
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  if (!haystack) return { isInfrastructureIntent: false, signals: [] };

  const signals: string[] = [];
  for (const { signal, patterns } of INFRASTRUCTURE_INTENT_SIGNALS) {
    if (patterns.some((pattern) => pattern.test(haystack))) {
      signals.push(signal);
    }
  }
  return { isInfrastructureIntent: signals.length > 0, signals };
}

export type DaasInfrastructureTaskDecision =
  | "allow_non_infrastructure"
  | "deny_requires_mission_route";

export interface DaasInfrastructureTaskGuardInput {
  title?: string | null;
  description?: string | null;
  reason?: string | null;
  instructionTexts?: Array<string | null | undefined>;
}

export interface DaasInfrastructureTaskGuardResult {
  allowed: boolean;
  decision: DaasInfrastructureTaskDecision;
  message: string | null;
  signals: string[];
  missionRoute: string;
}

/**
 * Central policy decision for whether a task may be dispatched for direct
 * execution. Fail-closed for infrastructure intent:
 *
 *   - non-infrastructure tasks always proceed;
 *   - infra tasks proceed ONLY when both routed through the mission API and the
 *   - infrastructure tasks are denied in heartbeat dispatch; the only governed
 *     path is the external DAAS mission handoff route, which does not create a
 *     Paperclip run.
 */
export function guardDaasInfrastructureTaskDispatch(
  input: DaasInfrastructureTaskGuardInput,
): DaasInfrastructureTaskGuardResult {
  const { signals, isInfrastructureIntent } = detectDaasInfrastructureTaskIntent(
    input.title,
    input.description,
    input.reason,
    ...(input.instructionTexts ?? []),
  );

  if (!isInfrastructureIntent) {
    return {
      allowed: true,
      decision: "allow_non_infrastructure",
      message: null,
      signals,
      missionRoute: DAAS_PAPERCLIP_MISSIONS_ROUTE,
    };
  }

  return {
    allowed: false,
    decision: "deny_requires_mission_route",
    message: DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE,
    signals,
    missionRoute: DAAS_PAPERCLIP_MISSIONS_ROUTE,
  };
}

/**
 * Resolve whether a dispatch context indicates the task was routed through a
 * server-issued DAAS mission. A generic mutable boolean is not accepted. T269
 * will mint this provenance from the real mission adapter route.
 */
export function isDaasMissionRoutedContext(
  context: Record<string, unknown> | null | undefined,
): boolean {
  if (!context) return false;
  const provenance = context[DAAS_MISSION_ROUTE_CONTEXT_KEY];
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return false;
  const record = provenance as Record<string, unknown>;
  return (
    record.route === DAAS_PAPERCLIP_MISSIONS_ROUTE &&
    typeof record[DAAS_MISSION_ID_CONTEXT_KEY] === "string" &&
    record[DAAS_MISSION_ID_CONTEXT_KEY].trim().length > 0
  );
}

export function stripDaasMissionProvenanceFromUntrustedContext<T extends Record<string, unknown>>(context: T): T {
  delete context[DAAS_MISSION_ROUTE_CONTEXT_KEY];
  delete context[DAAS_MISSION_ID_CONTEXT_KEY];
  return context;
}

export interface DaasInfrastructureTaskDenialLogContext {
  companyId?: string | null;
  agentId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  source?: string | null;
}

type MinimalLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Log a denied infra-task dispatch attempt WITHOUT any secret material. Only
 * non-secret identifiers, the decision, and the canonical signal names are
 * emitted — never the task title/description/reason text, which can contain
 * secrets.
 */
export function logDaasInfrastructureTaskDenial(
  log: MinimalLogger,
  input: {
    result: DaasInfrastructureTaskGuardResult;
    context?: DaasInfrastructureTaskDenialLogContext;
  },
): void {
  const { result, context } = input;
  log.warn(
    {
      event: "daas.infrastructure_task.denied",
      decision: result.decision,
      signals: result.signals,
      missionRoute: result.missionRoute,
      companyId: context?.companyId ?? null,
      agentId: context?.agentId ?? null,
      issueId: context?.issueId ?? null,
      projectId: context?.projectId ?? null,
      source: context?.source ?? null,
      securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
    },
    "DAAS blocked direct infrastructure task dispatch; route through DAAS mission API",
  );
}
