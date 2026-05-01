## Problem

Our release workflow failed on the very first run after introducing CI — not on any of our changes, but on an infrastructure step that was already there: an attempt to upgrade npm that no longer works on the current GitHub Actions runner. Tests passed, so nothing broken was shipped, but the version bump and publish never happened.

## Solution

Remove the broken step. The npm version that ships with the Node 22 runner already supports the features we need, so upgrading it is unnecessary — and currently impossible due to an upstream bug in npm's self-upgrade path.

## Impact

Once this merges, re-running the release workflow should publish a new version cleanly.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
