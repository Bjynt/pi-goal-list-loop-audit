# Vision Assist — see with mmx, not a model switch

**v0.34.72** · note.md 2026-08-07: *"the agent is too eager when couldnt see it
tried to use expensive mdoels. we need to special a vision setting where it
called another model or cli like mmx vision to see if stuck. but not just this
we need to specify that it cant be too eager to switch only preapproved."*

## Policy

The executor (pi's main agent) has no eyes. When a task needs it to **look**
at something — a screenshot, a UI state, an error dialog, a rendered mockup —
it must NOT switch models to get vision. The check routes to the **mmx vision
CLI** (the `mmx-cli` skill, MiniMax VLM):

```bash
mmx vision describe --image <path-or-url> --prompt "<question>" --quiet --non-interactive
```

- The image is usually a screenshot the user already pasted into the
  conversation (e.g. `/home/dracon/Pictures/Screenshots/...`). Pass its path
  straight through.
- Keep the question short and specific: *"What does this screenshot show?"*,
  *"Is there an error dialog?"*, *"What is the terminal output?"*.
- Reading the returned description is the agent's job — no model switch
  needed. (Verified 2026-08-07: `mmx vision describe` returns clean JSON/text
  with `status_code: 0`.)

## The preapproval gate (model switches)

A model switch is sanctioned **only when the target is preapproved** — i.e.
NOT in the `forbiddenModels` policy:

- Default forbidden list: empty — no opinionated ban list ships. Users can
  add patterns such as `gpt-5.5`, `sonnet`, or `opus`; matches are
  case-insensitive substrings against the `provider/id` ref.
- `/glla` → **Keep-going** → **Forbidden models** edits the list;
  `blockForbiddenModelSwitches` (default on) reverts an explicitly forbidden
  selection to the previous model.
- Every switch to a forbidden model is ledgered as `forbidden_model_switch`
  (with `blocked: true|false`).
- With vision assist on (default), the same event also appends a
  `vision_assist` ledger entry — the routing alternative: `{ route:
  "mmx-vision", blockedSwitch: <ref>, reason: "forbidden_model_switch" }`.

Even a preapproved vision-capable model is a second choice: mmx vision is the
default for every vision check.

## The setting

`visionAssist` (default **on** — opt-out):

- **on** → every continuation prompt carries the `## VISION-ASSIST — SEE WITH
  MMX, NOT A MODEL SWITCH` directive (`extensions/vision-assist.ts`
  `VISION_ASSIST_GUIDANCE`), and a forbidden switch also records the
  `vision_assist` routing entry.
- **off** → no vision guidance is injected; the `forbiddenModels` gate still
  stands (forbidden switches remain blocked/ledgered).

Edit: `/glla` → **Keep-going** → **Vision assist**, then choose **off**.

## Implementation map

| Piece | Where |
|---|---|
| Guidance block (single source of truth) | `extensions/vision-assist.ts` → `VISION_ASSIST_GUIDANCE` |
| Command builder | `visionDescribeCommand(imagePath, question?)` |
| Routing rule (pure) | `routeVisionCheck(request)` — mmx by default; forbidden target → mmx + `blockedSwitch`; preapproved target → `model-switch` allowed |
| Ledger payload builder | `visionAssistLedger(route, request)` |
| Continuation injection | `extensions/goal-continuation.ts` pushes `VISION_ASSIST_GUIDANCE` into the continuation directives (gated on `visionAssist !== false`) |
| Forbidden-switch hook | forbidden-model gate in the settings editors/model pickers (`extensions/loops/goal-settings-ui.ts`, `extensions/loops/goal-activation.ts`) → `forbidden_model_switch` + `vision_assist` ledger entries |
| Setting | `extensions/goal-settings.ts` (default true), menu row in `extensions/settings-menu.ts`, editor + `/glla` row in `extensions/loops/goal.ts` |
| Tests | `tests/vision-assist.test.ts` |

The `vision_assist` ledger type is the audit trail: every entry says where the
check routed and (when a switch was blocked) which model was refused.
