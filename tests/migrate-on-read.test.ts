// pi-goal-list-loop-audit — v0.38.32 migrate-on-read pins (2026-09-08).
//
// DECIDED 2026-09-08: pre-v0.38.21 audit histories lack superseded flags, so
// liveDisapproval treated every legacy disapproval as live — one
// post-upgrade retry argued already-settled objections. The read-path
// migration replays the appendAuditVerdict scope rules over the stored
// array (add-only, idempotent) before selecting the live round.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  backfillSupersededObjections,
  liveDisapproval,
} from "../extensions/goal-loop-core.js";
import type { AuditVerdict } from "../extensions/goal-loop-core.js";

const at = (n: number): string => `2026-08-0${n}T10:00:00.000Z`;
const legacyDis = (n: number): AuditVerdict =>
  ({ at: at(n), approved: false, disapproved: true, model: "m", report: `R${n}` });
const legacyApproval = (n: number): AuditVerdict =>
  ({ at: at(n), approved: true, disapproved: false, model: "m", report: "ok" });

// The field shape: two legacy disapprovals settled by a legacy approval.
// Before the migration liveDisapproval returned R2; after, nothing is live
// and both rounds carry the flags live code would have written.
test("v0.38.32: legacy disapprovals settled by a later approval are never live again", () => {
  const history: AuditVerdict[] = [legacyDis(1), legacyDis(2), legacyApproval(3)];
  assert.equal(liveDisapproval(history), undefined, "no live objections after the settling approval");
  assert.equal(history[0]!.superseded, true, "R1 retired");
  assert.equal(history[0]!.supersededBy, "disapproval:2026-08-02T10:00:00.000Z", "R1 names the superseding round");
  assert.equal(history[1]!.superseded, true, "R2 retired");
  assert.equal(history[1]!.supersededBy, "approval:2026-08-03T10:00:00.000Z", "R2 names the clearing approval");
});

// A later legacy disapproval settles the earlier one; the newest stays live.
test("v0.38.32: later legacy disapproval supersedes the earlier round only", () => {
  const history: AuditVerdict[] = [legacyDis(1), legacyDis(2)];
  assert.equal(liveDisapproval(history)?.report, "R2", "newest round stays live");
  assert.equal(history[0]!.superseded, true, "R1 retired");
  assert.equal(history[0]!.supersededBy, "disapproval:2026-08-02T10:00:00.000Z", "R1 names R2");
  assert.equal(history[1]!.superseded, undefined, "R2 untouched");
});

// A lone legacy disapproval with no later verdict is genuinely live.
test("v0.38.32: lone legacy disapproval stays live", () => {
  const history: AuditVerdict[] = [legacyDis(1)];
  assert.equal(liveDisapproval(history)?.report, "R1", "still live — nothing settled it");
  assert.equal(history[0]!.superseded, undefined, "no flag invented without a settling verdict");
});

// Infrastructure entries are transparent in both directions.
test("v0.38.32: error entries neither settle nor get settled", () => {
  const history: AuditVerdict[] = [
    legacyDis(1),
    { at: at(2), approved: false, disapproved: false, error: "boom", model: "m" },
  ];
  assert.equal(liveDisapproval(history)?.report, "R1", "error leaves R1 live");
  assert.equal(history[0]!.superseded, undefined, "errors never mark flags");
});

// The migration converges: second run marks nothing, and post-v0.38.21
// histories that live code already flagged pass through untouched.
test("v0.38.32: backfill is idempotent and a no-op on flagged histories", () => {
  const history: AuditVerdict[] = [legacyDis(1), legacyDis(2), legacyApproval(3)];
  assert.equal(backfillSupersededObjections(history), 2, "first run marks two rounds");
  assert.equal(backfillSupersededObjections(history), 0, "second run marks nothing");
  assert.equal(liveDisapproval(history), undefined, "still settled");
  const flagged: AuditVerdict[] = [
    { ...legacyDis(1), superseded: true, supersededBy: "disapproval:2026-08-02T10:00:00.000Z" },
    legacyDis(2),
  ];
  assert.equal(backfillSupersededObjections(flagged), 0, "live-written flags are never rewritten");
  assert.equal(flagged[0]!.supersededBy, "disapproval:2026-08-02T10:00:00.000Z", "existing byRef preserved");
});
