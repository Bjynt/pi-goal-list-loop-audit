# Proactive drafting pre-read — 2026-08-29

## Problem

`/goal` drafting started cold: the seed string arrived as a grill prompt and the agent asked the first question without having seen the files/pictures the user already cited. Screenshot claims, `audit/...` paths, and repo evidence were re-asked. The verification contract for `20260829215603-qzo0p2` required a bounded pre-read (mini-audit) before the first question, pinned by a test, with no extra model switch.

## Solution

New module `extensions/proactive-pre-read.ts`:

* `PROACTIVE_MAX_FILES=3`, `PROACTIVE_MAX_CHARS_PER_FILE=800`, `PROACTIVE_MAX_TOTAL_CHARS=2800`, `PROACTIVE_SEED_EXCERPT=500`.
* Extracts candidate paths with `/(?:^|[\s"'`(\[])([a-zA-Z0-9_.\-/@]+\.(?:md|json|ts|js|txt|png|jpg|jpeg|webp|log))/g` and absolute `/...` variant, deduped, capped.
* `tryRead` checks existence via `fs.statSync`/`readFileSync`; images emit `Image reference/evidence: <path> — inspect via mmx vision describe …` (no bytes loaded, no model call); text files emit `File evidence <path> (N bytes, showing first M chars):` with `800`-char snippet.
* Even with zero file hits it emits `[PROACTIVE PRE-READ — bounded evidence before first question (max 3 files, 800 chars each)]\nSeed excerpt (M chars): …` so the first question is always grounded.

Wired in `extensions/loops/goal-list-queue.ts:startDrafting` after `buildSeedGrillMessage`/`crossRecommendMode`:

```ts
if (seed) {
  const pre = gatherProactivePreRead(seed, ctx.cwd);
  if (pre) tmpl += `\n\n${pre}`;
}
```

No `setModel`/`model_switch` path is touched; image evidence is an explicit `mmx vision describe` note (vision-assist routing).

## Verification

* `tests/proactive-pre-read.test.ts` 5/5:
  1. bounded file snippet surfaces and truncates before questioning
  2. image reference emits mmx routing without model switch
  3. empty file set still emits seed-excerpt block
  4. drafting injects the block via `pi.command("goal", "investigate audit/INDEX.md …")` — `pi.userMessages` contains `PROACTIVE PRE-READ` + `DRAFT EVIDENCE 99` + `Seed excerpt`
  5. constants stay `3 / 800`
* `npx tsc --noEmit` clean.
* `bun test tests/behavioral-orchestrator.test.ts` 127/127 pass (isolated; multi-file harness shares singleton — not mixing with other fixtures).
* No `extensions/model-selector.ts` or provider code changed; `grep -rn setModel proactive-pre-read` zero hits.

## Bounds and safety

* Pure `fs` reads, `try/catch`, `statSync` only — never throws out of drafting.
* Header + entries truncated at `2800` chars; per-file `800`; at most 3 files.
* Relative paths resolved against `ctx.cwd`; absolute paths honored.
* Does not ingest `active.jsonl` beyond the seed — bounded by construction.
