/**
 * Las fábricas de `SharedModule` y `ConfigModule` con los entornos que el arranque de
 * `test/db/c100-boot-app.test.ts` no usa: correo por Brevo, y Redis para el bus y los contadores.
 *
 * Se leen de los metadatos del propio módulo —las mismas funciones que Nest invoca—. Redis es el
 * falso en proceso de `c100-redis-fakes` (se instala en `require.cache` al importarlo), así que
 * construir el bus o el almacén no sale a la red.
 */
import "@test/support/c100-redis-fakes";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ConfigModule } from "@/shared/config/config.module";
import { ENV, loadEnv, type Env } from "@/shared/config/env";
import { SharedModule } from "@/shared/shared.module";
import { BrevoMailer, LogMailer, MAILER } from "@/shared/mail/mailer";
import { INSTANCE_BUS } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { RedisInstanceBus } from "@/shared/bus/redis-instance-bus";
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from "@/shared/rate-limit/rate-limit-store";
import { RedisRateLimitStore } from "@/shared/rate-limit/redis-rate-limit-store";

type FactoryProvider = { provide: unknown; useFactory: (...args: unknown[]) => unknown };

function factoryOf(module: object, token: unknown): FactoryProvider["useFactory"] {
  const providers = Reflect.getMetadata("providers", module) as FactoryProvider[];
  const found = providers.find((provider) => provider.provide === token);
  assert.ok(found?.useFactory, "el módulo registra una fábrica para el token");
  return found.useFactory;
}

const base = {
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
};

describe("SharedModule elige sus adaptadores por el entorno", () => {
  test("el correo va por Brevo solo con MAIL_DRIVER=brevo y su clave; si no, al registro", () => {
    const mailer = factoryOf(SharedModule, MAILER);
    const brevo = mailer(loadEnv({ ...base, MAIL_DRIVER: "brevo", BREVO_API_KEY: "xkeysib-prueba" }));
    assert.ok(brevo instanceof BrevoMailer);
    assert.equal((brevo as unknown as { apiKey: string }).apiKey, "xkeysib-prueba");
    assert.ok(mailer(loadEnv(base)) instanceof LogMailer);
    // La clave vacía no la acepta el entorno validado, pero la fábrica tampoco se fía de ella.
    assert.ok(mailer({ ...loadEnv(base), MAIL_DRIVER: "brevo", BREVO_API_KEY: "" } as Env) instanceof LogMailer);
  });

  test("con REDIS_URL el bus y los contadores son los de Redis; sin ella, los de memoria", async () => {
    const bus = factoryOf(SharedModule, INSTANCE_BUS);
    const store = factoryOf(SharedModule, RATE_LIMIT_STORE);
    const env = loadEnv({ ...base, REDIS_URL: "redis://fabricas.interno:6379" });

    const redisBus = bus(env);
    const redisStore = store(env);
    assert.ok(redisBus instanceof RedisInstanceBus);
    assert.ok(redisStore instanceof RedisRateLimitStore);
    await (redisBus as RedisInstanceBus).close();
    await (redisStore as RedisRateLimitStore).onModuleDestroy();

    assert.ok(bus(loadEnv(base)) instanceof InMemoryInstanceBus);
    assert.ok(store(loadEnv(base)) instanceof InMemoryRateLimitStore);
  });
});

describe("ConfigModule", () => {
  test("lee y valida el entorno del proceso", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base, { PORT: "4321" });
      const env = factoryOf(ConfigModule, ENV)() as Env;
      assert.equal(env.PORT, 4321);
      assert.equal(env.DATABASE_URL, base.DATABASE_URL);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
