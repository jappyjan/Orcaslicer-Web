/**
 * `--pipe`: the slicer's progress channel.
 *
 * ORDERING IS THE WHOLE POINT OF THIS FILE. A FIFO blocks on open until both ends are
 * present, so:
 *
 *   1. `mkfifo` the path;
 *   2. open the READ end *before* spawning the slicer — and open it O_NONBLOCK, so we
 *      do not block waiting for a writer that cannot exist yet;
 *   3. spawn the slicer with `--pipe <path>`.
 *
 * Open the read end after spawning and the slicer blocks in `open(2)` on the write end
 * while we block waiting for it to say something: a deadlock the wall-clock timeout
 * eventually breaks, having produced nothing. Open it blocking instead of O_NONBLOCK and
 * step 2 hangs before we ever reach step 3 — the same deadlock, earlier.
 *
 * A plain `fs.createReadStream` cannot be used: it would stop at the first EOF. Wrapping
 * the non-blocking fd in a `net.Socket` gives a stream that stays open until the writer
 * closes, which is exactly the FIFO semantics we want.
 */

import { execFile } from 'node:child_process';
import { closeSync, openSync, constants as fsConstants } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One line of the slicer's pipe output, before normalisation. */
export interface RawPipeMessage {
  plate_index?: number;
  plate_count?: number;
  plate_percent?: number;
  total_percent?: number;
  message?: string;
  /**
   * MEASURED: on 2.4.2 this key is usually ABSENT rather than `null`, so it must be
   * treated as optional. It is the user's only signal for e.g. unsupported overhangs,
   * so it is never dropped.
   */
  warning?: string | null;
}

export type PipeMessageHandler = (message: RawPipeMessage) => void;

export class ProgressPipe {
  readonly path: string;
  private socket: Socket | undefined;
  private fd: number | undefined;
  private buffer = '';
  private closed = false;
  private readonly onMessage: PipeMessageHandler;
  private readonly onMalformed: ((line: string) => void) | undefined;

  constructor(path: string, onMessage: PipeMessageHandler, onMalformed?: (line: string) => void) {
    this.path = path;
    this.onMessage = onMessage;
    this.onMalformed = onMalformed;
  }

  /** Step 1 + step 2. Must be awaited before the slicer is spawned. */
  async open(): Promise<void> {
    // `mkfifo(3)` has no binding in Node; coreutils' mkfifo is present in the image and
    // on any POSIX host.
    await execFileAsync('mkfifo', ['--mode=0600', this.path]);

    this.fd = openSync(this.path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const socket = new Socket({ fd: this.fd, readable: true, writable: false });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consume(chunk));
    socket.on('error', () => {
      /* the writer going away mid-slice is not a slice failure */
    });
    socket.on('close', () => {
      this.fd = undefined;
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.emit(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private emit(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed line is a curiosity for the log, never a reason to fail a slice.
      this.onMalformed?.(line);
      return;
    }
    if (parsed !== null && typeof parsed === 'object') {
      this.onMessage(parsed as RawPipeMessage);
    }
  }

  /** Close the reader and delete the FIFO. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Flush a trailing line that arrived without its newline.
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail.length > 0) this.emit(tail);

    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
      this.fd = undefined;
    } else if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* already gone */
      }
      this.fd = undefined;
    }
    await rm(this.path, { force: true });
  }
}
