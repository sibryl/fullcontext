#!/usr/bin/env node

// fullcontext - Stop AI agents from truncating your command output

import { spawn } from 'child_process';

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
 * Transform multi-line output into single-line format with line markers.
 * Empty lines in the middle are preserved with their line numbers (e.g., "[3] ").
 */
function transformOutput(output: string): string {
  const lines = output.split('\n');

  // Remove trailing empty line caused by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // Handle empty output
  if (lines.length === 0) {
    return '';
  }

  return lines.map((line, i) => `[${i + 1}] ${line}`).join(' ');
}

/**
 * Execute a command and transform its output.
 */
function executeCommand(command: string): void {
  // Spawn the command in a shell to support pipes, redirects, etc.
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

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

  // Buffer stdout chunks
  const stdoutChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });

  // Buffer stderr chunks
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // Handle process close - transform and output
  child.on('close', (code: number | null) => {
    // Transform and output stdout
    const stdout = Buffer.concat(stdoutChunks).toString();
    const transformedStdout = transformOutput(stdout);
    if (transformedStdout) {
      process.stdout.write(transformedStdout + '\n');
    }

    // Transform and output stderr
    const stderr = Buffer.concat(stderrChunks).toString();
    const transformedStderr = transformOutput(stderr);
    if (transformedStderr) {
      process.stderr.write(transformedStderr + '\n');
    }

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
