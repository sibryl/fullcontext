# Phase 02 — Implement Streaming Transformer

**Story points:** 3

## Phase Completion Protocol

- [ ] Confirm Phase 01 is complete and committed.
- [ ] Confirm you are on the `add-streaming-output` feature branch.
- [ ] Read `src/index.ts` and `src/transform.ts` from Phase 01.
- [ ] Implement tasks below.
- [ ] Run `npm run build` — must pass.
- [ ] Run `npm test` — ALL Phase 01 baseline tests must still pass, plus new streaming tests.
- [ ] Commit: `feat: stream transformed output line-by-line`
- [ ] Update STATE.md to mark Phase 02 complete, set current phase to 03.
- [ ] Commit: `docs(plan): mark phase 02 complete`

## Context and Goal

Replace the buffer-until-close approach with a per-stream incremental
transformer that emits each completed line as soon as its newline arrives.

Key invariant: the **final bytes** written to stdout and stderr must be
byte-identical to what the current implementation produces. This is verified
by re-running Phase 01's golden-output tests unchanged.

## Design: `StreamingLineTransformer`

For each of stdout and stderr, we need an object that:

1. Accumulates incoming `Buffer` chunks into a partial-line buffer, decoded
   as UTF-8 via `StringDecoder` (handles multi-byte boundary splits).
2. Whenever a complete line (terminated by `\n`) is available, emits it in
   the correct format to the wrapper's output stream.
3. Tracks a line counter starting at 1.
4. Tracks whether anything has been written yet, so the first line gets no
   leading space and subsequent lines get a leading space.
5. On flush (child close), emits any remaining partial line as the final
   numbered line, then — if anything was ever emitted — writes a trailing
   `\n`.

### Output format rules

Given the batch format `[1] a [2] b [3] c\n`:

- First emitted line: write `[N] line` (no leading space).
- Subsequent emitted lines: write ` [N] line` (one leading space as separator).
- On close, if at least one line was emitted OR a non-empty partial line
  exists: write the partial (if any) using the same leading-space rule, then
  write exactly one `\n`.
- On close with zero output at all: write nothing.

This precisely mirrors `transformOutput`:
- `''` → `''` → no write.
- `'a\n'` → `[1] a` → `[1] a\n` on close.
- `'a\nb\n'` → `[1] a` on first `\n`, ` [2] b` on second `\n`, `\n` on close.
- `'a\nb'` → `[1] a` on `\n`, then on close emit ` [2] b` (partial flushed),
  then `\n`.
- `'\n'` → empty line → `[1] ` emitted on `\n`, then `\n` on close.
  **Wait.** Re-check: current `transformOutput('\n')` returns `''` because
  `lines = ['', '']`, trailing empty popped → `['']`, then... `lines.length`
  is 1, not 0, so it maps to `[1] ` and returns `'[1] '`. Let's verify.

### Edge case: lone `\n` input

```js
transformOutput('\n')
// lines = ['', '']
// trailing '' popped → ['']
// length === 1, not 0
// returns '[1] '  (with trailing space after marker)
```

The CLI then writes `'[1] \n'` to stdout because `transformedStdout` is
truthy (`'[1] '` is length 4, not empty).

Phase 01 already encodes this as a passing test. The streaming transformer
must preserve this exact behavior.

### Streaming behavior for lone `\n`

With the streaming transformer, input `'\n'` produces one completed empty
line. It emits `[1] ` (no leading space, first line) immediately on receiving
the `\n`. On close with no partial remaining, it writes `\n`. Final bytes:
`[1] \n`. Byte-identical ✓.

## Tasks

### Task 2.1 — Create `src/streaming-transformer.ts`

