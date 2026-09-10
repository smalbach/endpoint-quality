/**
 * Refresh tokens and API tokens, which are opaque bearer secrets rather than passwords.
 *
 * They are hashed with **SHA-256 and not with the password KDF**, and that is deliberate rather
 * than lazy: a 256-bit random string has no dictionary to attack, so the stretching a KDF buys
 * against guessable input buys nothing here — while a refresh call would pay 100 ms for it on
 * every rotation. What matters is that a database dump does not hand over usable tokens, and a
 * one-way hash of a high-entropy secret does that.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

export function opaqueTokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashOpaqueToken(token));
  const stored = Buffer.from(storedHash);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** The prefix an operator sees in the UI to tell two API tokens apart without revealing either.
 * The token itself is shown exactly once, at creation, and never again. */
export function tokenPreview(token: string): string {
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
