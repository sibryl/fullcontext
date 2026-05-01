## Problem

The previous release workflow attempt reached the publish step but failed to authenticate with npm, even though everything upstream had completed successfully — tag created, GitHub release page live. The underlying cause was that the `npm` version shipped with the GitHub Actions runner is too old to use our secure publishing path.

A prior change in this repo had removed the step that upgrades `npm`, assuming it was no longer needed. That turned out to be wrong: the upgrade is necessary for our preferred authentication method to work. Simply putting the old step back doesn't work either, because the bundled `npm` has a bug when upgrading itself to the latest version.

## Solution

Two changes:

1. Restore the `npm` upgrade with a safer target version, avoiding the bundled bug.
2. Add a "skip version bump" option to the release workflow so we can finish publishing a version whose tag and GitHub release already exist but whose npm publish failed partway through — without re-bumping the version.

## Impact

Once this merges, we can complete the stalled `v1.1.0` release by running the workflow with the skip-bump option enabled. Future releases will use the normal full flow.

# Credits

- Nabs (Architect)
- JENA (Lead Developer)
