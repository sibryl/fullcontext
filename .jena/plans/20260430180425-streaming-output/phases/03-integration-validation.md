# Phase 03 — Integration Validation & Docs

**Story points:** 2

## Phase Completion Protocol

- [ ] Confirm Phase 02 is complete and committed.
- [ ] Confirm you are on the `add-streaming-output` branch.
- [ ] Implement tasks below.
- [ ] Run `npm run build` — must pass.
- [ ] Run `npm test` — must pass.
- [ ] Commit: `test: add streaming integration test` (or similar — may be combined with docs).
- [ ] Commit docs change: `docs: note streaming output behavior`.
- [ ] Update STATE.md to mark Phase 03 complete and all phases done.
- [ ] Commit: `docs(plan): mark phase 03 complete`.
- [ ] Open a PR using `jena pr create` (only if the user explicitly asks).

## Context and Goal

Phase 02 verified the streaming transformer at the unit level and the CLI at
the batch level. This phase:

1. Adds a timing-based integration test that proves streaming actually happens
   at the CLI level (the first line reaches the wrapper's stdout before the
   child process exits).
2. Updates the README to mention streaming.

## Tasks

### Task 3.1 — Streaming integration test

Append to `src/cli.test.ts` (or create `src/streaming-cli.test.ts`):

```typescript
import { spawn } from 'node:child_process';

test('streams stdout incrementally', async () => {
  // The child prints "one", sleeps 500ms, then prints "two".
  // We assert we receive "[1] one" before the child exits.
  const child = spawn(
    process.execPath,
    [CLI, 'printf "one\\n"; sleep 0.5; printf "two\\n"'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const firstChunkTime = new Promise<number>((resolve) => {
    child.stdout.once('data', () => resolve(Date.now()));
  });
  const exitTime = new Promise<number>((resolve) => {
    child.on('close', () => resolve(Date.now()));
  });

  const chunks: Buffer[] = [];
  child.stdout.on('data', (c) => chunks.push(c));

  const [t1, t2] = await Promise.all([firstChunkTime, exitTime]);

  // The first chunk must arrive meaningfully before exit.
  // Use a 200ms margin to be robust on slow CI.
  assert.ok(
    t2 - t1 >= 200,
    `expected first chunk to arrive >=200ms before exit, got ${t2 - t1}ms`,
  );

  // Final bytes unchanged from the batch implementation
  const final = Buffer.concat(chunks).toString('utf8');
  assert.equal(final, '[1] one [2] two\n');
});

test('streams stderr incrementally and independently from stdout', async () => {
  const child = spawn(
    process.execPath,
    [CLI, 'printf "out\\n"; printf "err\\n" 1>&2'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on('data', (c) => outChunks.push(c));
  child.stderr.on('data', (c) => errChunks.push(c));

  await new Promise((resolve) => child.on('close', resolve));

  assert.equal(Buffer.concat(outChunks).toString('utf8'), '[1] out\n');
  assert.equal(Buffer.concat(errChunks).toString('utf8'), '[1] err\n');
});
```

Note: the streaming-timing test is inherently timing-sensitive. The 200ms
margin against a 500ms sleep leaves a 300ms cushion, which should be robust
on GitHub Actions runners but not flaky. If it does flake, widen the sleep
(e.g., 1s sleep, 500ms margin) rather than removing the test.

### Task 3.2 — Update README

In `README.md`:

1. In the **Features** section, add:
   ```
   - **Streams output live** — Lines appear as the child emits them, just like
     a normal terminal. The final bytes are still the single-line `[N]` format
     so AI agents still see the complete output.
   ```

2. In the **How It Works** section, update step 3:
   > 3. Streams each line with an `[N]` marker as the child emits it, joined
   >    into a single line so `head`/`tail` can't truncate the final output

3. In the **Don't use fullcontext for** section, soften the "Streaming/
   real-time output" bullet since streaming is now supported. Replace:
   > - Streaming/real-time output (logs, watch modes)

   with:
   > - Commands that rely on in-place terminal updates (progress bars using
   >   `\r`, curses-style UIs, watch modes that redraw)

4. In the **FAQ**, optionally add:
   ```
   ### Does output stream, or is it buffered until the command exits?

   Output streams. As soon as the child process emits a line, `fullcontext`
   transforms it and writes it to stdout/stderr. The transformed format —
   a single line with `[N]` markers — is preserved; streaming only changes
   *when* bytes are written, not *what* bytes are written.
   ```

### Task 3.3 — Verify final state

Run the full verification suite:

```bash
npm run build
npm test

# Manual smoke tests
node dist/index.js 'for i in 1 2 3; do echo "line $i"; sleep 0.5; done'
node dist/index.js 'npm --version'
node dist/index.js 'false'; echo "Exit: $?"
```

## Acceptance Criteria

- Streaming timing test passes reliably (at least 10 consecutive runs
  without flake on your machine).
- README updated with streaming behavior.
- `npm test` passes.
- `npm run build` passes.
- Working tree clean.
- STATE.md shows all three phases complete.

## Commit Discipline

Two or three commits:

1. `test: add streaming integration test`
2. `docs: note streaming output behavior`
3. `docs(plan): mark phase 03 complete`

## Verification Commands

```bash
# Run the full test suite multiple times to verify no flakiness
for i in 1 2 3 4 5; do npm test || break; done

# Confirm streaming visually
node dist/index.js 'for i in 1 2 3 4 5; do echo "$i"; sleep 0.3; done'

# Confirm exit codes unchanged
node dist/index.js 'exit 7'; echo "Exit: $?"
# Expected: Exit: 7

# Confirm signals still forwarded (run in one terminal, Ctrl-C it)
node dist/index.js 'sleep 30'
```

## Post-Phase

After all three phases are complete and committed, the user may ask to open a
PR. If so, use `jena pr create` as documented in AGENTS.md — do NOT use
`gh pr`. Do not open the PR autonomously.
