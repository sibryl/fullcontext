# Phase 01 — Test Infrastructure & Baseline Tests

**Story points:** 3

## Phase Completion Protocol

Complete these steps in order. Do not skip ahead.

- [ ] Verify you are on a feature branch (NOT `main`). If not, run `git checkout -b add-streaming-output`.
- [ ] Read `.jena/plans/20260430180425-streaming-output/00-overview.md` to understand the overall design.
- [ ] Read `src/index.ts` to understand current behavior.
- [ ] Implement the tasks below in order.
- [ ] Run `npm run build` — must pass.
- [ ] Run `npm test` — must pass, all baseline tests green.
- [ ] Commit changes with message: `test: add baseline tests for output transformation`
- [ ] Update `.jena/plans/20260430180425-streaming-output/STATE.md` to mark Phase 01 complete and set current phase to 02.
- [ ] Commit the state update: `docs(plan): mark phase 01 complete`

## Context and Goal

There are currently no tests. Before changing behavior, we must lock in the
current output contract so we can verify Phase 02's streaming implementation
produces byte-identical results.

This phase:
1. Adds a `test` script using Node's built-in `node:test` runner.
2. Extracts `transformOutput` into a dedicated module so it can be imported
   by tests without running `main()`.
3. Adds baseline unit tests capturing the exact behavior of `transformOutput`
   for all edge cases.
4. Adds a baseline end-to-end test that spawns the compiled CLI and asserts
   exact bytes on stdout/stderr for a few canonical commands.

## Tasks

### Task 1.1 — Extract `transformOutput` into its own module

Create `src/transform.ts` containing ONLY the transform function and its
JSDoc, moved verbatim from `src/index.ts`:

```typescript
/**
 * Transform multi-line output into single-line format with line markers.
 * Empty lines in the middle are preserved with their line numbers (e.g., "[3] ").
 */
export function transformOutput(output: string): string {
  const lines = output.split('\n');

  // Remove trailing empty line caused by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // Handle empty output
  if (lines.length === 0) {
    return '';
  }

  return lines.map((line, i) => `[${i + 1}] ${line}`).join(' ');
}
```

Update `src/index.ts` to import it:

```typescript
import { transformOutput } from './transform';
```

Remove the inline definition from `src/index.ts`. **No `.js` extension** on
the import — `tsconfig.json` currently uses `"module": "commonjs"` which uses
classic Node resolution, so extensionless imports are correct. Verify by
running `npm run build` and checking that `dist/index.js` contains
`require("./transform")` and resolves `dist/transform.js` correctly.

### Task 1.2 — Add test infrastructure

Update `package.json`:

- Add `"test": "tsc && node --test dist/*.test.js"` to `scripts`.
- No new dependencies. `node:test` and `node:assert` are built-in.

Update `tsconfig.json` if needed to ensure test files in `src/` are compiled
to `dist/`. If `tsconfig.json` has an `include` field, make sure it covers
`src/**/*.ts`. Do NOT add `@types/node` if it's already in `devDependencies`
(it is: `@types/node` v25 is present).

### Task 1.3 — Baseline unit tests for `transformOutput`

