import { Global, Module } from "@nestjs/common";
import { CLOCK, SystemClock, type ClockPort } from "./clock/clock.port";
import { SECRET_CIPHER } from "./crypto/secret-cipher";
import { SecretCipherProvider } from "./crypto/secret-cipher.provider";
import { ENV, type Env } from "./config/env";
import { BrevoMailer, LogMailer, MAILER } from "./mail/mailer";
import { INSTANCE_BUS } from "./bus/instance-bus";
import { InMemoryInstanceBus } from "./bus/in-memory-instance-bus";
import { RedisInstanceBus } from "./bus/redis-instance-bus";
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from "./rate-limit/rate-limit-store";
import { RedisRateLimitStore } from "./rate-limit/redis-rate-limit-store";
import { EXECUTION_TURNS } from "./turns/execution-turns";
import { TypeOrmExecutionTurnStore } from "./turns/typeorm-execution-turns";
import { LOGGER } from "./logging/logger.port";
import { JsonLogger } from "./logging/json-logger";
import { METRICS } from "./metrics/metrics.port";
import { PromMetrics } from "./metrics/prom-metrics";

/**
 * The cross-cutting providers every module needs and none owns.
 *
 * `@Global()` because time is not a dependency of any one module: a handler in `iam` and one in
 * `runs` both ask the clock, and requiring each feature module to re-provide it means the day
 * somebody forgets, the container fails at boot with a message about a symbol rather than about
 * a missing import.
 *
 * That is not hypothetical — it is exactly how this file came to exist. `CLOCK` was registered in
 * `AppModule`, which is not global, so every handler outside it failed to resolve. The in-memory
 * test harness registers its providers in one flat module, so the suite could not see it: the
 * first thing that did was starting the real process.
 *
 * The cipher is here for the same reason. It was registered in `environments`, which owned the
 * only thing that needed it — until the spec import started storing the headers a contract behind
 * authentication needs, at which point `specs` would have had to import `environments` to reach
 * a symbol that has nothing to do with environments.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: SECRET_CIPHER, useClass: SecretCipherProvider },
    // Mail is sent by auth today and will be by runs tomorrow (a report to a list), so it is
    // nobody's module's.
    {
      provide: MAILER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.MAIL_DRIVER === "brevo" && env.BREVO_API_KEY
          ? new BrevoMailer(env.BREVO_API_KEY, { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME })
          : new LogMailer(),
    },
    // Lo que une a las instancias: el progreso en vivo, las órdenes a un socket que tiene otra y las
    // señales de las colas en memoria. Sin `REDIS_URL` no hay otras instancias a las que hablar, y el
    // bus en memoria es exactamente eso; con él, todas las que apunten al mismo Redis se oyen.
    {
      provide: INSTANCE_BUS,
      inject: [ENV],
      useFactory: (env: Env) => (env.REDIS_URL ? new RedisInstanceBus(env.REDIS_URL) : new InMemoryInstanceBus()),
    },
    // Los contadores de los límites de peticiones, por la misma razón y con la misma variable: con
    // un contador por réplica, N réplicas son un límite N veces más flojo.
    {
      provide: RATE_LIMIT_STORE,
      inject: [ENV],
      useFactory: (env: Env) => (env.REDIS_URL ? new RedisRateLimitStore(env.REDIS_URL) : new InMemoryRateLimitStore()),
    },
    // El turno de las corridas que van de una en una en todo el despliegue (seguridad y
    // rendimiento). En la base y no en Redis: es lo que comparten todas las réplicas siempre, con
    // `REDIS_URL` o sin él, y una fila con su latido sobrevive a que Redis se caiga.
    { provide: EXECUTION_TURNS, useClass: TypeOrmExecutionTurnStore },
    // El registro, con la hora del mismo reloj que todo lo demás. Global por la misma razón que el
    // reloj: lo que hace falta medir está en todas partes, y un módulo que se olvide de proveerlo
    // falla al arrancar hablando de un símbolo en vez de de una línea que no se escribió.
    {
      provide: LOGGER,
      inject: [ENV, CLOCK],
      useFactory: (env: Env, clock: ClockPort) =>
        new JsonLogger({
          level: env.LOG_LEVEL,
          format: env.LOG_FORMAT ?? (env.NODE_ENV === "development" ? "text" : "json"),
          clock,
        }),
    },
    // Lo mismo que cuentan las líneas del registro, agregado en memoria para poder dibujarlo. Se
    // recoge siempre —cuesta un histograma— y se **expone** solo con `METRICS_TOKEN`.
    { provide: METRICS, useClass: PromMetrics },
  ],
  exports: [CLOCK, SECRET_CIPHER, MAILER, INSTANCE_BUS, RATE_LIMIT_STORE, EXECUTION_TURNS, LOGGER, METRICS],
})
export class SharedModule {}
