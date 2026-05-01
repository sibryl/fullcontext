import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

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

/**
 * Collect every byte emitted by a Readable stream and return the concatenated
 * Buffer. Attaches a 'data' listener synchronously, then awaits the 'end'
 * event so the returned Buffer is guaranteed to contain every chunk the
 * stream ever emits.
 *
 * Prefer this over `Buffer.concat(chunks)` gated on `child.on('close')`:
 * 'close' on the child process can fire while the parent-side Readable still
 * has queued 'data' events, which causes intermittent truncation under load.
 * 'end' fires only after the last 'data' event has been dispatched.
 */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(stream, 'end');
  return Buffer.concat(chunks);
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
  // collectStream awaits 'end', so the returned Buffer contains every chunk.
  const outputPromise = collectStream(child.stdout);

  const [t1, t2, outputBuf] = await Promise.all([
    firstChunkTime,
    exitTime,
    outputPromise,
  ]);

  // The first chunk must arrive meaningfully before exit.
  // Use a 200ms margin to be robust on slow CI.
  assert.ok(
    t2 - t1 >= 200,
    `expected first chunk to arrive >=200ms before exit, got ${t2 - t1}ms`,
  );

  // Final bytes unchanged from the batch implementation
  assert.equal(outputBuf.toString('utf8'), '[1] one [2] two\n');
});

