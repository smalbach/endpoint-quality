import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { RunQueuePort } from "../../domain/ports";
import type { ResumeMode, RunPause } from "../../domain/model";

/**
 * The queue for a hosted deployment.
 *
 * What Redis buys over the in-memory adapter is the two things a shared instance needs: a run
 * survives an API restart, and several can proceed at once without one operator's matrix waiting
 * behind another's.
 *
 * **BullMQ is loaded lazily and by name.** A self-hosted install running `QUEUE_DRIVER=memory`
 * must not need the dependency present at all, and a static import would make it a hard
 * requirement of the bundle. The failure, when it happens, says exactly what to install.
 */
@Injectable()
export class RedisRunQueue implements RunQueuePort, OnModuleDestroy {
  private readonly logger = new Logger(RedisRunQueue.name);
  private queue: any;
  private worker: any;

  constructor(
    private readonly redisUrl: string,
    private readonly queueName = "runs",
  ) {}

  /**
   * Loaded through a variable specifier so the compiler does not demand the package.
   *
   * That is the point rather than a trick: `bullmq` is a real optional dependency, and a static
   * import would make a self-hosted install running `QUEUE_DRIVER=memory` fail to build over a
   * queue it never uses. The error, when it does happen, says what to do about it.
   */
  private async bullmq(): Promise<any> {
    const specifier = "bullmq";
    try {
      return await import(specifier);
    } catch {
      throw new Error("QUEUE_DRIVER=redis requiere la dependencia bullmq: instálala o usa QUEUE_DRIVER=memory");
    }
  }

  private async ensureQueue(): Promise<any> {
    if (!this.queue) {
      const { Queue } = await this.bullmq();
      this.queue = new Queue(this.queueName, { connection: { url: this.redisUrl } });
    }
    return this.queue;
  }

  async enqueue(runId: string): Promise<void> {
    const queue = await this.ensureQueue();
    // The run id is the job id, so enqueuing the same run twice is one job rather than two
    // workers walking the same matrix against the same target.
    await queue.add("run", { runId }, { jobId: runId, removeOnComplete: true, removeOnFail: false });
  }

  process(handler: (runId: string) => Promise<void>): void {
    void (async () => {
      const { Worker } = await this.bullmq();
      this.worker = new Worker(this.queueName, async (job: { data: { runId: string } }) => handler(job.data.runId), {
        connection: { url: this.redisUrl },
        // One at a time per worker. Concurrency comes from running more API instances, which is
        // the knob an operator can actually reason about.
        concurrency: 1,
      });
      this.worker.on("failed", (job: { id: string } | undefined, error: Error) => {
        this.logger.error(`La corrida ${job?.id} falló en la cola: ${error.message}`);
      });
    })();
  }

  async cancel(runId: string): Promise<void> {
    const queue = await this.ensureQueue();
    // Two paths, because a run can be waiting or already in flight: remove the job if it has not
    // started, and leave the flag for the worker to notice at the next case boundary.
    await queue.remove(runId).catch(() => undefined);
    const { Queue } = await this.bullmq();
    void Queue;
    await (
      await this.ensureQueue()
    ).client.then((client: any) => client.set(`run:cancelled:${runId}`, "1", "EX", 3600));
  }

  async isCancelled(runId: string): Promise<boolean> {
    const queue = await this.ensureQueue();
    const client = await queue.client;
    return (await client.get(`run:cancelled:${runId}`)) === "1";
  }

  // Same keyspace and expiry as the cancel flag: a pause outlives no run by more than the hour.
  async pause(runId: string, at: RunPause | null): Promise<void> {
    const client = await (await this.ensureQueue()).client;
    if (at) await client.set(`run:paused:${runId}`, JSON.stringify(at), "EX", 3600);
    else await client.del(`run:paused:${runId}`);
  }

  async pausedAt(runId: string): Promise<RunPause | null> {
    const client = await (await this.ensureQueue()).client;
    const raw = await client.get(`run:paused:${runId}`);
    return raw ? (JSON.parse(raw) as RunPause) : null;
  }

  async resume(runId: string, how: ResumeMode): Promise<void> {
    const client = await (await this.ensureQueue()).client;
    await client.set(`run:resume:${runId}`, how, "EX", 3600);
  }

  async takeResume(runId: string): Promise<ResumeMode | null> {
    const client = await (await this.ensureQueue()).client;
    const how = await client.get(`run:resume:${runId}`);
    if (how) await client.del(`run:resume:${runId}`);
    return how === "step" || how === "continue" ? how : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
