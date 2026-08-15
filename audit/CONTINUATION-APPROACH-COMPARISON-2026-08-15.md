# Continuation approach comparison — 2026-08-15

## Scope and conclusion

This is a focused review of current official material for OpenAI Codex,
Claude Code, and DeepSeek Harness. It is not a benchmark and does not justify
copying another product's provider, quota, or session internals into glla.

The concrete decision is to keep glla's durable goal/task/audit ledger as the
source of truth and strengthen the host-session request around an explicit
resume/replacement boundary. No wholesale continuation rewrite is warranted.

## Comparison

| System | Durable continuation primitive | Useful lesson for glla | Boundary / risk |
|---|---|---|---|
| Codex | The app-server exposes `thread/start`, `thread/resume`, and `thread/fork`; the CLI also supports `resume` by id or most recent session, plus `/compact`. | Make session identity, resume, and fork explicit operations; keep a compact durable checkpoint rather than relying on a live callback. | This is a host/app-server protocol, not an extension event API. It does not make Pi's stale `ExtensionContext` replaceable by itself. |
| Claude Code | Conversations are saved continuously to local transcripts. `--continue`, `--resume`, and `/resume` restore sessions; resumed state includes history/tool calls and selected session configuration. Large sessions can resume from a summary, and `/branch` preserves the original. | Treat resume as a first-class, named, inspectable boundary; distinguish full-history resume from summary/compaction; preserve the original when branching. | Transcript formats are internal/versioned, and a restored transcript is not the same thing as a live Pi event context. |
| DeepSeek Harness | Cordis makes the model adapter, tools, session log, and agent loop plugins. Durable session events are the replay source; live agent events handle turn flow; the documented API includes session fork and next-request injection. | Put new continuation behavior at a documented seam, log model-visible inputs durably, and make replay/fork semantics explicit. | The architecture is a different host and remains in developer preview; its plugin graph is not a drop-in Pi extension API. |

## Actions taken in glla

1. The existing `.pi-glla/` state, dispatch sidecar, task list, completion
   claim, and audit job remain canonical. Continuation prompts already include
   a checkpoint id, objective, verification contract, task summary, next task,
   and post-compaction resynchronization instructions.
2. Designer routing is explicit and persisted, so a resumed goal/list item does
   not need to infer a specialist from natural-language prose.
3. Drafting recovery stays inside its own temporary model lease and resumes the
   existing interview; it does not consume the main-goal or auditor chain.
4. Provider recovery remains blind and generic. None of the reviewed systems is
   evidence that a plugin can reliably infer quota resets, so glla continues to
   retry without quota checking or `Retry-After` scheduling.
5. The missing host capability is recorded separately in
   [PI-HOST-SESSION-REPLACEMENT-REQUEST-2026-08-15.md](PI-HOST-SESSION-REPLACEMENT-REQUEST-2026-08-15.md)
   instead of being simulated in plugin code.

## Sources reviewed

- [OpenAI Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  — thread start/resume/fork and durable turn/session protocol.
- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference)
  — `codex resume`, `codex exec resume`, `/compact`, `/resume`, and `/fork`.
- [Claude Code session management](https://code.claude.com/docs/en/sessions)
  — continuous local transcripts, resume/continue, summary resume, and
  branching.
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
  — plugin seams, durable session events, turn flow, injection, and fork.

## Decision record

The optional research item is resolved as **documented no-change**. The
comparison produced a concrete host-API request and confirms that the current
glla approach—durable state plus explicit bounded continuation—is the right
abstraction for this plugin. The next improvement requiring external work is
Pi's event-safe session replacement capability, not another provider-specific
retry heuristic.
