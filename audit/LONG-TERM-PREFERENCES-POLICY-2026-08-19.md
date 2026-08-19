# Long-term preferences policy — 2026-08-19

## Current behavior

glla already has a durable, typed operational-settings layer, but it does not
have a general-purpose “remember anything the agent learned about me” store.
The current layers are:

- **Current explicit instruction / goal contract:** the user's current message,
  confirmed objective, and verification contract are the source of truth for
  the work in front of the agent.
- **Session state:** the active Pi model/thinking selection and other runtime
  context are ephemeral to the host session unless Pi itself persists them.
- **Global glla settings:**
  `~/.pi/agent/pi-goal-list-loop-audit.settings.json` stores user-wide
  operational defaults such as recovery, auditor, model, and continuation
  policy.
- **Project glla settings:** `<cwd>/.pi-glla/settings.json` stores
  repository-specific overrides, including tool/reviewer policy. The loader
  resolves project over global over defaults, while explicitly designated
  main-recovery/drafter keys are global-only.
- **Pi/pi-subagents configuration:** Pi's own settings and custom agent
  frontmatter are separate owners. An agent's `memory` scope, when explicitly
  configured, is not a glla preference and must not be silently mined as one.
- **Goal/list/loop state:** `.pi-glla/active.jsonl`, goal archives, and queue
  sidecars are work state and audit history, not a user-preference database.

The settings UI displays effective values with `project`, `global`, or
`default` provenance. The headless `/glla` surface is read-only and prints the
effective value plus source and the paths of both settings files. Writes go
through the settings UI or the existing settings helpers; arbitrary `/glla`
arguments are rejected rather than interpreted as hidden preference syntax.

## Policy: explicit, scoped, and reversible preferences

### Declaration

Only a known, typed setting or an explicitly authored Pi/pi-subagents agent
configuration may declare a long-term preference. A natural-language sentence
in a conversation, completion summary, auditor report, repository file, or
Explore transcript must not become a preference automatically.

A future preference record should carry at least:

```text
key · value · scope · source · updatedAt · revision
```

The value must be validated against a finite schema, and the source must say
whether it came from a user-confirmed setting, project config, or agent
configuration. Free-form “lessons” are not safe defaults: they can be stale,
secret-bearing, or prompt-injected.

### Precedence

For work decisions, use this descending precedence:

1. The user's current explicit instruction and the confirmed objective/
   verification contract.
2. An explicit current-session command/model selection or one-off tool input.
3. A confirmed project-scoped setting.
4. A confirmed global user setting.
5. Product defaults and fixed safety policy.

A preference is guidance at its scope, never a rewrite of the objective or a
permission to ignore a current instruction. In particular, the durable
`LONG_RUNNING_JUDGMENT_POLICY` is a product invariant, not a user preference
that can be changed by remembered prose. An old preference must lose to a new
explicit instruction even when the old value is more specific or was used in a
previous session.

### Scope and storage

| Scope | Store | Appropriate contents | Reset behavior |
| --- | --- | --- | --- |
| Session/one-off | Pi runtime or command argument | Current model, thinking level, temporary experiment | Ends with the session/command; never silently promoted |
| Global user | `~/.pi/agent/pi-goal-list-loop-audit.settings.json` | Defaults the user wants across projects | Remove the key to reveal the product default |
| Project | `<cwd>/.pi-glla/settings.json` | Repo-specific tool, audit, reviewer, or workflow policy | Remove the project key to reveal global/default behavior |
| Agent type | Pi/pi-subagents agent file | Role, tools, model, memory scope, prompt mode | Edit/eject/disable the authored agent config |
| Goal/list/loop | `.pi-glla` state/archive/ledger | Objective, contract, evidence, lifecycle history | Use the explicit goal/list/loop commands; never call this “preference reset” |

Settings files are already written with a lock, atomic replacement, and mode
`0600`. That is the right storage boundary for typed settings. A future
preference system must not copy free-form conversation or tool output into
these files, and it must not store a secret in a prompt-facing preference
field.

### Update and reset

- Update a preference only through a confirmed settings action or an explicit
  edit to its owned configuration file. Record the effective source in the UI;
  do not silently mutate a project file from a global setting change.
- `saveSettings(scope, cwd, { key: undefined })` is the existing clear
  operation: it removes that layer's key, allowing the next lower layer or
  default to take effect. A project reset therefore does not copy the global
  value into the project file.
