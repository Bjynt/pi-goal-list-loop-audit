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

export interface ProviderTokenUsage {
  /** Exact provider-reported prompt/input token count. */
  inputTokens: number;
  /** Exact provider-reported completion/output token count. */
  outputTokens: number;
  /** Exact provider-reported cache-read token count. */
  cacheReadTokens: number;
  /** Exact provider-reported cache-write token count. */
  cacheWriteTokens: number;
  /** Exact provider-reported total token count. */
  totalTokens: number;
}

export interface ProviderTokenMeasurement {
  /** Number of complete assistant usage samples captured from the provider. */
  sampleCount: number;
  /** Cumulative raw values across the captured provider samples. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  firstInputTokens: number | null;
  latestInputTokens: number | null;
  /** latestInputTokens - firstInputTokens, when both are present. */
  inputTokenDelta: number | null;
  /** Assistant messages carrying a missing/non-finite usage field. */
  incompleteSampleCount: number;
}

export interface ContextGrowthMeasurementOptions {
  /**
   * Assistant messages emitted after each measured snapshot. In production
   * these are the raw pi-ai messages from `agent_end`; keeping them separate
   * prevents provider usage metadata from changing the context-size counts.
   */
  providerMessages?: readonly unknown[];
}

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
  /** Exact provider usage captured from assistant messages, when present. */
  provider: ProviderTokenMeasurement;
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
  provider: ProviderTokenMeasurement;
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

function exactTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read the exact usage object emitted by pi-ai on an AssistantMessage. This
 * intentionally rejects partial data instead of filling missing fields with
 * zero: a zero would look like a provider measurement when it is only a
 * compatibility/error fixture. The returned values are not chars/4 estimates.
 */
export function captureProviderTokenUsage(message: unknown): ProviderTokenUsage | null {
  if (typeof message !== "object" || message === null) return null;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
  };
  const inputTokens = exactTokenCount(record.input);
  const outputTokens = exactTokenCount(record.output);
  const cacheReadTokens = exactTokenCount(record.cacheRead);
  const cacheWriteTokens = exactTokenCount(record.cacheWrite);
  const totalTokens = exactTokenCount(record.totalTokens);
  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || totalTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function measureProviderTokens(messages: readonly unknown[]): ProviderTokenMeasurement {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let firstInputTokens: number | null = null;
  let latestInputTokens: number | null = null;
  let sampleCount = 0;
  let incompleteSampleCount = 0;

  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; usage?: unknown };
    if (record.role !== "assistant" || record.usage === undefined) continue;
    const usage = captureProviderTokenUsage(message);
    if (!usage) {
      incompleteSampleCount++;
      continue;
    }
    sampleCount++;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalTokens += usage.totalTokens;
    if (firstInputTokens === null) firstInputTokens = usage.inputTokens;
    latestInputTokens = usage.inputTokens;
  }

  return {
    sampleCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    firstInputTokens,
    latestInputTokens,
    inputTokenDelta: firstInputTokens !== null && latestInputTokens !== null ? latestInputTokens - firstInputTokens : null,
    incompleteSampleCount,
  };
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
  const isGoalEvent = record.customType === "goal-event" || record.customType === "glla-authoritative-checkpoint";
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
export function measureContextGrowth(
  messages: readonly unknown[],
  options: ContextGrowthMeasurementOptions = {},
): ContextGrowthMeasurement {
  let totalSerializedBytes = 0;
  let totalTextChars = 0;
  let gllaMessageCount = 0;
  let gllaSerializedBytes = 0;
  let gllaTextChars = 0;
  let failedErrorOnlyCount = 0;
  let unserializableMessageCount = 0;
  const payloads = new Map<string, { count: number; serializedBytes: number }>();
  const provider = measureProviderTokens(options.providerMessages ?? messages);

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
    provider,
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
    provider: {
      sampleCount: after.provider.sampleCount - before.provider.sampleCount,
      inputTokens: after.provider.inputTokens - before.provider.inputTokens,
      outputTokens: after.provider.outputTokens - before.provider.outputTokens,
      cacheReadTokens: after.provider.cacheReadTokens - before.provider.cacheReadTokens,
      cacheWriteTokens: after.provider.cacheWriteTokens - before.provider.cacheWriteTokens,
      totalTokens: after.provider.totalTokens - before.provider.totalTokens,
      firstInputTokens: after.provider.firstInputTokens,
      latestInputTokens: after.provider.latestInputTokens,
      inputTokenDelta: after.provider.latestInputTokens !== null && before.provider.latestInputTokens !== null
        ? after.provider.latestInputTokens - before.provider.latestInputTokens
        : after.provider.latestInputTokens,
      incompleteSampleCount: after.provider.incompleteSampleCount - before.provider.incompleteSampleCount,
    },
  };
}