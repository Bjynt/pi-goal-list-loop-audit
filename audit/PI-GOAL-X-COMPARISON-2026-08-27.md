# pi-goal-x comparative learning audit — 2026-08-27

## Scope and conclusion

This is a read-only research comparison, not an adoption proposal. The source
was cloned fresh from upstream after the user requested that recent work be
included. The report compares the complete repository surface—runtime and
state, lifecycle/recovery, auditing, commands/UX, tests, documentation, and
packaging—with GLLA. Findings are labeled **transferable**, **already covered**,
**caution/avoid**, or **unresolved**. No pi-goal-x files were changed and no
GLLA runtime or test implementation was changed.

**Overall:** pi-goal-x's recent work contains a few useful, focused patterns,
not a replacement architecture for GLLA. The highest-value lessons are bounded
checkpoint markers with authoritative state injected once, strict terminal-line
verdict parsing with payload escaping, and a real local-provider E2E fixture.
GLLA is already stronger in detached auditor isolation, durable recovery,
ownership fencing, and operational status evidence. Its simpler storage-health
repair surface is also worth studying, but requires adaptation to `.pi-glla`.

## Fresh-source provenance

- **Remote:** `https://github.com/tmonk/pi-goal-x.git`
- **Fresh clone:** `/tmp/pi-goal-x-fresh-audit-Y2dBBX/repo`
- **Branch:** `main`
- **HEAD:** `59826ec818aa8883329a74c62000d18aa1e1dbfe` (`v0.30.5`, 2026-08-25)
- **Recent history inspected:** `59826ec` release 0.30.5; `51f8810` provider
  abort/429 recovery; `ea9b9a2` release 0.30.4; `70c27cd` live-pi network
  recovery E2E; `926a46c` release 0.30.3; `f178e38` release 0.30.2;
  `18473b8` and `52e77ea` README updates.
- **Recent tags inspected:** `v0.30.5`, `v0.30.4`, `v0.30.3`, `v0.30.2`,
  `v0.30.1`, `v0.30.0`, `v0.29.0`, `v0.28.0`, `v0.27.5`.

## Coverage map

| Surface | Fresh pi-goal-x evidence | GLLA comparison |
|---|---|---|
| Runtime/state/persistence | `extensions/goal-state.ts`, `goal-service.ts`, `storage/goal-files.ts`, `storage/goal-lock.ts` | `extensions/goal-state.ts`, `extensions/loops/goal-orchestrator.ts`, `storage/goal-lock.ts` |
| Lifecycle/recovery | `extensions/goal-runtime.ts`, `goal-events.ts`, `network-error-backoff.ts` | `extensions/goal-continuation.ts`, `goal-recovery.ts`, `main-model-recovery.ts` |
| Auditor/verification | `extensions/goal-auditor.ts`, `goal-completion.ts` | `extensions/goal-loop-auditor.ts`, `goal-loop-auditor-process.ts`, `goal-loop-shield.ts` |
| Commands/UX | `extensions/goal-commands.ts`, `extensions/widgets/*` | `extensions/loops/goal-activation.ts`, `goal-loop-display.ts`, `goal-agents-panel.ts` |
| Tests | `tests/goal-network-recovery.test.ts`, dashboard/golden tests, `tests/e2e/*` | `tests/auditor-process.test.ts`, status/recovery/provider tests, `scripts/smoke.sh` |
| Documentation | `README.md`, `docs/architecture.md`, `docs/agentic-runtime-prd.md`, `CHANGELOG.md` | `README.md`, `docs/DESIGN.md`, `audit/`, `CHANGELOG.md` |
| Packaging/release | `package.json`, `scripts/run-unit-tests.mjs`, `.github/workflows/ci.yml` | `package.json`, `docs/RELEASING.md`, `.github/workflows/publish.yml` |

## Runtime, state, persistence, lifecycle

### Transferable: bounded checkpoint markers

pi-goal-x persists one small v2 checkpoint marker (≤160 characters) and injects
the authoritative goal prompt once at `before_agent_start`
(`extensions/goal-events.ts:37-101,347-386`; `extensions/prompts/goal-prompts.ts:10-38`).
This directly limits session-message growth while retaining a deterministic
re-anchor point. GLLA still sends the full resync plus continuation prompt in
each follow-up (`extensions/goal-continuation.ts:1069-1074,1204-1365`); its
context hygiene removes images and old error-only turns but does not eliminate
repeated goal prompts (`extensions/loops/goal-activation.ts:2466-2510`).

