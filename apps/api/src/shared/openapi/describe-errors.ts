/**
 * Declares, on this API's own contract, the errors it actually answers.
 *
 * Nest generates a document from the decorators, and the decorators describe the happy path: one
 * response per operation, the one the handler returns. Everything this product exists to check —
 * the 401 of a missing token, the 404 of somebody else's project, the 422 of a bad body — was
 * undeclared. **That makes the document a description of half the API**, and it is the exact
 * failure the product looks for in everybody else's: a contract that promises less than the
 * service does, so nothing is testing the promises that were never written down.
 *
 * It also has a concrete consequence: you cannot point Endpoint Quality at Endpoint Quality. The
 * matrix is generated from `statuses`, and with only a 200 declared there is no authorization
 * matrix, no not-found case and no invalid-body case to generate.
 *
 * The rules below are derived from the route rather than written per operation, because 45
 * operations' worth of `@ApiResponse` decorators is 45 places for the document to drift from the
 * guard that actually decides. What the guards do is uniform, so this is too:
 *
 * - **401** everywhere the auth guard runs, which is everywhere except the four public routes;
 * - **403** where a role is required, which is every route under an organization;
 * - **404** where the path names something that may not exist, or may belong to somebody else —
 *   the API folds "not yours" into "not found" on purpose, so it does not confirm that an id is
 *   real to an outsider;
 * - **422** where a body is validated, which is anywhere one is accepted;
 * - **429** everywhere, because the throttler is global.
 */
import type { OpenAPIObject } from "@nestjs/swagger";

/**
 * The routes that answer without a credential. Four, and each one has to be:
 *
 * `/health` is what a load balancer polls; the other three are how a session begins, and
 * `refresh` in particular runs before there is an access token to present. `PUBLIC_PATHS` is
 * asserted against the running app in the suite rather than trusted — a document that says a
 * route needs a token when it does not is worse than one that says nothing.
 */
export const PUBLIC_PATHS = new Set(["/health", "/auth/register", "/auth/login", "/auth/refresh"]);

const PROBLEM_DETAILS = "ProblemDetails";

/** RFC 9457, which is what `ProblemDetailsFilter` writes for every error in the system. */
const problemDetailsSchema = {
  type: "object",
  required: ["type", "title", "status", "detail"],
  properties: {
    type: { type: "string", format: "uri", description: "Identificador del tipo de problema." },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    errors: {
      type: "array",
      description:
        "Presente en un 422: qué campo y por qué. Es lo que permite poner el mensaje junto al input que lo causó.",
      items: {
        type: "object",
        required: ["field", "detail"],
        properties: { field: { type: "string" }, detail: { type: "string" } },
      },
    },
  },
} as const;

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: { $ref: `#/components/schemas/${PROBLEM_DETAILS}` } } },
});

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function describeErrors(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[PROBLEM_DETAILS] =
    problemDetailsSchema as unknown as (typeof document.components.schemas)[string];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const isPublic = PUBLIC_PATHS.has(path);
    // Under an organization is where `OrgRoleGuard` runs, and it is the only place a role can be
    // insufficient. Outside it the answer to "not yours" is 401 or 404, never 403.
    const scoped = path.startsWith("/orgs/");
    const addressesSomething = path.includes("{");

    for (const method of METHODS) {
      const operation = (item as Record<string, unknown>)[method] as
        { responses?: Record<string, unknown>; requestBody?: unknown } | undefined;
      if (!operation) continue;
      const responses = (operation.responses ??= {});

      if (!isPublic) responses["401"] ??= problem("Falta el token, ha caducado o ha sido revocado.");
      if (scoped) responses["403"] ??= problem("El rol en la organización no alcanza para esta operación.");
      if (scoped && addressesSomething) {
        responses["404"] ??= problem(
          "No existe, o pertenece a otra organización: la API no distingue las dos cosas a propósito, para no confirmarle a nadie que un identificador ajeno es real.",
        );
      }
      if (operation.requestBody)
        responses["422"] ??= problem("El cuerpo no supera la validación. `errors` nombra los campos.");
      responses["429"] ??= problem("Demasiadas peticiones.");
    }
  }
  return document;
}
