# Phase 06 — Signal Forwarding Fix for Linux (CI Red → Green)

**Story points:** 2

## Phase Completion Protocol

Complete these steps in order. Do not skip ahead.

- [ ] Confirm Phases 01–05 are complete and committed.
- [ ] Confirm you are on the `add-streaming-output` feature branch. If not,
      stop — Phase 06 extends that branch. Do NOT commit to `main`.
- [ ] Read the failing CI run log end-to-end for at least one Ubuntu matrix
      cell (`gh run view 25207518443 --log-failed`). Confirm you see the
      same symptom described under **Diagnosis** below.
- [ ] Read `src/index.ts` (`executeCommand`) and `src/cli.test.ts`
      (the "forwards SIGINT to the child and exits" test) so you understand
      exactly what changes and what stays the same.
- [ ] Implement Task 6.1 (the `src/index.ts` fix).
- [ ] Run `npm run build` — must pass.
- [ ] Run `npm test` locally on macOS — must pass (all existing tests).
- [ ] Run the flake-guard loop for the signal/EPIPE tests:
      `for i in 1 2 3 4 5; do npm test || break; done`
- [ ] Commit the fix:
      `fix: spawn wrapped command in its own process group and forward signals to the group`
- [ ] Push the branch: `git push`
- [ ] Watch the CI run on GitHub Actions. All 6 matrix cells
      (ubuntu × {18,20,22} + macos × {18,20,22}) must go green.
- [ ] If any cell fails, diagnose and iterate — do **not** mark Phase 06
      complete until CI is fully green.
- [ ] Update `.jena/plans/20260430180425-streaming-output/STATE.md` to mark
      Phase 06 complete.
- [ ] Commit the state update: `docs(plan): mark phase 06 complete`.

## Context and Goal

The PR CI run for `add-streaming-output` (run id `25207518443`) failed on all
three Ubuntu matrix cells (Node 18, 20, 22). All three macOS cells passed.

Every failing job fails on the **same** test:

```
not ok 11 - forwards SIGINT to the child and exits
  error: 'expected wrapper to exit within 5s of SIGINT, took 29932ms'
  duration_ms: 30033.911358
```

The test sends SIGINT to the wrapper; the wrapper is expected to forward
SIGINT to the wrapped `sleep 30` and exit promptly. Instead, the wrapper
keeps running until `sleep 30` completes naturally — 30 seconds, exactly
the sleep duration. This is a real platform-specific correctness bug in
the wrapper's signal-forwarding logic, not a flake and not a test bug.

The goal of Phase 06 is to make `fullcontext` forward SIGINT/SIGTERM to
the entire wrapped-command process tree on Linux (and keep working on
macOS), so that:

- The existing `forwards SIGINT to the child and exits` test passes on
  all matrix cells without modification.
- Ctrl-C in a real terminal kills the wrapped command immediately on
  Linux (user-visible correctness win — the fix is not just a CI
  placation).

## Diagnosis

### What the current code does

`src/index.ts` spawns the wrapped command like this:

```typescript
const child = spawn(command, {
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
```

With `shell: true`, Node invokes `/bin/sh -c "<command>"`. `child.pid` is
the PID of the shell (dash on Ubuntu, bash on macOS). `child.kill(signal)`
sends the signal to that one PID only — it does **not** propagate to the
shell's own children.

### Why macOS passes

On macOS, `/bin/sh` is `bash`. When bash runs `sh -c 'sleep 30'` and the
command body is a single "simple command" with no shell features left to
execute, bash applies the "last-command exec optimization": bash calls
`exec(2)` to replace its own process image with `sleep 30`. The PID that
Node knows about is now the `sleep` process. `child.kill('SIGINT')` hits
`sleep` directly, `sleep` dies, the pipes close, Node's `close` event
fires, the wrapper exits in under a second. Test passes.

### Why Ubuntu fails

