# Install & try v0.1.0

## Prerequisites

- Node 22+ (uses `--experimental-strip-types` for tests)
- pi-coding-agent installed (`npm i -g @earendil-works/pi-coding-agent`)
- TypeScript 5.9+ (for `tsc --noEmit` type-check)

## Install from source

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git   # or use the local dir
cd pi-goal-list-loop-audit
pi install .                                               # installs from local path
```

## Install from npm (after publish)

```bash
pi install npm:pi-goal-list-loop-audit
```

> **Persistence note**: `pi update` can overwrite `~/.pi/agent/npm/node_modules/`.
> If the plugin disappears after an update, re-run `pi install`. For a permanent
> install, copy the package into your project's `.pi/extensions/` directory instead.

## Auditor model: the built-in-provider rule

The auditor runs in a **fresh session with no extensions**, so it can only use
**built-in providers** (opencode, openrouter, minimax, google, anthropic, …).
You select the model in pi; the auditor uses it. The plugin never picks a
model itself. The resolution is just:

1. your explicit `/glla model=provider/id` override (rare), else
2. the pi session model — whatever you selected in pi.

If your session model's provider is extension-registered, the auditor's
extension-less session cannot auth it and the plugin says so at session start,
with the two fixes: switch pi's model to a built-in provider, or set the
override:

```
/glla model=provider/model-id
```

Whatever you choose must work extension-less. Verify with:

```bash
PI_CODING_AGENT_DIR=/tmp/bare-agent pi -p "say ok" --model "provider/model-id"
```

## Subagent model inheritance (v0.24.6)

If you use `@tintinweb/pi-subagents`: its default `Explore` agent pins
`anthropic/claude-haiku-4-5`, so `Explore` subagents run on a **different
provider and quota pool than your session** — a quota-capped key (e.g.
OpenRouter) 403s after a few concurrent spawns even while the parent
session is fine.

glla fixes this by default: at session start it manages
`~/.pi/agent/agents/Explore.md` (pi-subagents' native override mechanism)
without the model pin, so subagents inherit your session model. Your own
same-named files are never touched (glla only edits files carrying its
`x-managed-by` marker).

Control it via `/glla` → Settings:

- **Subagent model strategy** — `inherit-parent` (default, subagents share
  your session model + quota) or `agent-default` (upstream: Explore pins
  haiku — cheap search, separate quota).
- **Subagent Explore model pin** — e.g. `minimax/MiniMax-M3`; always wins
  over strategy.

Changes apply to NEW pi sessions (pi-subagents registers agents at its own
session start).

Release-workflow note: installing into the local extension tree
(`~/.pi/agent/npm`) requires `--legacy-peer-deps` — a pre-existing
`@pi-unipi/notify` peer pin on `@earendil-works/pi-coding-agent@^0.78.0`
conflicts with the current pi release.

## Try it without installing

```bash
pi -e /home/dracon/Dev/pi-goal-list-loop-audit
```

## What you should see

Once installed, restart pi. The plugin contributes:

- **Commands**: `/goal`, `/list`, `/loop`, `/glla` (settings).
- **Tools available to the agent** (only when a goal is active): `complete_goal`, `pause_goal`, `complete_task`, `update_task_status`.

## Run the tests

```bash
npm test
```

Expected output: 168 passing tests across 12 files (`goal-loop-core.test.ts`, `goal.schema.test.ts`, `extract-verification.test.ts`, `regression-shield.test.ts`, `list-import.test.ts`, `list-queue.test.ts`, `loop-forever.test.ts`, `display.test.ts`, `goal-route.test.ts`, `heartbeat.test.ts`, `task-list.test.ts`, `auditor-error-paths.test.ts`, plus `tests/README.md`).

## Run the type-check

```bash
npm run check
```

Expected output: no TypeScript errors.

## End-to-end smoke test

After installing:

1. In a pi session, run:
   ```
   /goal start "
   Add a /healthz endpoint to src/server.ts that returns {status:'ok'} JSON.

   Done when:
   - curl -fsS localhost:3000/healthz returns 200 with body {\"status\":\"ok\"}
   - The file is committed
   "
   ```
2. The orchestrator creates `.pi-glla/goals/<id>.md`, schedules continuation, and the agent starts.
3. The agent reads the goal, makes the change, runs the verification, and calls `complete_goal`.
4. The orchestrator spawns the isolated auditor.
5. The auditor inspects files, runs `curl`, reads `git log`.
6. Either `<approved/>` → goal archived; or `<disapproved/>` → loop continues.

## Reading the state

While the loop runs:

```bash
ls .pi-glla/                  # see live state
cat .pi-glla/active.jsonl | tail -5
cat .pi-glla/goals/<id>.md    # current goal markdown
ls .pi-glla/archive           # past goals
```

## v0.1.0 verification status (2026-07-20, all live-verified)

- [x] Live `agent_end` loop fires after agent returns.
- [x] `complete_goal` triggers the isolated auditor session.
- [x] Auditor session correctly isolates (no extensions — discovered the built-in-provider rule).
- [x] `<approved/>` archives the goal with clean history.
- [x] `<disapproved/>` / auditor error continues or pauses with feedback.
- [x] 5-consecutive-error auto-pause fires (verified via live 403 storm).
- [x] Stale-ctx safety after session replacement (lastCtx pattern).
- [x] `npm test` 24/24. `npm run check` clean.

Known v0.1.0 limitation: Esc during an audit aborts the pi turn but the auditor
session may complete detached; the loop recovers via `agent_end`. pi-goal-x's
Escape dialog is v0.2.0 scope.
