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
