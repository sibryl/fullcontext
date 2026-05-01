## Problem

Our release pipeline is currently unable to publish new versions to npm. The step that upgrades the installed `npm` to a version new enough to use our secure authentication method fails with an internal error — not because the target version is wrong, but because the copy of `npm` preinstalled on our build server has corrupted dependencies and cannot install anything, including itself.

This has left `v1.1.0` tagged and released on GitHub but not actually published to npm.

## Solution

Switch to a different mechanism for installing the newer `npm`. Instead of asking the broken `npm` to upgrade itself, use the package-manager manager that ships with Node (built in since 2021) to download the version we need directly from the registry.

This bypasses the corrupt installation entirely and is the approach recommended by the Node team for this exact situation.

## Impact

Once this merges, the release workflow can be re-run in "skip bump" mode to finish publishing the stalled `v1.1.0` to npm.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