test('streams stderr incrementally and independently from stdout', async () => {
  const child = spawn(
    process.execPath,
    [CLI, 'printf "out\\n"; printf "err\\n" 1>&2'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Collect both streams to their 'end' event to guarantee no queued
  // 'data' chunks are missed when the child closes.
  const [outBuf, errBuf] = await Promise.all([
    collectStream(child.stdout),
    collectStream(child.stderr),
  ]);
  await once(child, 'close');

  assert.equal(outBuf.toString('utf8'), '[1] out\n');
  assert.equal(errBuf.toString('utf8'), '[1] err\n');
});

test('exits cleanly when downstream pipe closes early (EPIPE)', async () => {
  // Generate a large volume of output and pipe through `head -c 100`.
  // head -c closes its stdin after 100 bytes, while the wrapper has far
  // more to write. This guarantees an EPIPE on the wrapper's side — unlike
  // `head -n N`, which would just count newlines and drain our single-line
  // streaming output naturally without ever closing its read end.
  //
  // We invoke bash (not sh) because `set -o pipefail` is not portable to
  // dash (the default /bin/sh on many Linux CI images).
  const cmd = `set -o pipefail; '${process.execPath}' '${CLI}' 'for i in $(seq 1 100000); do echo line $i; done' | head -c 100`;
  const result = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}; stderr: ${result.stderr}`,
  );

  // No uncaught-exception noise on stderr.
  assert.ok(
    !/Error: write EPIPE|Uncaught|UnhandledPromiseRejection/.test(
      result.stderr ?? '',
    ),
    `unexpected error on stderr: ${result.stderr}`,
  );

  // Some content should have reached stdout before the pipe closed.
  assert.ok(
    (result.stdout ?? '').length > 0,
    'expected some output before EPIPE',
  );
});

test('EPIPE does not leave the child running in the background', async () => {
  // Spawn the wrapper directly (no shell pipeline) so we control the
  // downstream reader and can observe the child-exit timing.
  const child = spawn(
    process.execPath,
    [
      CLI,
      // Produce lines forever so EPIPE is the only way this terminates.
      'while true; do echo line; done',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Read a few chunks, then forcibly close the reader side to trigger EPIPE
  // inside the wrapper.
  await new Promise<void>((resolve) => {
    child.stdout.once('data', () => resolve());
  });
  // Defensive: swallow any spurious post-destroy error events on this side of
  // the pipe. .destroy() without an argument should not emit 'error', but
  // adding a no-op listener is cheap insurance on platforms where it might.
  child.stdout.on('error', () => {});
  child.stdout.destroy();

  // The wrapper must exit within a reasonable window. If EPIPE weren't
  // handled, it would still exit (uncaught exception → code 1), so this test
  // also asserts that the exit is clean (code 0 or null-from-signal).
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );

  // Accept either a clean exit (0) or a SIGTERM-from-test-teardown on slow CI.
  assert.ok(
    exit.code === 0 || exit.code === null,
    `expected clean exit, got code=${exit.code} signal=${exit.signal}`,
  );
});

test('forwards SIGINT to the child and exits', async () => {
  // Start the wrapper running a long sleep. If SIGINT forwarding works, the
  // wrapper kills the child and exits quickly. If it doesn't, the test times
  // out at the 5-second assertion.
  const child = spawn(
    process.execPath,
    [CLI, 'sleep 30'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Give the wrapper time to register its SIGINT handler before we send the
  // signal. 100ms is generous; the handler registration is synchronous at
  // the top of executeCommand.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const startedAt = Date.now();
  child.kill('SIGINT');

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );
  const elapsed = Date.now() - startedAt;

  // Must terminate well before the 30s sleep would finish. 5 seconds is
  // deliberately generous for slow CI.
  assert.ok(
    elapsed < 5000,
    `expected wrapper to exit within 5s of SIGINT, took ${elapsed}ms`,
  );

  // When a shell receives SIGINT and its child sleep is killed, the shell
  // typically exits with 130 (128 + SIGINT=2) or is reported as signal
  // 'SIGINT' depending on platform. Either way, it must not be 0.
  assert.ok(
    exit.code !== 0 || exit.signal !== null,
    `expected non-zero exit or signal, got code=${exit.code} signal=${exit.signal}`,
  );
});

test('handles invalid UTF-8 bytes in a single chunk without crashing', () => {
  // Emit raw invalid bytes: 0xff 0xfe are never valid UTF-8 lead bytes.
  // Use printf with octal escapes so the shell passes the literal bytes
  // through to the wrapper's child.
  const r = runCli('printf "\\377\\376hello\\n"');

  // The wrapper must not crash.
  assert.equal(r.status, 0);

  // Output must be a single line (matches streaming format) and end with \n.
  assert.ok(
    (r.stdout ?? '').endsWith('\n'),
    `expected trailing newline, got ${JSON.stringify(r.stdout)}`,
  );
  assert.ok(
    (r.stdout ?? '').startsWith('[1] '),
    `expected [1] prefix, got ${JSON.stringify(r.stdout)}`,
  );

  // The valid portion ("hello") must survive.
  assert.ok(
    r.stdout!.includes('hello'),
    `expected 'hello' to be preserved, got ${JSON.stringify(r.stdout)}`,
  );

  // We do NOT assert byte-equivalence with any specific replacement strategy.
  // StringDecoder will produce U+FFFD replacement characters; that is
  // sufficient for "doesn't corrupt or crash."
});

test('streams ~1 MB of output without loss or corruption', async () => {
  // Generate 10,000 lines of ~100 bytes each → ~1 MB. We use `spawn` (not
  // spawnSync with its 1 MB maxBuffer default) so we can collect the full
  // output via data events.
  const LINE_COUNT = 10_000;
  const padding = 'x'.repeat(90); // ~100 bytes per line including "line NNNNN "
  const command = `for i in $(seq 1 ${LINE_COUNT}); do echo "line $i ${padding}"; done`;

  const child = spawn(process.execPath, [CLI, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Collect stdout and wait for the child to close in parallel. collectStream
  // awaits the stream's 'end' event, which fires only after every 'data'
  // event has been dispatched — eliminating the close-vs-data race that
  // caused intermittent missing-trailing-newline failures on CI.
  const [outputBuf, [exit]] = await Promise.all([
    collectStream(child.stdout),
    once(child, 'close') as Promise<[number | null]>,
  ]);

  assert.equal(exit, 0, 'expected clean exit');

  const output = outputBuf.toString('utf8');

  // Starts with the first line marker and no leading space.
  assert.ok(
    output.startsWith('[1] line 1 '),
    `expected output to start with '[1] line 1 ', got: ${output.slice(0, 40)}`,
  );

  // Ends with exactly one trailing newline.
  assert.ok(output.endsWith('\n'), 'expected trailing newline');
  assert.ok(!output.endsWith('\n\n'), 'expected exactly one trailing newline');

  // Line-marker count equals LINE_COUNT.
  const markerMatches = output.match(/\[\d+\] /g) ?? [];
  assert.equal(
    markerMatches.length,
    LINE_COUNT,
    `expected ${LINE_COUNT} markers, got ${markerMatches.length}`,
  );

  // Last marker must be [LINE_COUNT].
  assert.ok(
    output.includes(`[${LINE_COUNT}] line ${LINE_COUNT} `),
    `expected last line [${LINE_COUNT}] to be present`,
  );
});
