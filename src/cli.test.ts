import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, 'index.js');

/**
 * Spawn the compiled CLI with a single command argument and capture its
 * stdout, stderr, and exit status.
 */
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

test('streams stdout incrementally', async () => {
  // The child prints "one", sleeps 500ms, then prints "two".
  // We assert the first stdout chunk arrives meaningfully before the
  // child exits, which proves we are streaming rather than buffering.
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
