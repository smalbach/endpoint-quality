"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFinished = void 0;
exports.verdictFor = verdictFor;
const isFinished = (status) => ["passed", "failed", "cancelled", "error"].includes(status);
exports.isFinished = isFinished;
/**
 * The verdict of a finished run.
 *
 * A run with skipped cases and no failures still **passes**: a case the environment refused to
 * run — a write against a read-only target — is not a finding about the API, and reporting it as
 * one would train people to ignore red.
 */
function verdictFor(totals) {
    return totals.failed > 0 ? "failed" : "passed";
}
//# sourceMappingURL=model.js.map