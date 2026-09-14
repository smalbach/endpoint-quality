import { Injectable, Logger } from "@nestjs/common";
import type { SecurityRunQueuePort } from "../domain/ports";

/**
 * The security queue that needs no infrastructure.
 *
 * One run at a time, in this process: two matrices hitting the same target at once would make the
 * rate-limit and size heuristics meaningless. A run in flight dies with the process — the same
 * trade the contract queue makes, and acceptable because a security run is re-runnable.
 */
@Injectable()
export class InMemorySecurityRunQueue implements SecurityRunQueuePort {
  private readonly logger = new Logger(InMemorySecurityRunQueue.name);
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    void this.drain();
  }

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  isCancelled(runId: string): boolean {
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
          this.logger.error(
            `La corrida de seguridad ${runId} terminó con un error no controlado`,
            error instanceof Error ? error.stack : String(error),
          );
        } finally {
          this.cancelled.delete(runId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Lets a test await the queue instead of polling. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
}