**Learning:** measure GLLA session growth first, then consider adopting only the
bounded-marker/prompt-injection shape. Preserve GLLA's generation, owner,
consent, stale-context, and explicit cold-resume gates.

### Transferable: one mutation boundary and revision conflict semantics

The fresh service orders reconcile → validate → clone → write → ledger →
memory commit (`extensions/goal-service.ts:99-112,410-444`), with per-goal
locks and typed revision conflicts (`storage/goal-lock.ts:1-111`). GLLA has
transaction journaling and per-goal locks (`extensions/goal-loop-core.ts:1514-1562`;
`storage/goal-lock.ts:2-10`) but still has separate active-goal writes and
ledger calls (`extensions/loops/goal-orchestrator.ts:746-774`; 
`extensions/goal-loop-core.ts:1490-1509`).

**Learning:** a single typed mutation service could reduce crash windows and
make cross-process conflicts clearer. This is an architectural candidate,
not a reason to transplant pi-goal-x storage formats.

### Transferable: durable draft recovery

pi-goal-x persists unconfirmed drafts as `pi-goal-draft` entries and rehydrates
them across compaction/tree navigation (`extensions/goal-drafting.ts:19-114`).
GLLA drafting state is in memory and is cleared on shutdown/rebind
(`extensions/loops/goal-ui.ts:375-386`; `extensions/loops/goal-activation.ts:1084-1086,1172-1175`).

**Learning:** a durable, generation-fenced draft could improve recovery of an
in-progress confirmation. It must not bypass GLLA's user-confirmation floor.

### Already covered: continuation and recovery foundations

pi-goal-x deduplicates continuation timers and waits for idle/pending-message
state (`extensions/goal-runtime.ts:61-101`). GLLA adds generation and owner
fences, durable dispatch records, exact-payload retry, and start-proof watchdogs
(`extensions/goal-continuation.ts:456-590,757-816`; `extensions/goal-loop-dispatch.ts:20-157`).
The fresh runtime distinguishes user abort from provider failure
(`extensions/goal-events.ts:170-185,481-565`), while GLLA already has durable
main-model recovery, fallback selection, error brakes, and detached-auditor
recovery (`extensions/goal-recovery.ts:267-268,506-667,742-750,1353-1384`;
`extensions/loops/goal-activation.ts:1771-1813,2044-2065`).

### Caution/avoid: startup continuation and unbounded retry

Do not copy pi-goal-x's unconditional startup continuation
(`extensions/goal-events.ts:281-324`) over GLLA's explicit consent and load-hold
gates (`extensions/loops/goal-activation.ts:1382-1461,1744-1766`). Do not copy
its default-unbounded 5/10/20/40/80-second network ladder
(`extensions/network-error-backoff.ts:1-44`); GLLA intentionally bounds
zero-stream recovery and retains manual holds.

## Auditor, verification, and provider handling

### Transferable: strict terminal-line verdict protocol and escaping

The fresh auditor accepts a verdict only from the final non-empty line and
escapes XML-like delimiters in objective, claims, contract, task, and warm
context (`extensions/goal-auditor.ts:50-70,120-235`). This reduces both prose
false positives and prompt-boundary ambiguity.

GLLA's parser currently reads the last block that mentions a tag rather than
requiring the final non-empty line (`tests/audit-verdict.test.ts`, test named
`verdict read from LAST block`). GLLA does have stronger detached execution,
unsupported-tool rejection, tool-use floors, raw-evidence requirements, and
per-contract-item regression shielding (`extensions/goal-loop-auditor-process.ts`;
`extensions/goal-loop-shield.ts:8-12,145-179`).

**Learning:** the terminal-line rule and delimiter escaping are worthwhile
protocol hardening. Do not trade away GLLA's evidence and regression-shield
requirements when borrowing them.

### Already covered: independent audit isolation and durable recovery

