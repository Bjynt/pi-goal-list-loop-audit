# AVO deep read — full picture for GLLA (2026-09-02)

**Sources:** arXiv:2603.24517 `AVO: Agentic Variation Operators for Autonomous Evolutionary Search` (2026-03-25, html/pdf fetched 2026-09-02), NVIDIA developer blog `NVIDIA AVO Reaches 100% on ARC-AGI-3` (2026-08-21, by Chen et al.), prior `audit/PR-AVO-DISPOSITION-2026-09-01.md`, PR #22/#36 bodies, and `/tmp/avo.html` extracts.

## 1. What AVO actually is

AVO is **not** a “stagnation detector plugin”. It is a *family* of evolutionary **variation operators** where the LLM is elevated from *candidate generator inside a fixed pipeline* to *the variation operator itself*.

Classical LLM-in-the-loop search: `Vary(Pt) = Generate(Sample(Pt))` — the model only writes the candidate inside a prescribed sample→generate→evaluate pipeline (`§2.1`, `§3.1`).

AVO: `Vary(Pt) = Agent(Pt, K, f)` where

- `Pt = {(x1,f(x1)), …,(xt,f(xt))}` is the full **lineage** of committed solutions and their scores (not just the last version);
- `K` is a **domain knowledge base** (for attention: CUDA guides, PTX ISA, Blackwell arch spec, FA4 source; for other domains, the analogous docs);
- `f` is the **scoring function** (for kernels: *correctness vs reference* × *throughput TFLOPS* across configs; 0 if incorrect; vector-valued across benchmark configs);
- `Agent` is a **general-purpose coding agent** with planning, tool use, persistent memory, and execution feedback — no task-specific model tuning.

One AVO instantiation in the paper is a **single-lineage continuous run** from `x0` producing `x1…xt`, *persisting each committed new version as a git commit with its score* (`§3.3`). Branching/population management is deferred to future work.

### Anatomy of one variation step (§3.2)

A step `Pt → xt+1` is an *autonomous agent loop*, not a single LLM call:

1. examine **multiple** prior `xi` in `Pt`, compare profiling characteristics, consult `K` for hardware constraints;
2. implement a candidate, invoke `f` (compile/run, time, correctness);
3. on fail / no improvement, diagnose from compiler/profiling output, revise, repeat until commit-worthy;
4. **commit** only if `passes correctness && f(xt+1) ≥ best-so-far` (else it stays as internal trajectory, not in `Pt`).

Early steps lean on `K` reference impls; late steps lean on `f` profiling and lineage patterns.

### Continuous evolution + supervision (§3.3)

> “The AVO agent operates as a continuous loop that periodically produces new solutions without human intervention. Each committed version `xi` is persisted as a git commit along with its score, maintaining full state continuity across the entire evolutionary process.”

Two **failure modes** in long runs:

1. **Stall** — exhausts current line of exploration.
2. **Unproductive cycling** — repeated edits that repeatedly fail to improve scores.

AVO’s **self-supervision** detects both, then **reviews the overall evolutionary trajectory and steers the search toward several candidate optimization directions** (`§3.3`). The 7-day MHA run spanned **40 committed versions**, explored **>500 directions**, while the supervisor kept forward progress. This is *conditional intervention toward fresh directions*, not a “kill the run” gate.

Crucially (§3.3+§4.4): **scale, discrete jumps, diminishing returns** — gains arrive as jumps, not gradual; diminishing returns beyond ~40 versions; lineage + memory matters.

## 2. What AVO demonstrated

### Blackwell attention kernels (§4–5)

- Hardware: **B200, CUDA 13.1, PyTorch 2.10.0**, BF16, head 128, 16 heads, total 32k tokens varying seq {4096,8192,16384,32768}, causal+non-causal.
- Baselines: **cuDNN 9.19.1** (closed, Blackwell-tuned) and **FlashAttention-4 commit 71bf77c** (open Blackwell baseline), same warmup/repeats and FA4 timing script, 10-run avg.
- Result (MHA): **up to +3.5% vs cuDNN, +10.5% vs FA4** on causal (0.4–3.5% vs cuDNN, 5.0–10.5% vs FA4 across configs); **+1.8–2.4% vs cuDNN at long seq non-causal**, noise at short. Peak **~1668 TFLOPS BF16**.
- Optimized artifacts (§5): branchless accumulator rescaling, correction/MMA pipeline overlap (+1.1% non-causal, +0.4% causal geomean), register rebalancing across warp groups — joint HW-subsystem reasoning, not single-parameter tuning.
- Transfer: MHA→**GQA** (Qwen3 32q/4kv, 32q/8kv) in **~30 min** additional autonomous adaptation → **+7.0% vs cuDNN, +9.3% vs FA4**.
- Interpretation (§5.4): agent discovered expert-depth micro-architectural optimizations autonomously via doc+profiling loop.

### ARC-AGI-3 adaptation (blog 2026-08-21, not in March paper)

Same **general-purpose agent**, different tool/interface:

- Public set: **25 envs, 183 levels**, **100.00 RHAE** score (all levels completed).
- Baseline lift: **Claude Opus 5 30% → 100%** as part of full AVO system — argument that frontier-level long-horizon performance emerges from **harness**, not model alone.
- Efficiency: **~12% fewer environment actions** than **VISTA** with same underlying model.
- System view emphasized on blog: *harness = context, tools, memory, feedback, recovery*; “trusted agent stack requires performance, reliability, and security across the full system”.

### What AVO is *not* in the evidence

