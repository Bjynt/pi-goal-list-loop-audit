# Vision Assist — native vision first; external tools optional

**v0.34.72 policy update** · The executor/auditor should use the native image
capability of the model currently doing the work whenever it is available.
No external vision CLI, including MMX, is assumed to be installed.

## Policy

When a task needs the model to **look** at a screenshot, UI state, error dialog,
or rendered mockup:

1. Use the current model's native image capability first. This means the main
   model for executor work or the configured auditor model for detached audit
   work.
2. Do not switch models merely to obtain vision.
3. If native image input is unavailable, use an external vision provider only
   after its availability has been explicitly confirmed. MMX is an optional
   example, not a default or package requirement:

   ```bash
   mmx vision describe --image <path-or-url> --prompt "<question>" --quiet --non-interactive
   ```

4. If neither native vision nor a confirmed external provider is available,
   state that visual evidence is unavailable and request a supported capture or
   user description. Never invent a visual observation or silently assume MMX.

## The preapproval gate (model switches)

A model switch is not the default solution to a visual check. A preapproved
model may be selected only when the user explicitly requests it or it is needed
for the ordinary task—not as an assumed vision workaround.

- Default `forbiddenModels` is empty; users may add patterns such as `gpt-5.5`,
  `sonnet`, or `opus`.
- `/glla` → **Keep-going** → **Forbidden models** edits that list.
- `blockForbiddenModelSwitches` (default on) blocks explicitly forbidden
  selections and records `forbidden_model_switch`.
- Vision routing is recorded as `vision_assist`, including the selected route
  (`main-model`, confirmed `mmx-vision`, `model-switch`, or `unavailable`).

## The setting

`visionAssist` (default **on** — opt-out):

- **on** → continuation prompts carry the native-vision-first guidance and
  forbidden-switch events can record a `vision_assist` entry.
- **off** → no vision guidance is injected; the forbidden-model gate still
  stands.

Edit: `/glla` → **Keep-going** → **Vision assist**, then choose **off**.

## Implementation map

| Piece | Where |
|---|---|
| Guidance block (single source of truth) | `extensions/vision-assist.ts` → `VISION_ASSIST_GUIDANCE` |
| Optional MMX command builder | `visionDescribeCommand(imagePath, question?)` |
| Routing rule (pure) | `routeVisionCheck(request)` — native main-model route by default; confirmed MMX is optional; forbidden target never forces an unconfirmed tool |
| Ledger payload builder | `visionAssistLedger(route, request)` |
| Continuation injection | `extensions/goal-continuation.ts` pushes `VISION_ASSIST_GUIDANCE` into continuation directives (gated on `visionAssist !== false`) |
| Visual audit prompt | `extensions/goal-loop-auditor.ts` requires fresh evidence and does not assume an external tool |
| Forbidden-switch hook | forbidden-model gate in the settings editors/model pickers (`extensions/loops/goal-settings-ui.ts`, `extensions/loops/goal-activation.ts`) → `forbidden_model_switch` + `vision_assist` ledger entries |
| Setting | `extensions/goal-settings.ts` (default true), menu row in `extensions/settings-menu.ts` |
| Tests | `tests/vision-assist.test.ts` |

The `vision_assist` ledger entry is the audit trail: it says whether the check
used the current model, a confirmed optional provider, an explicitly allowed
model switch, or had no safe visual path.
