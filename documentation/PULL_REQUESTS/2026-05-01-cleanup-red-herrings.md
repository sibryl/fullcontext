## Problem

After the debugging spiral that preceded the `v1.1.0` release, a review surfaced two places on `main` where the documentation no longer matches reality:

1. Our release instructions still point to a workflow name that no longer exists (the file was renamed during the fix).
2. Three of the PR write-ups from the debugging spiral describe fixes that didn't work or were later reverted, with no pointer to the PR that actually fixed the issue. A future reader finding them in isolation could easily be misled.

## Solution

Update the release instructions to match the current workflow name, and add a "Superseded" banner to each of the three misleading PR write-ups with a link to the real fix. Historical content is preserved in full.

## Impact

No behavior changes. Anyone reading `AGENTS.md` or the old PR write-ups now gets accurate guidance.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
