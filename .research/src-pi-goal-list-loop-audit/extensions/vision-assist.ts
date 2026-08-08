// pi-goal-list-loop-audit — v0.34.72
// extensions/vision-assist.ts
//
// note.md 2026-08-07: "the agent is too eager when couldnt see it tried to
// use expensive mdoels. we need to special a vision setting where it called
// another model or cli like mmx vision to see if stuck. but not just this
// we need to specify that it cant be too eager to switch only preapproved."
//
// The vision-assist policy: when the agent needs to SEE something (a
// screenshot, a UI state, an error dialog), the check routes to the mmx
// vision CLI (the mmx-cli skill) — NOT to a model switch. A model switch
// for a vision check is sanctioned only when the target is PREAPPROVED
// (not in the forbiddenModels policy). This module is pure — no pi runtime
// calls, no fs — so the rule is unit-testable in isolation; the
// orchestration layer (goal.ts) injects the guidance into continuation
// prompts and writes the vision_assist ledger entries.

import { isForbiddenModel, DEFAULT_FORBIDDEN_MODELS } from "./goal-loop-core.js";

/** The vision-assist setting is ON by default (opt-out) — the guidance
 * ships so agents default to mmx vision instead of switching models. */
export const VISION_ASSIST_DEFAULT = true;

/** The guidance block injected into continuation prompts (the documented
 * vision-assist routing rule — single source of truth; docs/VISION-ASSIST.md
 * mirrors it for humans). */
export const VISION_ASSIST_GUIDANCE = `## VISION-ASSIST — SEE WITH MMX, NOT A MODEL SWITCH

You cannot see images (screenshots, UI states, error dialogs) with your own
eyes. When a task needs you to LOOK at something, do NOT switch models to
get vision — route the check through the mmx vision CLI (the mmx-cli skill)
instead:

  mmx vision describe --image <path-or-url> --prompt "<question>" --quiet --non-interactive

- The image is usually a screenshot the user already pasted into the
  conversation (e.g. /home/dracon/Pictures/Screenshots/...). Pass its path
  straight through; keep the question short and specific ("What does this
  screenshot show?", "Is there an error dialog?", "What is the terminal
  output?").
- Reading the returned description is YOUR job — no model switch needed.

MODEL-SWITCH GATE (preapproval only): switching models to "see" is exactly
the too-eager behavior this setting exists to stop. A switch is sanctioned
ONLY when the target model is preapproved — i.e. NOT in the forbiddenModels
policy (gpt-5.5, sonnet, opus are forbidden by default; /glla
forbiddenModels= edits the list). Any switch to a forbidden model is
blocked and ledgered as a violation (forbidden_model_switch), and the
vision-assist routing is ledgered as vision_assist. Prefer mmx vision for
every vision check, even when a preapproved vision-capable model exists.`;

/** The exact mmx vision describe command for one check. */
export function visionDescribeCommand(imagePath: string, question?: string): string {
  const q = question && question.trim().length > 0 ? question.trim() : "Describe what is shown in the image.";
  return `mmx vision describe --image "${imagePath}" --prompt "${q}" --quiet --non-interactive`;
}

export interface VisionCheckRequest {
  /** The image to look at (path or URL). */
  imagePath?: string;
  /** The question to ask about the image. */
  question?: string;
  /** The model the agent was reaching for (provider/id or bare id). */
  targetModelRef?: string;
  /** The forbidden-model policy to gate against (defaults to the policy). */
  forbiddenModels?: readonly string[];
}

export type VisionCheckRoute =
  | { route: "mmx-vision"; command: string; blockedSwitch?: string }
  | { route: "model-switch"; ref: string; command?: string };

/**
 * The routing rule: a vision check routes to mmx vision by default. A model
 * switch is sanctioned ONLY when the target is preapproved (not forbidden);
 * a forbidden target forces the mmx-vision route and reports the blocked
 * switch (the preapproval gate). No target model → mmx-vision.
 */
export function routeVisionCheck(request: VisionCheckRequest): VisionCheckRoute {
  const imagePath = request.imagePath?.trim();
  const command = imagePath ? visionDescribeCommand(imagePath, request.question) : undefined;
  if (request.targetModelRef) {
    if (isForbiddenModel(request.targetModelRef, request.forbiddenModels)) {
      return { route: "mmx-vision", command: command ?? "mmx vision describe --image <path-or-url> --quiet --non-interactive", blockedSwitch: request.targetModelRef };
    }
    return { route: "model-switch", ref: request.targetModelRef, command };
  }
  return { route: "mmx-vision", command: command ?? "mmx vision describe --image <path-or-url> --quiet --non-interactive" };
}

export interface VisionAssistLedgerValue {
  route: "mmx-vision" | "model-switch";
  command?: string;
  imagePath?: string;
  question?: string;
  /** model-switch route: the preapproved target. */
  ref?: string;
  /** mmx-vision route: a forbidden switch the gate turned into a vision check. */
  blockedSwitch?: string;
  at: string;
}

/** The ledger payload for a vision_assist entry. */
export function visionAssistLedger(route: VisionCheckRoute, request: VisionCheckRequest, at = new Date().toISOString()): VisionAssistLedgerValue {
  return {
    route: route.route,
    ...(route.command ? { command: route.command } : {}),
    ...(request.imagePath?.trim() ? { imagePath: request.imagePath.trim() } : {}),
    ...(request.question?.trim() ? { question: request.question.trim() } : {}),
    ...(route.route === "model-switch" ? { ref: (route as { ref: string }).ref } : {}),
    ...(route.route === "mmx-vision" && (route as { blockedSwitch?: string }).blockedSwitch ? { blockedSwitch: (route as { blockedSwitch: string }).blockedSwitch } : {}),
    at,
  };
}

// Re-export the gate so callers/tests share ONE matcher.
export { isForbiddenModel, DEFAULT_FORBIDDEN_MODELS };
