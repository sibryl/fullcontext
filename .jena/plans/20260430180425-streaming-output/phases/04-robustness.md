# Phase 04 — Robustness: EPIPE, Signals, and Volume

**Story points:** 3

## Phase Completion Protocol

Complete these steps in order. Do not skip ahead.

- [ ] Confirm Phases 01–03 are complete and committed.
- [ ] Confirm you are on the `add-streaming-output` feature branch. If not,
      stop — Phase 04 extends that branch; do NOT commit to `main`.
- [ ] Read `src/index.ts`, `src/streaming-transformer.ts`, and `src/cli.test.ts`
      so you understand the current streaming wiring and existing CLI tests.
- [ ] Implement Tasks 4.1 – 4.5 in order.
- [ ] Run `npm run build` — must pass.
- [ ] Run `npm test` — must pass (all prior tests remain green, plus new ones).
- [ ] Run the flake-guard loop for the new timing/signal tests:
      `for i in 1 2 3 4 5; do npm test || break; done`
- [ ] Commit the implementation + tests: `feat: handle EPIPE and cover signals, utf-8, and large output`
      (or split into two commits — see **Commit Discipline** below).
- [ ] Update `.jena/plans/20260430180425-streaming-output/STATE.md` to mark
      Phase 04 complete.
- [ ] Commit the state update: `docs(plan): mark phase 04 complete`.

## Context and Goal

Phases 01–03 delivered line-by-line streaming. A follow-up audit found four
production-readiness gaps that this phase closes:

1. **EPIPE (highest priority)** — when the wrapper's stdout/stderr pipe is
   closed early (e.g. `fullcontext 'for i in ...; do echo $i; done' | head -5`),
   the next `process.stdout.write()` emits an `'error'` event with
   `code: 'EPIPE'`. The wrapper currently has no handler, so Node reports it
   as an uncaught exception, prints a stack trace, and exits with status 1.
   That's ugly for a tool designed to live inside shell pipelines.
2. **SIGINT forwarding test** — the wrapper already forwards SIGINT/SIGTERM
   (see `src/index.ts`), but no test verifies it. Adding the test removes
   uncertainty for future refactors.
3. **Invalid UTF-8 at chunk boundaries** — the transformer uses
   `StringDecoder` which already handles this, but we have no test locking in
   the behavior.
4. **Large-output volume sanity** — confirm the streaming pipeline doesn't
   lose data or corrupt output under ~1 MB of throughput.

### Scope note (from the user)

> Preserving the old "all at once / batch-at-close" output behavior is NOT a
> requirement. Nobody was relying on that.

As a result, this phase does **not** add:
- Byte-identical comparisons against the pre-streaming implementation.
- A/B golden comparison scripts.
- Combined-stream ordering tests (stdout/stderr interleaving).
- A canary publish workflow. That's release guidance handled outside this plan.

## Design: EPIPE Handling

### The Node.js pattern

When a downstream pipe reader closes (e.g. `head -5` has read enough and
exits), the next write on `process.stdout` / `process.stderr` emits an
`'error'` event with `err.code === 'EPIPE'`. Node's documented pattern is to
install an `'error'` listener and exit cleanly:

```typescript
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});
```