On Ubuntu, `/bin/sh` is `dash`. For `sh -c 'sleep 30'`, dash does **not**
apply the same last-command `exec` optimization — it `fork(2)`s a child
`sleep` process and then `wait(2)`s on it. The process tree is:

```
wrapper (Node)
  └── dash      (pid = child.pid)
        └── sleep 30   (grandchild)
```

When `child.kill('SIGINT')` fires, dash receives SIGINT. In non-
interactive mode dash does the POSIX default: it exits. But it does
**not** forward SIGINT to its `sleep` child first. Worse, the orphan
`sleep` keeps both pipe file descriptors (stdout, stderr — inherited
from dash when it forked) open. Node's `ChildProcess` `'close'` event
only fires when both:

1. the child has exited (dash has, so this part is fine), AND
2. the stdio streams have been fully closed (they have **not** — the
   orphan `sleep` still holds them open).

So the wrapper sits in `child.on('close', …)` for 30 seconds until
`sleep` finishes on its own and its copy of the pipe FDs is finally
closed. That is exactly the 29,932 ms the test measured.

This is a classic instance of the well-known Node.js gotcha: **when you
spawn with `shell: true` on Linux and need signals to reach the wrapped
command, you must put the child in its own process group and signal the
group, not the PID.**

### Other Phase 04 tests that happen to pass

The three EPIPE / UTF-8 / large-output tests pass on Ubuntu because:

- **EPIPE-via-head** (`for i in $(seq …); do echo $i; done`) — the shell
  itself is the process that writes lines; there is no grandchild blocking
  the pipe. SIGTERM to the shell kills the `for` loop immediately.
- **EPIPE-with-while-true** (`while true; do echo line; done`) — same
  reasoning; the shell is the writer.
- **Invalid UTF-8** and **1 MB volume** — the wrapped command exits
  naturally; signals are never sent.

So the SIGINT test is the *only* test that exercises the "signal a shell
that has a live grandchild" case. But the same bug would manifest in
practice for any user running e.g. `fullcontext npm test` on Linux and
hitting Ctrl-C — the shell would die but the `npm` grandchild would
linger, holding the wrapper open for an unpredictable time. Fixing this
test fixes the real user-facing bug.

## Fix Approach

### Recommended: `detached: true` + group-kill

Spawn the child in its own process group by setting `detached: true`.
When forwarding signals, signal the negative PID — POSIX shorthand for
"send to every process in the group with leader PID". The signal then
reaches the shell AND every grandchild the shell has forked, regardless
of whether the shell is willing to forward it.

This is the standard Node.js pattern for "my child is a shell and I
want signals to reach the wrapped command." It is documented in
`node:child_process` (see `options.detached` and `subprocess.kill()`)
and used by tools like `execa`, `kill-port`, `foreman`, and `cross-spawn`.

### Why not the alternatives

| Approach | Rejected because |
|---|---|
| Always invoke `bash -c` instead of `sh -c` | Requires bash to be installed. Ubuntu ships `/bin/sh` as dash deliberately for startup-speed reasons; our tool should not assume bash exists. Also papers over the general issue: even bash won't always exec-optimize (e.g. if the command has `&&` or redirects), so we would have introduced a subtler version of the same bug. |
| Manually track the child tree (walk `/proc`) | Enormous complexity for a problem the kernel already solves via process groups. Zero-dependency promise is easier kept with the built-in group mechanism. |
| Use `pidtree` or a similar npm package | Adds a runtime dependency. Phase 06 constraint: zero new runtime dependencies. |
| Swap to `spawn(cmd, args, { shell: false })` and parse the user's command | Out of scope; would break pipes/redirects/`&&` which are the main value-adds of `shell: true`. Users rely on wrapping whole command strings. |

### Platform considerations

- **POSIX (Linux + macOS):** `detached: true` makes the child the leader
  of a new process group. `process.kill(-child.pid, signal)` targets the
  group. Works identically on both platforms.
