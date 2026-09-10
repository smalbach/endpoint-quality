/**
 * Fires the retention sweep on an interval, and nothing else.
 *
 * No cron dependency and no lock. The sweep is idempotent — `prunedAt IS NULL` skips rows a
 * previous pass already emptied, and a `DELETE` of a run somebody else just deleted affects
 * nothing — so two API instances sweeping at once waste a query and cannot corrupt anything. A
 * distributed lock here would be machinery guarding an operation that does not need guarding.
 *
 * The timer is `unref`'d so it cannot hold the process open: a container told to stop should
 * stop, not wait six hours for the next tick.
 */
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";

import { ENV, type Env } from "@/shared/config/env";
import { PruneRunsCommand } from "../application/commands/prune-runs";

@Injectable()
export class RetentionScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Retention");
  private timer?: NodeJS.Timeout;

  constructor(private readonly commandBus: CommandBus, @Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap(): void {
    const hours = this.env.RETENTION_SWEEP_HOURS;
    if (!hours || (!this.env.RETENTION_BODIES_DAYS && !this.env.RETENTION_RUNS_DAYS)) {
      this.logger.log("Retención desactivada: nada se borra ni se vacía");
      return;
    }
    this.timer = setInterval(() => void this.sweep(), hours * 60 * 60 * 1000);
    this.timer.unref();
    // Once at boot as well. An instance restarted daily would otherwise never reach its first
    // tick, and the policy would be configuration nobody ever applied.
    void this.sweep();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A failed sweep is logged and forgotten. It runs again in six hours, and a database hiccup
   * during housekeeping must not take the API down with it. */
  private async sweep(): Promise<void> {
    try {
      await this.commandBus.execute(new PruneRunsCommand());
    } catch (error) {
      this.logger.warn(`La retención falló y se reintentará: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
