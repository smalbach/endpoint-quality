/**
 * The environment, validated once at boot.
 *
 * A missing `JWT_ACCESS_SECRET` must stop the process on the first line, not surface as a 500
 * the first time somebody logs in. The same goes for the network guards: a deployment that
 * meant to forbid private targets and typoed the variable would silently allow them, which is
 * the failure mode SSRF protection cannot have.
 */
import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),

  QUEUE_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().optional(),

  // Rejected rather than defaulted: a signing key with a default is a signing key everybody
  // knows. 32 characters is the floor, not a recommendation.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * AES-256-GCM key, 32 bytes in base64. Optional here and required in practice: the two things
   * that need it — a target credential and a variable marked secret — both fail loudly at the
   * moment of the write rather than at boot, because an install that stores neither should not be
   * made to invent a key it will never use.
   */
  SECRETS_KEY: z.string().optional(),

  ALLOW_PRIVATE_TARGETS: booleanish.default(false),
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(5_242_880),

  /**
   * Retention, in days. `0` means never, and is a decision somebody has to make on purpose.
   *
   * Two stages because the two things cost differently. A step's request and response bodies are
   * what make `run_steps` the table with no ceiling; its assertion list and label are a few
   * hundred bytes and are what lets a run from March still answer «was this green, and what
   * failed». So the bodies go first, at 30 days, and the run itself much later.
   */
  RETENTION_BODIES_DAYS: z.coerce.number().int().min(0).default(30),
  RETENTION_RUNS_DAYS: z.coerce.number().int().min(0).default(365),
  /** How often the sweep runs. Not a cron: one interval, started at boot, is the whole of it. */
  RETENTION_SWEEP_HOURS: z.coerce.number().int().min(0).max(168).default(6),

  /**
   * Cada cuánto se mira si algún monitor ha vencido. `0` apaga la vigilancia.
   *
   * Decide la precisión del horario y nada más: con el valor por defecto, un monitor de las 9:00
   * dispara entre las 9:00 y las 9:01. Afinarlo sería consultar la tabla sesenta veces por minuto
   * para adelantar un turno unos segundos. Que dos instancias hagan este turno a la vez es seguro:
   * lo que reparte los monitores es un reclamo en la base de datos, no este intervalo.
   */
  MONITOR_TICK_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  /**
   * Los techos de una sesión de WebSocket, para todo el despliegue.
   *
   * Cada canal elige sus propios topes y estos son el máximo que puede elegir: un canal no puede
   * pedir escuchar una hora ni guardar cien megas porque quien lo creó lo escribiera así. Los
   * valores por omisión son los que una prueba de un socket necesita de verdad —treinta segundos,
   * doscientos mensajes— y no más.
   *
   * `CHANNEL_MAX_IDLE_MS` es el que atrapa el socket colgado: sin él, toda sesión contra un servidor
   * que acepta y calla cuesta la duración entera. Y `CHANNEL_MAX_OPEN` es por proceso, porque un
   * socket abierto es un descriptor, y sin tope el editor sería una forma de clavar quinientos en la
   * API a golpe de botón.
   */
  CHANNEL_MAX_MESSAGES: z.coerce.number().int().min(1).max(10_000).default(200),
  CHANNEL_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(1024 * 1024),
  CHANNEL_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .min(256)
    .max(16 * 1024 * 1024)
    .default(64 * 1024),
  CHANNEL_MAX_DURATION_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  CHANNEL_MAX_IDLE_MS: z.coerce.number().int().min(500).max(600_000).default(10_000),
  CHANNEL_MAX_OPEN: z.coerce.number().int().min(1).max(1000).default(20),

  /**
   * The most cases one run may produce.
   *
   * Every ceiling in this product is local — 500 rows in a dataset, 50 flows in a suite, 200
   * elements in a loop — and they **multiply**. Nothing was stopping one click from queueing a run
   * of several million requests against somebody's staging environment, which is not a test suite;
   * it is an outage with a green tick at the end of it.
   *
   * Checked twice, because the size is known in two halves: the flows times the rows is arithmetic
   * done before the run is queued, so it is a 422 at the click, and a loop's length is whatever the
   * target answered, so it is enforced while walking and the truncation is reported.
   */
  MAX_RUN_CASES: z.coerce.number().int().min(1).default(5_000),

  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_DOMAIN: z.string().optional(),

  /** Where the interface lives, for the links a mail carries. */
  APP_URL: z.string().url().default("http://localhost:5173"),
  /**
   * `log` writes mails to the process log, which is enough for a local install and shows the reset
   * link to whoever runs it. `brevo` sends them, and then the key is required: a deployment that
   * asked for real mail and has no key must fail at boot, not the first time somebody forgets
   * their password.
   */
  MAIL_DRIVER: z.enum(["log", "brevo"]).default("log"),
  BREVO_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().email().default("no-reply@endpoint-quality.local"),
  MAIL_FROM_NAME: z.string().default("Endpoint Quality"),

  /**
   * The model that narrates a security run. Optional: with no key the run still gets a deterministic
   * analysis built from its own numbers, so the feature degrades to «no prose» rather than «no
   * feature». The model never sets the score — that is evidence, computed.
   */
  SECURITY_AI_DRIVER: z.enum(["off", "anthropic"]).default("off"),
  ANTHROPIC_API_KEY: z.string().optional(),
  SECURITY_AI_MODEL: z.string().default("claude-sonnet-4-6"),
});

const refinedEnvSchema = envSchema.superRefine((env, context) => {
  if (env.MAIL_DRIVER === "brevo" && !env.BREVO_API_KEY)
    context.addIssue({ code: "custom", path: ["BREVO_API_KEY"], message: "requerida con MAIL_DRIVER=brevo" });
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = refinedEnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Configuración de entorno inválida:\n${detail}`);
}

export const ENV = Symbol("ENV");