pi-goal-x runs an in-process auditor with transient abort state
(`extensions/goal-completion.ts:235-322,405-412`; `goal-record.ts:1-57`). GLLA
uses a detached, extension-less worker with atomic protocol files, identity and
revision checks, process-group termination, wall/tool/stall bounds, and
infrastructure-versus-semantic verdict classification
(`extensions/goal-loop-auditor-process.ts`; `scripts/goal-auditor-worker.mjs`;
`extensions/goal-loop-auditor.ts`). The fresh design is a useful baseline, but
not an upgrade to GLLA's audit safety model.

### Unresolved: prompt payload escaping

The fresh clone escapes interpolated auditor payloads; GLLA's auditor prompt
still interpolates `<goal>`, `<completion_summary>`, and
`<verification_contract>` in `extensions/goal-loop-auditor.ts` without the same
delimiter escaping. This is the clearest auditor-specific hardening candidate,
subject to preserving exact verdict and evidence tests.

### Already covered, with a useful test lesson: provider recovery

Recent pi-goal-x commits `51f8810`, `70c27cd`, and `926a46c` add exact 429/503
fixtures, provider-side `stopReason:"aborted"` versus user Esc handling, settle
ordering, quota exclusions, and a local HTTP provider E2E
(`tests/goal-network-recovery.test.ts`; `tests/e2e/network-recovery-rpc.test.ts`).
GLLA already has broader structured error normalization, durable recovery,
forbidden/unregistered-model filtering, a finite zero-stream budget, and
provider-pane/recovery tests (`scripts/goal-auditor-worker.mjs`;
`extensions/main-model-recovery.ts:14-20,84-99,195-198`;
`tests/uniform-provider-retry.test.ts`, `tests/post-accept-hang-retry.test.ts`).

**Learning:** reuse the exact provider event-order fixtures if adding coverage;
do not adopt pi-goal-x's text-trust or default-unbounded retry policy.

### Caution/avoid: weak or unbounded recovery assumptions

The fresh classifier omits generic HTTP 500 forms and relies heavily on
`errorMessage` (`extensions/goal-format.ts:232-295`). Its retry timers/counters
are runtime-local (`extensions/network-error-backoff.ts:8-24,44-54`) and its
network recovery is unbounded by default. GLLA's structured status extraction,
generation fencing, durable recovery state, and bounded horizon are safer
boundaries.

## Commands, UX, and status surfaces

### Transferable: shared dashboard view-model and durable current task

pi-goal-x derives compact/expanded widgets, `/goal-status`, task focus, and
ledger activity from one dashboard model (`extensions/widgets/goal-dashboard-model.ts:1-8,220-279,462-530`).
It persists and validates `currentTaskId` for consistent current-task display.
GLLA has strong pure status/widget builders and an operational worker roster,
but generally derives the next pending task and recent action ring directly
(`extensions/goal-loop-display.ts:796-816,1072-1140,1589-1609`;
`extensions/goal-continuation.ts:1207-1213`).

**Learning:** a shared presentation view-model and durable current-task field
could make status surfaces more consistent. This is a presentation/data-model
candidate, not a reason to simplify GLLA's richer status vocabulary.

### Transferable: real local-provider E2E fixture

The fresh local HTTP fixture returns exact 503 and OpenRouter-shaped 429
payloads, drives real `pi --mode rpc`, and verifies recovery notifications and
checkpoint delivery (`tests/e2e/network-recovery-rpc.test.ts:2-16,52-77,80-130,196-238,255-270`).
GLLA has extensive mocks and tmux smoke but no equivalent release-runnable
local-provider event-shape test in its normal gate (`scripts/smoke.sh:1-15`).

**Learning:** a deterministic local provider fixture is a high-value test
pattern; keep it opt-in or release-gated with an explicit runtime prerequisite.

### Already covered: lifecycle controls and operational status

The fresh individually registered command palette is discoverable
(`extensions/goal-commands.ts:733-828`), but GLLA's `/goal` subcommands plus
`/list`, `/loop`, `/glla`, and `/review` cover the same lifecycle controls and
more (`extensions/loops/goal-activation.ts:690-778`). GLLA's status surfaces
also include worker evidence, queue/recovery ownership, supervisor freeze,
stale-host state, auditor phases, and subagent projections
(`extensions/goal-loop-display.ts:816-1042`; `CHANGELOG.md:94-104`), beyond
pi-goal-x's simple running/paused/blocked vocabulary.

