// pi-goal-list-loop-audit — v0.34.60
// tests/disk-first-queue.test.ts
//
// File-only command path. /list and /goal draft must work without a live
// extension handle: write the goal .md / queue sidecar BEFORE the
// in-memory state commit. The disk is the source of truth; RAM is the
// cache. When active.jsonl is intact but in-memory state is empty
// (e.g. after /reload, plugin re-init, torn jsonl), /list must fall
// back to scanning the disk.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  writeQueueItemFile,
  deleteQueueItemFile,
  readQueueFromDisk,
  queueItemPath,
  piGlaDir,
  type ListItem,
} from "../extensions/goal-loop-core.ts";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-disk-first-"));
}

function mkItem(id: string, suffix = ""): ListItem {
  return {
    id,
    objective: `Enqueue: build the focused token pattern${suffix}`,
    verificationContract: "Done when: 1. fixtures exist 2. tests pass",
    addedAt: "2026-08-06T08:00:00.000Z",
  };
}

test("writeQueueItemFile: atomic, lands in .pi-glla/goals/<id>.queue.json", () => {
  const cwd = mkTmp();
  const item = mkItem("20260806080000-aaaa01");
  const { path: p, wrote } = writeQueueItemFile(cwd, item);
  assert.equal(wrote, true);
  assert.equal(p, path.join(cwd, ".pi-glla", "goals", `${item.id}.queue.json`));
  assert.equal(fs.existsSync(p), true, "file exists on disk");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.equal(raw.schema, 1);
  assert.equal(raw.type, "queue-item");
  assert.equal(raw.id, item.id);
  assert.equal(raw.objective, item.objective);
  assert.equal(raw.verificationContract, item.verificationContract);
});

test("writeQueueItemFile: idempotent on retry (no overwrite)", () => {
  const cwd = mkTmp();
  const item = mkItem("20260806080000-aaaa02");
  const first = writeQueueItemFile(cwd, item);
  assert.equal(first.wrote, true);
  // Second call returns wrote=false; existing file untouched.
  const second = writeQueueItemFile(cwd, { ...item, objective: "ENEMY OVERWRITE" });
  assert.equal(second.wrote, false);
  const raw = JSON.parse(fs.readFileSync(second.path, "utf-8"));
  assert.equal(raw.objective, item.objective, "the first write won — second was refused");
});

test("writeQueueItemFile: refuses to follow symlinks (symlink-safety)", () => {
  // v0.34.60: a symlink at goals/<id>.queue.json pointing outside the
  // workspace must NOT be silently followed — it could clobber an
  // arbitrary file the user trusts. Capture-and-report is fine because
  // the calling code (enqueueItems) re-asserts idempotency on retry.
  const cwd = mkTmp();
  fs.mkdirSync(path.join(cwd, ".pi-glla", "goals"), { recursive: true });
  const target = path.join(cwd, "outside.json");
  fs.writeFileSync(target, "{}", "utf-8");
  const link = path.join(cwd, ".pi-glla", "goals", "20260806080000-aaaa03.queue.json");
  try { fs.symlinkSync(target, link); } catch { return; } // unsupported — skip
  const item = mkItem("20260806080000-aaaa03");
  const r = writeQueueItemFile(cwd, item);
  assert.equal(r.wrote, false, "refuses to overwrite via symlink");
});

test("writeQueueItemFile: survives an existing temp residual", () => {
  // The atomic-write contract is temp + rename. A stale .tmp file in
  // the goals/ dir (left by a crashed previous write) must not block
  // the next write — the rename target is the .queue.json path, not
  // the .tmp. The next write completes cleanly.
  const cwd = mkTmp();
  fs.mkdirSync(path.join(cwd, ".pi-glla", "goals"), { recursive: true });
  const id = "20260806080000-aaaa04";
  const stray = path.join(cwd, ".pi-glla", "goals", `${id}.queue.json.12345.999.tmp`);
  fs.writeFileSync(stray, "stale", "utf-8");
  const item = mkItem(id);
  const r = writeQueueItemFile(cwd, item);
  assert.equal(r.wrote, true);
  assert.equal(fs.existsSync(queueItemPath(cwd, id)), true, "the real sidecar landed");
  assert.equal(fs.existsSync(stray), true, "the stray is left alone");
});

test("deleteQueueItemFile: returns true when present, false when missing", () => {
  const cwd = mkTmp();
  const id = "20260806080000-aaaa05";
  const item = mkItem(id);
  writeQueueItemFile(cwd, item);
  assert.equal(fs.existsSync(queueItemPath(cwd, id)), true);
  assert.equal(deleteQueueItemFile(cwd, id), true, "deletes the existing file");
  assert.equal(fs.existsSync(queueItemPath(cwd, id)), false);
  assert.equal(deleteQueueItemFile(cwd, id), false, "second delete is a no-op");
});

test("readQueueFromDisk: returns queue items, in id order, skipping garbage", () => {
  const cwd = mkTmp();
  writeQueueItemFile(cwd, mkItem("20260806080000-aaaa06"));
  writeQueueItemFile(cwd, mkItem("20260806080000-aaaa07", " (with extra objective text)"));
  // Garbage file mixed in
  fs.mkdirSync(path.join(cwd, ".pi-glla", "goals"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goals", "garbage.queue.json"), "this is not json {", "utf-8");
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goals", "not-queue-json.txt"), "untouched", "utf-8");
  // Wrong-schema file
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goals", "wrong-schema.queue.json"), JSON.stringify({ schema: 99 }), "utf-8");
  const items = readQueueFromDisk(cwd);
  assert.equal(items.length, 2, "exactly the two queue items, garbage skipped");
  assert.equal(items[0]!.id, "20260806080000-aaaa06");
  assert.equal(items[1]!.id, "20260806080000-aaaa07");
});

test("readQueueFromDisk: excludeIds removes ids that are active or archived", () => {
  const cwd = mkTmp();
  writeQueueItemFile(cwd, mkItem("20260806080000-aaaa08"));
  writeQueueItemFile(cwd, mkItem("20260806080000-aaaa09"));
  const noExclude = readQueueFromDisk(cwd);
  assert.equal(noExclude.length, 2, "without exclude, both returned");
  const withExclude = readQueueFromDisk(cwd, new Set(["20260806080000-aaaa08"]));
  assert.equal(withExclude.length, 1);
  assert.equal(withExclude[0]!.id, "20260806080000-aaaa09");
});

test("readQueueFromDisk: missing goals/ dir returns [] (not throw)", () => {
  const cwd = mkTmp();
  // No .pi-glla at all.
  const items = readQueueFromDisk(cwd);
  assert.deepEqual(items, []);
});

test("round-trip: write then read returns identical items", () => {
  const cwd = mkTmp();
  const items: ListItem[] = [
    mkItem("20260806080000-aaaa10"),
    { id: "20260806080000-aaaa11", objective: "objective without contract", addedAt: "2026-08-06T08:01:00.000Z" },
  ];
  for (const it of items) writeQueueItemFile(cwd, it);
  const out = readQueueFromDisk(cwd);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], items[0], "first round-trips exactly");
  assert.equal(out[1]!.id, items[1]!.id);
  assert.equal(out[1]!.objective, items[1]!.objective);
  assert.equal(out[1]!.verificationContract, undefined, "absent optional field stays absent");
});

test("queueItemPath: stable relative shape", () => {
  const p = queueItemPath("/tmp/foo", "20260806080000-aaaa12");
  assert.equal(p, path.join("/tmp/foo", ".pi-glla", "goals", "20260806080000-aaaa12.queue.json"));
});
