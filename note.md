# Now

## session visibility goal (drafted, awaiting confirm → v0.38.7)

Recovery banner + auditor-queue progress line.

- Recovery banner: resumed-but-empty session paints objective + next pending task + pending audits/verdicts + resume command from disk state
  (evidence: Screenshot_20260902_223042.png, Screenshot_20260902_223001.png)
- Queue progress line: auditor queued/running + disapproval count + last-verdict age + what unblocks, in status line and `/goal status`
  (evidence: Screenshot_20260903_090025-1.png)
- Closed: compaction proactivity done in v0.38.6 (85% nudge, ladder, send refuse, sticky refuse)

# Next

Queue drained — recovery + progress are the Now goal above, compaction shipped in v0.38.6. Only unshaped candidate left is in Later.

# Later

## we stil have the question that despite our efforts assume something goves over context how do we hadnle it

## visual improvements ?
