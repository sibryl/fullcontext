## Problem

`fullcontext` wraps shell commands so AI agents see complete output even when terminals truncate. It does this well — but the tool has always waited for a command to finish before printing anything. For a quick `npm --version` that's fine. For a 45-second test suite or a 2-minute build, the terminal sits silent the whole time. Users can't tell if the command is progressing, stuck, or broken. It stops feeling like a terminal and starts feeling like a black box.

## Solution

Output now streams live, line by line, as the wrapped command produces it — just like any normal terminal. The final `[N] line [N+1] line...` format that makes truncation-proof output possible is unchanged, so AI agents still receive the same complete result.

Zero configuration. No new flags. Existing usage keeps working exactly as it did before.

## How It Works

- Each line appears in your terminal the moment the command emits it
- The `[N]` line markers still turn into a single line at the end, preserving the truncation-proof contract AI agents depend on
- `stdout` and `stderr` stream independently with their own line numbers
- Exit codes and signal forwarding (Ctrl-C) work the same as before

## Extras We Added Along the Way

While wiring this up, we closed a few other gaps that production users will feel:

- **Broken pipes handled gracefully.** Running `fullcontext npm test | head` no longer crashes with an unhandled error — it exits cleanly and stops the underlying command from wasting work.
- **Safer invalid UTF-8 handling.** Commands that emit non-text bytes no longer risk corrupting output.
- **Volume-tested.** Commands that produce ~1 MB of output are verified to stream correctly without data loss.

## Release Safety

This release also introduces the first automated quality bar for the project:

- **Continuous integration runs on every push and pull request**, testing on both Ubuntu and macOS across Node 18, 20, and 22.
- **The release workflow now runs tests before publishing.** If tests fail, no tag, no GitHub release, and no npm publish happens — the package stays safe.
- **Minimum supported Node version** is now 18 (Node 14 has been end-of-life since April 2023, Node 16 since September 2023).

# Credits

- Nabs (Architect)
- JENA (Lead Developer)