### Caution/avoid: heuristic dashboards and conditional E2E claims

pi-goal-x's percentage-based auditor dashboard is presentation-only and can
mark stages passed from heuristic percentages
(`extensions/widgets/auditor-dashboard-model.ts:31-120`). Its E2E runner
skips when `pi` is absent (`tests/e2e/network-recovery-rpc.test.ts:255-270`),
so “E2E” is conditional evidence, not automatically a release guarantee.

## Documentation, testing, and packaging

### Already covered: broader GLLA product and release surface

pi-goal-x has a simpler regular/Sisyphus product shape and per-goal `.pi/goals`
files (`README.md:32-46`). GLLA deliberately owns `/goal`, `/list`, and
`/loop` with stronger consent and recovery policy (`README.md:121-192`). Its
independent auditor remains more isolated and its release path includes tagged
GitHub Release, version/tag checks, npm provenance, and registry verification
(`docs/RELEASING.md:18-62`; `.github/workflows/publish.yml:41-91`). MIT versus
AGPL is a licensing choice, not a defect to reconcile
(`package.json:2-47`; GLLA `package.json:2-55`).

### Transferable: manifest and quality-gate discipline

The fresh repository has categorized Node test discovery, a committed manifest
self-check, lint, npm audit, and benchmark gates (`scripts/run-unit-tests.mjs:15-99`;
`.github/workflows/ci.yml:11-42`). GLLA has broader behavioral coverage and a
live tmux harness, but its package scripts do not have the same manifest-drift,
lint, and audit separation (`tests/README.md:1-78`; `package.json:50-56`).

**Learning:** a manifest self-check is a low-risk quality improvement. Lint and
npm audit should remain separate policy decisions because they may add release
noise or dependency-policy constraints.

### Caution/avoid: stale or aspirational documentation

The fresh README's “curated twelve” command comment is stale relative to its
sixteen registered commands (`extensions/goal-commands.ts:733-828`). Its
agentic-runtime PRD is explicitly historical and partly superseded
(`docs/agentic-runtime-prd.md:1-12`). Treat docs and changelog claims as
artifacts to validate against code and tests, not as proof by themselves.

## Prioritized GLLA follow-up list (research only)

These are learning candidates, not approved implementation work:

1. **High — measure session growth, then assess bounded checkpoint markers.**
   Confirm whether repeated continuation prompts materially grow GLLA session
   files before changing the protocol. If the defect is real, preserve
   authoritative state injection, generation/owner fences, and cold-resume
   consent.
2. **High — add a local-provider event-shape fixture.** Reuse exact 503/429 and
   provider-abort/settle-order cases from `tests/e2e/network-recovery-rpc.test.ts`,
   while retaining GLLA's bounded recovery and structured diagnostics.
3. **Medium — harden GLLA auditor payload boundaries.** Consider delimiter
   escaping and strict final non-empty-line verdict parsing; retain tool-use
   floors, raw evidence, regression shielding, `<impossible>`, and detached
   infrastructure handling.
4. **Medium — consider a shared dashboard view-model/current-task field.** Add
   only if a concrete consistency defect is measured; do not simplify GLLA's
   richer worker/recovery status model.
5. **Medium — evaluate a storage-health report/repair surface.** Adapt
   pi-goal-x's malformed-file, malformed-ledger, stale-lock, and orphan checks
   to `.pi-glla`, `audit-jobs`, queue sidecars, and ownership fences; require
   confirmation and backups for repair.
6. **Low — consider a test-manifest self-check.** Keep live/model tests
   explicitly conditional and avoid weakening the existing release gates.
7. **Low — review wildcard peer dependencies and stale plan pointers.** This is
   compatibility/release hygiene, not evidence that pi-goal-x's license or
   architecture should be adopted.

## Explicit non-adoption boundary

This report does not modify GLLA runtime, tests, scripts, package metadata, or
pi-goal-x. It does not adopt pi-goal-x's storage format, startup continuation,
unbounded retry, in-process auditor, heuristic dashboard, or licensing model.
Any follow-up above requires a separate scoped goal with its own contract.
