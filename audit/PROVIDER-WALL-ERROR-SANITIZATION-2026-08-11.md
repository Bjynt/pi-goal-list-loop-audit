# Provider-wall error sanitization and episode deduplication

## Scope

Quota/provider-wall errors can contain raw HTTP status, Token Plan/account text,
request ids, retry hints, and nested provider JSON. That text is diagnostic
input, not safe chat or tool copy.

## Policy

- `extensions/quota-retry.ts` creates a bounded `ProviderErrorPresentation`.
  `diagnostic` is retained for ledger/archive forensics; `display` is a stable
  provider classification; `action` is safe recovery guidance.
- `providerErrorFingerprint()` removes changing retry hints, numbers, and
  request ids so one logical wall is stable across retries.
- `claimRecoveryNotice()` stores bounded notice keys on the active goal or
  pending completion claim. Recovery notifications use the key before they
  emit, so retries in one episode do not duplicate the same warning.
- Main-model recovery persists `providerErrorDiagnostic`, `recoveryEpisodeKey`,
  and notice keys in `MainModelRecovery` and goal state. Detached completion
  recovery persists the same split on `PendingCompletion` and the owning Goal.
- Active/archived markdown exposes diagnostics only in a labeled forensics
  block; pause, status, widget, notification, and tool-result projections use
  sanitized copy.

## Regression evidence

- `tests/quota-retry.test.ts`: nested Token Plan/429 payloads are absent from
  display/action copy; changing retry hints/request ids retain one fingerprint;
  a duplicate schedule notice emits once.
- `tests/behavioral-orchestrator.test.ts`: a fake detached auditor returns a
  raw Token Plan/429 payload; completion output and recovery notifications stay
  sanitized, raw diagnostics remain durably available, and the notice key is
  claimed once.
- Main recovery behavioral coverage uses a raw Token Plan/429 payload and
  checks sanitized pause/notification copy plus durable diagnostic retention.
