## Problem

After PR #7 eliminated one data-loss bug (truncated output when piping large command output), a review noted that the same bug class lingered in our help / version output paths. Someone running `fullcontext --help | head` could theoretically see a truncated help message — the same mechanism as before: our code prints output and then exits synchronously, which on Node doesn't wait for buffered pipe writes to reach the operating system.

## Solution

Apply the identical fix to the remaining exits after writes. Tell Node the exit code we want and let the runtime exit naturally once all output has flushed. No new bug, no new test, just the same correct pattern applied consistently.

## Impact

- No more silent truncation bugs anywhere in the CLI.
- No behavior change for non-piped usage — exit codes and help output are identical.
- Small follow-up to PR #7; single-file change.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
