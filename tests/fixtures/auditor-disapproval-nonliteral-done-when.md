The `Done when` cell check returned 0 matches. Let me run the exact contract command verbatim to see what's happening.Contract item 3 as literally specified returns **0**, not 27. The rows carry clauses but without the literal `Done when:` prefix the contract greps for. Before deciding, let me check the rest: findings.md content, 1:1 mapping, file existence, git checks.The 27 rows map 1:1 to open findings by line number (117-155), severities and descriptions look faithful. But contract item 3 literally fails (0 matches, needs 27), and item 4's captured paths include two directories (`docs/strategy/`, `web/packages/chrome/src/lib/` — glob patterns in Done when clauses) on which `test -f` fails. Let me run items 4, 5, 6 exactly as written.Items 4, 5, 6 pass (item 4 only by sort-order luck — two captured paths are directory prefixes from globs, but `test -f` on the last-sorted path succeeds). Let me confirm the 1:1 source-line mapping and repo cleanliness, then finalize.All evidence is in. The 1:1 mapping is exact (findings.md lines 117–155 → rows 1–27, in order, all severities matching, descriptions faithful, DEFERRED/`[x]`/`[?]` items correctly excluded), and items 1, 2, 4, 5, 6 pass. But contract item 3 — the literal acceptance command — returns **0, not 27**, because no row's final cell begins with the literal `Done when: ` text the contract greps for, and the executor's verification summary falsely claims that command passed (it substituted a different "cell 6 non-empty" check). That is a direct contradiction of an explicit contract item.

# Audit Report

**Verdict: <disapproved/>** — 5 of 6 verification-contract items pass on real evidence; contract item 3 fails as literally specified and the executor's summary misrepresents it as passing.

**Semantic quality assessment (non-contract):** The inventory itself is high quality. All 27 open `- [ ]` findings appear exactly once, in log-line order (findings.md:117,118,119,121,122,125–129,132–136,139–142,145–149,152,154,155), each with the correct severity, a faithful one-line description, a primary file:line reference, and a genuinely mechanical `Done when` clause (exact `cargo test`/`bun test` invocations, `grep` patterns, `python3 -c` JSON probes). DEFERRED `[x]` items, closed `[x]` fixes, and `[?]` DECIDE items are correctly out of scope. `findings.md` is untouched.

**The blocking gap:** the goal's verification contract item 3 is a literal command: `awk 'NR>4 && /^\| [0-9]+ \|/' .pi-glla/audit-loop/leftovers.md | grep -cE '\| Done when: [^|]+ \|$'` must equal 27. It returns **0**. The rows' final cells contain the clauses but lack the literal `Done when: ` prefix the contract requires (the column header is `Done when`, but the cell text starts with a backtick or a command). The executor's `<verification_summary>` claims this item PASSED — that claim is false; they ran a different check (cell 6 non-empty). An explicit acceptance-test item is contradicted by raw evidence.

<evidence>
Item: 1 — `test -f .pi-glla/audit-loop/leftovers.md` succeeds.
Output:
```
$ test -f .pi-glla/audit-loop/leftovers.md && echo "PASS: file exists"; wc -l .pi-glla/audit-loop/leftovers.md .pi-glla/audit-loop/findings.md
PASS: file exists
   47 .pi-glla/audit-loop/leftovers.md
  157 .pi-glla/audit-loop/findings.md
```

Item: 2 — `awk 'NR>4 && /^\| [0-9]+ \|/' ... | wc -l` equals `grep -cE '^- \[ \]' findings.md`.
Output:
```
$ grep -cE '^- \[ \]' .pi-glla/audit-loop/findings.md; awk 'NR>4 && /^\| [0-9]+ \|/' .pi-glla/audit-loop/leftovers.md | wc -l
27
27
```
(1:1 mapping additionally confirmed: `grep -nE '^- \[ \]'` → lines 117,118,119,121,122,125,126,127,128,129,132,133,134,135,136,139,140,141,142,145,146,147,148,149,152,154,155; leftovers.md Source column → exactly `findings.md:117 … findings.md:155` same set, in order.)

Item: 3 — `awk ... | grep -cE '\| Done when: [^|]+ \|$'` equals the row count.
Output:
```
$ awk 'NR>4 && /^\| [0-9]+ \|/' .pi-glla/audit-loop/leftovers.md | grep -cE '\| Done when: [^|]+ \|$'
0
---exit: 1
```
Sample row (row 1, final cell shown): `… | \`timeout 300 cargo test -p studio-api thumbnail_ -- --nocapture\` passes ≥4 tests … |` — no literal `Done when: ` prefix inside the cell. **0 ≠ 27. FAIL.**

Item: 4 — `while read f; do test -f "$f"; done < <(grep -oE '(web|docs|apis|scripts)/[A-Za-z0-9_./+-]+' ... | sort -u)` exits 0.
Output:
```
$ while read f; do test -f "$f"; done < <(grep -oE '(web|docs|apis|scripts)/[A-Za-z0-9_./+-]+' .pi-glla/audit-loop/leftovers.md | sort -u); echo "contract4-exit: $?"
contract4-exit: 0
```
Caveat: the grep also captures two *directory prefixes* from globs inside Done-when clauses — `docs/strategy/` (from `docs/strategy/*.md`) and `web/packages/chrome/src/lib/` (from `*.svelte`) — on which `test -f` fails; the loop still exits 0 only because the last-sorted path (`web/playwright.config.ts`) exists. No File-column reference is missing.

Item: 5 — `git diff --check` exits 0.
Output:
```
$ git diff --check; echo "diff-check-exit: $?"
diff-check-exit: 0
```

Item: 6 — `git diff --stat -- .pi-glla/audit-loop/findings.md` is empty.
Output:
```
$ git diff --stat -- .pi-glla/audit-loop/findings.md; echo "findings-stat-exit: $?"
findings-stat-exit: 0
```
(also absent from `git status --porcelain`; the only nearby mutations are the audit harness's own `progress.json` and unrelated pre-existing `web/games/wip/*` submodule pointers.)
</evidence>

## Required fixes

1. **Make verification-contract item 3 pass literally.** Prefix each of the 27 rows' final cell with the exact text `Done when: ` (e.g. row 1's last cell becomes `| Done when: \`timeout 300 cargo test -p studio-api thumbnail_ -- --nocapture\` passes … |`), so `awk 'NR>4 && /^\| [0-9]+ \|/' .pi-glla/audit-loop/leftovers.md | grep -cE '\| Done when: [^|]+ \|$'` returns 27. Re-run the full six-item contract verbatim afterwards — the goal's objective also calls each clause "a `Done when:` clause", so the literal label belongs in the cell.
2. **Do not re-report item 3 as passed until the raw command output shows 27.** The verification summary must quote the actual contract command's output, not a substituted "cell 6 non-empty" check. (Optional hardening: replace the globs `docs/strategy/*.md` and `web/packages/chrome/src/lib/*.svelte` inside clauses with literal file paths so item 4's grep stops capturing directory prefixes.)

<disapproved/>