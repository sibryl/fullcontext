# STATE: Streaming Output for fullcontext

## Current Phase

All phases complete. Ready for PR merge.

## Remaining Phases

- [x] Phase 01 — Test infrastructure & baseline tests
- [x] Phase 02 — Implement streaming transformer
- [x] Phase 03 — Integration validation & docs
- [x] Phase 04 — Robustness: EPIPE, signals, and volume
- [x] Phase 05 — CI validation & release test gate
- [x] Phase 06 — Signal-forwarding fix for Linux (CI red → green)

## Completed Phases

- Phase 01 — Test infrastructure & baseline tests
- Phase 02 — Implement streaming transformer
- Phase 03 — Integration validation & docs
- Phase 04 — Robustness: EPIPE, signals, and volume
- Phase 05 — CI validation & release test gate
- Phase 06 — Signal-forwarding fix for Linux + EPIPE/close race fix for macOS Node 18

## Notes

- Branch: `add-streaming-output`. Phase 06 continues on the same branch.
  PR #1 is already open; the Phase 06 fix will land as additional
  commits on the same branch/PR.
- Do NOT commit to `main`.
- Each phase ends with a clean working tree and at least one commit.
- `npm run build` must pass before ending any phase.
- `npm test` must pass before ending any phase.
- Phase 04 was added after a backwards-compatibility audit. Per user
  direction, Phase 04 does NOT preserve the old batch-at-close output
  timing, and does NOT add byte-identity or A/B comparison tests.
- Phase 05 is release-readiness infrastructure: it adds a `ci.yml` for
  push/PR validation and inserts a test gate into `release.yml` before
  any mutating step. It also bumps `engines` from `>=14.0.0` to
  `>=18.0.0`. No `src/` changes.
- Phase 06 fixes a Linux-only signal-forwarding bug that Phase 05's CI
  immediately surfaced: with `shell: true`, dash (Ubuntu's `/bin/sh`)
  doesn't forward SIGINT from shell to grandchild, so `child.kill('SIGINT')`
  leaves the grandchild alive and the wrapper blocked in `'close'`. Fix:
  spawn with `detached: true` and signal the process group. No new deps,
  no test changes — the existing `forwards SIGINT to the child and exits`
  test in `src/cli.test.ts` is correct; the wrapper was wrong. CI must
  be fully green across all 6 matrix cells (ubuntu × {18,20,22},
  macos × {18,20,22}) before Phase 06 is considered complete.
- Ready for PR merge after Phase 06 completes and CI is green.
- Phase 06 completed in two commits: (1) `detached: true` + group-signal
  fix addressed the Ubuntu failure; (2) a follow-up defensive guard in
  the `close` handler addressed a macOS Node 18 regression where the
  `close` event could fire before the EPIPE `error` handler on older
  libuv, causing `code ?? 1` to exit 1 instead of 0. The guard exits 0
  when `process.stdout` is already destroyed/ended, matching coreutils
  EPIPE convention. CI run 25207935949: all 6 cells green.
