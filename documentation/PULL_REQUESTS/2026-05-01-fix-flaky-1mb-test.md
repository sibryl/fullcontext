## Problem

During the `v1.1.0` release, one test flaked once on CI — a test that checks we can stream about 1 MB of output through the wrapper without losing bytes. It passed on retry and has passed on every run since, but flaky release-gate tests are dangerous: they either block shipping or erode confidence in the gate.

The cause was a subtle race in how the test collected output. It waited for the child process to close, then read the bytes it had collected — but a child "closing" doesn't guarantee every chunk has been handed over to the test yet. Under heavy load (10 000 lines, ~1 MB) the parent-side stream can still have queued chunks when the process exits, so the test occasionally saw a truncated buffer and failed an assertion.

## Solution

Two other tests had the same pattern (also vulnerable to the same race, just less likely to trigger under their smaller loads). Extract a small helper that waits for the stream's own "I've finished emitting everything" signal before returning the collected bytes, and use it in all three tests.

The helper is ten lines, uses Node's built-in primitives (no new dependencies), and is well-commented so the next person who sees it understands why we aren't doing the obvious thing.

## Impact

- No production code changes — only the test file.
- All 35 tests still pass, locally and in CI.
- The failing assertion is preserved — we fixed the race, not the assertion.
- Release CI gate is stable.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
