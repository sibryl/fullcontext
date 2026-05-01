# Phase 05 — CI Validation & Release Test Gate

**Story points:** 3

## Phase Completion Protocol

Complete these steps in order. Do not skip ahead.

- [ ] Confirm Phases 01–04 are complete and committed.
- [ ] Confirm you are on the `add-streaming-output` feature branch. If not,
      stop — Phase 05 extends that branch; do NOT commit to `main`.
- [ ] Read `package.json`, `.github/workflows/release.yml`, and the
      Compatibility section of `README.md` so you understand the current
      Node engines declaration and release flow.
- [ ] Implement Tasks 5.1 – 5.4 in order.
- [ ] Run `npm run build` — must pass (no source changes, but sanity-check).
- [ ] Run `npm test` — must pass (all existing tests remain green).
- [ ] Validate `.github/workflows/ci.yml` syntax with `npx --yes @action-validator/cli .github/workflows/ci.yml`
      **or** push the branch and observe Actions parse it cleanly. (See
      **Verification Commands** below.)
- [ ] Commit the changes per the **Commit Discipline** section.
- [ ] Update `.jena/plans/20260430180425-streaming-output/STATE.md` to mark
      Phase 05 complete.
- [ ] Commit the state update: `docs(plan): mark phase 05 complete`.

## Context and Goal

Phases 01–04 delivered streaming output with robustness coverage. Before the
user publishes the next release (a direct `latest` release — no canary) we
need two infrastructural safeguards in place:

1. **Continuous integration.** The repository currently has **no CI**. Pushes
   and pull requests are never automatically built or tested. A regression
   could land on `main` and go unnoticed until a human happens to run
   `npm test` locally. Phase 05 adds a `ci.yml` workflow that builds and
   tests on every push to `main` and every pull request.
2. **Release test gate.** The current `release.yml` bumps the version,
   pushes the tag, creates a GitHub release, and publishes to npm **without
   running tests**. A broken `main` would publish a broken package. Phase 05
   inserts `npm test` into `release.yml` so a failing test aborts the release
   before any tags or GitHub releases are created.

This phase also reconciles a subtle mismatch: `package.json` declares
`"engines": { "node": ">=14.0.0" }`, but the Phase 01 test harness uses
Node's built-in `node:test` module, which is **only available on Node 18+**
(and only fully stable on Node 20+). On Node 14–17, `npm test` would fail
to even start. Task 5.1 bumps the engines field to reflect reality.

### Scope note

This phase deliberately does **not** add:

- Windows CI jobs. The tool targets POSIX environments; there are no
  Windows-specific tests and `shell: true` behavior under `cmd.exe` is out
  of scope.
- Canary or staged-release mechanics. The user has opted for a direct
  `latest` release.
- PR templates, CODEOWNERS, dependabot, label automation, or any other
  GitHub-side scaffolding.
- Any changes to files under `src/`. Only CI config, `package.json`,
  `README.md` (the compatibility line), and plan files are modified.
- New runtime dependencies.

## Task 5.1 — Reconcile Node engines with test runtime

### Decision: bump to `">=18.0.0"`

Change `package.json`:

```diff
   "engines": {
-    "node": ">=14.0.0"
+    "node": ">=18.0.0"
   },
```

### Rationale

| Version | EOL date             | Status (May 2026)                                   |
|---------|----------------------|-----------------------------------------------------|
| Node 14 | Apr 2023             | EOL 3+ years; no security patches                   |
| Node 16 | Sep 2023             | EOL 2.5+ years                                      |
| Node 18 | Apr 2025             | Recently EOL but still widely installed             |
| Node 20 | Apr 2026             | Active LTS during bulk of 2024–2026                 |
| Node 22 | Apr 2027 (projected) | Current active release                              |

- `node:test` only became available in Node 18, and was only marked stable
  in Node 20+. On Node 14–17, `npm test` would throw immediately on the
  `require('node:test')` line. Shipping a package whose declared minimum
  cannot even run the package's own tests is misleading.
- No real-world user is still on Node 14 in 2026. Bumping to ≥18 does not
  tighten the effective support envelope — it aligns the declared
  requirement with the practical requirement.
