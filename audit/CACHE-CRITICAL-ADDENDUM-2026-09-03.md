# Cache-critical addendum — bounded marker vs prompt cache (2026-09-03)

> Addendum to `audit/ANTIGRAVITY-CODEX-CLAUDE-PI-GOAL-X-2026-09-03.md` §6 A2 and `audit/CROSS-HARNESS-REVIEW-2026-09-01.md` A2.
> Prompted by user review: *"GLLA resends full prompt each follow-up; pi-goal-x/Claude summary-resume suggests ≤160-char marker once at `before_agent_start` + checkpoint — this could break the cache so just because they do it doesn't mean it's good"* — correct, and the original ranking under-specified the trade-off.

## 0. Verdict in one paragraph

**Do not ship a naked ↓160-char followUp marker.** GLLA today delivers context as a **hidden followUp user message** (`extensions/goal-continuation.ts:1123` `sendMessage({content: resync+continuationPrompt}, {deliverAs:"followUp"})`). `pi-goal-x`/`Claude` tiny markers only work because the **systemPrompt is re-injected every turn at `before_agent_start`** with the full goal state — the marker is just a wake-up, not the context carrier. Without that paired injection, a tiny GLLA marker leaves the next turn with no objective/contract/task state except stale history, which disappears after compaction. With the paired injection, the marker is strictly *better* for cache and history growth than the current full-prompt resend. Original doc §6 ranked A2 as #2 BORROW ("measure first"); downgrade to **CONDITIONAL — paired systemPrompt injection + marker, measured, behind explicit goal — never marker alone.**

## 1. What GLLA actually sends today — measured

| Artifact | File | Raw cap | Rendered (this repo) | Tokens ~ |
|---|---|---|---|---|
| GLLA template | `prompts/goal-loop-continuation.md` | 17,004 chars raw | 21,002 chars short objective, no directives → 40,691 chars long+auditor (node render, §1 bench) | 5.2k–10k |
| pi-goal-x prompt | `.research/src-pi-goal-x/extensions/prompts/goal-prompts.ts` | `MAX_PROMPT_FRAGMENT 10_000` + `MAX_OBJECTIVE_BLOCK 3_000` + `MAX_PENDING_RENDERED 10` | 3k objective truncated, 10 pending only | ≤2.5k |
| Tiny marker | `extensions/goal-continuation.ts:1087` `marker: [GOAL CHECKPOINT goalId=…]` | 45 chars | same | ~11 |

GLLA's `continuationPrompt()` substitutes `${GOAL_ID}`, `${OBJECTIVE}`, `${VERIFICATION_CONTRACT}`, `${TASK_LIST}`, `${NEXT_PENDING_TASK_BLOCK}`, `${LONG_RUNNING_JUDGMENT_POLICY}`, `${ACTIVE_EXECUTION_QUESTION_GUIDANCE}`, `${DYNAMIC_DIRECTIVES}` (auditor report, `RECOVERY NOTICE`, `STALE APPROVAL`, repair target, pendingTasks). `DYNAMIC_DIRECTIVES` is empty in steady state but inflates by 5–15k when an audit disapproves — the prompt is **not stable** across turns even though the objective is.

pi-goal-x splits the same content differently: `goalPrompt()` (active) and `continuationPrompt()` both capped at 10k, called from `before_agent_start` as `systemPrompt` suffix, while `queueContinuation` sends `continuationPrompt` as followUp — but the per-turn authority is the systemPrompt injection, not the followUp length.

## 2. How pi-ai caches — not "resend = hit"

`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`:

- `getCacheControl()` → `{type:"ephemeral", ttl:"1h"?}` unless `PI_CACHE_RETENTION=none`.
- `buildParams()` adds `cache_control` to **system prompt** (`params.system[].cache_control`) and via `convertMessages()` to the **last user message's last block** (`lastBlock.cache_control = cacheControl`).
- Effect: anchor at (a) system, (b) conversation prefix up to last user message. Next request reuses prefix if identical.

