#!/usr/bin/env node

// fullcontext - Prevent LLMs from truncating command output

const USAGE = `fullcontext - Prevent LLMs from truncating command output

Usage: fullcontext <command> [arguments...]

Examples:
  fullcontext npm test
  fullcontext npx eslint src/
  fullcontext cat package.json

Transforms multi-line output into single-line format with [N] line markers,
making it impossible for LLMs to use head/tail/grep to hide parts of the output.`;