- `>=18.0.0` is deliberately permissive. We are not pinning to Node 20 or
  22 because there is no runtime feature we need from newer versions; the
  source compiles to plain CommonJS with no ESM-only or newer-API usage.
- The CI matrix in Task 5.2 will actively verify Node 18, 20, and 22 so
  the engines declaration stays honest.

### Update README compatibility section

Edit `README.md` (around line 117):

```diff
 ## Compatibility

-- **Node.js**: 14.0.0 and above
+- **Node.js**: 18.0.0 and above
 - **Platforms**: macOS, Linux, Windows
 - **AI Tools**: Works with any AI coding assistant that executes shell commands
```

No other documentation references Node 14.

### Why not Option B (keep `>=14`, document test-only requirement)

- Users discover minimum version via `npm install` failing. If engines says
  `>=14` but tests can't run on 14, any contributor who clones the repo on
  Node 14 gets a confusing failure that is not explained by the engines
  field. Bumping is the simplest, most honest fix.
- The engines field has no runtime cost and no user cost here — nobody is
  actively using Node 14 in 2026.

## Task 5.2 — Add CI workflow for push + PR

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# Cancel in-flight runs on the same ref when a new commit is pushed. Saves
# runner minutes without blocking contributor iteration.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: Test (Node ${{ matrix.node }} on ${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    # Don't let one matrix cell's failure cancel the others — we want the
    # full compatibility picture on each run.
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20, 22]
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
```

### Design notes

- **Triggers.** `push` on `main` catches any direct-to-main commits (which
  should be rare given branch discipline) and re-validates after PR
  merges. `pull_request` (no branch filter) catches every PR regardless of
  its base, which is the right default.
- **Matrix.**
  - **OS:** `ubuntu-latest` is the dominant install environment (CI boxes,
    production servers, Docker images). `macos-latest` is the primary
    development environment and catches platform-specific regressions in
    signal handling and pipe behavior — both of which Phase 04 added tests
    for. macOS runners are ~3× slower than Ubuntu but the test suite is
    small enough (~2 seconds locally) that it doesn't matter.
  - **Node:** `18` validates the engines floor declared in Task 5.1, `20`
    is the current LTS, `22` is the active release. Running all three
    versions on both OSes gives 6 jobs. Each job finishes in well under
    two minutes; the overall wall-clock is gated by the slowest matrix
    cell (macOS), typically ~60–90 seconds.
- **`fail-fast: false`.** If Node 18 on macOS fails but Node 20 on ubuntu
  passes, we want to see both results to triage quickly. The default
  (`true`) would cancel other cells on the first failure.
- **`concurrency`.** Cancelling superseded runs saves runner minutes on
  rapid re-pushes. Keyed on `github.ref` so concurrent PRs and a
  branch-push don't evict each other.
- **`cache: npm`.** Caches `~/.npm` keyed on the lockfile, trimming
  `npm ci` time from ~20s to ~5s on subsequent runs.
- **`timeout-minutes: 5`.** Hard cap so a hung signal test (see Phase 04's
  SIGINT test) can't block the runner for the default 6-hour window.
- **No Windows.** Explicitly out of scope. If the product ever targets
  Windows, this is where it would go — add `windows-latest` to the matrix
  and expect failures from the shell-wrapping logic until it's adapted.

### If matrix cost becomes a concern later

Drop Node 18 from macOS — it's the least interesting combination (old Node
on non-primary-production OS). That reduces 6 → 5 jobs. Keep it in scope
for now; runner minutes on a single small repo are negligible.

## Task 5.3 — Add test gate to Release workflow

### Decision: run tests BEFORE the version bump

Modify `.github/workflows/release.yml`. Move `npm ci` and `npm run build`
to before the version bump, and insert `npm test` as a gate between build
and the first mutating action (the version bump).

Full rewritten `release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version bump type'
        required: true
        default: 'patch'
        type: choice
        options:
          - patch
          - minor
          - major

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      # ── Test gate ─────────────────────────────────────────────────────
      # Install, build, and test BEFORE any mutating action (version bump,
      # git push, GitHub release, npm publish). If tests fail, the job
      # aborts with no lingering tags or releases to clean up. `npm publish`
      # below will re-run `npm run build` via the `prepublishOnly` hook, so
      # the build here is primarily for the test step's dist/ output.

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      # ── Mutating steps (only reached if tests pass) ───────────────────

      - name: Upgrade npm for OIDC support
        run: npm install -g npm@latest

      - name: Configure Git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump version
        id: bump
        run: |
          npm version ${{ inputs.version }} -m "chore: release v%s"
          echo "version=$(node -p "require('./package.json').version")" >> $GITHUB_OUTPUT

      - name: Push changes
        run: git push --follow-tags

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.bump.outputs.version }}
          generate_release_notes: true

      - name: Publish to npm
        run: npm publish --access public --provenance
