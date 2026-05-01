## Problem

During the `v1.1.0` release, one test flaked once on CI — a test that checks we can stream about 1 MB of output through the wrapper without losing bytes. It passed on retry and has passed on every run since, but flaky release-gate tests are dangerous: they either block shipping or erode confidence in the gate.

Investigation revealed this wasn't just test flakiness — it was a real production bug. When our wrapper finishes a command, it writes a final newline and then exits. But Node's `process.exit()` is synchronous and doesn't wait for pipe buffers to drain. Under heavy load (~1 MB of prior output), the final bytes could still be in-flight to the operating system when the process tears down, getting silently dropped. A user running something like `fullcontext npm test > output.txt` could end up with a truncated file missing its last bytes — rarely, but possibly.

## Solution

Two fixes, both shipped on this branch:

1. **Production fix (the real blocker):** Stop calling `process.exit()` after writing output. Instead, set the exit code and let Node exit naturally once all buffered writes have reached the operating system. This is the pattern Node's own documentation recommends for exactly this bug class.

2. **Test hardening (defense in depth):** Update the three streaming tests to wait for each stream to fully end before asserting on collected output, rather than waiting only for the child process to close. These races could theoretically produce false failures under different loads. The producer must emit correctly; the consumer must read everything emitted. Both sides are now right.

## Impact

- Eliminates a rare but real data-loss bug in production output.
- Fixes the CI flake at the gate, not just masks it.
- All 35 tests still pass, locally and in CI, across both fixes.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
