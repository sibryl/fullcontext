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
