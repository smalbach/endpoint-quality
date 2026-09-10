import { Controller, Get } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";

/**
 * The probe, shaped like the ones this product asserts against.
 *
 * It answers 200 while it can serve traffic and 503 when it cannot, and it actually **queries
 * the database** rather than reporting that the process is running. A health check that always
 * says `ok` is the same hardcoded `pass: true` this whole product was built to replace.
 */
@Controller("health")
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  async check() {
    const started = Date.now();
    let database: { status: "up" | "down"; latencyMs?: number; error?: string };
    try {
      await this.dataSource.query("SELECT 1");
      database = { status: "up", latencyMs: Date.now() - started };
    } catch (error) {
      database = { status: "down", error: error instanceof Error ? error.message : "sin detalle" };
    }
    const status = database.status === "up" ? "ok" : "down";
    return { status, checks: { database } };
  }
}
