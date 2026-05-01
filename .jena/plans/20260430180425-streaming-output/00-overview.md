# Plan: Streaming Output for `fullcontext`

## Problem

`fullcontext` currently buffers all child-process output in memory and only writes
the transformed, single-line result after the child exits (`src/index.ts` lines
83–112). For long-running commands (test suites, type checkers, builds) this
means the terminal is silent until the process finishes — which is the primary
pain point: the tool no longer "feels" like a normal terminal wrapper.

## Goal

Stream each transformed line to stdout/stderr as soon as the underlying `\n`
arrives from the child process, while preserving the **exact byte-for-byte
output** that the tool produces today. No CLI flag, no behavior change for
downstream consumers — only the *timing* of writes changes.

## Core Design Decision: Byte-Identical Streaming

The current output format for N lines is:

```
[1] line1 [2] line2 [3] line3\n
```

This can be produced identically in a streaming fashion by:

1. For the **first** completed line on a given stream, emit `[1] line1` (no
   leading space).
2. For each **subsequent** completed line, emit ` [N] lineN` (leading space acts
   as the separator).
3. On child close, if any bytes were emitted on a stream, emit the trailing
   `\n`.
4. If the child ends with a trailing partial line (no final `\n`), emit it as
   a numbered line during the close handler (matches current behavior — the
   current code `pop`s a trailing empty string but still emits partial lines
   as-is).

Stdout and stderr each maintain their own line counter and their own
"first-line-emitted" flag. This mirrors the current behavior, where each
stream is transformed independently.

**Consequence:** No CLI flag is required. Streaming is the default because the
output format is unchanged. Existing npm scripts, pipelines, and tests see
identical bytes — only the arrival pattern changes.

## Non-Goals

- **Per-line stream flushing via `\r`.** Progress bars (carriage-return updates)
  are still not supported; the README explicitly warns against this use case.
  A `\r` without a `\n` will continue to buffer in the partial-line buffer, as
  it does today.
- **TTY passthrough / color detection.** The child still runs with
  `stdio: 'pipe'`, so it will not detect a TTY on stdout/stderr. This matches
  current behavior. Commands that gate color on `isatty()` will still need
  `FORCE_COLOR=1` or similar, exactly as before.
- **Streaming on stdin.** stdin is already `'inherit'`; no change.
- **CLI flags.** Keep the zero-configuration promise.

## Tech Stack

- **Runtime:** Node.js ≥ 18 (raised from ≥ 14 in Phase 05 to match the
  `node:test` runtime requirement; Node 14/16 are both long past EOL and
  could not run the test suite anyway).
- **Language:** TypeScript 5.9 (unchanged).
- **Dependencies:** Zero runtime dependencies (unchanged — critical feature).
- **Test runner:** Node's built-in `node:test` module (ships with Node 18+,
  backported features in 20+, fully stable in 22). This keeps the zero-dep
  promise. For environments on Node 14–17 we document that tests require
  Node ≥ 18 even though the tool itself still supports Node 14.

## Phase Overview

| # | Phase | Story Points | Summary |
|---|-------|--------------|---------|
| 01 | Test infrastructure & baseline tests | 3 | Add `node:test`-based test harness. Extract `transformOutput` logic into a testable module. Add tests that lock in current output format as the spec. |
| 02 | Implement streaming transformer | 3 | Replace the buffer-then-transform approach with a per-stream `StreamingLineTransformer` that emits completed lines immediately. Wire into `executeCommand`. |
| 03 | Integration validation & docs | 2 | Add integration tests that spawn the compiled binary and assert streaming timing + final bytes. Update README to mention streaming. |
| 04 | Robustness: EPIPE, signals, and volume | 3 | Follow-up from a production-readiness audit. Handle EPIPE on `process.stdout`/`process.stderr` so `fullcontext <cmd> \| head` exits cleanly. Add integration tests for SIGINT forwarding, invalid UTF-8 at chunk boundaries, and ~1 MB output volume. |
| 05 | CI validation & release test gate | 3 | Pre-release infrastructure. Bump `engines` to `node >=18` to match the `node:test` runtime. Add a `ci.yml` workflow (ubuntu + macos × node 18/20/22) for push and PR validation. Reorder `release.yml` so `npm test` runs before any mutating step (version bump, tag push, GitHub release, npm publish). Document a pre-release smoke-test checklist. No source changes. |
| 06 | Signal-forwarding fix for Linux (CI red → green) | 2 | CI surfaced a real Linux-only bug: on Ubuntu (`/bin/sh` = dash), `child.kill('SIGINT')` hits the shell but not its grandchild, so the wrapper blocks in `'close'` until the grandchild exits naturally. Fix by spawning the child with `detached: true` and routing SIGINT/SIGTERM (and the EPIPE cleanup kill) through a `killChildTree` helper that signals the whole process group on POSIX, with a Windows-safe fallback. No new deps. |

