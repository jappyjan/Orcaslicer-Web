/**
 * Per-job event fan-out for SSE.
 *
 * A phone browser will drop the connection every time the screen locks, so every
 * channel keeps a bounded replay buffer: a client that reconnects gets the events it
 * missed rather than a progress bar that jumps from 12 % to done. Terminal events are
 * never evicted from the buffer, because they are the ones a late subscriber most needs.
 */

import type { JobEvent } from '@orca-web/shared';

export interface DeliveredEvent {
  /** Monotonic per-job sequence, sent as the SSE `id:` field. */
  seq: number;
  event: JobEvent;
}

export type EventListener = (delivered: DeliveredEvent) => void;

interface Channel {
  seq: number;
  buffer: DeliveredEvent[];
  listeners: Set<EventListener>;
  terminal: DeliveredEvent | undefined;
}

const MAX_BUFFERED = 200;

export class JobEventBus {
  private readonly channels = new Map<string, Channel>();

  private channel(jobId: string): Channel {
    let channel = this.channels.get(jobId);
    if (!channel) {
      channel = { seq: 0, buffer: [], listeners: new Set(), terminal: undefined };
      this.channels.set(jobId, channel);
    }
    return channel;
  }

  publish(jobId: string, event: JobEvent): void {
    const channel = this.channel(jobId);
    channel.seq += 1;
    const delivered: DeliveredEvent = { seq: channel.seq, event };
    channel.buffer.push(delivered);
    if (channel.buffer.length > MAX_BUFFERED) channel.buffer.shift();
    if (event.type === 'done' || event.type === 'failed') channel.terminal = delivered;
    for (const listener of channel.listeners) listener(delivered);
  }

  /** Replays everything after `afterSeq`, then streams. */
  subscribe(jobId: string, afterSeq: number, listener: EventListener): () => void {
    const channel = this.channel(jobId);
    for (const delivered of channel.buffer) {
      if (delivered.seq > afterSeq) listener(delivered);
    }
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  /** The terminal event, if the job has already finished. */
  terminal(jobId: string): DeliveredEvent | undefined {
    return this.channels.get(jobId)?.terminal;
  }

  /** Drop a job's channel entirely (used by `DELETE /jobs/:id`). */
  forget(jobId: string): void {
    this.channels.delete(jobId);
  }
}