- Global-only settings remain global-only. Saving one in a project file is
  stripped rather than left as a misleading inert value. This prevents a stale
  project setting from appearing to override a current global policy.
- Updates must not rewrite an already confirmed goal or contract. If a setting
  affects future work (for example, auto-resume or audit behavior), the new
  value applies at its documented lifecycle boundary and the current goal
  remains governed by its durable contract.
- There is no implicit “remember this” path and no claim that `/glla wipe`
  resets preferences: wipe is a destructive goal-state operation. A future
  all-preferences reset should be a separately named, confirmed operation that
  lists global and project files before deleting keys.

## Stale-preference safety

The safe rule is **current explicit intent wins; remembered intent is
advisory**. The implementation boundary should enforce this mechanically:

- Load and normalize only known keys. Migrate or delete deprecated aliases
  instead of letting old fields resurrect retired behavior.
- Show the source of every effective value. If a value came from global or
  project storage, the user can identify and clear it rather than guessing why
  it is active.
- Keep one-off command arguments and current goal contracts out of the
  settings merge. A settings reload must not replace a newer in-memory/user
  choice with an older snapshot.
- If a future preference conflicts with the current instruction, surface the
  conflict or ignore the preference; never rewrite the current objective,
  verification contract, or user wording to make the preference fit.
- Apply prompt-facing preferences as low-priority guidance with explicit
  provenance. Repository text, auditor reports, and Explore output remain
  evidence, not configuration instructions.

## Trade-offs

| Approach | Benefit | Cost/risk |
| --- | --- | --- |
| Keep only typed global/project settings (recommended) | Auditable, bounded, reversible, already supported by glla | Does not remember nuanced prose or cross-session lessons |
| Add an explicit user-authored preference file | Flexible and portable; can hold prose the user deliberately chose | Needs schema, precedence, privacy, and reset rules; stale guidance can still mislead |
| Automatically extract preferences from conversations | Lowest friction and broadest personalization | High false-positive, prompt-injection, privacy, and stale-instruction risk; hard to reset honestly |
| Use agent `memory` as glla preferences | Reuses pi-subagents infrastructure | Wrong ownership/scope; memory may be agent/project/user scoped and is not the glla settings contract |

The recommendation is to keep the existing settings model and make its scope
and precedence explicit. A general preference-memory feature should wait for a
specific user-approved use case and a concrete consumer; it should not be
introduced merely because cross-session “lessons memory” sounds useful.

## Implementation boundary

- **Main user/session owns explicit intent:** current messages, commands,
  model picks, and confirmed objective contracts outrank all stored defaults.
- **glla owns typed workflow settings:** `goal-settings.ts`, the `/glla` UI,
  provenance display, atomic/locked updates, and the project/global allowlist.
- **Pi core owns host settings and sessions:** Pi's own settings, session
  persistence, model registry, and session-level selections remain outside
  glla's preference store.
- **pi-subagents owns agent declarations and memory:** custom-agent
  frontmatter, `persist_session`, `memory`, and agent-scoped prompts must not be
  silently copied into glla settings.
- **glla state/ledger owns work history:** objectives, contracts, audit reports,
  and recovery evidence are not candidate preferences and must not be mined
  automatically.

No source fix is supported by this review. The existing loader, provenance
surface, atomic settings writes, global-only enforcement, and clear-by-unset
behavior already provide the safe typed boundary. A future implementation
would need a concrete preference key/use case before adding a preference record,
revision history, prompt injection, or a reset-all command.

## Evidence reviewed

- `extensions/goal-settings.ts` — `Settings`, defaults, project/global merge,
  global-only keys, provenance, atomic writes, lock, and unset/reset behavior.
- `extensions/loops/goal-settings-ui.ts` and `extensions/settings-menu.ts` —
  confirmed update controls, scope labels, and clear operations.
- `extensions/goal-commands.ts` — read-only headless `/glla` output and explicit
  command routing.
- `extensions/goal-loop-core.ts` — fixed judgment policy and durable objective
  contract boundary.
- `/home/dracon/.npm-global/lib/node_modules/@tintinweb/pi-subagents/README.md`
  and `src/custom-agents.ts` — agent frontmatter/memory ownership is distinct
  from glla settings.
- `tests/settings-editors.test.ts`, `tests/settings-menu-complete.test.ts`,
  `tests/list-settings-route.test.ts`, and `tests/autoresume-default.test.ts` —
  current settings UI/routing and global-only restore-policy regressions.