Create `src/transform.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformOutput } from './transform';

test('returns empty string for empty input', () => {
  assert.equal(transformOutput(''), '');
});

test('transforms lone newline into single empty numbered line', () => {
  // A lone '\n' splits to ['', ''], the trailing '' is popped to give [''],
  // which maps to '[1] ' (note the trailing space after the marker).
  assert.equal(transformOutput('\n'), '[1] ');
});

test('transforms single line without trailing newline', () => {
  assert.equal(transformOutput('hello'), '[1] hello');
});

test('transforms single line with trailing newline', () => {
  assert.equal(transformOutput('hello\n'), '[1] hello');
});

test('transforms two lines with trailing newline', () => {
  assert.equal(transformOutput('a\nb\n'), '[1] a [2] b');
});

test('transforms three lines preserving order', () => {
  assert.equal(transformOutput('a\nb\nc\n'), '[1] a [2] b [3] c');
});

test('preserves empty middle lines with line numbers', () => {
  assert.equal(transformOutput('a\n\nc\n'), '[1] a [2]  [3] c');
});

test('does not trim leading whitespace on lines', () => {
  assert.equal(transformOutput('  indented\nnext\n'), '[1]   indented [2] next');
});

test('handles no trailing newline on last line', () => {
  assert.equal(transformOutput('a\nb'), '[1] a [2] b');
});

test('preserves carriage returns within a line', () => {
  assert.equal(transformOutput('a\rb\nc\n'), '[1] a\rb [2] c');
});

test('preserves ANSI color codes', () => {
  const input = '\x1b[31merror\x1b[0m\nok\n';
  const expected = '[1] \x1b[31merror\x1b[0m [2] ok';
  assert.equal(transformOutput(input), expected);
});
```

These tests capture the CURRENT behavior exactly. They must still pass after
Phase 02. Note especially the lone-newline case: the current implementation
emits `'[1] '` (with trailing space), not `''`. This will be a key invariant
for the streaming transformer.

### Task 1.4 — Baseline integration test for the CLI

Create `src/cli.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, 'index.js');

function runCli(command: string) {
  const result = spawnSync(process.execPath, [CLI, command], {
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

test('transforms multi-line stdout into single line', () => {
  const r = runCli('printf "a\\nb\\nc\\n"');
  assert.equal(r.stdout, '[1] a [2] b [3] c\n');
  assert.equal(r.status, 0);
});

test('transforms multi-line stderr into single line', () => {
  const r = runCli('printf "err1\\nerr2\\n" 1>&2');
  assert.equal(r.stderr, '[1] err1 [2] err2\n');
  assert.equal(r.status, 0);
});

test('preserves non-zero exit code', () => {
  const r = runCli('printf "boom\\n"; exit 42');
  assert.equal(r.stdout, '[1] boom\n');
  assert.equal(r.status, 42);
});

test('produces empty stdout for command with no output', () => {
  const r = runCli('true');
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
});

test('handles partial final line without trailing newline', () => {
  const r = runCli('printf "no-newline"');
  assert.equal(r.stdout, '[1] no-newline\n');
});

test('emits lone newline as [1] marker with trailing space', () => {
  const r = runCli('printf "\\n"');
  assert.equal(r.stdout, '[1] \n');
});
```

These integration tests are the golden-output contract. Phase 02 must leave
them green, unchanged.

## Acceptance Criteria

- `src/transform.ts` exists and exports `transformOutput` with identical
  implementation to the current inline version.
- `src/index.ts` imports `transformOutput` from `./transform` and no longer
  defines it inline.
- `src/transform.test.ts` and `src/cli.test.ts` exist.
- `npm run build` exits 0 and produces `dist/transform.js`, `dist/index.js`,
  `dist/transform.test.js`, `dist/cli.test.js`.
- `npm test` exits 0 and reports all tests passing.
- Manually running `node dist/index.js 'printf "a\nb\n"'` still prints
  `[1] a [2] b` followed by a newline (sanity check).
- No new runtime dependencies added (`dependencies` field remains absent).

## Commit Discipline

Single commit at end of phase:

```
test: add baseline tests for output transformation

Extract transformOutput into its own module so it can be unit-tested
without invoking the CLI's main(). Add node:test-based unit tests for
all edge cases of the transform, plus integration tests that spawn the
compiled CLI and assert exact bytes on stdout and stderr. These tests
capture the current output contract as a baseline for the upcoming
streaming refactor.
```

Then a second commit to update STATE.md.

## Verification Commands

```bash
# Build and run tests
npm run build
npm test

# Sanity-check CLI still works
node dist/index.js 'printf "a\nb\nc\n"'
# Expected: [1] a [2] b [3] c

node dist/index.js 'printf "err\n" 1>&2; exit 3'
echo "Exit: $?"
# Expected: stderr "[1] err", exit 3
```
