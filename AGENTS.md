# Agent Instructions

## Releasing

Do NOT bump versions or publish locally. Use the GitHub Actions workflow:

1. Go to Actions > Publish > Run workflow
2. Select version bump type (patch/minor/major)
3. The workflow will run tests, bump version, push tags, create a GitHub release, and publish to npm automatically

### Republishing a stalled version

If a previous run tagged the version and created the GitHub release but failed at the npm publish step (rare, usually infrastructure-related), re-run the workflow with the `skip_bump` input set to true. This will republish the current `package.json` version without bumping or re-tagging.
