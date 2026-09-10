"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpaqueToken = generateOpaqueToken;
exports.hashOpaqueToken = hashOpaqueToken;
exports.opaqueTokenMatches = opaqueTokenMatches;
exports.tokenPreview = tokenPreview;
/**
 * Refresh tokens and API tokens, which are opaque bearer secrets rather than passwords.
 *
 * They are hashed with **SHA-256 and not with the password KDF**, and that is deliberate rather
 * than lazy: a 256-bit random string has no dictionary to attack, so the stretching a KDF buys
 * against guessable input buys nothing here — while a refresh call would pay 100 ms for it on
 * every rotation. What matters is that a database dump does not hand over usable tokens, and a
 * one-way hash of a high-entropy secret does that.
 */
const node_crypto_1 = require("node:crypto");
function generateOpaqueToken(bytes = 32) {
    return (0, node_crypto_1.randomBytes)(bytes).toString("base64url");
}
function hashOpaqueToken(token) {
    return (0, node_crypto_1.createHash)("sha256").update(token).digest("base64");
}
function opaqueTokenMatches(token, storedHash) {
    const candidate = Buffer.from(hashOpaqueToken(token));
    const stored = Buffer.from(storedHash);
    return candidate.length === stored.length && (0, node_crypto_1.timingSafeEqual)(candidate, stored);
}
/** The prefix an operator sees in the UI to tell two API tokens apart without revealing either.
 * The token itself is shown exactly once, at creation, and never again. */
function tokenPreview(token) {
    return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
//# sourceMappingURL=opaque-token.js.map