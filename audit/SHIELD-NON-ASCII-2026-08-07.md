# Shield non-ASCII contract items — GitHub #5

2026-08-07 · item 1 of the "note.md newer ones" batch · v0.34.77

## The bug (as filed)

[github.com/DraconDev/pi-goal-list-loop-audit/issues/5](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/5):
the regression shield's token extraction regex only matches ASCII:

```typescript
item.split(/[^A-Za-z0-9_.\-/]+/)   // every CJK char is a delimiter
```

For a pure-Chinese contract item like `调研报告文件存在且包含以下章节：` the
split produced zero candidates, so the check fell back to
`reportLower.includes(item.toLowerCase())` — and an English-written auditor
report never contains the Chinese line. Result: 18 rounds of `approved=True`
verdicts, `shield=False` every round, the goal stuck in `active` forever
(the loop kept re-auditing, burning tokens).

The failure was two-layered:

1. **Tokenization** — CJK letters were treated as delimiters, so no candidate
   token was ever produced from a Chinese line.
2. **Reference matching** — even with a token in hand, a translated/paraphrased
   evidence item (English gloss of a Chinese line) can never match. The
   auditor prompt only said "quote the item", which an auditor can honor by
   paraphrasing — and a paraphrase is unmatchable.

## The fix

`extensions/goal-loop-shield.ts` (v0.34.77):

- **Unicode-aware split**: `/[^\p{L}\p{N}_.\-/]+/u` — `\p{L}` treats CJK
  characters as letters, so a pure-Chinese line is ONE candidate token.
- **Unicode-safe `stripEdgePunct`**: `\p{L}\p{N}` on both edges (the old
  ASCII-only class would have stripped Chinese characters as "punctuation").
- **`tokenPresent` Han branch**: a Han token matches by exact substring only —
  Chinese words have no compound-segment decomposition, so the ASCII
  "left-cropped → left + cropped" segment rule must not apply to them.
- **Punctuation-edge-normalized fallback**: when an item produces no
  candidates, the fallback comparison strips trailing punctuation
  (`章节：` → `章节`), so a verbatim quote that drops the item's full-width
  colon still counts.

`extensions/goal-loop-auditor.ts` (same version): the REGRESSION SHIELD prompt
block now says each item must be quoted **VERBATIM in the contract's original
language** — a translated or paraphrased item cannot be matched and the
approval will be rejected. This is the forward fix: compliant auditors quote
the Chinese, and the Unicode matcher can then find it.

## Design stance (what the shield still rejects)

The shield stays strict for genuine weak evidence: an English-only paraphrase
of a Chinese item is still a `missingItem` (pinned by test). The 18-round
deadlock closes because (a) quotes now match even with punctuation drift, and
(b) the prompt forbids paraphrase-only evidence. We deliberately did NOT add
"any report that mentions an evidence block passes CJK items" leniency — that
would reopen the bamboozle hole the shield exists to close.

## Evidence

- `tests/regression-shield.test.ts` +6 (24 total): verbatim-quoted Chinese
  item passes; quote dropping the trailing `：` passes; pure-CJK line yields a
  single candidate; English paraphrase still rejected; mixed item matches on
  its ASCII token; ASCII distinctive-token + compound behavior unchanged.
- Full suite: **1026 pass / 1 skip / 0 fail across 95 files** (was
  1020/1/0 at v0.34.76), `npx tsc --noEmit` clean.
