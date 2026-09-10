import { Injectable, Logger } from "@nestjs/common";
import type { RunQueuePort } from "../../domain/ports";

/**
 * The queue that needs no infrastructure.
 *
 * This is what keeps "ejecutable en local" honest: `pnpm dev`, a Postgres, and runs work. It
 * processes **one run at a time**, in order, in this process — which is a real limitation and
 * the right one for a single operator, because two matrices hitting the same target at once
 * would make every latency measurement meaningless.
 *
 * A run in flight dies with the process. That is the trade the Redis adapter exists to remove,
 * and the reason `QUEUE_DRIVER` is a deployment decision rather than a default.
 */
@Injectable()
export class InMemoryRunQueue implements RunQueuePort {
  private readonly logger = new Logger(InMemoryRunQueue.name);
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    // Not awaited: the HTTP request that started the run answers 202 immediately, which is what
    // makes closing the browser harmless.
    void this.drain();
  }

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const runId = this.pending.shift()!;
        try {
          await this.handler(runId);
        } catch (error) {
          // Swallowed on purpose: one run that throws must not stop the queue, and the handler
          // has already recorded the failure against its own run.
          this.logger.error(`La corrida ${runId} terminó con un error no controlado`, error instanceof Error ? error.stack : String(error));
        } finally {
          this.cancelled.delete(runId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Lets a test wait for the queue to settle without polling a private field. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
}
