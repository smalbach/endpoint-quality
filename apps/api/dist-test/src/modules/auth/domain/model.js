"use strict";
/**
 * The auth domain: who a user is, and the two kinds of long-lived credential they hold.
 *
 * No TypeORM, no Nest, no HTTP. These types are what the handlers reason about; the columns
 * that store them live in `infrastructure/persistence` and are free to look different.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isActive = isActive;
exports.verifyRefreshToken = verifyRefreshToken;
exports.normalizeEmail = normalizeEmail;
function isActive(user) {
    return user.status === "active";
}
function verifyRefreshToken(token, now) {
    if (token.usedAt)
        return { usable: false, reason: "reused" };
    if (token.revokedAt)
        return { usable: false, reason: "revoked" };
    if (token.expiresAt.getTime() <= now.getTime())
        return { usable: false, reason: "expired" };
    return { usable: true };
}
/** Emails are compared case-insensitively and stored as entered, trimmed. Two accounts that
 * differ only in capitalisation are one account to every user who ever types one of them. */
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
//# sourceMappingURL=model.js.map