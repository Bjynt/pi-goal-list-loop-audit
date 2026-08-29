// pi-goal-list-loop-audit — context-growth measurement
//
// Pure measurement helpers for the context-bloat investigation. This module
// deliberately does not project, prune, or mutate messages: the first step is
// to quantify the effective context and isolate GLLA's repeated follow-up
// payloads from ordinary conversation, image payloads, and failed turns.

export type GllaPayloadKind =
  | "goal-continuation"
  | "post-compaction-resync"
  | "stall-warning"
  | "length-continuation"
  | "unknown";

export interface ContextGrowthMeasurement {
  messageCount: number;
  serializedBytes: number;
  textChars: number;
  /** A rough comparison only: text characters divided by four. */
  estimatedTokens: number;
  gllaMessageCount: number;
  gllaSerializedBytes: number;
  gllaTextChars: number;
  gllaEstimatedTokens: number;
  uniqueGllaPayloadCount: number;
  /** Occurrences after the first exact payload in each repeated group. */
  repeatedGllaPayloadCount: number;
  repeatedGllaSerializedBytes: number;
  failedErrorOnlyCount: number;
  unserializableMessageCount: number;
}

export interface ContextGrowthDelta {
  messageCount: number;
  serializedBytes: number;
  textChars: number;
  estimatedTokens: number;
  gllaMessageCount: number;
  gllaSerializedBytes: number;
  gllaTextChars: number;
  gllaEstimatedTokens: number;
  uniqueGllaPayloadCount: number;
  repeatedGllaPayloadCount: number;
  repeatedGllaSerializedBytes: number;
  failedErrorOnlyCount: number;
  unserializableMessageCount: number;
}

const TOKEN_ESTIMATE_CHARS = 4;
const encoder = new TextEncoder();

function serializedBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : encoder.encode(json).byteLength;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block !== "object" || block === null) return "";
      const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof candidate.text === "string") return candidate.text;
      if (candidate.type === "text" && typeof candidate.content === "string") return candidate.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  return textFromContent((message as { content?: unknown }).content);
}

function gllaKind(message: unknown): GllaPayloadKind | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as { customType?: unknown };
  const text = messageText(message);
  const isGoalEvent = record.customType === "goal-event";
  if (!isGoalEvent && !text.includes("[GOAL CHECKPOINT")) return null;
  if (text.includes("[POST-COMPACTION RESYNC]")) return "post-compaction-resync";
  if (text.includes("[STALL WARNING")) return "stall-warning";
  if (text.includes("output-token cap")) return "length-continuation";
  return "goal-continuation";
}

/** FNV-1a is sufficient for a diagnostic grouping key; this is not a trust
 * boundary and the original text is never persisted by this helper. */
function payloadFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}:${text.length}`;
}

/**
 * Measure one outgoing context snapshot without changing it. GLLA payloads
 * are recognized by the stable custom type/dispatch marker and grouped by
 * exact text so repeated continuation cost is visible separately from the
 * total context. All counters are bounded by the supplied message array.
 */
export function measureContextGrowth(messages: readonly unknown[]): ContextGrowthMeasurement {
  let totalSerializedBytes = 0;
  let totalTextChars = 0;
  let gllaMessageCount = 0;
  let gllaSerializedBytes = 0;
  let gllaTextChars = 0;
  let failedErrorOnlyCount = 0;
  let unserializableMessageCount = 0;
  const payloads = new Map<string, { count: number; serializedBytes: number }>();

  for (const message of messages) {
    const bytes = serializedBytes(message);
    if (bytes === null) {
      unserializableMessageCount++;
    } else {
      totalSerializedBytes += bytes;
    }
    const text = messageText(message);
    totalTextChars += text.length;
    if (typeof message === "object" && message !== null) {
      const record = message as { role?: unknown; stopReason?: unknown; content?: unknown };
      if (record.role === "assistant" && record.stopReason === "error" && Array.isArray(record.content)) {
        const hasToolCall = record.content.some((block) =>
          typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall",
        );
        if (!hasToolCall) failedErrorOnlyCount++;
      }
    }
    if (gllaKind(message) === null) continue;
    gllaMessageCount++;
    const gllaBytes = bytes ?? 0;
    gllaSerializedBytes += gllaBytes;
    gllaTextChars += text.length;
    const key = payloadFingerprint(text);
    const previous = payloads.get(key);
    if (previous) {
      previous.count++;
      previous.serializedBytes += gllaBytes;
    } else {
      payloads.set(key, { count: 1, serializedBytes: gllaBytes });
    }
  }

  let repeatedGllaPayloadCount = 0;
  let repeatedGllaSerializedBytes = 0;
  for (const payload of payloads.values()) {
    if (payload.count > 1) {
      repeatedGllaPayloadCount += payload.count - 1;
      // The first occurrence is the baseline; every later occurrence is
      // repeated context cost even when its JSON wrapper is different.
      repeatedGllaSerializedBytes += payload.serializedBytes * (payload.count - 1) / payload.count;
    }
  }

  return {
    messageCount: messages.length,
    serializedBytes: totalSerializedBytes,
    textChars: totalTextChars,
    estimatedTokens: Math.ceil(totalTextChars / TOKEN_ESTIMATE_CHARS),
    gllaMessageCount,
    gllaSerializedBytes,
    gllaTextChars,
    gllaEstimatedTokens: Math.ceil(gllaTextChars / TOKEN_ESTIMATE_CHARS),
    uniqueGllaPayloadCount: payloads.size,
    repeatedGllaPayloadCount,
    repeatedGllaSerializedBytes: Math.round(repeatedGllaSerializedBytes),
    failedErrorOnlyCount,
    unserializableMessageCount,
  };
}

/** Compare two snapshots, useful for reporting the marginal cost of another
 * continuation without coupling the measurement to a runtime state object. */
export function diffContextGrowth(
  before: ContextGrowthMeasurement,
  after: ContextGrowthMeasurement,
): ContextGrowthDelta {
  return {
    messageCount: after.messageCount - before.messageCount,
    serializedBytes: after.serializedBytes - before.serializedBytes,
    textChars: after.textChars - before.textChars,
    estimatedTokens: after.estimatedTokens - before.estimatedTokens,
    gllaMessageCount: after.gllaMessageCount - before.gllaMessageCount,
    gllaSerializedBytes: after.gllaSerializedBytes - before.gllaSerializedBytes,
    gllaTextChars: after.gllaTextChars - before.gllaTextChars,
    gllaEstimatedTokens: after.gllaEstimatedTokens - before.gllaEstimatedTokens,
    uniqueGllaPayloadCount: after.uniqueGllaPayloadCount - before.uniqueGllaPayloadCount,
    repeatedGllaPayloadCount: after.repeatedGllaPayloadCount - before.repeatedGllaPayloadCount,
    repeatedGllaSerializedBytes: after.repeatedGllaSerializedBytes - before.repeatedGllaSerializedBytes,
    failedErrorOnlyCount: after.failedErrorOnlyCount - before.failedErrorOnlyCount,
    unserializableMessageCount: after.unserializableMessageCount - before.unserializableMessageCount,
  };
}