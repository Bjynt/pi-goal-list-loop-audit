# External review evidence — 2026-08-09

This file records what was actually retrievable from the two URLs in
`/home/dracon/chat/pi/note.md`; it does not treat an inaccessible review as
verified evidence.

## ChatGPT share

- URL: `https://chatgpt.com/share/6a7767d3-a520-83ed-82ce-2f60014bfdd5`
- Retrieval: HTTP `200`, `text/html`, 718,916 bytes.
- Page title: `ChatGPT - Goal Extension Rankings`.
- The serialized share contained the following relevant conclusions:

> “After reading the auditor implementation, **GLLA wins for unattended goal
> completion**.”

> “An empty response or missing verdict becomes an **error**, not a rejection
> and definitely not an accidental approval.”

> “More importantly, an `<approved/>` isn't sufficient. The code checks that
> the auditor actually invoked an inspection tool.”

> “The big negative is real, though: `extensions/loops/goal.ts` is currently
> **11,266 lines / 10,935 LOC / 590 KB**.”

The maintainability criticism was based on the older monolithic source the
review inspected. Current HEAD preserves the public installer path at 388
lines and has the runtime split into sibling modules; `npx tsc --noEmit` and
the full Bun suite cover the split. No wholesale `pi-goal-x` adoption was
justified.

The share also compared `pi-goal-x`, `@narumitw/pi-goal`, `pi-codex-goal`,
`@misunders2d/pi-goal`, `pi-dgoal`, `pi-until-done`, and others. The useful
plugin-owned takeaway was to retain the existing independent auditor,
regression shield, stale-generation checks, and watchdogs rather than replace
them with a simpler fail-open judge.

## Qwen share

- URL: `https://chat.qwen.ai/s/c724bf2d-8ee9-447d-8d89-2001cf5048d3?fev=0.2.83`
- Landing page retrieval: HTTP `200`, `text/html`, 144,790 bytes.
- Review-content retrieval: the attempted review API returned HTTP `401`.

The Qwen review body therefore remains unavailable and is explicitly not
claimed as read. The landing HTML is not evidence of its review conclusions.

## Scope result

External-review investigation is complete for this plugin goal: the
retrievable ChatGPT evidence was archived and compared with current HEAD; the
Qwen blocker is recorded with its raw HTTP outcome. Any future Qwen follow-up
must retrieve its authorized API content before making a new implementation
claim.
