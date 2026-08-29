import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LONG_RUNNING_JUDGMENT_POLICY } from "../extensions/goal-loop-core.ts";

describe("defer vs durable — long-term ordering", () => {
  test("policy prioritizes durable long-term focused action over defer and pins plaque ordering", () => {
    const p = LONG_RUNNING_JUDGMENT_POLICY;
    assert.match(p, /Defer vs durable/i);
    assert.match(p, /long-term focused action outranks defer/i);
    assert.match(p, /durable fix.*not a defer/i);
    assert.match(p, /ledger distinguishes deferred vs inline/i);
    // ordering regression: durable before defer, and plaque collision guard
    const durableIdx = p.indexOf("durable");
    const deferIdx = p.toLowerCase().indexOf("defer");
    assert.ok(durableIdx >= 0 && deferIdx >= 0 && durableIdx < deferIdx, "durable must appear before defer in policy ordering");
    assert.match(p, /N=31.*i%2.*wrap/i);
    assert.match(p, /the-ember-throne/i);
    assert.match(p, /the-frost-beneath/i);
  });

  test("ledger distinction exists for deferred vs inline", () => {
    // policy is the durable artifact that declares the ledger contract;
    // the regression pins the wording so a future edit cannot silently drop it
    assert.match(LONG_RUNNING_JUDGMENT_POLICY, /ledger distinguishes deferred vs inline/i);
  });
});
