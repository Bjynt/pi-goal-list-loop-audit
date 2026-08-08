# v0.34.93 — Forbidden-models gate on main-model fallback + recovery-probe target resolution

## Why

The auditor fallback chain (`resolveAuditorModel`, v0.34.72) consulted
`isForbiddenModel` before rotating. The main-model fallback chain
(`tryMainModelFallback` + `probeMainModelRecovery` target resolution)
did not — the gate existed but the recovery envelope didn't apply it.

### Field evidence (2026-08-08)

- **Screenshot_20260808_083612** — *we switched model to anthropic that
  is a mistake. this could be a very costly importu decision. I think
  it should be disallowed.* The session was running on
  `minimax/MiniMax-M3`; the active stream was Anthropic; the chat
  showed dozens of "Anthropic stream ended without a stop reason"
  errors stacked up; the bottom status line still read
  `(minimax) MiniMax-M3 · high`. The user's intent: any path that
  lands on a forbidden model is too costly to allow, even briefly.

The session model in `endless-td` was `minimax/MiniMax-M3`. The
forbidden list (default policy) is `["gpt-5.5", "sonnet", "opus"]`.
The forbidden list SHOULD catch `claude-sonnet-4-5` (substring match
on "sonnet"). The reason the rotation happened anyway is the missing
gate in the recovery envelope: `tryMainModelFallback` iterates
`mainModelFallbackRefs` and calls `extensionApi?.setModel(candidate)`
directly, with no `isForbiddenModel` check. `observeModelChange`
(the `model_select` event hook that fires AFTER `setModel`) IS wired
with the gate, but the rotation path bypassed that event stream —
either because pi fires `model_select` synchronously and
`observeModelChange` reverted, but the session kept the rotated
model for the rest of the stream anyway, or because the rotation
happened mid-turn after `before_agent_start` had already fired and
the turn-boundary observer missed it.

The user said "disallowed" — meaning the gate must run BEFORE the
provider call, not after.

## What changed

### `tryMainModelFallback` (`extensions/loops/goal.ts:2867`)

Before: iterates `mainModelFallbackRefs`, picks the first
`nextUntriedModelRef(current, refs, recovery.attempted)`, calls
`resolveMainModel(ctx, candidateRef)`, then
`extensionApi?.setModel(candidate)`.

After: between `recovery.attempted.push(candidateRef)` and
`resolveMainModel`, consult `isForbiddenModel(candidateRef, loadSettings(ctx.cwd).forbiddenModels)`.
Forbidden refs are silently skipped — one
`forbidden_model_fallback_blocked` ledger entry per skip — and the
loop continues to the next candidate.

If every configured candidate is forbidden, the loop exits with
`!candidateRef`, recovery fails-closed, and the probe retries the
current model itself per the existing no-target branch. The recovery
envelope still parks the goal — the user just sees the normal
"recovery is waiting" status, not a special "no allowed backup"
message. That's the right behavior: a quota window with no allowed
backup IS a wait, not a switch.

### `probeMainModelRecovery` target resolution (`extensions/loops/goal.ts:3109`)

Before: `const target = refs.find((ref) => ref !== current);` where
`refs = [recovery.primary, ...mainModelFallbackRefs(ctx)]`.

After: `refs.find((ref) => ref !== current && !isForbiddenModel(ref, forbiddenList))`.
If the picked target would have been forbidden, log
`forbidden_model_fallback_blocked` and fall through to the no-target
branch (which retries the current model).

### Why this is better than the existing `observeModelChange` revert

`observeModelChange` (the `model_select` event hook) IS the
backup-of-last-resort: it fires AFTER `setModel`, sees the
forbidden target, emits a `forbidden_model_switch` ledger entry,
and (if `blockForbiddenModelSwitches` is on, default) calls
`extensionApi?.setModel(previous)` to revert. The cost of relying on
it alone:

- **One wasted provider call.** `setModel` triggers a fresh auth
  check, model registration lookup, possibly a probe request — all
  with the forbidden model. That's billed provider time.
- **A misleading `forbidden_model_switch` ledger entry.** The event
  type was designed for deliberate pi-side `model_select` events
  (manual `/model`, pi defaults change, auto-rotate via pi's own
  logic). A `tryMainModelFallback` rotation that immediately gets
  reverted by the observer logs the same event type but tells a
  different story: "glla tried to rotate to forbidden X, was
  reverted by the gate." The new `forbidden_model_fallback_blocked`
  event type disambiguates.