```

### Rationale for running tests before the bump

The user's suggested placement (tests between `npm ci` and `npm run build`,
after the bump) was noted as acceptable-but-ugly: "if tests fail, the
version bump and git tag already happened — this is ugly but no worse than
the current state where build failures cause the same issue."

We reject that placement. Moving `npm ci + build + test` to the top of the
job is a one-time YAML reorder that:

1. **Costs nothing.** The same three commands run. Order change only.
2. **Eliminates the ugly state entirely.** If `npm test` fails:
   - No `npm version` bump → no commit modifying `package.json`.
   - No `git push --follow-tags` → no new tag on origin.
   - No `softprops/action-gh-release` → no GitHub Release page.
   - No `npm publish` → no bad release on npm.
   The repo and remotes are byte-identical to before the workflow ran.
3. **Matches standard release-pipeline design.** Every mature release
   workflow (semantic-release, changesets, release-please) verifies the
   artifact before minting a version. Our workflow has been the odd one
   out.
4. **Is not scope creep.** Scope creep would be adding retries, Slack
   notifications, SBOM generation, or signing infrastructure. Reordering
   three existing steps to sit above three mutating steps is routine
   hygiene.

### Why `npm publish` doesn't need an explicit rebuild afterward

`package.json` defines `"prepublishOnly": "npm run build"`. npm runs this
hook automatically before `npm publish` executes. So the dist/ artifacts
are rebuilt from the (just-bumped) version one more time immediately
before publish, with zero extra config. The upstream Build step in our
workflow exists to produce dist/ for the Test step.

### What a test failure looks like to the release operator

```
Release › Test
  ✗ streams ~1 MB of output without loss or corruption
  Error: expected 10000 markers, got 9873

Job failed.
```

Package state: unchanged. Branch: clean. Remote: clean. npm: clean.
Operator can investigate, fix, merge a fix PR, and re-run the workflow.

## Task 5.4 — Pre-Release Smoke Test Checklist

Add a `§ Pre-Release Smoke Tests` section to this phase document (below).
This is a checklist the user (or the code agent acting on their behalf)
runs on the compiled artifact before triggering `release.yml`. It
complements — it does not replace — the automated `npm test` suite.

The checklist is **documented here only**; it does not land in source,
README, or any committed script. Several items are not practically
automatable (Ctrl-C signal forwarding, for example), and the user
specifically asked for a battery of real-world manual verifications.

### § Pre-Release Smoke Tests

Run these from the repo root on a clean `npm run build` output. Branch
must be `add-streaming-output` (or whatever is about to be released) with
all commits pushed. All are expected to exit `0` and produce the noted
output unless stated otherwise.

#### Automated (covered by `npm test` in CI, listed here for transparency)

The following behaviors are already locked in by the test suite in
`src/transform.test.ts` and `src/cli.test.ts`. They do NOT need manual
verification — listed so the operator knows what is already covered.

- [x] **Empty output.** `node dist/index.js 'true'` → empty stdout, exit 0.
      _(cli.test.ts: "produces empty stdout for command with no output")_
- [x] **Multi-line transform.** `node dist/index.js 'printf "a\nb\nc\n"'`
      → `[1] a [2] b [3] c\n`.
      _(cli.test.ts: "transforms multi-line stdout into single line")_
- [x] **stderr transform.** `node dist/index.js 'printf "e1\ne2\n" 1>&2'`
      → stderr `[1] e1 [2] e2\n`.
      _(cli.test.ts: "transforms multi-line stderr into single line")_
- [x] **Exit-code preservation.** `node dist/index.js 'exit 42'; echo $?`
      → `42`.
      _(cli.test.ts: "preserves non-zero exit code")_
- [x] **Broken-pipe / EPIPE.** Long command piped into `head` exits 0.
      _(cli.test.ts: "exits cleanly when downstream pipe closes early")_
- [x] **~1 MB volume.** Generating 10 000 lines through the wrapper yields
      all 10 000 markers.
      _(cli.test.ts: "streams ~1 MB of output without loss or corruption")_
- [x] **Invalid UTF-8.** Arbitrary 0xff/0xfe bytes do not crash.
      _(cli.test.ts: "handles invalid UTF-8 bytes split across a chunk boundary")_

#### Manual (run by operator before release)

```bash
# 1. Basic sanity — tool can wrap common commands.
node dist/index.js 'npm --version'
# Expected: single line like "[1] 11.x.x", exit 0.