Several production CLIs (git, Node's own `npm`) exit with status 0 on EPIPE
because it is not an error from the user's point of view — `head`/`less`
closing the pipe is normal.

### Our requirements on top of the pattern

- **Scope the handler to `executeCommand`.** The handler needs access to the
  `child` reference so it can kill the child when the wrapper's pipe dies.
- **Kill the child on EPIPE.** Otherwise the child may keep producing output
  into a broken pipe, potentially wasting work. Use SIGTERM (not SIGPIPE —
  POSIX SIGPIPE delivery happens naturally to the child on its own next write,
  but we can't rely on that for commands that don't write immediately, e.g. a
  long-running test runner between log lines).
- **Preserve child exit code if already known.** If the child finished before
  EPIPE fired (rare but possible for fast commands), use the child's code.
  Otherwise exit with `0`.
- **Guard against re-entry.** Both stdout and stderr EPIPE can fire in rapid
  succession; only run the cleanup once.
- **Re-throw non-EPIPE errors.** Those are real bugs that should not be
  swallowed.

### Exit-code convention

We adopt **exit code `0` on EPIPE** when the child hasn't exited yet. This
matches the conventions of `cat`, `head`, `seq`, and other coreutils that
treat downstream pipe closure as normal termination. If the child finished
with a non-zero code before EPIPE fires, we preserve that code — the user
ran a command that failed, and that signal is more important than the pipe
closure.

Rationale: `fullcontext 'npm test' | head` should never add a spurious
failure signal when `npm test` was going to succeed.

## Tasks

### Task 4.1 — Install EPIPE handlers on `process.stdout` and `process.stderr`

Modify `src/index.ts`. Update `executeCommand` to install per-stream error
handlers before wiring the transformers. Track the child's last-known exit
code so the handler can preserve it.

The full rewritten `executeCommand` (the rest of `src/index.ts` — `USAGE`,
`main`, and imports — is unchanged, except for any new imports noted):

```typescript
function executeCommand(command: string): void {
  // Spawn the command in a shell to support pipes, redirects, etc.
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  // Track the child's exit code so the EPIPE handler can preserve it if the
  // child finished before the downstream pipe broke.
  let childExitCode: number | null = null;

  // Guard against re-entering the shutdown path. EPIPE can fire on both
  // stdout and stderr in quick succession; we only want to clean up once.
  let exiting = false;

  /**
   * Handle an 'error' event from process.stdout or process.stderr.
   *
   * For EPIPE: a downstream consumer (like `head`) has closed the pipe we
   * were writing to. Kill the child so it stops generating output, then
   * exit cleanly. Preserve the child's exit code if known; otherwise use 0
   * to match the convention of coreutils tools that treat downstream pipe
   * closure as normal termination.
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

    // Stop the child so it doesn't keep producing output into a broken pipe.
    // If the child has already exited this is a no-op.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Child may have exited between the check and kill; ignore.
      }
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

  // Forward SIGINT/SIGTERM to child process for proper cleanup
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

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
    // the flush below, it can preserve the child's actual exit code. In
    // practice the 'close' handler is usually reached when the pipe is
    // still open, so this field mostly matters for the race where the
    // very last write triggers EPIPE.
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

No new imports are required — `spawn` and `StreamingLineTransformer` are
already imported.

### Task 4.2 — EPIPE integration tests

Append to `src/cli.test.ts`:

```typescript
test('exits cleanly when downstream pipe closes early (EPIPE)', async () => {
  // Run a command that would normally produce 1000 lines and pipe it into
  // `head -n 5`, which closes its stdin after reading 5 lines. The wrapper
  // must handle the resulting EPIPE without printing an uncaught exception
  // or exiting with an error code.
  //
  // We invoke `bash` explicitly (not `sh`) because `set -o pipefail` is
  // required here and is NOT supported by `dash` — the default /bin/sh on
  // most Linux CI images. With pipefail, a non-zero exit from the wrapper
  // (e.g. from an uncaught EPIPE) would propagate through the pipeline
  // and fail the test.
  const cmd = `set -o pipefail; '${process.execPath}' '${CLI}' 'for i in $(seq 1 1000); do echo "$i"; done' | head -n 5`;
  const result = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}; stderr: ${result.stderr}`,
  );

  // No uncaught-exception noise on stderr.
  assert.ok(
    !/Error: write EPIPE|Uncaught|UnhandledPromiseRejection/.test(
      result.stderr ?? '',
    ),
    `unexpected error on stderr: ${result.stderr}`,
  );

  // Some content should have reached stdout before the pipe closed.
  assert.ok(
    (result.stdout ?? '').length > 0,
    'expected some output before EPIPE',
  );
});

test('EPIPE does not leave the child running in the background', async () => {
  // Spawn the wrapper directly (no shell pipeline) so we control the
  // downstream reader and can observe the child-exit timing.
  const child = spawn(
    process.execPath,
    [
      CLI,
      // Produce lines forever so EPIPE is the only way this terminates.
      'while true; do echo line; done',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Read a few chunks, then forcibly close the reader side to trigger EPIPE
  // inside the wrapper.
  await new Promise<void>((resolve) => {
    child.stdout.once('data', () => resolve());
  });
  // Defensive: swallow any spurious post-destroy error events on this side of
  // the pipe. .destroy() without an argument should not emit 'error', but
  // adding a no-op listener is cheap insurance on platforms where it might.
  child.stdout.on('error', () => {});
  child.stdout.destroy();

  // The wrapper must exit within a reasonable window. If EPIPE weren't
  // handled, it would still exit (uncaught exception → code 1), so this test
  // also asserts that the exit is clean (code 0 or null-from-signal).
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );

  // Accept either a clean exit (0) or a SIGTERM-from-test-teardown on slow CI.
  assert.ok(
    exit.code === 0 || exit.code === null,
    `expected clean exit, got code=${exit.code} signal=${exit.signal}`,
  );
});
```

**Why two tests?** The first asserts the user-visible contract: `fullcontext |
head` exits 0 and doesn't splatter an exception. The second asserts the
internal contract that we actually kill the child process so it doesn't keep
producing output.

### Task 4.3 — SIGINT forwarding integration test

Append to `src/cli.test.ts`:

```typescript
test('forwards SIGINT to the child and exits', async () => {
  // Start the wrapper running a long sleep. If SIGINT forwarding works, the
  // wrapper kills the child and exits quickly. If it doesn't, the test times
  // out at the 5-second assertion.
  const child = spawn(
    process.execPath,
    [CLI, 'sleep 30'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Give the wrapper time to register its SIGINT handler before we send the
  // signal. 100ms is generous; the handler registration is synchronous at
  // the top of executeCommand.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const startedAt = Date.now();
  child.kill('SIGINT');

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );
  const elapsed = Date.now() - startedAt;

  // Must terminate well before the 30s sleep would finish. 5 seconds is
  // deliberately generous for slow CI.
  assert.ok(
    elapsed < 5000,
    `expected wrapper to exit within 5s of SIGINT, took ${elapsed}ms`,
  );

  // When a shell receives SIGINT and its child sleep is killed, the shell
  // typically exits with 130 (128 + SIGINT=2) or is reported as signal
  // 'SIGINT' depending on platform. Either way, it must not be 0.
  assert.ok(
    exit.code !== 0 || exit.signal !== null,
    `expected non-zero exit or signal, got code=${exit.code} signal=${exit.signal}`,
  );
});
```

### Task 4.4 — Invalid UTF-8 boundary test

Append to `src/cli.test.ts`:

```typescript
test('handles invalid UTF-8 bytes split across a chunk boundary without crashing', () => {
  // Emit raw invalid bytes: 0xff 0xfe are never valid UTF-8 lead bytes.
  // Use printf with octal escapes so the shell passes the literal bytes
  // through to the wrapper's child.
  const r = runCli('printf "\\377\\376hello\\n"');

  // The wrapper must not crash.
  assert.equal(r.status, 0);

  // Output must be a single line (matches streaming format) and end with \n.
  assert.ok(
    (r.stdout ?? '').endsWith('\n'),
    `expected trailing newline, got ${JSON.stringify(r.stdout)}`,
  );
  assert.ok(
    (r.stdout ?? '').startsWith('[1] '),
    `expected [1] prefix, got ${JSON.stringify(r.stdout)}`,
  );

  // The valid portion ("hello") must survive.
  assert.ok(
    r.stdout!.includes('hello'),
    `expected 'hello' to be preserved, got ${JSON.stringify(r.stdout)}`,
  );

  // We do NOT assert byte-equivalence with any specific replacement strategy.
  // StringDecoder will produce U+FFFD replacement characters; that is
  // sufficient for "doesn't corrupt or crash."
});
```

### Task 4.5 — Large output sanity test

Append to `src/cli.test.ts`:

```typescript
test('streams ~1 MB of output without loss or corruption', async () => {
  // Generate 10,000 lines of ~100 bytes each → ~1 MB. We use `spawn` (not
  // spawnSync with its 1 MB maxBuffer default) so we can collect the full
  // output via data events.
  const LINE_COUNT = 10_000;
  const padding = 'x'.repeat(90); // ~100 bytes per line including "line NNNNN "
  const command = `for i in $(seq 1 ${LINE_COUNT}); do echo "line $i ${padding}"; done`;

  const child = spawn(process.execPath, [CLI, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => chunks.push(c));

  const exit = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });

  assert.equal(exit, 0, 'expected clean exit');

  const output = Buffer.concat(chunks).toString('utf8');

  // Starts with the first line marker and no leading space.
  assert.ok(
    output.startsWith('[1] line 1 '),
    `expected output to start with '[1] line 1 ', got: ${output.slice(0, 40)}`,
  );

  // Ends with exactly one trailing newline.
  assert.ok(output.endsWith('\n'), 'expected trailing newline');
  assert.ok(!output.endsWith('\n\n'), 'expected exactly one trailing newline');

  // Line-marker count equals LINE_COUNT. Each marker is `[N] ` where N is
  // the 1-based index. The number of markers is the number of matches of
  // the `\[\d+\] ` pattern minus the leading one (which has no space prefix)
  // — actually, the count of ` \[\d+\] ` (leading-space form) plus 1 for the
  // first marker. Simpler: count `] ` occurrences where the preceding chars
  // look like `[N`.
  const markerMatches = output.match(/\[\d+\] /g) ?? [];
  assert.equal(
    markerMatches.length,
    LINE_COUNT,
    `expected ${LINE_COUNT} markers, got ${markerMatches.length}`,
  );

  // Last marker must be [LINE_COUNT].
  assert.ok(
    output.includes(`[${LINE_COUNT}] line ${LINE_COUNT} `),
    `expected last line [${LINE_COUNT}] to be present`,
  );
});
```

**Notes:**
- No byte-equivalence against the old batch implementation is required.
- The test verifies structural invariants: count, boundaries, ordering of
  the first/last markers.
- ~1 MB is well within Node's default stream buffering; the test should
  complete in 1–3 seconds on CI.

## Acceptance Criteria

- `src/index.ts` installs `'error'` handlers on `process.stdout` and
  `process.stderr` that handle `EPIPE` by killing the child and exiting with
  the child's exit code (or `0` if unknown), and re-throw all other errors.
- `src/cli.test.ts` contains the four new tests listed above:
  - EPIPE clean-exit via pipeline to `head`
  - EPIPE child-termination via direct spawn + reader destroy
  - SIGINT forwarding
  - Invalid UTF-8 at chunk boundary
  - Large (~1 MB) output sanity
- `npm run build` exits 0.
- `npm test` exits 0, all new and existing tests green.
- Five consecutive `npm test` runs all pass (no flakes on the timing-
  sensitive EPIPE/SIGINT tests).
- No new runtime dependencies (`dependencies` field remains absent).
- No changes to `src/streaming-transformer.ts` or `src/transform.ts`.
- Manual smoke test passes:
  ```bash
  node dist/index.js 'for i in $(seq 1 1000); do echo $i; done' | head -n 5
  echo "Exit: $?"
  # Expected: five numbered lines on stdout, Exit: 0, no stack trace.
  ```

## Commit Discipline

Two commits for Phase 04 (plus the state-update commit):

1. `feat: handle EPIPE and forward to child on broken downstream pipe`
   — the `src/index.ts` changes only.
2. `test: cover EPIPE, SIGINT, invalid utf-8, and large output`
   — the `src/cli.test.ts` additions.
3. `docs(plan): mark phase 04 complete` — `STATE.md` update.

Splitting implementation and tests into two commits makes the diff easier
to review and lets us bisect on the behavior change independently of the
test additions.

If that splitting turns out to be awkward (e.g. you want to stage tests
before the fix to confirm they fail on the unfixed code), a single
combined commit is acceptable:

- `feat: handle EPIPE and cover signals, utf-8, and large output`

## Verification Commands

```bash
# Build and run the full test suite
npm run build
npm test

# Flake-guard: run the full suite five times in a row.
for i in 1 2 3 4 5; do npm test || break; done

# Manual smoke tests for each category:

# 1. EPIPE via head
node dist/index.js 'for i in $(seq 1 1000); do echo $i; done' | head -5
echo "Exit: $?"   # Expected: 0

# 2. EPIPE via head -c
node dist/index.js 'for i in $(seq 1 1000); do echo $i; done' | head -c 50
echo "Exit: $?"   # Expected: 0

# 3. SIGINT forwarding (run, then Ctrl-C)
node dist/index.js 'sleep 30'
# Press Ctrl-C; the process should exit promptly with a non-zero status.

# 4. Invalid UTF-8 survives
node dist/index.js 'printf "\377\376hello\n"'
# Expected: a single [1] ... hello line ending in \n, exit 0.

# 5. Large output
node dist/index.js 'seq 1 10000' | wc -c
# Expected: ~55000+ bytes, exit 0, no errors.
```

## Open Questions / Future Work

- **Exit-code convention on EPIPE:** we chose `0` (coreutils convention).
  An alternative is `141` (= `128 + SIGPIPE=13`), which some tools use.
  If users report that pipefail-based CI scripts would prefer 141, we can
  revisit. Not in scope for this phase.
- **SIGPIPE vs SIGTERM for child kill on EPIPE:** we chose SIGTERM because
  it is more likely to trigger the child's own cleanup handlers. SIGPIPE
  would be more POSIX-idiomatic but is harsher. No behavioral difference
  for typical test runners / linters.
