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

  /**
   * Write a single transformed line to the output stream. The first line
   * is emitted without a leading space; subsequent lines get a single space
   * separator so the final byte sequence matches the batch transform format
   * `[1] a [2] b [3] c`.
   */
  private emitLine(line: string): void {
    const prefix = this.hasEmitted ? ' ' : '';
    this.output.write(`${prefix}[${this.lineNumber}] ${line}`);
    this.lineNumber += 1;
    this.hasEmitted = true;
  }
}