node dist/index.js 'node --version'
# Expected: single line like "[1] v22.x.x", exit 0.

# 2. Dogfood — run this project's own test suite through fullcontext.
#    Every line of npm/node:test output passes through the streaming
#    transformer. A regression in the transformer would cause a visible
#    truncation or reordering.
node dist/index.js 'npm test'
# Expected: exit 0. Output is a single very long line with [N] markers.
# You should SEE output streaming as the tests execute, not all at once
# after they finish.

# 3. Mixed stdout + stderr ordering within one command.
node dist/index.js 'node -e "console.log(1); console.error(2); console.log(3);"'
# Expected: stdout shows "[1] 1 [2] 3", stderr shows "[1] 2".
# (Each stream is numbered independently — this is intentional.)

# 4. EPIPE via `head -c` (byte-limited pipe, more aggressive than `head -n`).
node dist/index.js 'for i in $(seq 1 100000); do echo $i; done' | head -c 100
echo "Exit: $?"
# Expected: ~100 bytes of numbered output, then "Exit: 0".
# NO stack trace. NO "Error: write EPIPE" on stderr.

# 5. Signal forwarding — run, then Ctrl-C within 1 second.
node dist/index.js 'sleep 10'
# Press Ctrl-C. The process should exit PROMPTLY (well under 10s).
# Exit status is typically 130 on bash. NOT 0 (since the sleep did
# not complete normally).

# 6. Large dict output — platform-dependent, skip if dict not available.
#    On macOS and most Linux distros, /usr/share/dict/words is ~100K lines.
if [ -f /usr/share/dict/words ]; then
  node dist/index.js 'cat /usr/share/dict/words' | wc -c
  echo "Exit: ${PIPESTATUS[0]}"
fi
# Expected: wc -c reports a number roughly (original_byte_count + N*6)
# where N is the line count (each marker is "[N] " plus a space). Exit 0.

# 7. CLI args with spaces and shell metacharacters.
node dist/index.js 'echo "hello world"; echo goodbye'
# Expected: "[1] hello world [2] goodbye", exit 0.

