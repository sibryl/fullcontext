## Problem

Two previous attempts to unblock the stalled `v1.1.0` npm publish both failed. The underlying issue, now confirmed from build logs, is a bug in the version of `npm` that comes pre-installed on the current Node 22 runner image. Our previous successful releases used an older Node 22 sub-version that had a working `npm`.

## Solution

Switch the release workflow to Node 20, which has a stable pre-installed `npm` that can be upgraded to the version we need for secure publishing. Node 20 is the current long-term-support version and works fine for publishing — the choice of Node only affects the build/publish environment, not what end users run our tool on (our test matrix still covers Node 18/20/22 for the user-facing code).

## Impact

Once this merges, re-running the release workflow in skip-bump mode should finally publish the already-tagged `v1.1.0` to npm.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
