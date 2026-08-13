# Windows detached-auditor launch — 2026-08-13

## Finding

GitHub issue #7 reported that every detached audit on Windows failed with
`pi launch failed: spawn pi ENOENT`. The npm-installed `pi` command is a
`pi.cmd` shim on Windows, not a directly executable `pi.exe`. The current
worker used `child_process.spawn("pi", args)` and therefore never reached the
RPC session.

GitHub PRs #8 and #9 both proposed the relevant Windows launch correction.
PR #8 also deleted the destination before retrying an atomic JSON rename.
That deletion creates a visible missing-file window and can lose the prior
valid snapshot if the retry fails, so it was not copied verbatim.

## Implementation in local v0.34.133

- `scripts/goal-auditor-launch.mjs` builds the platform-specific child launch.
  POSIX remains direct and shell-less. Windows invokes the configured
  `ComSpec` with `/d /s /c`, an outer command quote, individually quoted
  arguments, and `windowsVerbatimArguments: true`.
- `%`, CR, and LF are rejected in Windows launch arguments because they cross
  the command-interpreter expansion boundary. Model IDs and fixed auditor
  flags remain ordinary quoted arguments; the prompt still travels over RPC
  stdin, not the shell command line.
- Parent and worker atomic JSON writes retry transient Windows rename errors
  (`EACCES`, `EBUSY`, `ENOTEMPTY`, `EPERM`) for 25/50/100/200ms while leaving
  the old destination in place. This preserves the old-or-complete-new
  snapshot guarantee.
- Windows cancellation uses `taskkill /t /f` for the cmd/pi process tree,
  with a bounded direct-child fallback if the tree command races or is
  unavailable.
- The launch, retry, and process-tree contracts are covered by deterministic
  Linux tests that
  exercise the Windows branch with an explicit platform argument. The real
  worker contract tests still run through the POSIX direct-launch path.

## Verification

```text
bun test tests/auditor-process.test.ts   26 pass / 0 fail
npx tsc --noEmit                         clean
node --check scripts/goal-auditor-launch.mjs
node --check scripts/goal-auditor-worker.mjs
npm pack --dry-run                       package includes the new launch helper
```

A native Windows runner is not available in this checkout, so an actual
`cmd.exe`/npm-shim end-to-end run remains environment validation. The launch
spec is isolated and testable without pretending that Linux is Windows.
