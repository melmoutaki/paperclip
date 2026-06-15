---
title: T275 — Paperclip Fork Acceptance (Phase 0B)
summary: Acceptance report and archived evidence for the limited-agent / DAAS-mission scenario
---

# T275 — Paperclip Fork Acceptance Report

**Task:** [T275] Pass Paperclip fork acceptance — a limited-permission Paperclip agent
creates a DAAS mission, cannot SSH directly, and receives a DAAS evidence link.

**Type:** Acceptance + minimal scoped fix. The originally-reported blocker was an
implementation defect (the limited-agent route dropped DAAS evidence links and URL validation
was scheme-only); this task lands the minimal, T275-scoped fix that closes it — route
exposure, a non-secret URL-safety contract, persistence, UI render, and fail-closed accepted
handoffs when DAAS does not return safe evidence — and adds focused tests. The acceptance is a
PASS for the Paperclip-fork contract.

**Fork base:** `melmoutaki/paperclip` `daas/patches` at `36536ae7`
(`T274 add DAAS fork security regression suite`).

**Verdict (M10 exit gate): PASS for the Paperclip-fork contract.** The third clause of the
acceptance scenario — *"receives a DAAS evidence link"* — was previously unprovable because
the limited-agent route dropped DAAS evidence links and no safe, schema-backed evidence-link
state was exposed. That gap is now closed by code in this branch:

- the limited-agent route `POST /api/integrations/paperclip/missions`
  (`server/src/routes/daas-integrations.ts`) now parses a **safe** DAAS evidence link in
  `handoffMissionToDaas` and exposes it as `evidenceUrl` on its accepted/surfaced responses;
- `PersistedDaasMissionState` carries an `evidenceUrl` field, persisted into
  `issue.executionState.daasMission` and re-validated on read;
- a **non-secret URL-safety contract** — configured DAAS origin, bounded evidence/proof path,
  absolute `http(s)` only, **no userinfo, no query string, no fragment** — is enforced in route parsing
  (`readSafeEvidenceUrl`), server persistence read-back, and the UI (`normalizeEvidenceUrl`),
  so a tampered persisted state cannot render a sensitive-material-bearing link;
- the existing T270 UI renders the link.

