/**
 * Queue selection. The only place in the codebase that knows which adapter is live —
 * switching is a config change, not a refactor (ADR 0002).
 */

import type { AppConfig } from '../config.js';
import { BullMqJobQueue } from './bullmq-queue.js';
import { InProcessJobQueue } from './in-process-queue.js';
import type { JobQueue, QueueHandler, QueuePayload } from './port.js';

export interface CreateQueueOptions {
  handler: QueueHandler;
  onError?: (error: unknown, payload: QueuePayload) => void;
}

export function createQueue(config: AppConfig, options: CreateQueueOptions): JobQueue {
  if (config.queueDriver === 'bullmq') {
    return new BullMqJobQueue({
      handler: options.handler,
      concurrency: config.concurrency,
      redisUrl: config.redisUrl,
    });
  }
  return new InProcessJobQueue({
    handler: options.handler,
    concurrency: config.concurrency,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