`node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js` confirms model: `CACHE_TTL_MS 5*60*1000`, `detectMiss` compares `prev.promptTokens` vs `usage.cacheRead`; `NOISE_FLOOR 1024`. Compaction entries reset `prev=undefined` — post-compaction cache legitimately misses.

Two implications:

1. **System prompt is the stable cached segment.** `pi-goal-x` appends `goalPrompt` to systemPrompt every `before_agent_start` (`goal-events.ts:392` `let prompt = goalPrompt(activeGoal)` → `return {systemPrompt: current+prompt}`). That system extension is cached (first `cache_control`). Goal revision changes invalidate it, but steady-state turns hit.

2. **Last user message is the second cached segment.** GLLA's followUp is a user message, so it becomes the `lastBlock` cache anchor. The *new* followUp content each turn is `cacheWrite`, not `cacheRead` — the common prefix is everything *before* the new user message. Resending 5k vs 11 tokens changes `cacheWrite` per turn by ~5k, but both miss on the new block because the block is new content.

**Cache break vs cache write:** the user's instinct ("this could break the cache") is about **prefix invalidation**, not per-turn write volume.

- **Prefix break** = earlier cached prefix changes (e.g., system prompt or earlier messages mutated). A tiny followUp does NOT break prefix — it *shortens* the new block, actually reducing cacheWrite.
- **But** a tiny followUp **without** system injection removes the objective from the *current* turn's prompt entirely. The model's context then depends on **history**: prior turns where the objective appeared as an older user message. That's cacheRead (history is prefix), but history is truncated by compaction (`session_compact` → summary, `cache-stats.js` resets `prev`). After compaction, history no longer contains the full objective — the tiny marker turn would have no objective at all.

So:
- `systemPrompt injection + tiny marker` = **cache-friendly**: system stays stable (hit), marker is tiny write.
- `user-message full prompt + no system injection` (GLLA today) = **cache-inefficient and history-bloating**: every turn writes 5k new tokens *and* appends 5k to history, so n=10 turns → history = 50k prompt tokens re-sent as context each turn (O(n²) token billing).
- `tiny marker + no system injection` (naive borrow) = **cheapest but incorrect**: tiny write, but next turn has no objective after compaction — functional break, not just cache break.

Codex's `compactContinuationPrompt` is the middle path: still a user message, not system injection, but compact (budget+guidance only). Cheaper than GLLA, but still history-bloating and still loses detail after compaction; acceptable only because Codex goals are single-thread without auditor directives.

## 3. Token economics (illustrative, `faux` provider logic)

`providers/faux.js:129` simulates cache via `commonPrefixLength(previousPrompt, promptText)`.

| Mode (10 turns) | System per turn | FollowUp per turn | History growth | 10-turn cacheWrite | 10-turn context billed (input+cacheRead) |
|---|---|---|---|---|---|
| GLLA today | base (~2k) | ~5k full | +5k/turn → 50k history | ~50k | ~275k (prefix re-billed + new) |
| pi-goal-x (system+marker) | base+goalPrompt ~2.5k cached | 0.01k marker | +0.01k/turn → 0.1k | ~2.5k (system once) +0.1k | ~50k |
| Naive tiny only | base (~2k) | 0.01k | +0.01k/turn | ~0.1k | ~20k but **objective lost after compaction** |

Numbers are schematic (prompt length /4 = tokens, cache hit on prefix). Real `cacheRead/write` observed via `cache-stats.js:computeCacheWaste()` and provider `usage.cacheRead/cacheWrite`.

## 4. Why original A2 ranking was under-specified

`CROSS-HARNESS 2026-09-01` A2 said "GLLA resends full prompt each follow-up; pi-goal-x persists ≤160-char marker once at `before_agent_start`" and proposed "measure growth, spec bounded marker". `ANTIGRAVITY-…-2026-09-03` §6 kept that as #2 BORROW. Both omitted the **paired systemPrompt injection** that makes pi-goal-x's marker valid. The borrow is not `continuationPrompt` length alone; it's the **delivery plane**: move authority from followUp user message to `before_agent_start` systemPrompt suffix, then shrink followUp to checkpoint id.