```typescript
import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';

/**
 * Incrementally transforms a child process's output stream into the
 * single-line [N]-prefixed format, writing each completed line to the
 * provided output stream as soon as its terminating newline arrives.
 *
 * The final bytes written are byte-identical to the batch transform
 * produced by transformOutput() applied to the full concatenated input.
 */
export class StreamingLineTransformer {
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private lineNumber = 1;
  private hasEmitted = false;

  constructor(private readonly output: Writable) {}

  /**
   * Feed a chunk from the child process. Any complete lines (terminated by
   * \n) are emitted immediately; the remainder is held in the partial buffer.
   */
  write(chunk: Buffer): void {
    this.partial += this.decoder.write(chunk);

    let newlineIdx: number;
    while ((newlineIdx = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, newlineIdx);
      this.partial = this.partial.slice(newlineIdx + 1);
      this.emitLine(line);
    }
  }

  /**
   * Signal end of input. Flush any remaining decoder state and any trailing
   * partial line, then write a final newline if anything was emitted.
   */
  end(): void {
    // Flush any buffered multi-byte sequence from the decoder
    this.partial += this.decoder.end();

    // If there's a non-empty partial remaining, emit it as the last line.
    // (A partial of '' only happens when the input ended cleanly on \n —
    // no extra line to flush.)
    if (this.partial.length > 0) {
      this.emitLine(this.partial);
      this.partial = '';
    }

    // Write the trailing newline exactly once, matching the batch
    // implementation which appends '\n' when the transformed string is
    // non-empty.
    if (this.hasEmitted) {
      this.output.write('\n');
    }
  }

  private emitLine(line: string): void {
    const prefix = this.hasEmitted ? ' ' : '';
    this.output.write(`${prefix}[${this.lineNumber}] ${line}`);
    this.lineNumber += 1;
    this.hasEmitted = true;
  }
}
```

### Task 2.2 — Wire the transformer into `src/index.ts`

Replace the current buffer-and-transform logic in `executeCommand` with a
per-stream transformer:

```typescript
import { spawn } from 'child_process';
import { StreamingLineTransformer } from './streaming-transformer';

// ... USAGE unchanged ...

function executeCommand(command: string): void {
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.on('error', (err: Error) => {
    process.stderr.write(`[1] fullcontext: ${err.message}\n`);
    process.exit(1);
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  // One transformer per output stream. Each maintains its own line counter
  // and its own "first-line-emitted" state, matching the existing behavior
  // where stdout and stderr are transformed independently.
  const stdoutTransformer = new StreamingLineTransformer(process.stdout);
  const stderrTransformer = new StreamingLineTransformer(process.stderr);

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutTransformer.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTransformer.write(chunk);
  });

  child.on('close', (code: number | null) => {
    // Flush any partial lines and emit trailing newlines.
    stdoutTransformer.end();
    stderrTransformer.end();

    // Preserve exit code from child process
    process.exit(code ?? 1);
  });
}

// main() unchanged
```

Remove the now-unused `transformOutput` import from `src/index.ts` if the only
remaining consumer is the test file. Keep `src/transform.ts` in place — it
remains useful as a reference implementation and is still exercised by its
unit tests.

### Task 2.3 — Unit tests for `StreamingLineTransformer`