# 8. Exit code preservation with output.
node dist/index.js 'echo boom; exit 17'
echo "Exit: $?"
# Expected: "[1] boom" on stdout, "Exit: 17".
```

**How to record results.** The operator ticks off each manual item in a
temp scratchpad (not committed). If any item fails, investigate before
triggering `release.yml`. If all pass and CI on `main` is green, the
release is cleared.

**Nothing in this section commits to the repository.** The checklist
lives inside this phase document so future releases (Phase 06+ or a
different feature plan) can reference it as a template.

## Acceptance Criteria

- `package.json` has `"engines": { "node": ">=18.0.0" }`.
- `README.md` compatibility line reads `**Node.js**: 18.0.0 and above`.
- `.github/workflows/ci.yml` exists with:
  - Triggers: `push` on `main` and `pull_request`.
  - Matrix: `os: [ubuntu-latest, macos-latest]` × `node: [18, 20, 22]`.
  - Steps: checkout, setup-node (with `cache: npm`), `npm ci`,
    `npm run build`, `npm test`.
  - `fail-fast: false`.
  - `concurrency` block that cancels superseded runs.
  - `timeout-minutes: 5`.
- `.github/workflows/release.yml` has been reordered so `npm ci`,
  `npm run build`, and `npm test` all run **before** the "Upgrade npm",
  "Configure Git", "Bump version", "Push changes", "Create GitHub Release",
  and "Publish to npm" steps.
- No changes under `src/`.
- No new entries in `dependencies`.
- `npm run build` still exits 0.
- `npm test` still exits 0 (all 35+ existing tests green).
- After pushing the branch, the Actions tab shows CI running and producing
  6 matrix cells (or they run locally-parsed without error if using
  `@action-validator/cli`).
- `STATE.md` lists Phase 05 as complete.

## Commit Discipline

Four commits for Phase 05 (plus the state-update commit):

1. `chore: bump engines to node >=18 to match test runtime`
   — `package.json` + `README.md` compatibility line.
2. `ci: add push and pull-request validation workflow`
   — `.github/workflows/ci.yml` only.
3. `ci: run tests before mutating release steps`
   — `.github/workflows/release.yml` reorder only.
4. `docs(plan): add phase 05 (ci and release gate)`
   — this file + `00-overview.md` + `STATE.md` updates that describe the
   phase. (This commit may already exist if the plan was committed by the
   architect; in that case skip.)
5. `docs(plan): mark phase 05 complete` — final `STATE.md` update.

Splitting engines, CI, and release into three separate commits keeps each
behavior change reviewable and bisect-able. If Task 5.2's CI run
surfaces a config bug, you can revert commit 2 without touching commits
1 or 3.

If you prefer, a combined variant is acceptable:

- `ci: add CI workflow and release test gate, bump engines to node 18`
  — covers commits 1, 2, 3.
- `docs(plan): mark phase 05 complete`

## Verification Commands

```bash
# Local sanity — no source changes, but confirm the build/test path is
# still green after the engines bump.
npm ci
npm run build
npm test

# Syntax-check the new workflow file locally (fast, no network).
# action-validator parses the YAML against the GitHub Actions schema.
npx --yes @action-validator/cli .github/workflows/ci.yml
npx --yes @action-validator/cli .github/workflows/release.yml

# End-to-end verification of the CI workflow. Push the branch and
# observe the Actions tab. Expected:
#   - 6 jobs start (ubuntu×3 + macos×3).
#   - All 6 complete green within ~2 minutes wall-clock.
#   - Each job shows: Setup Node.js → Install → Build → Test, all green.
git push origin add-streaming-output

# Then open:
#   https://github.com/sibryl/fullcontext/actions
# and confirm the run.

# Release workflow cannot be cheaply dry-run via workflow_dispatch without
# actually publishing. Instead, verify the reorder by reading the workflow
# file and confirming the step ordering matches the Acceptance Criteria.

# Optional: install `act` (https://github.com/nektos/act) to run the CI
# workflow locally against a Docker runner. Not required for this phase.
#   act pull_request -W .github/workflows/ci.yml
```

**Note on `action-validator`:** It validates schema and action-reference
shape, not the behavior of the steps. Passing validation does NOT prove
the workflow will succeed on GitHub's runners. The authoritative test
is pushing and watching the Actions tab.

## Open Questions / Future Work

- **Should the CI matrix include Node 24 once released?** Node 24 is
  projected to enter LTS in October 2026. Adding it to the matrix at that
  point is a one-line change and a good idea. Not in scope for this phase.
- **Should we add a `release.yml` dry-run mode?** A `workflow_dispatch`
  input like `dry_run: true` that runs everything except `npm publish` and
  `git push --follow-tags` would let the user validate the full pipeline
  without minting a release. Nice-to-have, not in scope.
- **Should `ci.yml` also run `npm audit`?** It would catch known
  vulnerabilities in the (zero runtime, two devDep) tree. Trivially cheap.
  Deferred: the devDep surface is `typescript` + `@types/node` and neither
  has ever shipped a CVE that would affect a build-tool-only install.
- **Branch protection.** Once CI is green, the user may want to require
  the CI check to pass before merging PRs into `main`. That's a GitHub
  repository setting, not a workflow change, so it is out of scope here.
  Recommended follow-up.
