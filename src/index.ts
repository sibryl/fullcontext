#!/usr/bin/env node

// fullcontext - Stop AI agents from truncating your command output

import { spawn } from 'child_process';
import { StreamingLineTransformer } from './streaming-transformer';

const USAGE = `fullcontext - Stop AI agents from truncating your command output

Usage: fullcontext <command> [arguments...]

Examples:
  fullcontext npm test
  fullcontext npx eslint src/
  fullcontext cargo build
  fullcontext pytest
  fullcontext go test ./...

  # For commands with pipes or &&, wrap in quotes:
  fullcontext 'npm run lint:es && npm run lint:ts'
  fullcontext 'echo "test" | cat'

How It Works:
  Transforms multi-line output into a single line with [N] markers.
  When output is a single line, there's nothing to head or tail.
  The agent gets everything.

Features:
  - Zero configuration - Just prefix your command
  - Preserves exit codes - CI/CD pipelines work correctly
  - Preserves environment - AWS CLI, kubectl, etc. work seamlessly
  - Transforms both stdout and stderr - Nothing escapes

Best For:
  Test runners, linters, type checkers, and build tools where
  missing output causes agent confusion.

More info: https://github.com/sibryl/fullcontext`;

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
    // See child.on('close') below: set exitCode and let the runtime exit
    // naturally so buffered stderr bytes are flushed before termination.
    process.exitCode = 1;
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

    // Race guard for older libuv (observed on macOS Node 18): the child
    // may have been group-killed by our EPIPE handler, but the 'close'
    // event can fire before the 'error' event on process.stdout. In that
    // case code is null (signal-killed) and `code ?? 1` would exit 1,
    // masking what is semantically a normal EPIPE termination.
    //
    // If our own stdout is no longer writable, the downstream consumer
    // closed their read end — treat this as EPIPE and exit 0 to match
    // coreutils convention, regardless of which event won the race.
    if (process.stdout.destroyed || process.stdout.writableEnded) {
      process.exit(0);
    }

    // Flush any partial lines and emit trailing newlines. These writes go
    // into Node's internal stdout/stderr buffers and are drained to the OS
    // asynchronously by libuv.
    stdoutTransformer.end();
    stderrTransformer.end();

    // Do NOT call process.exit(): it is synchronous and does not wait for
    // buffered pipe writes to drain. Under load (e.g. ~1 MB of prior
    // output), the final bytes — including the trailing newline written
    // by stdoutTransformer.end() — can still be in Node's internal write
    // buffer or libuv's write queue at the moment of exit and would be
    // dropped, producing silently truncated output (observed as an
    // intermittent "expected trailing newline" failure in the 1 MB
    // streaming test on slow CI runners, and reproducible in the wild as
    // `fullcontext big-cmd > file.txt` producing a file missing its last
    // bytes).
    //
    // Setting process.exitCode and returning lets the runtime exit
    // naturally once every pending stdout/stderr write has been accepted
    // by the OS. Pending libuv write requests are tracked as active
    // requests on the stdio handles and keep the event loop alive; the
    // SIGINT/SIGTERM listeners registered via process.on() are backed by
    // unref'd uv_signal_t handles and do not hold the loop open. This is
    // the pattern Node's own docs prescribe for this exact class of bug
    // (see https://nodejs.org/api/process.html#processexit ).
    process.exitCode = code ?? 1;
  });
}

function main(): void {
  // Extract command arguments (skip node and script path)
  const args = process.argv.slice(2);

  // Display usage if no arguments provided or help requested
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    // Set exitCode + return rather than process.exit(): when stdout is a
    // pipe (e.g. `fullcontext --help | head`), synchronous process.exit
    // can drop buffered writes before libuv has flushed them to the OS.
    // See the matching pattern in executeCommand's 'close' handler.
    process.exitCode = 0;
    return;
  }

  // Join all arguments into a single command string for shell execution
  // This supports pipes (|), redirects (>), chains (&&), and other shell features
  const command = args.join(' ');

  executeCommand(command);
}

main();