- **Windows:** `detached: true` on Windows starts the child in a new
  console. Negative-PID signaling does not exist on Windows, and Node's
  `process.kill(-pid)` throws `ESRCH`. The fix guards on
  `process.platform !== 'win32'` and falls back to plain `child.kill()`
  on Windows. Windows is not currently covered by CI (Phase 05's matrix
  is ubuntu + macos only), so "must not regress Windows" is a code-read
  argument, not a tested one. The fall-back preserves pre-Phase-06
  behavior on Windows exactly.
- **stdio inheritance:** `detached: true` does **not** change pipe
  semantics for our stdio config (`['inherit', 'pipe', 'pipe']`). stdin
  still inherits from the wrapper, stdout/stderr still come back through
  pipes. Confirmed by the Node docs and by the fact that `execa` uses
  this exact combination.
- **unref():** We do **not** call `child.unref()`. Calling `unref()`
  would let the wrapper exit while the child is still running — the
  opposite of what we want. `detached: true` without `unref()` is the
  standard "group leadership only" idiom.

### Exit-code propagation unchanged

The child still emits `'close'` with a `(code, signal)` pair. Our
existing handler does `process.exit(code ?? 1)`. When the child dies from
a signal, `code` is `null` and `signal` is e.g. `'SIGINT'`; we exit `1`.
That matches the test assertion
`exit.code !== 0 || exit.signal !== null`. No change needed here.

### EPIPE handler: same group-kill treatment

For consistency (and to prevent a symmetric bug where a grandchild keeps
writing to a dead pipe on Linux), the EPIPE handler's `child.kill('SIGTERM')`
call is updated to use the same group-kill helper. This is a behavior
upgrade, not a regression: on macOS bash exec-optimizes so group-kill
and direct-kill land on the same PID; on Linux group-kill is strictly
better than direct-kill.

## Task

### Task 6.1 — Spawn detached + signal the process group

Modify `src/index.ts`. Three changes:

1. Add `detached: true` to the `spawn` options.
2. Extract a `killChildTree(signal)` helper that does the group-kill on
   POSIX and falls back to `child.kill(signal)` on Windows or if the
   group is already gone.
3. Route both the EPIPE SIGTERM path and the SIGINT/SIGTERM forward path
   through that helper.

**Full rewritten `executeCommand` (the rest of `src/index.ts` — `USAGE`,
`main`, and imports — is unchanged). The diff from Phase 04 is minimal;
lines 1–42 and 144–161 of the current file do not need edits.**