- The March paper makes **no ARC-AGI/RHAE claim**; PR #22’s citation `…avo… ; NVIDIA dev blog 2026-08 — AVO scored 100% RHAE` was *404 at review time* and is now confirmed by the **Aug blog** above — the PR cited the right number to the wrong source. The dispositive doc already flagged this; for GLLA docs we cite **blog for ARC, paper for kernels**.
- AVO is **domain-agnostic** at the operator level (kernel lesson → “other performance-critical systems on diverse hardware, engineering/scientific domains”).

## 3. How PR #22/#36 mapped (and mis-mapped) AVO to GLLA

Evidence from `gh pr view` bodies + diffs, summarized in the 2026-09-01 disposition (still valid on `v0.38.3`):

**PR #22 `feat(stagnation): v0.36.0 AVO-inspired goal stagnation supervisor`**
- Claims: ports AVO **long-horizon supervision** (“exhaustion” = N active turns with activity but zero commits/tasks/writes; “cycling” = trigram-Jaccard ≥0.8) → **non-prescriptive SUPERVISOR DIRECTIVE** in next continuation (trajectory review + fresh framing, clears on progress, bounded `maxConsecutiveInjections`). `Goal.stagnation` + `goal_progress_vector` ledger.
- Good: pure `recordTurnObservation`, testable, exemptions for provider-error/abort, ordering pinned after length/nudge gates, `exec`-based HEAD probe.
- **P1s that block merge as-is:** raw `HEAD` counts daemon/ledger commits; no `goalId/revision/generation/status` fencing (tweak inherits streak); cycling resets `injections:0` so cap never hit; first-turn baseline invisible + `toolCalls` under-count. Doc: `docs/DESIGN-stagnation-supervisor.md`.

**PR #36 `feat(commissar): v0.37.0 …`**
- Two features: **(i) commissar** detached `<adherent>/<wanting>` watchdog (WANTING×2 → terminate + restart same objective/loop via durable marker, infra-fail ≠ verdict, opt-in via `/glla`), plus **(ii) zombie human-input stand-down** (`USER_INPUT_WAIT_TOOL_NAMES` → `zombie_run_stood_down_user_input`, legitimate silent wait on `ask_user_question`/`pause_goal`/`propose_*`/`list_add` dialogs).
- Commissar is **not** AVO — it is a *termination* control plane with subjective WANTING criteria (including “dismisses achievability”), process-global streak, missing loop schema/revision fences, and a `newSession()` path unavailable on event handlers. Deferred pending per-target fencing + explicit termination policy.

### Verdict reaffirmed after deep read

- **Paper supports** only the high-level pattern “monitor lineage, conditionally intervene toward fresh directions” — not the PRs’ specific heuristics or termination.
- **System resonance with GLLA:** GLLA’s `/loop` **already is** an AVO-like system: `measureCmd` = `f` (vector scored), agent turn = variation step, prompts/knowledge base `K` (AGENTS.md, DESIGN docs, skill docs), git-committed lineage `Pt`, and continuous supervision via `ContinuousSupervisor 250ms→15s` (v0.38.0), `LIVE · WORKING` / `MONITORING` display, and `LONG_RUNNING_JUDGMENT_POLICY` (zero mid-run questions, batch upfront). The paper’s “review trajectory → steer to candidate directions” is what PR #22 attempted to add as a second supervisor.
- **Do not merge PR #22/#36 as-is** (still `CONFLICTING`, `5/1075` and `19/904` behind `v0.38.3`).

## 4. What GLLA should / should not borrow

**Worth borrowing (bounded, opt-in):**

1. **PR #22’s exhaustion/cycling nudge *only after fixing P1s*** — attribute progress to *agent-owned* writes (not raw HEAD), activation-time baseline, revision/generation fence + reset on `tweak`, monotonic cycling injections. As a **non-terminating, feature-gated directive** (not kill), complements the existing `STALL_NUDGE_MAX=3` nudge and `ContinuousSupervisor`. Dry-run telemetry first, then prompt-only.
2. **PR #36’s zombie stand-down** — ~10-line `hasPendingMessages`/`hasLiveSubagentHangProbes` carve-out in `goal-heartbeat.ts`/`goal-activation.ts`. Compatible with `v0.38.0`’s *drafting-only questions* and prevents `ask_user_question` waits from being mis-aborted. Small bounded port with behavioral `subagent-hang` coverage.

**Not worth borrowing:**

- Commissar auto-termination as “the AVO implementation” — needs a separate, operator-approved safety policy, per-target `cwd+goalId+revision+generation` keys, loop schema coverage, and reliable `newSession` ownership. Keep separate from stagnation work.
- Any “AVO” branding/flag in GLLA — the term is kernel-search-specific; GLLA’s equivalent is already “/loop as variation operator”.

**True AVO-like extension for GLLA (future, optional):** formalize `/loop` as `Agent(Pt,K,f)` more explicitly — expose `Pt` (recent loop ledger + scores), `K` (prompted docs), and `f` (measure) together in `prompts/goal-loop-*.md`, and log `Pt` continuity (git commits of loop artifacts) as the paper does. This is a docs/prompt-polish pass, not a code change.

## 5. Evidence pointers for this doc

- Paper HTML locally at `/tmp/avo.html` (≈42k), top-3 extracts grepped: formulation `Vary(Pt)=Agent(Pt,K,f)`, `§3.3 Continuous Evolution` stall/cycling + supervisor intervention + 40 versions, `§4.1 Setup` + `Fig.3` MHA gains, `§3.2` anatomy, `§5.x` optimizations, `§6 Conclusion` + `85ece…` trace of 500+ directions.
- Blog: `docs/INDEX.md` v0.38.3 trail, `gh pr view 22/36` bodies above, `audit/PR-AVO-DISPOSITION…`, `note.md` Now/Later as of 2026-09-02 17:35.
- Prior ledger: `v0.38.0` docs `docs/DESIGN-long-running-supervision.md`, `LIVE · WORKING` widget.
