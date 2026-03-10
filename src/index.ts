#!/usr/bin/env node

// fullcontext - Prevent LLMs from truncating command output

import { spawn } from 'child_process';

const USAGE = `fullcontext - Prevent LLMs from truncating command output

Usage: fullcontext <command> [arguments...]

Examples:
  fullcontext npm test
  fullcontext npx eslint src/
  fullcontext cat package.json

Transforms multi-line output into single-line format with [N] line markers,
making it impossible for LLMs to use head/tail/grep to hide parts of the output.`;

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

function main(): void {
  // Extract command arguments (skip node and script path)
  const args = process.argv.slice(2);

  // Display usage if no arguments provided or help requested
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Join all arguments into a single command string for shell execution
  const command = args.join(' ');

  // Spawn the command in a shell to support pipes, redirects, etc.
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
}

main();
