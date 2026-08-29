import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeMainModelFallbackRefs } from "../extensions/main-model-recovery.ts";
import { ModelSelector } from "../extensions/model-selector.ts";

describe("model selector parity — fallback set and ordering", () => {
  test("subagent-like raw chains are normalized like main (cap 10, case-insensitive dedup, order retained)", () => {
    const raw = [
      "openai/gpt-4o",
      "OpenAI/GPT-4o", // duplicate case-insensitive
      "anthropic/claude-sonnet-4-5",
      "openrouter/a",
      "openrouter/b",
      "openrouter/c",
      "openrouter/d",
      "openrouter/e",
      "openrouter/f",
      "openrouter/g",
      "openrouter/h",
      "openrouter/i", // 12th raw, should cap at 10 after dedup
    ];
    const normalized = normalizeMainModelFallbackRefs(raw);
    assert.equal(normalized.length, 10);
    assert.equal(normalized[0], "openai/gpt-4o");
    assert.equal(normalized[1], "anthropic/claude-sonnet-4-5");
    // dedup removed the second gpt-4o
    assert.deepEqual(normalized.slice(0, 2), ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
  });

  test("selectors share fallback ordering and forbidden/unregistered walk", () => {
    const chain = ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"];
    const forbidden = new Set(["anthropic/claude-sonnet-4-5"]);
    const available = new Set(["openai/gpt-4o", "minimax/MiniMax-M3"]);
    const deps = {
      getChain: () => chain,
      resolve: (ref: string) => (available.has(ref) ? { provider: ref.split("/")[0], id: ref.split("/")[1] } : undefined),
      isForbidden: (ref: string) => forbidden.has(ref),
      record: () => {},
    };
    const sessionSel = new ModelSelector(deps);
    const drafterSel = new ModelSelector(deps);
    const auditorSel = new ModelSelector(deps);

    const sessionRes = sessionSel.selectNextValid({ kind: "session" }, undefined, []);
    const drafterRes = drafterSel.selectNextValid({ kind: "drafter" }, undefined, []);
    const auditorRes = auditorSel.selectNextValid({ kind: "auditor" }, undefined, []);

    // All three walk past the forbidden entry and land on the first valid
    assert.equal((sessionRes as any).ref, "openai/gpt-4o");
    assert.equal((drafterRes as any).ref, "openai/gpt-4o");
    assert.equal((auditorRes as any).ref, "openai/gpt-4o");

    // After that ref is attempted, the next valid should be the third (second is forbidden)
    const attempted = ["openai/gpt-4o"];
    const session2 = sessionSel.selectNextValid({ kind: "session" }, "openai/gpt-4o", attempted);
    const drafter2 = drafterSel.selectNextValid({ kind: "drafter" }, "openai/gpt-4o", attempted);
    const auditor2 = auditorSel.selectNextValid({ kind: "auditor" }, "openai/gpt-4o", attempted);

    assert.equal((session2 as any).ref, "minimax/MiniMax-M3");
    assert.equal((drafter2 as any).ref, "minimax/MiniMax-M3");
    assert.equal((auditor2 as any).ref, "minimax/MiniMax-M3");

    // All three report the same visited ordering (forbidden is visited then skipped)
    assert.deepEqual(sessionSel.lastVisitedRefs, ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"].slice(1,2).length ? ["anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"] : []);
    // Actually after second call, visited should be forbidden + third
    assert.deepEqual(session2 !== null && "ref" in session2 ? sessionSel.lastVisitedRefs : [], ["anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"]);
    assert.deepEqual(drafterSel.lastVisitedRefs, ["anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"]);
    assert.deepEqual(auditorSel.lastVisitedRefs, ["anthropic/claude-sonnet-4-5", "minimax/MiniMax-M3"]);
  });
});
