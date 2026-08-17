import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-08-17T20:10:00Z");

function goal(): Goal {
  return {
    id: "20260817200522-y5az91",
    objective: "Show model provenance on the active goal",
    status: "active",
    policy: "list",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-17T20:05:22Z",
    updatedAt: "2026-08-17T20:05:22Z",
  };
}

test("active goal card pins primary, ordered fallbacks, skipped forbidden refs, and handled models", () => {
  const state: State = { goal: goal(), list: [] };
  const lines = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    120,
    {
      modelProvenance: {
        primary: "opencode-go/gpt-5.6-luna",
        primarySource: "inherited",
        fallbackRefs: ["openai/gpt-5.1", "anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"],
        skippedForbiddenRefs: ["anthropic/claude-sonnet-4-5"],
        handledTurn: "openai/gpt-5.1",
        handledAudit: "google/gemini-2.5-pro",
        handledAuditSource: "fallback-pin",
      },
    },
  )!;
  const rendered = lines.join("\n");

  assert.match(rendered, /model: primary opencode-go\/gpt-5\.6-luna · inherited from session/);
  assert.match(rendered, /fallbacks: openai\/gpt-5\.1 → anthropic\/claude-sonnet-4-5 → google\/gemini-2\.5-pro/);
  assert.match(rendered, /skipped forbidden: anthropic\/claude-sonnet-4-5/);
  assert.match(rendered, /handled turn: openai\/gpt-5\.1/);
  assert.match(rendered, /handled audit: google\/gemini-2\.5-pro · via fallback-pin/);

  const pinned = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    120,
    { modelProvenance: { primary: "anthropic/claude-sonnet-4-5", primarySource: "pinned" } },
  )!;
  assert.match(pinned.join("\n"), /model: primary anthropic\/claude-sonnet-4-5 · pinned/);
});