```typescript
/**
 * Execute a command and transform its output.
 */
function executeCommand(command: string): void {
  // Spawn the command in a shell to support pipes, redirects, etc.
  //
  // `detached: true` makes the child the leader of a new process group.
  // That lets us signal the entire wrapped-command tree (shell + any
  // grandchildren the shell may have forked) via process.kill(-pid, sig),
  // rather than just the shell PID. This is critical on Linux where
  // /bin/sh is dash: dash fork(2)s a child for `sh -c 'cmd'` and does not
  // forward SIGINT to that child. Without group signalling, SIGINT kills
  // the shell but the grandchild keeps the pipe open and we block in
  // 'close' until the grandchild exits on its own. See Phase 06 plan.
  //
  // We intentionally do NOT call child.unref(): we want the wrapper to
  // keep running until the child tree exits, exactly as before.
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  });

  /**
   * Send a signal to the child's entire process group on POSIX, falling
   * back to a direct signal-to-PID on Windows or when the group is
   * already gone.
   *
   * Always swallows ESRCH-style errors — if the child already exited, a
   * failed kill is the desired outcome, not a bug to surface.
   */
  const killChildTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        // Negative PID = "every process in the group led by this PID".
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Group is gone (child already exited) or not signalable from
        // this process; fall through to a best-effort direct kill.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Child may have exited between the platform check and kill.
    }
  };

  // Track the child's exit code so the EPIPE handler can preserve it if
  // the child finished before the downstream pipe broke.
  let childExitCode: number | null = null;

  // Guard against re-entering the shutdown path. EPIPE can fire on both
  // stdout and stderr in quick succession; we only want to clean up once.
  let exiting = false;

  /**
   * Handle an 'error' event from process.stdout or process.stderr.
   *
   * For EPIPE: a downstream consumer (like `head`) has closed the pipe we
   * were writing to. Kill the child tree so it stops generating output,
   * then exit cleanly. Preserve the child's exit code if known; otherwise
   * use 0 to match the convention of coreutils tools that treat
   * downstream pipe closure as normal termination.
   *
   * For anything else: re-throw so real bugs surface instead of being
   * silently swallowed.
   */
  const handleOutputError = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EPIPE') {
      throw err;
    }
    if (exiting) {
      return;
    }
    exiting = true;

    // Stop the entire child tree so nothing keeps writing into a broken
    // pipe. If the shell already exited this is effectively a no-op.
    if (child.exitCode === null && child.signalCode === null) {
      killChildTree('SIGTERM');
    }

    process.exit(childExitCode ?? 0);
  };

  process.stdout.on('error', handleOutputError);
  process.stderr.on('error', handleOutputError);

  // Handle spawn errors (e.g., shell not found)
  child.on('error', (err: Error) => {
    process.stderr.write(`[1] fullcontext: ${err.message}\n`);
    process.exit(1);
  });

  // Forward SIGINT/SIGTERM to the entire child tree so a Ctrl-C in the
  // user's terminal (or a kill from a parent process) reaches the
  // wrapped command's grandchildren, not just the shell.
  process.on('SIGINT', () => killChildTree('SIGINT'));
  process.on('SIGTERM', () => killChildTree('SIGTERM'));

  // One transformer per output stream. Each maintains its own line counter
  // and its own "first-line-emitted" state, matching the existing behavior
  // where stdout and stderr are transformed independently.
  const stdoutTransformer = new StreamingLineTransformer(process.stdout);
  const stderrTransformer = new StreamingLineTransformer(process.stderr);

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutTransformer.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTransformer.write(chunk);
  });

  child.on('close', (code: number | null) => {
    // Record the exit code so that if an EPIPE handler is invoked during
    // the flush below, it can preserve the child's actual exit code.
    childExitCode = code;

    // If we've already begun shutting down via EPIPE, don't double-exit.
    if (exiting) {
      return;
    }

    // Flush any partial lines and emit trailing newlines.
    stdoutTransformer.end();
    stderrTransformer.end();

    // Preserve exit code from child process
    process.exit(code ?? 1);
  });
}
```

**No import changes.** `spawn` is already imported; `process.kill` and
`process.platform` are on the global `process` object.

**No test changes.** The existing `forwards SIGINT to the child and
exits` test in `src/cli.test.ts` was written correctly; it was the
wrapper that was wrong. After this fix, the test passes on Linux without
modification.

### Optional: tightened SIGINT-test assertion (do NOT do this in Phase 06)

Once Phase 06 is green on CI, a future small polish would be to tighten
the SIGINT test's upper-bound assertion from 5000 ms to ~1000 ms (since
the fix makes exits near-instantaneous) and to additionally assert the
grandchild is not lingering. These are nice-to-have follow-ups that
would belong in a Phase 07, not here. Phase 06 intentionally leaves the
test as-is so the fix is verifiable against the exact assertion that
has been failing in CI.

## Acceptance Criteria

- `src/index.ts` passes `detached: true` to `spawn`.
- `src/index.ts` contains a `killChildTree(signal)` helper used by both
  the EPIPE SIGTERM path and the SIGINT/SIGTERM forwarders.
- `killChildTree` uses `process.kill(-child.pid, signal)` on non-Windows
  platforms and falls back to `child.kill(signal)` on Windows or on a
  failed group-kill, swallowing errors in both cases.
