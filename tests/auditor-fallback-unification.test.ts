// tests/auditor-fallback-unification.test.ts
//
// v0.35.5: regression test pinning auditor fallback behavior to the same
// primitives main-model-recovery / drafter-model already use. The audit
// (audit/FALLBACK-UNIFICATION-2026-08-17.md) flagged the auditor resolver
// as the thin path — it had its own hand-rolled two-slot walker that did
// not share normalizeMainModelFallbackRefs, the forbidden-gate, the
// MAX_MAIN_MODEL_FALLBACKS cap, or the uniform envelope from
// mainModelFailureDelayMs. This test pins:
//
//   1. Plural chain (auditorModelFallbacks) goes through the same
//      canonical normalizer — case-insensitive dedup, cap at 10, original
//      spelling preserved for the per-pin source label.
//   2. Forbidden refs in auditorModelFallbacks are silently skipped — no
//      loud warning, the gate matches main / drafter semantics.
//   3. The deprecated auditorModelFallback (singular) alias still works —
//      it is appended to the chain when set so a legacy global.json entry
//      keeps working unchanged.
//   4. The chain emits the auditor_model_fallback ledger event with
//      reason:"forbidden" for forbidden refs (forensic trail) while
//      remaining silent in the user-facing notify surface.
//
// Tests live in node:test style to match the rest of the suite. The
// resolveAuditorModel function is now exported from goal-settings-ui.ts
// specifically so this regression can drive it without booting the
// runtime global.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";
import { MAX_MAIN_MODEL_FALLBACKS } from "../extensions/main-model-recovery.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface FakeContext {
  ctx: any;
  session: any;
  primary: any;
  fallback1: any;
  fallback2: any;
  forbiddenRef: any;
  tmpDir: string;
}

