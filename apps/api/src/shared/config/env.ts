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
  .transform((value) => (typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase())));

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

  /** AES-256-GCM key for target credentials, 32 bytes in base64. Optional until P3 stores one. */
  SECRETS_KEY: z.string().optional(),

  ALLOW_PRIVATE_TARGETS: booleanish.default(false),
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(5_242_880),

  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_DOMAIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(raíz)"}: ${issue.message}`).join("\n");
  throw new Error(`Configuración de entorno inválida:\n${detail}`);
}

export const ENV = Symbol("ENV");
