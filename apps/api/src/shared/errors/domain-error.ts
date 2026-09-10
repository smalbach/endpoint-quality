/**
 * Errors the domain raises, with no HTTP in them.
 *
 * A handler that throws `NotFoundException` has an opinion about status codes, which is a
 * presentation concern leaking into the application layer — and the day the same handler is
 * driven by a queue worker instead of a controller, that opinion is noise. The filter maps
 * these to statuses at the edge.
 */
export type ErrorKind = "not-found" | "conflict" | "invalid" | "unauthenticated" | "forbidden" | "rate-limited";

export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** Field-level detail, echoed as `errors[]` in the Problem Details response. */
    readonly fields: { field: string; detail: string }[] = [],
    /** A stable slug for this specific failure, so a client can branch on it without parsing
     * prose. It becomes the `type` URI's last segment. */
    readonly code?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, code?: string) { super("not-found", message, [], code); }
}
export class ConflictError extends DomainError {
  constructor(message: string, code?: string) { super("conflict", message, [], code); }
}
export class InvalidInputError extends DomainError {
  constructor(message: string, fields: { field: string; detail: string }[] = [], code?: string) { super("invalid", message, fields, code); }
}
export class UnauthenticatedError extends DomainError {
  constructor(message = "Credenciales inválidas", code?: string) { super("unauthenticated", message, [], code); }
}
export class ForbiddenError extends DomainError {
  constructor(message = "No tienes permiso sobre este recurso", code?: string) { super("forbidden", message, [], code); }
}
