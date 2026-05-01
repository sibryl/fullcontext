# STATE: Streaming Output for fullcontext

## Current Phase

**Phase 05 — CI validation & release test gate** (pending).

## Remaining Phases

- [x] Phase 01 — Test infrastructure & baseline tests
- [x] Phase 02 — Implement streaming transformer
- [x] Phase 03 — Integration validation & docs
- [x] Phase 04 — Robustness: EPIPE, signals, and volume
- [ ] Phase 05 — CI validation & release test gate

## Completed Phases

- Phase 01 — Test infrastructure & baseline tests
- Phase 02 — Implement streaming transformer
- Phase 03 — Integration validation & docs
- Phase 04 — Robustness: EPIPE, signals, and volume

## Notes

- Branch: `add-streaming-output`. Phase 05 continues on the same branch.
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
- Ready for PR after Phase 05 completes.
