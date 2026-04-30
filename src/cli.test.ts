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
