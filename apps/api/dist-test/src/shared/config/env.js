"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENV = exports.envSchema = void 0;
exports.loadEnv = loadEnv;
/**
 * The environment, validated once at boot.
 *
 * A missing `JWT_ACCESS_SECRET` must stop the process on the first line, not surface as a 500
 * the first time somebody logs in. The same goes for the network guards: a deployment that
 * meant to forbid private targets and typoed the variable would silently allow them, which is
 * the failure mode SSRF protection cannot have.
 */
const zod_1 = require("zod");
const booleanish = zod_1.z
    .union([zod_1.z.boolean(), zod_1.z.string()])
    .transform((value) => (typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase())));
exports.envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).default("development"),
    PORT: zod_1.z.coerce.number().int().positive().default(3001),
    DATABASE_URL: zod_1.z.string().min(1),
    QUEUE_DRIVER: zod_1.z.enum(["memory", "redis"]).default("memory"),
    REDIS_URL: zod_1.z.string().optional(),
    // Rejected rather than defaulted: a signing key with a default is a signing key everybody
    // knows. 32 characters is the floor, not a recommendation.
    JWT_ACCESS_SECRET: zod_1.z.string().min(32),
    JWT_REFRESH_SECRET: zod_1.z.string().min(32),
    ACCESS_TOKEN_TTL: zod_1.z.string().default("15m"),
    REFRESH_TOKEN_TTL_DAYS: zod_1.z.coerce.number().int().positive().default(30),
    /** AES-256-GCM key for target credentials, 32 bytes in base64. Optional until P3 stores one. */
    SECRETS_KEY: zod_1.z.string().optional(),
    ALLOW_PRIVATE_TARGETS: booleanish.default(false),
    MAX_REDIRECTS: zod_1.z.coerce.number().int().min(0).max(10).default(3),
    REQUEST_TIMEOUT_MS: zod_1.z.coerce.number().int().positive().default(12_000),
    MAX_RESPONSE_BYTES: zod_1.z.coerce.number().int().positive().default(5_242_880),
    CORS_ORIGINS: zod_1.z.string().default("http://localhost:5173"),
    COOKIE_DOMAIN: zod_1.z.string().optional(),
});
function loadEnv(source = process.env) {
    const parsed = exports.envSchema.safeParse(source);
    if (parsed.success)
        return parsed.data;
    const detail = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(raíz)"}: ${issue.message}`).join("\n");
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
}
exports.ENV = Symbol("ENV");
//# sourceMappingURL=env.js.map