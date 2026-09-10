"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForbiddenError = exports.UnauthenticatedError = exports.InvalidInputError = exports.ConflictError = exports.NotFoundError = exports.DomainError = void 0;
class DomainError extends Error {
    kind;
    fields;
    code;
    constructor(kind, message, 
    /** Field-level detail, echoed as `errors[]` in the Problem Details response. */
    fields = [], 
    /** A stable slug for this specific failure, so a client can branch on it without parsing
     * prose. It becomes the `type` URI's last segment. */
    code) {
        super(message);
        this.kind = kind;
        this.fields = fields;
        this.code = code;
        this.name = new.target.name;
    }
}
exports.DomainError = DomainError;
class NotFoundError extends DomainError {
    constructor(message, code) { super("not-found", message, [], code); }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends DomainError {
    constructor(message, code) { super("conflict", message, [], code); }
}
exports.ConflictError = ConflictError;
class InvalidInputError extends DomainError {
    constructor(message, fields = [], code) { super("invalid", message, fields, code); }
}
exports.InvalidInputError = InvalidInputError;
class UnauthenticatedError extends DomainError {
    constructor(message = "Credenciales inválidas", code) { super("unauthenticated", message, [], code); }
}
exports.UnauthenticatedError = UnauthenticatedError;
class ForbiddenError extends DomainError {
    constructor(message = "No tienes permiso sobre este recurso", code) { super("forbidden", message, [], code); }
}
exports.ForbiddenError = ForbiddenError;
//# sourceMappingURL=domain-error.js.map