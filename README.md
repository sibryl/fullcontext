# fullcontext

**Stop AI agents from truncating your command output.**

A CLI tool that prevents AI coding assistants (Claude, GPT, Copilot, Cursor, etc.) from accidentally hiding critical information when they use `head`, `tail`, or `grep` to limit command output.

## The Problem

AI coding agents are incredibly powerful, but they have a frustrating habit: **truncating command output**.

When an agent runs your test suite or linter, it often tries to be "helpful" by showing only the first or last few lines. This leads to:

- **Missing errors** - The agent sees 5 of 50 test failures and thinks it fixed the issue
- **Endless loops** - The agent runs the same command repeatedly, each time seeing different fragments
- **Lost context** - Critical warnings buried in the middle of output are never seen
- **Wasted time** - You watch the agent chase ghosts while the real problem scrolls by unseen

If you've ever watched an AI assistant run `npm test | head -20` and then confidently declare victory while 47 failing tests scroll past unnoticed, this tool is for you.

## The Solution

`fullcontext` transforms multi-line output into a single line with numbered markers:

```bash
# Before: Agent might truncate this
Error: Missing semicolon
  at src/index.ts:10:5
  at src/utils.ts:25:10
Warning: Unused variable 'foo'

# After: Impossible to truncate
[1] Error: Missing semicolon [2]   at src/index.ts:10:5 [3]   at src/utils.ts:25:10 [4] Warning: Unused variable 'foo'
```

When output is a single line, there's nothing to `head` or `tail`. The agent gets **everything**.

## Installation

```bash
# Use directly with npx (no install needed)
npx fullcontext npm test

# Or install globally
npm install -g fullcontext

# Or add to your project
npm install --save-dev fullcontext
```

## Usage

Prefix any command with `fullcontext`:

```bash
fullcontext npm test
fullcontext npx eslint src/
fullcontext cargo build
fullcontext pytest
fullcontext go test ./...
```

### In npm scripts

Add it to your `package.json` for commands you want agents to see in full:

```json
{
  "scripts": {
    "test": "fullcontext jest",
    "lint": "fullcontext 'npm run lint:es && npm run lint:ts'",
    "typecheck": "fullcontext tsc --noEmit",
    "build": "fullcontext npm run compile"
  }
}
```

For aggregate commands using `&&`, `||`, or `|`, wrap the entire command in quotes.

Now when an AI agent runs `npm test`, it gets the complete output every time.

## How It Works

1. Runs your command exactly as specified
2. Captures stdout and stderr separately
3. Transforms each into a single line with `[N]` line markers
4. Preserves the original exit code
5. Preserves all environment variables (AWS credentials, API keys, etc.)

That's it. No configuration, no options, no complexity.

## Features

- **Zero configuration** - Just prefix your command
- **Preserves exit codes** - CI/CD pipelines work correctly
- **Preserves environment** - AWS CLI, kubectl, and other tools work seamlessly
- **Handles pipes and redirects** - `fullcontext 'echo "test" | cat'` works
- **Transforms both stdout and stderr** - Nothing escapes
- **No dependencies** - Pure Node.js

## When To Use It

**Use fullcontext for:**
- Test runners (`jest`, `pytest`, `go test`, `cargo test`)
- Linters (`eslint`, `prettier`, `rubocop`)
- Type checkers (`tsc`, `mypy`, `pyright`)
- Build tools (`webpack`, `cargo build`, `go build`)
- Any command where missing output causes agent confusion

**Don't use fullcontext for:**
- Interactive commands
- Commands that output binary data
- Streaming/real-time output (logs, watch modes)

## Compatibility

- **Node.js**: 14.0.0 and above
- **Platforms**: macOS, Linux, Windows
- **AI Tools**: Works with any AI coding assistant that executes shell commands

## FAQ

### Does this affect human developers?

The output is still readable - each line is numbered and separated. But yes, it's optimized for agents. Consider adding it only to specific npm scripts rather than using it for all commands.

### Why not just tell the agent not to truncate?

Agents don't always listen. They're optimized to reduce token usage and often truncate output even when instructed not to. `fullcontext` makes truncation physically impossible.

### Does it work with colored output?

Yes. ANSI color codes are preserved exactly as the original command outputs them.

### What about very long output?

That's the point! The entire output is returned, no matter how long. If you're worried about overwhelming the agent, consider whether `fullcontext` is the right tool for that particular command.

## License

MIT

## Links

- [GitHub Repository](https://github.com/sibryl/fullcontext)
- [npm Package](https://www.npmjs.com/package/fullcontext)
- [Report Issues](https://github.com/sibryl/fullcontext/issues)

---

**Built for the agentic coding era.** Because your AI assistant should see what you see.