Claude's `summary-resume` is the same lesson via a different mechanism: large sessions resume from a **summarized transcript**, not full history — the `session_compact` → `buildCompactionSummary` path in GLLA (`goal-continuation.ts:buildPostCompactResync`) is the analogue, but GLLA only prepends it as `resync` to the *same* large followUp. Summary-resume argues for shrinking the steady-state prompt and relying on durable sidecars/ledger, not for keeping full resend.

## 5. Revised disposition

| ID | Title | Old | New | Rationale |
|---|---|---|---|---|
| A2 | Bounded marker | BORROW #2, measure first | **CONDITIONAL — paired** | Ship only as atomic pair: (i) `before_agent_start` systemPrompt injection of bounded goal state (objective ≤3k, pending ≤10, contract snippet, like pi-goal-x `goalPrompt` with `MAX_PROMPT_FRAGMENT` cap) + (ii) followUp shrinks to `[GOAL CHECKPOINT goalId=…]` (+ generation/owner proof). Never shrink followUp without (i). Requires explicit goal with measurement gate. |
| Codex compact | Compact continuation | BORROW opt-in | **IGNORE** as standalone | Codex compact is still user-message history bloat; the system-injection pattern supersedes it. |
| A8 | Heartbeat coalesce | #1 | **#1 stays** | Diagnostic not terminal — independent, no cache interaction. |
| A1, A4, A5, A6, A7 | — | — | **unchanged** | No cache interaction. |

## 6. Measurement gate before any code

Do not spec A2 until growth and cache waste are pinned on `main`:

1. `tests/context-growth-measurement.test.ts` (already present, 23015 chars fixture) — assert rendered continuation length ≤ bound on long lists (20 tasks) and confirm history growth is O(n) not O(n²). Add explicit `continuationPrompt` length assertion vs `MAX_PROMPT_FRAGMENT`.
2. Instrument `cache-stats.js:computeCacheWaste` / `collectCacheMisses` in a fixture run: 5-turn mockPi session with (a) current full followUp vs (b) emulated system+marker (stub `before_agent_start` injection). Expect (b) `missedTokens` ↓ and `cacheRead` ↑.
3. Run `faux` provider simulation: `commonPrefixLength` between consecutive prompts — full prompt has low prefix overlap due to dynamic directives; marker has high system overlap.

Only after (1)–(3) green, spec the paired change behind no flag (explicit goal already gates).

## 7. Evidence pointers

- GLLA send plane `extensions/goal-continuation.ts:1069 dispatchPrepare → 1123 sendMessage({content: resync+continuationPrompt}, {deliverAs:"followUp"})` + `continuationPrompt()` at 1256 reading `prompts/goal-loop-continuation.md` (17,004 chars) → 21k–40k rendered.
- pi-goal-x send plane `.research/src-pi-goal-x/extensions/goal-runtime.ts:127 sendFollowUp(continuationPrompt)` vs authority plane `extensions/goal-events.ts:392 goalPrompt` injected at `before_agent_start:320` as `systemPrompt: current+prompt`, with `MAX_PROMPT_FRAGMENT 10_000` `goal-prompts.ts:10`.
- Pi cache planes `pi-ai/dist/api/anthropic-messages.js:717 getCacheControl → 741 system.cache_control → 980 last user block cache_control`; `pi-coding-agent/dist/core/cache-stats.js:2 CACHE_TTL_MS 5m, NOISE_FLOOR 1024, compaction resets prev`.
- Faux simulation `pi-ai/dist/providers/faux.js:129 commonPrefixLength`.
- GLLA lacks system injection `extensions/loops/goal-activation.ts:2450 before_agent_start` only `dispatchStartAcknowledged`, no `systemPrompt` augmentation — the missing pairing that makes naive marker incorrect.

