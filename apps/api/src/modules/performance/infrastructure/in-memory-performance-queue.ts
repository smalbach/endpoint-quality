import { Injectable } from "@nestjs/common";

import type { PerformanceRunQueuePort } from "../domain/ports";

/**
 * One performance run at a time, in this process.
 *
 * The same shape as the security queue and for the same reasons: a load test is already saturating
 * the target, so running two at once would measure their contention rather than the API, and a
 * single-instance in-memory queue is honest about the deployment it belongs to. Cancellation is a
 * flag the executor reads at each boundary; a request in flight is not interrupted.
 */
@Injectable()
export class InMemoryPerformanceRunQueue implements PerformanceRunQueuePort {
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
  }

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    // A run still queued never starts: drop it so cancel is immediate rather than «after it runs».
    const index = this.pending.indexOf(runId);
    if (index >= 0) this.pending.splice(index, 1);
  }

  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const runId = this.pending.shift()!;
        if (this.cancelled.has(runId)) {
          this.cancelled.delete(runId);
          continue;
        }
        try {
          await this.handler(runId);
        } finally {
          this.cancelled.delete(runId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Test helper: resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
