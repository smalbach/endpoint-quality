/**
 * Los brazos de las fábricas de módulo que el arranque de `test/db/c100-boot-app.test.ts` no toma.
 *
 * Aquel arranca un despliegue de una instancia —cola en memoria, análisis sin modelo—. Arrancar con
 * `QUEUE_DRIVER=redis` pondría al orquestador a escuchar en un Redis que en las pruebas no existe, así
 * que aquí se llama a la fábrica misma con el entorno que la elige: es la misma función que Nest invoca.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@/shared/config/env";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { RUN_QUEUE_PROVIDER } from "@/modules/runs/runs.module";
import { RedisRunQueue } from "@/modules/runs/infrastructure/queue/redis-queue";
import { InMemoryRunQueue } from "@/modules/runs/infrastructure/queue/in-memory-queue";
import { SECURITY_AI_PROVIDER } from "@/modules/security-runs/security-runs.module";
import { AnthropicSecurityAi, FallbackSecurityAi } from "@/modules/security-runs/infrastructure/security-ai";

const base = {
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
};

describe("la cola de corridas que elige RunsModule", () => {
  test("con QUEUE_DRIVER=redis es la de Redis, con la URL configurada y sin conectar al construirse", () => {
    const queue = RUN_QUEUE_PROVIDER.useFactory(
      loadEnv({ ...base, QUEUE_DRIVER: "redis", REDIS_URL: "redis://cola.interna:6380" }),
      new InMemoryInstanceBus(),
    );
    assert.ok(queue instanceof RedisRunQueue);
    assert.equal((queue as unknown as { redisUrl: string }).redisUrl, "redis://cola.interna:6380");
  });

  test("con QUEUE_DRIVER=redis y sin REDIS_URL apunta al Redis local", () => {
    const queue = RUN_QUEUE_PROVIDER.useFactory(loadEnv({ ...base, QUEUE_DRIVER: "redis" }), new InMemoryInstanceBus());
    assert.ok(queue instanceof RedisRunQueue);
    assert.equal((queue as unknown as { redisUrl: string }).redisUrl, "redis://localhost:6379");
  });

  test("por omisión es la de memoria", () => {
    assert.ok(RUN_QUEUE_PROVIDER.useFactory(loadEnv(base), new InMemoryInstanceBus()) instanceof InMemoryRunQueue);
  });
});

describe("el analista que elige SecurityRunsModule", () => {
  test("con SECURITY_AI_DRIVER=anthropic es el del modelo", () => {
    const ai = SECURITY_AI_PROVIDER.useFactory(
      loadEnv({ ...base, SECURITY_AI_DRIVER: "anthropic", ANTHROPIC_API_KEY: "sk-prueba" }),
    );
    assert.ok(ai instanceof AnthropicSecurityAi);
  });

  test("apagado es el determinista", () => {
    assert.ok(SECURITY_AI_PROVIDER.useFactory(loadEnv(base)) instanceof FallbackSecurityAi);
  });
});