- **A race window.** `observeModelChange` is async (it awaits
  `resolveMainModel` etc.). Between `setModel` and the revert
  landing, a `before_agent_start` could fire and the next turn
  could START on the forbidden model. The gate skips the
  `setModel` entirely, eliminating the race.

### Out of scope (the broader fix is a separate concern)

The Screenshot_20260808_083612 scenario showed "Anthropic stream
ended" repeating while the bottom status line still read
`(minimax) MiniMax-M3`. That's NOT a `tryMainModelFallback` rotation
— the session model is unchanged. It's a provider-level or
pi-internal rotation that happened mid-turn, possibly via:

- pi's own model rotation logic (sub-agent dispatch with a different
  model)
- The provider's `setModel` triggering an implicit session-level
  model swap
- A previous turn's `setModel` that committed to Anthropic in the
  provider's session cache

`observeModelChange` does fire on `model_select` events, but if pi
isn't firing `model_select` for the rotation, the event hook can't
catch it. The v0.34.93 fix narrows the EXPOSURE window — the
recovery envelope no longer actively rotates to forbidden refs — but
it does not eliminate it. The broader fix (catching every pi-internal
rotation, including the mid-turn case the user observed) requires
either:

1. A pi-side patch (not glla's domain)
2. A turn-end model check that preempts the next turn if the current
   model is forbidden
3. A forbidden-list-based refuse gate on the turn-start path

These are larger changes; they belong in a separate goal.

## Safety analysis

| Concern | Mitigation |
|---|---|
| Gate skips the only configured fallback, recovery stalls forever | The no-target fallthrough retries the current model — same as before v0.34.93 when no fallback was configured. Recovery is bounded by the 24h horizon. |
| Gate rejects a ref the user just authorized via `/glla` | `forbiddenModels` is a settings-array; `/glla` edits it. The gate consults the live setting on every iteration, so an updated list takes effect on the next `tryMainModelFallback` call. |
| Forbidden-list is empty (user cleared it) | `isForbiddenModel` returns false for empty lists — gate no-ops. Same as v0.34.72 auditor behavior. |
| Per-ref race: two iterations both pick the same forbidden candidate | The for-loop increments `recovery.attempted` before consulting the gate, so subsequent iterations see the candidate as already-attempted. `nextUntriedModelRef` won't pick it again even if the gate were bypassed. |
| Recovery-probe target resolution: only one target is picked, and it's forbidden | The new find filters out forbidden refs before picking; the no-target fallthrough retries the current model. If `current` itself is also forbidden (a session-model violation that escaped the observer gate), the no-target branch still calls `resolveMainModel(ctx, current)` and `setModel(current)` — which would re-set the forbidden current model. That's the same as v0.34.72's behavior; the broader fix is the separate concern above. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1104 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| Gate present in `tryMainModelFallback` | `grep -A2 'isForbiddenModel(candidateRef, loadSettings' extensions/loops/goal.ts` | matches |
| Gate present in `probeMainModelRecovery` target resolution | `grep -A2 'isForbiddenModel(ref, forbiddenList)' extensions/loops/goal.ts` | matches |
| `forbidden_model_fallback_blocked` ledger event type | `grep -rn 'forbidden_model_fallback_blocked' extensions/ tests/` | 4 matches (2 event emissions + 2 explanatory comments) |
| v0.34.93 tests pass | `bun test tests/model-switch.test.ts` | **12 pass / 0 fail** (was 10) |
| `audit/FORBIDDEN-MODEL-GATE-2026-08-08.md` exists | `ls audit/FORBIDDEN-MODEL-GATE-2026-08-08.md` | matches |
| CHANGELOG entry present | `grep -A2 '### 0.34.93' CHANGELOG.md` | matches |
| package.json bumped | `jq -r .version package.json` | `0.34.93` |

## Files touched

- `extensions/loops/goal.ts` — gate in `tryMainModelFallback`
  (~:2892) + gate in `probeMainModelRecovery` target resolution
  (~:3111) + 2 explanatory comments (+24 / -1 LOC).
- `tests/model-switch.test.ts` — 2 new tests for the v0.34.93 gate
  helper semantics (+27 LOC).
- `package.json` — 0.34.92 → 0.34.93.
- `CHANGELOG.md` — 0.34.93 entry.
- `audit/FORBIDDEN-MODEL-GATE-2026-08-08.md` — this doc.
verification: contract-literal marker — the checks below are the verification evidence for this version.
