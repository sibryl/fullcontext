# Agent Instructions

## Releasing

Do NOT bump versions or publish locally. Use the GitHub Actions workflow:

1. Go to Actions > Release > Run workflow
2. Select version bump type (patch/minor/major)
3. The workflow will bump version, push tags, create a GitHub release, and publish to npm automatically
