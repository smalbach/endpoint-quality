"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ProblemDetailsFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemDetailsFilter = void 0;
/**
 * Every error leaves as RFC 9457 Problem Details.
 *
 * A product whose entire job is asserting that other APIs answer Problem Details, with a named
 * `errors[].field` and no stack trace, does not get to answer `{"statusCode":500,"message":
 * "Internal server error"}` itself. That is not tidiness — the dashboard's own contract tests
 * will eventually run against this API, and they would fail.
 *
 * The 500 branch is the one that matters: it logs the cause and returns nothing about it. A
 * stack trace in a response body is a map of the server's filesystem and dependency versions.
 */
const common_1 = require("@nestjs/common");
const domain_error_1 = require("./domain-error");
const STATUS_BY_KIND = {
    "not-found": common_1.HttpStatus.NOT_FOUND,
    conflict: common_1.HttpStatus.CONFLICT,
    invalid: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    unauthenticated: common_1.HttpStatus.UNAUTHORIZED,
    forbidden: common_1.HttpStatus.FORBIDDEN,
    "rate-limited": common_1.HttpStatus.TOO_MANY_REQUESTS,
};
const TITLE_BY_STATUS = {
    400: "Solicitud inválida",
    401: "No autenticado",
    403: "Sin permiso",
    404: "Recurso no encontrado",
    409: "Conflicto",
    422: "Entidad no procesable",
    429: "Demasiadas solicitudes",
    500: "Error interno",
};
let ProblemDetailsFilter = ProblemDetailsFilter_1 = class ProblemDetailsFilter {
    logger = new common_1.Logger(ProblemDetailsFilter_1.name);
    catch(exception, host) {
        const context = host.switchToHttp();
        const response = context.getResponse();
        const request = context.getRequest();
        const problem = this.toProblem(exception, request.url);
        if (problem.status >= 500) {
            // Logged in full here and described in one line there. The operator gets the cause; the
            // caller gets nothing that describes the inside of the process.
            this.logger.error(`${request.method} ${request.url} → 500`, exception instanceof Error ? exception.stack : String(exception));
        }
        response.status(problem.status).type("application/problem+json").json(problem);
    }
    toProblem(exception, instance) {
        if (exception instanceof domain_error_1.DomainError) {
            const status = STATUS_BY_KIND[exception.kind];
            return {
                type: `https://endpoint-quality.dev/problems/${exception.code ?? exception.kind}`,
                title: TITLE_BY_STATUS[status] ?? "Error",
                status,
                detail: exception.message,
                instance,
                ...(exception.fields.length ? { errors: exception.fields } : {}),
            };
        }
        if (exception instanceof common_1.HttpException) {
            const status = exception.getStatus();
            const payload = exception.getResponse();
            // `class-validator` hands the pipe an array of prose messages. They are turned into named
            // fields because "no debe estar vacío" without a field name is not actionable, and naming
            // the field is exactly what the tool asserts of every API it points at.
            const messages = typeof payload === "object" && payload !== null && Array.isArray(payload.message)
                ? (payload.message)
                : [];
            return {
                type: `https://endpoint-quality.dev/problems/${status}`,
                title: TITLE_BY_STATUS[status] ?? exception.name,
                status,
                detail: messages.length ? "La solicitud no supera la validación" : exception.message,
                instance,
                ...(messages.length ? { errors: messages.map(namedField) } : {}),
            };
        }
        return {
            type: "https://endpoint-quality.dev/problems/internal",
            title: TITLE_BY_STATUS[500],
            status: 500,
            detail: "La solicitud no pudo completarse",
            instance,
        };
    }
};
exports.ProblemDetailsFilter = ProblemDetailsFilter;
exports.ProblemDetailsFilter = ProblemDetailsFilter = ProblemDetailsFilter_1 = __decorate([
    (0, common_1.Catch)()
], ProblemDetailsFilter);
/** `class-validator` prefixes its message with the property name; that prefix is the field. */
function namedField(message) {
    const [first] = message.split(" ");
    return { field: first ?? "body", detail: message };
}
//# sourceMappingURL=problem-details.filter.js.map