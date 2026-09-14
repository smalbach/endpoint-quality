/**
 * What a performance plan may say, checked in one place.
 *
 * The same division the workflows module draws: the DTO settles that the request is an object with
 * strings of the right length, and this settles what those strings may mean — a weight is not
 * negative, a duration has a ceiling, a scenario has at least one request to send. Kept in the
 * domain and validated inside the command so the published API contract and the stored document
 * cannot come from two lists that disagree.
 *
 * The ceilings on VUs and duration are the load-test equivalent of `MAX_RUN_CASES`: a plan whose
 * size is knowable from its own numbers is refused at save, not while a machine is already melting.
 */
import { z } from "zod";

import { LOAD_PROFILE_TYPES, PERF_CHECK_OPERATORS, PERF_CHECK_SOURCES } from "./model";

/** Hard ceilings, generous enough for a real test and low enough that a typo cannot ask for a
 * million virtual users. Enforced here so both create and update inherit them. */
export const PERF_MAX_VUS = 500;
export const PERF_MAX_DURATION_S = 900;

const extractSchema = z.object({
  variable: z.string().min(1).max(80),
  path: z.string().min(1).max(300),
});

const checkSchema = z.object({
  source: z.enum(PERF_CHECK_SOURCES),
  path: z.string().max(300).optional(),
  operator: z.enum(PERF_CHECK_OPERATORS),
  value: z.unknown().optional(),
});

const requestSchema = z.object({
  method: z.string().min(1).max(10),
  path: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  extract: z.array(extractSchema).max(20).optional(),
  checks: z.array(checkSchema).max(20).optional(),
});

const scenarioSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  weight: z.number().min(0).max(1000),
  thinkMs: z.number().int().min(0).max(60_000),
  requests: z.array(requestSchema).min(1).max(50),
});

const profileSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(LOAD_PROFILE_TYPES[0]), // constant
    vus: z.number().int().min(1).max(PERF_MAX_VUS),
    durationS: z.number().int().min(1).max(PERF_MAX_DURATION_S),
  }),
  z.object({
    type: z.literal(LOAD_PROFILE_TYPES[1]), // ramp
    startVus: z.number().int().min(0).max(PERF_MAX_VUS),
    endVus: z.number().int().min(0).max(PERF_MAX_VUS),
    durationS: z.number().int().min(1).max(PERF_MAX_DURATION_S),
  }),
  z.object({
    type: z.literal(LOAD_PROFILE_TYPES[2]), // spike
    baseVus: z.number().int().min(0).max(PERF_MAX_VUS),
    peakVus: z.number().int().min(1).max(PERF_MAX_VUS),
    durationS: z.number().int().min(1).max(PERF_MAX_DURATION_S),
  }),
]);

const thresholdsSchema = z.object({
  p95Ms: z.number().int().min(1).optional(),
  p99Ms: z.number().int().min(1).optional(),
  maxErrorRate: z.number().min(0).max(1).optional(),
  minRps: z.number().min(0).optional(),
});

export const planDefinitionSchema = z.object({
  scenarios: z.array(scenarioSchema).min(1).max(20),
  profile: profileSchema,
  thresholds: thresholdsSchema,
});

type ParseResult = { ok: true } | { ok: false; issues: { field: string; detail: string }[] };

/** Same `{ ok, issues }` shape the workflows schema uses, so the command reports issues the one way
 * this API reports them. */
export const safeParsePlanDefinition = (data: unknown): ParseResult => {
  const result = planDefinitionSchema.safeParse(data);
  return result.success
    ? { ok: true }
    : {
        ok: false,
        issues: result.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : "definition",
          detail: issue.message,
        })),
      };
};
