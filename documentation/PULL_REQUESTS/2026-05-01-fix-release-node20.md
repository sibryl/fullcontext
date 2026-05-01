## Problem

Our release pipeline cannot publish new versions to npm. Two separate issues both contributed, and both need to be fixed together for publishing to work again.

**Issue 1 — the real blocker.** When we split our original release workflow into two files and then later merged them back, we renamed the publishing file from `publish.yml` to `release.yml`. But the trust relationship between this package and our GitHub repository is registered on the npm side under the old filename. Every publish attempt since then has failed authentication because the identity npm sees during the publish step no longer matches the one it trusts.

**Issue 2 — a newer runner bug.** The current Node 22 image on GitHub Actions ships with a broken copy of `npm` that cannot install anything, including a newer version of itself. This means we cannot get to a `npm` version new enough to use our secure publishing method at all on Node 22 until GitHub fixes the image.

## Solution

Two changes, one for each issue:

1. Rename the publishing workflow back to `publish.yml` so it matches what npm trusts.
2. Switch the publishing workflow to Node 20, which has a working `npm` that can be upgraded to the current stable version.

## Impact

Once this merges, re-running the publishing workflow in "skip version bump" mode will finish publishing the already-tagged `v1.1.0` to npm.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