Focused tests pass for route exposure/omission, userinfo/query/fragment rejection,
persistence round-trip, and the UI render/drop. See
[Blocker — resolved](#blocker--daas-evidence-link-resolved).

**Verification status — focused checks passed.** The server focused suite, UI focused suite,
server typecheck, JSON parse, and `git diff --check` passed in this worktree.

**Prior regression coverage (per the fork patch series' GO gate records):** the existing
fork guardrails (mission routing, direct-access denial, no-proof/no-success, secret
redaction) are covered by the `GO`-gated tickets T256–T274 (see the
[traceability matrix](#traceability-matrix)). Those suites are not re-run here; this task
adds the evidence-link route/safety changes and their tests on top.

Archived evidence:

- [`evidence/T275/phase-0b-scenario.json`](./evidence/T275/phase-0b-scenario.json) — the
  redacted, synthetic Phase 0B walkthrough. Step 3's evidence-link sub-step is now marked
  **RESOLVED (code + focused tests)** and points at the real persisted field rather than a
  synthetic placeholder.
- [`evidence/T275/m10-exit-gate.json`](./evidence/T275/m10-exit-gate.json) — the M10
  exit-gate record, verdict **PASS**, with the resolved blocker, executed checks, and traceability.

All evidence is synthetic and redacted: secret material appears only as `<REDACTED_*>`
placeholders, and all hosts/ids (`daas.example.test`, `mis_daas_limited`, `agent-limited`)
are synthetic. Synthetic values are used only to illustrate route shape; they are **not**
treated as proof of any acceptance criterion.

---

## Scenario under test (Phase 0B)

A **limited-permission** Paperclip agent (`agent-limited`, `trustPreset: "limited"`)
handles an infrastructure request ("Restart nginx in production"). The acceptance aims to
prove that the fork (clauses 1, 2, 4, 5 have live regression coverage; **clause 3 is now
proven by focused live tests**):

1. lets the limited agent **create a DAAS mission** through the governed adapter route;
2. **denies** that same agent direct SSH, raw shell, and secret access;
3. treats **DAAS — not Paperclip — as the authoritative** final mission status source, and
   surfaces a **DAAS evidence link** to the limited agent
   (**now backed by a persisted `evidenceUrl` field + tests — see
   [Blocker — resolved](#blocker--daas-evidence-link-resolved-in-code-tests-authored)**);
4. preserves **no-proof/no-success**: an agent's success text cannot override missing or
   failing DAAS proof;
5. emits **no unredacted secrets** in any evidence;
6. resolves the **M10 exit gate** as pass/fail with traceability to the fork patch series.

---

## Acceptance results

> **Scope note.** AC1, AC2, AC4, and AC5 below are backed by **live regression coverage** on
> the base (cited tests pass, demonstrating no regression in the existing guardrails). AC3 —
> previously the controlling blocker — is now **resolved in code and proven by focused live tests in this branch**. See
> [Blocker — resolved](#blocker--daas-evidence-link-resolved-in-code-tests-authored).

### AC1 — Limited agent creates a DAAS mission via the adapter — PASS (regression coverage)

The limited agent `POST`s to `DAAS_PAPERCLIP_MISSIONS_ROUTE`
(`/api/integrations/paperclip/missions`). The route (`server/src/routes/daas-integrations.ts:134-220`):

- authenticates a scoped local agent JWT and requires JWT `company_id` / `sub`
  to match the body `companyId` / `agentId`, so the limited agent never receives
  the global Paperclip/DAAS shared secrets;
- requires the persisted agent to exist for `(agentId, companyId)` and have the
  low-trust review preset in `agents.permissions`;
- classifies infrastructure intent (`infra.orchestration`) and **rejects non-infra
  mission requests** with `400 infrastructure_mission_required` (`:160-164`);
- hands the mission off to DAAS using the **outbound** `DAAS_API_SHARED_SECRET`
  (`:62-70`) — this secret is server-side only and is not provided to the agent;
- returns `202 { missionId, status: "handoff_accepted", executionAuthority: "daas",
  paperclipRunId: null }` (`:214-219`).

`paperclipRunId: null` is the proof that **no internal Paperclip run was created** — the
mission is owned by DAAS. On every non-acceptance path the route still returns
`paperclipRunId: null` with the DAAS status surfaced (`:166-212`).

> Evidence: `phase-0b-scenario.json` step `1-create-mission`.
> Test: `daas-fork-security-regression.test.ts` → *"allows a limited Paperclip agent to
> create a DAAS mission without creating an internal run"*.

### AC2 — Same agent denied direct SSH, raw shell, secret access — PASS (regression coverage)

`guardDaasInfrastructureTaskDispatch` (`server/src/services/daas-infrastructure-task-guard.ts:250-277`)
is fail-closed: any infrastructure-intent text is `deny_requires_mission_route` with the
shared `DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE`. The three Phase 0B prompts map to:

| Prompt class | Signal | Decision |
| --- | --- | --- |
| direct SSH | `ssh.open` | `deny_requires_mission_route` |
| raw shell | `shell.execute` | `deny_requires_mission_route` |
| secret access | `secret.read` | `deny_requires_mission_route` |

Defense in depth across the fork:

- **Connectors:** all five dangerous SSH connectors report `enabled: false`, and
  `assertDaasForkHealthSafe` **throws** if any is overridden on
  (`server/src/daas-fork-health.ts:52-58, 128-140`).
- **Adapter types:** `process` and `http` adapter types are blocked, and
  `executionTarget: { transport: "ssh" }` / `dangerouslyBypassSandbox` config paths are
  flagged (`server/src/services/daas-infrastructure-guard.ts`,
  `packages/shared/src/constants.ts:118-131`).
- **UI:** `ui/src/adapters/daas-safety.ts` filters the same blocked adapter types and
  dangerous config fields out of the picker.

> Evidence: `phase-0b-scenario.json` step `2-deny-direct-access`.
> Tests: `daas-fork-security-regression.test.ts` → *"denies direct SSH, raw shell, and
> secret-intent tasks outside the DAAS mission route"*, *"blocks raw process/http
> infrastructure adapters and dangerous execution config"*, *"asserts telemetry and
> dangerous connectors are disabled in the fork health check"*.

### AC3 — DAAS is the authoritative final mission status source + evidence link — PASS

**Status authority (proven as regression coverage):**
`buildDaasMissionExecutionState` (`server/src/services/daas-mission-adapter.ts`)
persists `executionAuthority: "daas"` and `daasInternalExecution: "disabled"`, and sets the
server-minted DAAS-route provenance key **only when `missionWasAcknowledged`** (a real
`missionId`, `routed_accepted`, `ok`, and a safe `evidenceUrl`). The UI
(`ui/src/lib/daas-mission-output.ts:95-116`) returns `null` unless
`executionAuthority === "daas"`. A surfaced DAAS status
(`blocked_by_policy` / `rejected` / `failed`) sets the issue `status: "blocked"`.

**Evidence-link receipt — closed in code by the T275-scoped fix in this branch:**

- **Limited-agent route now exposes the link.** `handoffMissionToDaas`
  (`server/src/routes/daas-integrations.ts`) parses a safe DAAS evidence link via
  `parseDaasEvidenceUrl`, and `POST /api/integrations/paperclip/missions` returns it as
  `evidenceUrl` on accepted (`202`) responses and persists the mission/evidence state to the
  issue when `issueId` is supplied. If DAAS reports an accepted mission without a
  safe evidence link, Paperclip fails closed with `daas_mission_evidence_required` and does not
  record accepted DAAS-route provenance. Surfaced-failure responses may include a safe
  `evidenceUrl` for operator/audit context but remain non-ok.
- **Non-secret URL-safety contract.** `readSafeEvidenceUrl`
  (`server/src/services/daas-mission-adapter.ts`) accepts **only** an absolute `http(s)` URL
  from the configured DAAS origin with a bounded evidence/proof path and **no userinfo, no query
  string, and no fragment**, and **fails closed** on `javascript:` / `file:` / `data:` /
  relative / non-string values, cross-origin URLs, path-token URLs, and userinfo-, query-,
  or fragment-bearing URLs. The same contract is mirrored in the UI (`normalizeEvidenceUrl`) so
  a tampered persisted state cannot render a sensitive-material-bearing link.
- **Schema field + persistence.** `PersistedDaasMissionState` carries
  `evidenceUrl: string | null`; accepted states require a non-null safe value before `ok` or
  route provenance can be set. `postInfrastructureTicketToDaasAdapter` →
  `summarizeDaasMissionRouting` → `buildDaasMissionExecutionState` persist it into
  `issue.executionState.daasMission`, and `readDaasMissionState` re-validates it with
  `readSafeEvidenceUrl` on read (so even a tampered stored value is re-checked).
- **UI render.** With the backend populating it, the **"DAAS evidence"** `<a>` in
  `DaasMissionStatusCard.tsx:56-63` renders from real persisted state.

This is now a schema-backed, assertable path. The focused tests below were executed in this
worktree and passed. The evidence-link clause is a **PASS**.

> Evidence: `phase-0b-scenario.json` step `3-daas-authoritative-status` (evidence-link
> sub-step marked **PASS**).
> Tests (executed and passing): route — `daas-integrations.test.ts` → *"exposes a
> safe DAAS evidence link on the limited-agent mission route"*, *"omits an unsafe DAAS
> evidence link with a query param from the route response"*, plus `handoffMissionToDaas`
> → *"returns a safe DAAS-provided evidence url on the accepted path"* / *"omits an unsafe
> DAAS evidence url (userinfo), failing closed"*. Adapter/persistence —
> `daas-mission-adapter.test.ts` → *"captures a DAAS-provided http(s) evidence url from an
> accepted response"*, *"omits an unsafe (non-http(s)) DAAS evidence url, failing closed"*,
> *"captures a surfaced mission's evidence url from the links/evidence shape"*, *"persists a
> DAAS evidence url into executionState.daasMission for the UI to render"*, *"omits an unsafe
> DAAS evidence url from the persisted mission state"*, plus the `parseDaasEvidenceUrl` unit
> block including *"rejects http(s) urls carrying userinfo, query, or fragment components"*.
> UI — `DaasMissionStatusCard.test.tsx` → *"surfaces a persisted DAAS
> evidence url"* / *"returns null evidence when none was persisted"* / *"drops a tampered
> unsafe evidence url (userinfo, query, or fragment)"* / render + no-render cases.

### AC4 — No-proof / no-success — PASS (regression coverage)

`DaasMissionAdapterDispatchResult.ok` (`server/src/services/daas-mission-adapter.ts:228-338`)
is `true` **only** when DAAS returns an accepted/running status **and** a non-empty mission
id **and** `response.ok` **and** the response envelope is not `ok: false`. The `faked` field
is the literal `false` on every return path; the module never fabricates success. Failing /
absent proof is surfaced verbatim, never papered over:

| Condition | `ok` | `outcome` |
| --- | --- | --- |
| success-shaped text but no mission id | `false` | `handoff_failed` |
| `blocked_by_policy` / `rejected` / `awaiting_approval` | `false` | `routed_surfaced` |
| envelope `ok: false` | `false` | `handoff_failed` |
| adapter unreachable / token absent / timeout | `false` | `adapter_unavailable` |

An agent's own claimed success text is never an input to `ok` — only the DAAS-returned
status and mission id are.

> Evidence: `phase-0b-scenario.json` step `4-no-proof-no-success`.
> Tests: `daas-mission-adapter.test.ts` → *"does not treat success as accepted without DAAS
> evidence proof"*, *"surfaces blocked_by_policy / rejected / awaiting_approval without
> faking success"*, *"fails closed when DAAS accepts without returning a mission id"*,
> *"fails closed when the DAAS response envelope explicitly says ok false"*.

### AC5 — Evidence contains no unredacted secrets — PASS (regression coverage)

- The inbound route uses a scoped local agent JWT; the outbound DAAS shared secret
  stays server-side and travels only in the `x-paperclip-webhook-secret` header
  (`daas-mission-adapter.ts:252-263`).
- Denial decision objects exclude the raw prompt text — only canonical **signal names**
  are retained (`daas-infrastructure-task-guard.ts:166-168, 232-277`).
- Denial logs emit signal names only, never the matched substring (`:322-345`).
- This report and both evidence files use `<REDACTED_*>` placeholders and synthetic
  hosts/ids throughout.

> Evidence: `phase-0b-scenario.json` step `5-no-unredacted-secrets`.
> Test: `daas-fork-security-regression.test.ts` → *"keeps provider context free of raw
> secrets while routing secret-intent work to DAAS"*.

### AC6 — M10 exit gate is pass/fail with traceability — PASS

The M10 exit gate is recorded as **PASS for the Paperclip-fork contract**: the controlling
blocker (limited-agent route dropping evidence links; scheme-only URL validation) is fixed in
this branch and covered by focused tests against real route/persisted/UI state rather than a
synthetic placeholder. The focused server suite, UI suite, server typecheck, JSON parse, and
diff check passed in this worktree. The gate record carries the resolved blocker, the executed
checks, the code/test references, and the traceability matrix so the decision is itself
inspectable.
See [`evidence/T275/m10-exit-gate.json`](./evidence/T275/m10-exit-gate.json) and the
[traceability matrix](#traceability-matrix) below.

---

## Traceability matrix

Nine DAAS fork patch tickets landed on `daas/patches`, each with a `GO` gate record under
`.gate/records/`. Every Phase 0B acceptance criterion traces to at least one:

| Ticket | Gate | Title (abbrev.) | Backs AC |
| --- | --- | --- | --- |
| T256 | GO | DAAS AgentOps permission guardrails | AC2 |
| T257 | GO | Hide/deny direct SSH, raw shell, secret connectors | AC2 |
| T258 | GO | Policy guard → mission route required | AC1, AC2 |
| T259 | GO | Disable telemetry / non-required outbound | AC5 |
| T260 | GO | Fork health: telemetry + dangerous-connector state | AC2 |
| T261 | GO | DAAS sidecar Compose deployment | (deployment) |
| T269 | GO | Route infra tickets through DAAS adapter, no internal exec (T275 follow-up: evidence-link capture/persist) | AC1, AC3, AC4 |
| T270 | GO | UI: DAAS mission status + evidence link authoritative (now fed by real persisted field) | AC3 |
| T274 | GO | Fork security regression test suite | AC1–AC5 |

**Range note (honest traceability):** the task names the milestone range *T251–T274*.
Tickets **T251–T255, T262–T268, T271–T273** are **not present** in this Paperclip fork
(no commits, no gate records). They are DAAS-control-plane or planning tickets outside the
Paperclip-fork boundary. This is recorded as a traceability note, not a fork blocker.

### DAAS regression test inventory

8 DAAS test files, 93 test cases (by static `it(` count). The T275
evidence-link route/safety work adds cases to the three starred files below:

| File | Cases |
| --- | --- |
| `daas-mission-adapter.test.ts` ★ | 39 |
| `daas-integrations.test.ts` ★ | 20 |
| `daas-infrastructure-task-guard.test.ts` | 12 |
| `daas-fork-security-regression.test.ts` | 6 |
| `daas-infrastructure-guard.test.ts` | 5 |
| `ui/.../DaasMissionStatusCard.test.tsx` ★ | 5 |
| `daas-fork-health.test.ts` | 3 |
| `daas-infrastructure-intent-texts.test.ts` | 3 |

---

## Commands executed

These focused checks were executed in the T275 worktree and passed.

From this checkout:

```sh
COREPACK_HOME=/tmp/corepack XDG_DATA_HOME=/tmp/xdg-data PNPM_HOME=/tmp/pnpm-home \
  npm_config_cache=/tmp/npm-cache npm_config_devdir=/tmp/node-gyp \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store

# Server: evidence-link parsing + persistence (new tests) + existing regression set
COREPACK_HOME=/tmp/corepack XDG_DATA_HOME=/tmp/xdg-data PNPM_HOME=/tmp/pnpm-home \
  npm_config_cache=/tmp/npm-cache VITEST_CACHE_DIR=/tmp/paperclip-server-vitest-cache \
  pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/daas-fork-security-regression.test.ts \
  src/__tests__/daas-fork-health.test.ts \
  src/__tests__/daas-integrations.test.ts \
  src/__tests__/daas-mission-adapter.test.ts \
  --configLoader runner --pool=forks --fileParallelism=false --reporter=verbose

# UI: DAAS evidence-link render from real persisted state
COREPACK_HOME=/tmp/corepack XDG_DATA_HOME=/tmp/xdg-data PNPM_HOME=/tmp/pnpm-home \
  npm_config_cache=/tmp/npm-cache VITEST_CACHE_DIR=/tmp/paperclip-ui-vitest-cache \
  pnpm --filter @paperclipai/ui exec vitest run \
  src/components/issue-output/IssueOutputSection.test.tsx \
  src/components/issue-output/DaasMissionStatusCard.test.tsx \
  --configLoader runner --reporter=verbose

# Typecheck (server changed)
COREPACK_HOME=/tmp/corepack XDG_DATA_HOME=/tmp/xdg-data PNPM_HOME=/tmp/pnpm-home \
  npm_config_cache=/tmp/npm-cache \
  pnpm --filter @paperclipai/server typecheck
```

Results:

- Server focused set: **PASS** — 4 files, 88 tests.
- UI focused set: **PASS** — 2 files, 16 tests.
- Server typecheck: **PASS**.
- JSON parse for `docs/daas/evidence/T275/*.json`: **PASS**.
- `git diff --check`: **PASS**.

The server focused set covers route exposure of `evidenceUrl`, preservation of
existing execution state while adding DAAS provenance, scoped agent JWT
authorization, persisted limited-agent authorization with spoofed
request-permission rejection, mandatory issue id / issue existence / issue assignee checks before DAAS handoff,
Docker-provided frontend DAAS origin configuration,
stable limited-route mission ids and DAAS idempotency keys for duplicate requests,
non-2xx accepted-looking DAAS adapter responses and persisted accepted states failing closed,
omission of cross-origin/wrong-mission/path-token/userinfo/query/fragment-bearing URLs,
limited-route persistence, persistence round-trip of safe URLs, and rejection of unsafe
URLs. The UI focused set covers `IssueOutputSection` and `DaasMissionStatusCard` link render, no-link state, configured non-example DAAS origins, fail-closed behavior when no frontend DAAS base is configured, and tampered unsafe URL drops.

---

## Blocker — DAAS evidence-link (RESOLVED)

**Status:** the originally-reported blocker is **resolved** by the T275-scoped fix in
this branch. The scenario clause *"the limited agent receives a DAAS evidence link"* is now
backed by limited-agent route exposure, a non-secret URL-safety contract, schema-backed
persistence, UI consumption, and focused tests — i.e. it is assertable rather than synthetic.
The focused suite passed in this worktree.

**Original root cause (now fixed):**

1. **Route dropped evidence links → fixed.** `handoffMissionToDaas`
   (`server/src/routes/daas-integrations.ts`) parses a safe evidence link and the limited-agent
   route `POST /api/integrations/paperclip/missions` exposes it as `evidenceUrl`. Previously
   evidence handling existed only in `daas-mission-adapter.ts`, not on this route.
2. **Scheme-only URL validation → fixed.** `readSafeEvidenceUrl` now requires an absolute
   `http(s)` URL from the configured DAAS origin, under the returned mission id
   path (`/missions/<mission-id>/evidence|proof|e`), with **no userinfo, no
   query string, and no fragment**, failing closed on userinfo-, query-,
   fragment-, cross-origin-, wrong-mission-, and extra-path-token URLs as well
   as `javascript:`/`file:`/`data:`/relative/non-string. The UI
   `normalizeEvidenceUrl` mirrors it and requires `VITE_DAAS_BASE_URL`.
3. **Schema + persistence.** `PersistedDaasMissionState` has `evidenceUrl: string | null`;
   `postInfrastructureTicketToDaasAdapter` → `summarizeDaasMissionRouting` →
   `buildDaasMissionExecutionState` persist it; `readDaasMissionState` re-validates on read.
4. **UI render.** With the backend populating it, the **"DAAS evidence"** link in
   `DaasMissionStatusCard.tsx:56-63` renders from real persisted state; tests cover render,
   no-render, and drop-on-unsafe. No synthetic placeholder is used.

**Scope discipline:** the change is confined to evidence-link capture/persistence/render and
its tests. No guardrail, routing, secret-handling, or status-authority behavior was altered;
`faked`/no-proof-no-success semantics are unchanged; `ok` and DAAS-route provenance now also
require a safe evidence URL.

**Remaining ownership / follow-ups:**

| Item | Owner | Status |
| --- | --- | --- |
| Expose evidence link on the limited-agent route | **T275** (this branch) | **Done** — `daas-integrations.ts`: `handoffMissionToDaas` parses, route returns `evidenceUrl`. |
| Capture & persist DAAS-provided evidence link | **T269 follow-up** (mission adapter) | **Done in this branch** (`daas-mission-adapter.ts`: `parseDaasEvidenceUrl`, `evidenceUrl` field, persistence + read-back). |
| Non-secret URL-safety contract (no userinfo/query/fragment) | **T275** (this branch) | **Done** — `readSafeEvidenceUrl` (server, route + persistence) and `normalizeEvidenceUrl` (UI). |
| Wire UI to the real persisted field | **T270 follow-up** (work-product UI) | **Done in this branch** (UI consumes `mission.evidenceUrl`; render covered by `DaasMissionStatusCard.test.tsx`). |
| Execute the focused suite green | **T275** (this worktree) | **Done** — server suite 88/88, UI suite 16/16, server typecheck passed. |

> The Paperclip-side route exposure, persistence, URL-safety, and UI wiring are complete and
> test-covered. The acceptance is a **PASS for the
> Paperclip-fork contract**; accepted DAAS handoffs without safe evidence fail closed.

---

## Limitations

- The archived walkthrough (`phase-0b-scenario.json`) is deterministic and redacted; it
  references exact route behavior, tests, and gate records without storing real hosts or secret
  material. For the evidence-link criterion (AC3) it points at the **real persisted field and
  fail-closed route behavior** covered by tests.
- This task **did** change production code — scoped to evidence-link route exposure
  (`server/src/routes/daas-integrations.ts`), the non-secret URL-safety contract and
  persistence (`server/src/services/daas-mission-adapter.ts`), and the UI render/safety
  contract (`ui/src/lib/daas-mission-output.ts`) — plus tests.
- The focused tests passed in this worktree; the validator gate remains the required
  independent sign-off before merge.