## 8. TL;DR for next goal

If you want the "pi-goal-x is shorter" win, you must first **teach GLLA to speak via systemPrompt at `before_agent_start` like pi-goal-x does**, then you may silence the followUp. Doing the second without the first breaks correctness and does not improve cache — it just deletes context. Keep A2 as **Later, conditional, measured**, ranked after A8/A1.

## 9. Addendum 2026-09-03 late note — "ongoing conversation, why summary at all?"

User: *"there is also no need to summary or what they are gaining its an ongoing conversation, i dont get it"* — exactly right for **steady-state ongoing** turns.

History already contains the objective, contract, and task list from T0 + every `complete_task` tool_result. Resending `prompts/goal-loop-continuation.md` (21–40k) as a new followUp user message each turn (GLLA today `goal-continuation.ts:1123`) buys almost nothing in steady state — it just appends a 5k duplicate to history. Over n=10 idle wakeups, history grows +50k and each new followUp is 5k `cacheWrite` (previous prompt's marker is not prefix, so `commonPrefixLength` → low hit). That's the `context-growth-measurement.test.ts` fixture shape (23015-char resync) — O(n²) billed context.

What a summary/marker actually buys, per harness:
- **Claude `--resume` / pi-goal-x `before_agent_start`:** resume from **dead** session where history is gone (or compacted to `branch_summary`). There the summary *is* the context — without it the new session has no objective. Not relevant to a live ongoing turn.
- **pi-goal-x `goalPrompt` at `before_agent_start`:** not a summary of ongoing chat; it's the *current* bounded state (objective ≤3k + pending ≤10 + contract) re-injected into the cached system prompt each turn. That's the authority copy the model should obey; the followUp marker (`[GOAL CHECKPOINT]`) carries no state.
- **GLLA `buildPostCompactResync()` (`goal-continuation.ts:1239`):** only needed **after** `session_compact` where `cache-stats.js` resets `prev=undefined` and history is summarized away. Then a 200-char resync (`Goal ${id} — status ${status} — Next: ${task}`) *does* gain correctness — it re-anchors after loss. Today GLLA prepends that resync to the same 21k full prompt, so the gain is drowned in duplicate.

**So for a live idle wakeup with no state change (no task completed, no audit, no compaction), the correct payload is just the wake-up:** `'[GOAL CHECKPOINT goalId=…]'` (45 chars, `marker` at `goal-continuation.ts:1087`) — zero new state, history already holds it, and `agent_end → agent_settled → queueContinuation(50ms)` already proved the session is idle. Resending full state there is pure cost: extra `cacheWrite`, history bloat, and `DYNAMIC_DIRECTIVES` instability that actually *lowers* prefix hit.

**When to actually send state:**
- `postCompactResyncPending` true → send `buildPostCompactResync()` only (not full prompt).
- Task list mutated (`complete_task`/`update_task_status` changed `revision`) → send delta: `Next pending: ${id}` + maybe `AUDITOR DISAPPROVAL` report when present, not full `LONG_RUNNING_JUDGMENT_POLICY` + `ACTIVE_EXECUTION_QUESTION_GUIDANCE` (those are static and already in history's T0 prompt).
- Auditor disapproval / recovery notice → send that directive alone (already handled as `DYNAMIC_DIRECTIVES` but today bundled with the 17k static `EXECUTION DISCIPLINE` block).
- Otherwise: marker only.

That is why the revised A2 is *paired + conditional + delta-only*: teach `before_agent_start` to own the cached current state (like pi-goal-x), then steady-state followUps shrink to marker. No summary needed for ongoing — summary is only for **resumed/compacted** sessions. Until that pairing is measured (`§6` gate), the cheapest correct thing today is simply keep the status quo rather than summarize each turn.

— Addendum 2026-09-03, read-only, no code.
