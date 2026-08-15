// Drafting-only model resolution and fallback selection.
//
// Drafting runs in the main pi session, so the selected model is a temporary
// lease: the caller must restore the original session model when drafting
// ends. This module only resolves an ordered candidate list; lifecycle and
// retries remain in goal-list-queue.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isForbiddenModel } from "./goal-loop-core.js";
import { MAX_MAIN_MODEL_FALLBACKS, modelRef, normalizeMainModelFallbackRefs } from "./main-model-recovery.js";
import { ModelSelector } from "./model-selector.js";
import type { Settings } from "./goal-settings.js";

export const MAX_DRAFTER_FALLBACKS = MAX_MAIN_MODEL_FALLBACKS;

export interface DrafterModelCandidate {
  ref: string;
  model: any;
  via: "configured" | "session-last-resort";
}

export interface DrafterModelResolution {
  configuredRefs: string[];
  candidates: DrafterModelCandidate[];
  selected?: DrafterModelCandidate;
}

/** Resolve a provider/model ref without making a provider request. */
export function resolveDrafterModelRef(ctx: Pick<ExtensionContext, "modelRegistry">, ref: string): any | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  try {
    if (slash > 0) {
      const model = ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
      return model;
    }
    return ctx.modelRegistry
      .getAvailable()
      .filter((candidate: any) => candidate.id === trimmed || candidate.name === trimmed)
      .find((candidate: any) => ctx.modelRegistry.hasConfiguredAuth(candidate));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the dedicated drafter chain. The current session model is always a
 * final in-process fallback, even when every configured candidate is missing
 * auth or forbidden. No error text, quota state, or retry hint is inspected.
 */
export function resolveDrafterModel(ctx: ExtensionContext, settings: Pick<Settings, "drafterModel" | "drafterModelFallbacks" | "forbiddenModels">): DrafterModelResolution {
  const primary = typeof settings.drafterModel === "string" ? settings.drafterModel.trim() : "";
  const configuredRefs = normalizeMainModelFallbackRefs([
    ...(primary ? [primary] : []),
    ...normalizeMainModelFallbackRefs(settings.drafterModelFallbacks),
  ]).slice(0, MAX_DRAFTER_FALLBACKS);
  const currentRef = modelRef(ctx.model);
  const forbidden = (ref: string) => isForbiddenModel(ref, settings.forbiddenModels);
  const selector = new ModelSelector({
    getChain: () => configuredRefs,
    resolve: (ref) => resolveDrafterModelRef(ctx, ref),
    isForbidden: forbidden,
  });
  const attempted: string[] = [];
  const candidates: DrafterModelCandidate[] = [];
  for (;;) {
    const selected = selector.selectNextValid({ kind: "drafter" }, currentRef, attempted);
    if (!("ref" in selected)) break;
    attempted.push(selected.ref);
    candidates.push({ ref: selected.ref, model: selected.model, via: "configured" });
  }
  if (ctx.model && currentRef && !candidates.some((candidate) => candidate.ref.toLowerCase() === currentRef.toLowerCase())) {
    candidates.push({ ref: currentRef, model: ctx.model, via: "session-last-resort" });
  }
  return { configuredRefs, candidates, selected: candidates[0] };
}