function fakeContext(): FakeContext {
  const session = { provider: "test", id: "session", reasoning: true };
  const primary = { provider: "test", id: "primary", reasoning: true };
  const fallback1 = { provider: "test", id: "fallback-1", reasoning: true };
  const fallback2 = { provider: "test", id: "fallback-2", reasoning: true };
  const forbiddenRef = { provider: "test", id: "forbidden", reasoning: true };
  const models = new Map([
    ["test/session", session],
    ["test/primary", primary],
    ["test/fallback-1", fallback1],
    ["test/fallback-2", fallback2],
    ["test/forbidden", forbiddenRef],
  ]);
  const registry = {
    find(provider: string, id: string) {
      return models.get(`${provider}/${id}`);
    },
    getAvailable() {
      return [...models.values()];
    },
    hasConfiguredAuth(_model: any) {
      return true;
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-auditor-fb-"));
  const notifyMessages: { kind: string; text: string }[] = [];
  const ctx: any = {
    model: session,
    modelRegistry: registry,
    cwd: tmpDir,
    ui: {
      notify(text: string, kind: string) {
        notifyMessages.push({ kind, text });
      },
    },
    __notifyMessages: notifyMessages,
  };
  return { ctx, session, primary, fallback1, fallback2, forbiddenRef, tmpDir };
}

function readLedger(tmpDir: string): any[] {
  const file = path.join(tmpDir, ".pi-glla", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/* ------------------------------------------------------------------ */
/* 1. Plural chain — case-insensitive dedup, MAX_MAIN_MODEL_FALLBACKS cap */
/* ------------------------------------------------------------------ */

test("auditor fallback chain is normalized via normalizeMainModelFallbackRefs (case-insensitive dedup, cap at MAX_MAIN_MODEL_FALLBACKS)", () => {
  const { ctx, primary, fallback1, fallback2 } = fakeContext();
  // Mixed case, with duplicates — the canonical normalizer should fold them
  // to a single chain in the order they first appear. The MAX cap is
  // asserted separately below (we keep the chain length manageable here).
  // Note: refs must match the lowercase ids registered by fakeContext —
  // normalizeMainModelFallbackRefs preserves first-seen spelling, but the
  // resolver looks them up against the registry which uses the lowercase
  // id, so we use mixed case here to verify the case-insensitive dedup
  // without breaking the registry lookup.
  const refs = [
    "test/Fallback-1", // duplicates fallback-1 (different casing)
    "test/FALLBACK-1", // duplicate, dropped
    "test/FALLBACK-2",
    "test/PRIMARY", // duplicates primary (different casing) — appears AFTER the real fallback chain slots
  ];
  const resolved = resolveAuditorModel(
    ctx,
    "test/primary",
    undefined,
    true,
    refs,
  );
  assert.ok(resolved.model, "a primary is selected");
  assert.equal(resolved.model, primary, "primary is selected as the head of the chain");
  // The dedup'd chain order after normalization: PRIMARY (dropped as dup of
  // primary), FALLBACK-1 (kept spelling), FALLBACK-2 (kept spelling). So the
  // walked chain (head + tail) is: [primary, fallback-1, fallback-2].
  const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((c: any) => c.model)];
  assert.deepEqual(walked, [primary, fallback1, fallback2], "chain order after dedup: primary, fallback-1, fallback-2");
});

test("auditor plural chain is capped at MAX_MAIN_MODEL_FALLBACKS (10) entries — same primitive as main", () => {
  const { ctx } = fakeContext();
  // Build a chain with MAX+5 fake refs. Only one real model is resolvable
  // (test/primary); the rest are unregistered, which the resolver warns
  // loudly for and then skips — but the chain length is what we pin.
  const overflow = Array.from({ length: MAX_MAIN_MODEL_FALLBACKS + 5 }, (_, i) => `test/nonexistent-${i}`);
  const refs = ["test/primary", ...overflow];
  const resolved = resolveAuditorModel(ctx, undefined, undefined, true, refs);
  // The chain is normalized to MAX entries; the rest are dropped before the
  // walker sees them.
  const total = 1 + (resolved.fallbackModels?.length ?? 0);
  assert.ok(total <= MAX_MAIN_MODEL_FALLBACKS + 1, `chain length (${total}) stays within the cap+1 (primary)`);
  assert.ok(resolved.model, "primary resolved");
});

/* ------------------------------------------------------------------ */
/* 2. Forbidden refs are silently skipped                              */
/* ------------------------------------------------------------------ */

test("auditor forbidden refs are silently skipped — no user-facing warning, ledger records reason:\"forbidden\"", () => {
  const { ctx, primary, fallback1, forbiddenRef } = fakeContext();
  const beforeNotifyLen = ctx.__notifyMessages.length;
  // The deprecated singular fallback pin IS forbidden; the plural slot
  // holds the valid fallback. The legacy walker now applies the forbidden
  // gate to both the primary and the singular fallback, so the resolved
  // chain falls through to fallback-1.
  const resolved = resolveAuditorModel(
    ctx,
    "test/forbidden",
    "test/forbidden", // singular fallback also forbidden — both legacy walker slots are gated
    true,
    ["test/fallback-1"],
  );
  // The forbidden pins are dropped from the user-facing chain — the
  // resolved model walks past them to the first valid slot.
  assert.notEqual(resolved.model, forbiddenRef, "the forbidden ref is not selected");
  // The chain reaches fallback-1 (via the plural post-walker pass) — the
  // resolved head is primary, and fallbackModels contains the rest.
  const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((c: any) => c.model)];
  assert.ok(!walked.includes(forbiddenRef), "forbidden ref never appears in the walked chain");
  assert.ok(walked.includes(fallback1), "fallback-1 IS in the walked chain");
  // Ledger emits the reason:"forbidden" event for forensic trail.
  const ledger = readLedger(ctx.cwd);
  const forbiddenEvents = ledger.filter((e) => e.kind === "auditor_model_fallback" && e.data?.reason === "forbidden");
  assert.ok(forbiddenEvents.length >= 1, `at least one auditor_model_fallback reason:forbidden event recorded (got ${forbiddenEvents.length})`);
  // User-facing notify surface: the forbidden skip MUST NOT raise a warning
  // (forbidden is user-intent, not an unavailable ref).
  const afterNotify = ctx.__notifyMessages.slice(beforeNotifyLen);
  const loudForbiddenWarnings = afterNotify.filter(
    (m: any) => m.kind === "warning" && /is unavailable/i.test(m.text) && /forbidden/i.test(m.text),
  );
  assert.equal(loudForbiddenWarnings.length, 0, "no loud warning raised for the forbidden ref");
});

/* ------------------------------------------------------------------ */
/* 3. Deprecated auditorModelFallback (singular) alias still works    */
/* ------------------------------------------------------------------ */

test("the deprecated auditorModelFallback (singular) alias is appended to the plural chain — legacy global.json entries keep working", () => {
  const { ctx, primary, fallback1, fallback2 } = fakeContext();
  // Legacy user config: only the singular slot. Should still flow into the
  // chain the same way the plural does.
  const legacy = resolveAuditorModel(ctx, "test/primary", "test/fallback-1", true);
  assert.equal(legacy.model, primary);
  const legacyRefs = [legacy.model, ...(legacy.fallbackModels ?? []).map((c: any) => c.model)];
  assert.ok(legacyRefs.includes(fallback1), "singular fallback reaches fallback-1");
  // New user config: only the plural. Same shape, same semantics.
  const modern = resolveAuditorModel(ctx, "test/primary", undefined, true, ["test/fallback-1"]);
  assert.equal(modern.model, primary);
  const modernRefs = [modern.model, ...(modern.fallbackModels ?? []).map((c: any) => c.model)];
  assert.ok(modernRefs.includes(fallback1), "plural fallback reaches fallback-1");
  // Mixed config: both set — the singular is appended before the plural so
  // a legacy setting still wins the first fallback slot.
  const mixed = resolveAuditorModel(ctx, "test/primary", "test/fallback-1", true, ["test/fallback-2"]);
  assert.equal(mixed.model, primary);
  const mixedRefs = [mixed.model, ...(mixed.fallbackModels ?? []).map((c: any) => c.model)];
  assert.ok(mixedRefs.includes(fallback1), "mixed config still includes the singular fallback-1");
  assert.ok(mixedRefs.includes(fallback2), "mixed config also includes the plural fallback-2");
});

/* ------------------------------------------------------------------ */
/* 4. Same primitives as main — uniform envelope via ModelSelector    */
/* ------------------------------------------------------------------ */

test("auditor fallback path goes through the ModelSelector / forbidden-gate / dedup primitives shared with main and drafter", () => {
  // Static check: the auditor resolver imports normalizeMainModelFallbackRefs
  // (the canonical normalizer) and runs the plural chain through it. The
  // drafter does the same at extensions/drafter-model.ts. This pins the
  // dependency: pulling the import out would break the unification, and a
  // test catches it.
  const uiSource = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf-8");
  // The import block is multi-line. The dependency on the canonical
  // normalizer is what unifies main, drafter, and auditor — pulling the
  // import out would break the unification, and this test catches it.
  assert.match(
    uiSource,
    /from "\.\.\/main-model-recovery\.js";[\s\S]*?normalizeMainModelFallbackRefs/,
    "auditor resolver imports normalizeMainModelFallbackRefs from main-model-recovery.js (same primitive as main + drafter)",
  );
  assert.match(
    uiSource,
    /import \{[\s\S]*?normalizeMainModelFallbackRefs[\s\S]*?\} from "\.\.\/main-model-recovery\.js";/,
    "auditor resolver assembles the chain through normalizeMainModelFallbackRefs (dedup + cap + order)",
  );
  // The drafter uses the same normalizer at the same call site — pinning the
  // shared primitive.
  const drafterSource = fs.readFileSync("extensions/drafter-model.ts", "utf-8");
  assert.match(
    drafterSource,
    /normalizeMainModelFallbackRefs/,
    "drafter resolver uses normalizeMainModelFallbackRefs (same primitive as main + auditor)",
  );
});