**Total:** 16 story points across 6 phases. Each phase ≤ 3 points.

### Phase 04 scope note

Phase 04 intentionally does **not** attempt byte-identical comparison with
the pre-streaming implementation, and does not reintroduce the batch-at-close
output path. The user confirmed that no consumer was relying on the old
timing, so that entire risk category is dropped. Phase 04 asserts only
structural invariants (line counts, markers, trailing newlines) and
behavioral contracts (exit cleanly on EPIPE, forward SIGINT, don't corrupt
or crash on bad input).

### Phase 05 scope note

Phase 05 is pure release-readiness infrastructure — no `src/` changes, no
new runtime dependencies, no behavioral changes. It exists because the
project currently has **zero CI** and its release workflow publishes
without running tests. Phase 05 closes both gaps before the next
`latest` release. It also bumps `engines` from `>=14.0.0` to `>=18.0.0`
to match the actual test runtime requirement (`node:test` is Node 18+
only). Windows CI, canary releases, dependabot, and PR templates are
explicitly out of scope.

### Phase 06 scope note

Phase 06 is a follow-up correctness fix. Phase 05's new CI matrix
immediately surfaced a Linux-only bug in the Phase 04 SIGINT-forwarding
path: with `/bin/sh` = dash on Ubuntu, sending SIGINT to the child PID
kills the shell but leaves the grandchild (`sleep 30` in the test,
`npm test`'s node subprocess in real usage) holding the pipe open, so
the wrapper blocks in its `'close'` handler until the grandchild exits
naturally. All three Ubuntu matrix cells time out at 30 seconds on the
`forwards SIGINT to the child and exits` test; all three macOS cells
pass because bash exec-optimizes `sh -c '<single command>'` into the
sleep process. Phase 06 fixes the wrapper by spawning the child with
`detached: true` (making it a process-group leader) and routing all
signal forwards through a helper that signals the whole group on POSIX.
Zero new dependencies, no test changes — the existing test was written
correctly against the intended behavior; the wrapper is what needed to
change. Scope is deliberately minimal: one `src/index.ts` edit, one
commit, CI goes green.

## Success Criteria

1. **Byte-identical output.** For any command, running `fullcontext <cmd>`
   produces the same final stdout and stderr byte sequences as the current
   (pre-change) implementation. Verified by a golden-output test.
2. **Streaming behavior.** For a command that emits lines with delays between
   them (e.g., `sh -c 'echo a; sleep 0.2; echo b'`), the first line appears on
   the wrapper's stdout before the child exits. Verified by a timing-based
   integration test.
3. **Exit code preserved.** Unchanged from today.
4. **Signal forwarding preserved.** SIGINT/SIGTERM still forwarded.
5. **Zero new runtime dependencies.** `package.json` `dependencies` field
   remains absent/empty.
6. **Tests pass.** `npm test` green.
7. **Build passes.** `npm run build` still produces a working
   `dist/index.js` usable as a CLI.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Subtle trailing-newline mismatch between streaming and batch output | Phase 01 baseline tests capture current exact bytes for several cases (empty output, single line, multi-line, trailing-newline, no-trailing-newline, CR in middle). Phase 02 must pass all of them. |
| Multi-byte UTF-8 split across chunk boundaries | Use `StringDecoder` from `node:string_decoder` to safely decode incremental Buffer chunks without corrupting characters. |
| Interleaving between stdout and stderr lines causing confusing test expectations | Test each stream independently (two separate transformers, two separate assertions). No test should assert ordering *between* stdout and stderr. |
| `node:test` availability on older Node versions used by contributors | Document "Node ≥ 18 required for tests" in README. Runtime support for Node 14 unchanged. |
| Partial line at EOF (command prints `printf 'x'` with no newline) | Explicitly handled in Phase 02: on close, flush any non-empty partial line before writing the final `\n`. Baseline test in Phase 01 captures current behavior. |

## Out of Scope (Future Work)

- Adaptive output that switches between line-per-line and single-line based on
  whether the wrapper's stdout is a TTY.
- A `--raw` or `--stream-only` flag to skip transformation entirely.
- Binary-safe mode.
- Windows-specific newline handling (current code splits only on `\n`;
  behavior is unchanged).