Create `src/streaming-transformer.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';
import { StreamingLineTransformer } from './streaming-transformer';
import { transformOutput } from './transform';

function collect(): { out: Writable; chunks: string[]; joined: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { out, chunks, joined: () => chunks.join('') };
}

test('empty input produces no output', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.end();
  assert.equal(joined(), '');
});

test('single line with trailing newline', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('hello\n'));
  t.end();
  assert.equal(joined(), '[1] hello\n');
});

test('single line without trailing newline', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('hello'));
  t.end();
  assert.equal(joined(), '[1] hello\n');
});

test('multiple lines in one chunk', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('a\nb\nc\n'));
  t.end();
  assert.equal(joined(), '[1] a [2] b [3] c\n');
});

test('line split across two chunks', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('hel'));
  t.write(Buffer.from('lo\n'));
  t.end();
  assert.equal(joined(), '[1] hello\n');
});

test('emits first line before second chunk arrives', () => {
  const { out, chunks } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('first\n'));
  // Snapshot the chunks BEFORE feeding more — this is the streaming
  // guarantee: downstream has seen the first line already.
  const snapshot = [...chunks];
  t.write(Buffer.from('second\n'));
  t.end();
  assert.equal(snapshot.join(''), '[1] first');
  assert.equal(chunks.join(''), '[1] first [2] second\n');
});

test('preserves empty middle lines', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('a\n\nc\n'));
  t.end();
  assert.equal(joined(), '[1] a [2]  [3] c\n');
});

test('lone newline produces single empty numbered line', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  t.write(Buffer.from('\n'));
  t.end();
  assert.equal(joined(), '[1] \n');
});

test('handles multi-byte UTF-8 split across chunk boundary', () => {
  const { out, joined } = collect();
  const t = new StreamingLineTransformer(out);
  // "héllo\n" — é is 0xC3 0xA9 in UTF-8. Split between the two bytes.
  const full = Buffer.from('héllo\n', 'utf8');
  t.write(full.slice(0, 2));  // 'h' + 0xC3
  t.write(full.slice(2));     // 0xA9 + 'llo\n'
  t.end();
  assert.equal(joined(), '[1] héllo\n');
});

test('byte-identical to transformOutput for random-ish inputs', () => {
  const cases = [
    '',
    '\n',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    'a\n\nb\n',
    '  indented\nnext\n',
    'a\rb\nc\n',
    'line with spaces   \n',
    '[1] pre-existing marker\n',
  ];
  for (const input of cases) {
    const { out, joined } = collect();
    const t = new StreamingLineTransformer(out);
    t.write(Buffer.from(input, 'utf8'));
    t.end();
    const expected =
      transformOutput(input) === '' ? '' : transformOutput(input) + '\n';
    assert.equal(joined(), expected, `mismatch for input ${JSON.stringify(input)}`);
  }
});

test('byte-identical across arbitrary chunk splits', () => {
  const input = 'alpha\nbeta\n\ngamma delta\nepsilon';
  // Try every possible single-split point
  for (let splitAt = 0; splitAt <= input.length; splitAt++) {
    const { out, joined } = collect();
    const t = new StreamingLineTransformer(out);
    t.write(Buffer.from(input.slice(0, splitAt), 'utf8'));
    t.write(Buffer.from(input.slice(splitAt), 'utf8'));
    t.end();
    const expected = transformOutput(input) + '\n';
    assert.equal(
      joined(),
      expected,
      `mismatch when split at ${splitAt}`,
    );
  }
});
```

### Task 2.4 — Confirm Phase 01 CLI tests still pass

No changes to `src/cli.test.ts` should be required (except possibly the
lone-newline correction described above). Running `npm test` must show all
Phase 01 tests still green.

## Acceptance Criteria

- `src/streaming-transformer.ts` exists and exports
  `StreamingLineTransformer` as specified.
- `src/index.ts` no longer accumulates `Buffer[]` arrays. It uses
  `StreamingLineTransformer` for both stdout and stderr.
- `src/streaming-transformer.test.ts` exists with all tests listed.
- `npm run build` exits 0.
- `npm test` exits 0 and shows:
  - All Phase 01 unit tests passing (with the lone-newline correction if
    needed).
  - All Phase 01 CLI tests passing.
  - All new streaming-transformer tests passing.
- Manual smoke test demonstrates streaming:
  ```bash
  node dist/index.js 'echo one; sleep 1; echo two'
  ```
  `[1] one` must appear ~immediately; ` [2] two\n` one second later.
- Zero new runtime dependencies.

## Commit Discipline

Expected commits for this phase:

1. `feat: stream transformed output line-by-line` — the main change.
2. `docs(plan): mark phase 02 complete` — state update.

## Verification Commands

```bash
npm run build
npm test

# Streaming smoke test — visually observe streaming
node dist/index.js 'for i in 1 2 3 4 5; do echo "line $i"; sleep 0.3; done'

# Byte-for-byte comparison against a fixture
node dist/index.js 'printf "a\nb\nc\n"' | od -c | head
# Expected: [1] a [2] b [3] c \n
```