- No changes under `src/streaming-transformer.ts`, `src/transform.ts`,
  or `src/*.test.ts`. (The bug was in the wrapper, not the transformer
  or the tests.)
- `npm run build` exits 0.
- `npm test` exits 0 on macOS (local verification).
- Five consecutive `npm test` runs all pass locally (no flakes
  introduced).
- **CI on GitHub Actions passes all 6 matrix cells** for the next push
  to `add-streaming-output`: ubuntu-latest × {Node 18, 20, 22} AND
  macos-latest × {Node 18, 20, 22}. This is the headline success
  criterion — the reason Phase 06 exists.
- No new runtime dependencies (`dependencies` field remains absent).
- Manual smoke test on Linux (if available) or any POSIX machine:
  ```bash
  node dist/index.js 'sleep 30' &
  WRAPPER_PID=$!
  sleep 0.3
  kill -INT $WRAPPER_PID
  # Wrapper should exit within ~1 second. `wait` should return promptly.
  wait $WRAPPER_PID
  ```

## Commit Discipline

Two commits for Phase 06:

1. `fix: spawn wrapped command in its own process group and forward signals to the group`
   — the `src/index.ts` change.
2. `docs(plan): mark phase 06 complete`
   — `STATE.md` update.

A single-commit variant is acceptable if you prefer:
`fix: forward signals to wrapped-command process group for Linux compatibility`
(combines the `src/index.ts` change and the `STATE.md` mark-complete).

## Verification Commands

```bash
# Build and run the full test suite
npm run build
npm test

# Flake-guard: run the suite five times. None should fail.
for i in 1 2 3 4 5; do npm test || break; done

# Manual SIGINT smoke test (POSIX only).
#
# Expected: the "exited in Xms" line shows a small number (well under
# 1000 ms), NOT ~30000 ms. A pre-fix build would print ~30000.
node dist/index.js 'sleep 30' &
WRAPPER_PID=$!
START=$(date +%s%N)
sleep 0.3
kill -INT $WRAPPER_PID
wait $WRAPPER_PID 2>/dev/null
END=$(date +%s%N)
echo "exited in $(( (END - START) / 1000000 ))ms"

# Push the branch and observe the CI run.
git push
# Then open:
#   https://github.com/sibryl/fullcontext/actions
# and confirm all 6 matrix cells are green for the latest push to
# add-streaming-output. If any Ubuntu cell still shows the
# 'forwards SIGINT to the child and exits' failure, STOP and
# re-diagnose — do not mark Phase 06 complete.
```

## Open Questions / Future Work

- **Windows verification.** The README claims Windows support but Phase
  05's CI matrix is ubuntu + macos only. The `killChildTree` helper
  guards on `process.platform !== 'win32'` so Windows falls back to the
  pre-Phase-06 behavior (direct `child.kill`). That is not a regression,
  but it is also not a fix for Windows. If a Windows user ever reports
  "Ctrl-C doesn't stop the wrapped command," a follow-up would
  investigate Windows' `CREATE_NEW_PROCESS_GROUP` flag and
  `GenerateConsoleCtrlEvent` (both reachable via Node's Windows-specific
  spawn options). Out of scope here.
- **Preserve signal in wrapper's own exit.** When the child dies from
  SIGINT, the wrapper currently exits with code 1 (from `code ?? 1`).
  A more POSIX-pure behavior would be to re-raise the signal on the
  wrapper itself so the outer shell sees `$? == 130` and (e.g.) a
  `trap` sees the signal. Nice-to-have, not required by the failing
  test. Would belong in a future phase.
- **Tighten the SIGINT test's 5-second generous bound.** Post-fix the
  wrapper exits in <100 ms; tightening the assertion to 1000 ms would
  catch any future regression faster. Not in scope for Phase 06; leave
  the assertion as-is so this phase is a pure fix verified against
  the existing test.
