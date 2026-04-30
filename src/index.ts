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

function main(): void {
  // Extract command arguments (skip node and script path)
  const args = process.argv.slice(2);

  // Display usage if no arguments provided or help requested
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Join all arguments into a single command string for shell execution
  // This supports pipes (|), redirects (>), chains (&&), and other shell features
  const command = args.join(' ');

  executeCommand(command);
}

main();
