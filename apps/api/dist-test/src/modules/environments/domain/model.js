"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CREDENTIAL_KINDS = exports.CREDENTIAL_ROLES = void 0;
exports.credentialHeader = credentialHeader;
/**
 * What a credential is *for*, which is the thing that generalizes.
 *
 * - `primary`: the working credential, sent by every ordinary case.
 * - `insufficient`: authenticates but falls short of the required scope. That is the 403, and
 *   without a second credential it cannot be tested at all.
 * - `alternate`: a scheme the operation does not declare — an API key on an endpoint that only
 *   accepts bearer. The contract answers 401 and not 403, because it is not a permission problem.
 */
exports.CREDENTIAL_ROLES = ["primary", "insufficient", "alternate"];
exports.CREDENTIAL_KINDS = ["bearer", "api_key", "basic"];
/** The header a credential travels in. Bearer and Basic imply `Authorization`; an API key is
 * whatever the target calls it, which is why the name is stored. */
function credentialHeader(credential, secret) {
    if (credential.kind === "bearer")
        return { Authorization: `Bearer ${secret}` };
    if (credential.kind === "basic")
        return { Authorization: `Basic ${secret}` };
    return { [credential.headerName || "X-API-Key"]: secret };
}
//# sourceMappingURL=model.js.map