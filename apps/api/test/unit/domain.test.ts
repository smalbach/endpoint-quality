/**
 * The rules, checked directly.
 *
 * Everything here is a pure function over plain data. If one of these ever needs a container or
 * an HTTP request to be tested, the rule has drifted out of the domain and into infrastructure.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  atLeast,
  ROLES,
  slugify,
  wouldOrphanOrganization,
  type Membership,
  type Role,
} from "@/modules/iam/domain/model";
import { normalizeEmail, verifyRefreshToken, type RefreshToken } from "@/modules/auth/domain/model";
import { ScryptPasswordHasher, FastTestPasswordHasher } from "@/shared/crypto/password-hasher";
import { generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches, tokenPreview } from "@/shared/crypto/opaque-token";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { parseDuration } from "@/modules/auth/infrastructure/jwt-access-token.service";
import { loadEnv } from "@/shared/config/env";
import { TEST_ENV } from "../support/test-app";
import { caseStatusFor } from "@/modules/runs/domain/model";
import type { Assertion as WireAssertion } from "@eq/contracts";
import type { Assertion as EngineAssertion } from "@eq/runner-core";

describe("la escalera de roles", () => {
  test("cada rol alcanza a los de debajo y no a los de encima", () => {
    assert.ok(atLeast("owner", "viewer"));
    assert.ok(atLeast("admin", "editor"));
    assert.ok(atLeast("viewer", "viewer"));
    assert.ok(!atLeast("editor", "admin"));
    assert.ok(!atLeast("viewer", "editor"));
  });

  test("el orden declarado es el orden de privilegio", () => {
    // The guard is a comparison rather than a table of exceptions, which only holds while the
    // array stays sorted. Inserting a role in the wrong position would silently grant it more
    // than intended.
    for (let index = 1; index < ROLES.length; index += 1) {
      assert.ok(atLeast(ROLES[index], ROLES[index - 1]), `${ROLES[index]} debería alcanzar a ${ROLES[index - 1]}`);
      assert.ok(!atLeast(ROLES[index - 1], ROLES[index]));
    }
  });
});

describe("la organización no se queda sin dueño", () => {
  const membership = (userId: string, role: Role): Membership => ({
    organizationId: "org",
    userId,
    role,
    createdAt: new Date(),
  });

  test("degradar o quitar al único owner deja la organización huérfana", () => {
    const only = [membership("a", "owner"), membership("b", "admin")];
    assert.ok(wouldOrphanOrganization(only, "a", "admin"));
    assert.ok(wouldOrphanOrganization(only, "a", null));
  });

  test("con dos owners cualquiera puede salir", () => {
    const two = [membership("a", "owner"), membership("b", "owner")];
    assert.ok(!wouldOrphanOrganization(two, "a", null));
    assert.ok(!wouldOrphanOrganization(two, "b", "viewer"));
  });

  test("quitar a alguien que no es owner nunca deja huérfana la organización", () => {
    const list = [membership("a", "owner"), membership("b", "admin")];
    assert.ok(!wouldOrphanOrganization(list, "b", null));
  });
});

describe("slug", () => {
  test("acentos y símbolos se pliegan a algo que cabe en una URL", () => {
    assert.equal(slugify("Cañón del Chicamocha"), "canon-del-chicamocha");
    assert.equal(slugify("  Ara — Digital Catalog  "), "ara-digital-catalog");
  });
  test("un nombre sin caracteres utilizables no produce un slug vacío", () => {
    // An empty slug would collide with every other empty one and make the URL meaningless.
    assert.equal(slugify("···"), "org");
    assert.equal(slugify(""), "org");
  });
});

describe("refresh token", () => {
  const base: RefreshToken = {
    id: "t1",
    userId: "u1",
    sessionId: "s1",
    tokenHash: "h",
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    createdAt: new Date("2026-03-01T00:00:00Z"),
    usedAt: null,
    revokedAt: null,
    replacedByHash: null,
  };
  const now = new Date("2026-03-15T00:00:00Z");

  test("uno fresco es utilizable", () => {
    assert.deepEqual(verifyRefreshToken(base, now), { usable: true });
  });

  test("el reuso se distingue de la caducidad y de la revocación", () => {
    // They are three different situations: only the first is an attack signal, and only the
    // first may revoke the session.
    assert.deepEqual(verifyRefreshToken({ ...base, usedAt: now }, now), { usable: false, reason: "reused" });
    assert.deepEqual(verifyRefreshToken({ ...base, revokedAt: now }, now), { usable: false, reason: "revoked" });
    assert.deepEqual(verifyRefreshToken({ ...base, expiresAt: new Date("2026-03-01T00:00:00Z") }, now), {
      usable: false,
      reason: "expired",
    });
  });

  test("el reuso gana sobre la revocación", () => {
    // A token that was spent *and* then revoked was still spent: reporting it as merely revoked
    // would swallow the signal that two parties held the chain.
    assert.deepEqual(verifyRefreshToken({ ...base, usedAt: now, revokedAt: now }, now), {
      usable: false,
      reason: "reused",
    });
  });

  test("caduca en el instante exacto, no un momento después", () => {
    assert.deepEqual(verifyRefreshToken(base, new Date("2026-04-01T00:00:00Z")), { usable: false, reason: "expired" });
  });
});

describe("correos", () => {
  test("se comparan sin distinguir mayúsculas", () => {
    // Two accounts differing only in capitalisation are one account to every person who ever
    // types one of them.
    assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  });
});

describe("hash de contraseñas", () => {
  test("el mismo texto produce digests distintos y ambos verifican", async () => {
    const hasher = new ScryptPasswordHasher();
    const [first, second] = [await hasher.hash("Una-contraseña-larga-1"), await hasher.hash("Una-contraseña-larga-1")];
    assert.notEqual(
      first,
      second,
      "sin sal aleatoria dos usuarios con la misma contraseña serían visiblemente iguales",
    );
    assert.ok(await hasher.verify("Una-contraseña-larga-1", first));
    assert.ok(await hasher.verify("Una-contraseña-larga-1", second));
  });

  test("una contraseña incorrecta no verifica", async () => {
    const hasher = new ScryptPasswordHasher();
    assert.equal(await hasher.verify("otra-cosa", await hasher.hash("Una-contraseña-larga-1")), false);
  });

  test("los parámetros de coste viajan en el digest", async () => {
    // Stored inline so an old digest keeps verifying after the parameters are raised, instead of
    // locking every existing user out on the deploy that hardens them.
    const digest = await new ScryptPasswordHasher().hash("x".repeat(12));
    const [scheme, cost] = digest.split("$");
    assert.equal(scheme, "scrypt");
    assert.equal(Number(cost), 2 ** 17);
  });

  test("un digest corrupto se rechaza en vez de reventar", async () => {
    const hasher = new FastTestPasswordHasher();
    assert.equal(await hasher.verify("x", "no-es-un-digest"), false);
    assert.equal(await hasher.verify("x", ""), false);
  });

  test("unicode equivalente se normaliza antes de derivar", async () => {
    // "contraseña" typed with a combining tilde is the same word to the person typing it; NFKC
    // is what stops it depending on which keyboard they used.
    const hasher = new FastTestPasswordHasher();
    const digest = await hasher.hash("contraseña-larga-aqui");
    assert.ok(await hasher.verify("contraseña-larga-aqui", digest));
  });
});

describe("tokens opacos", () => {
  test("solo se guarda el hash, y coincide con el original", () => {
    const token = generateOpaqueToken();
    const stored = hashOpaqueToken(token);
    assert.notEqual(stored, token);
    assert.ok(opaqueTokenMatches(token, stored));
    assert.equal(opaqueTokenMatches(generateOpaqueToken(), stored), false);
  });

  test("dos generaciones nunca coinciden", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOpaqueToken()));
    assert.equal(tokens.size, 200);
  });

  test("el preview no permite reconstruir el token", () => {
    const token = generateOpaqueToken();
    const preview = tokenPreview(token);
    assert.ok(preview.length < token.length / 2);
    assert.equal(token.includes(preview), false);
  });
});

describe("cifrado de credenciales del target", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  test("ida y vuelta", () => {
    const cipher = new AesGcmSecretCipher(key);
    assert.equal(cipher.decrypt(cipher.encrypt("Bearer super-secreto")), "Bearer super-secreto");
  });

  test("dos cifrados del mismo texto son distintos", () => {
    // A deterministic ciphertext leaks that two environments share a token.
    const cipher = new AesGcmSecretCipher(key);
    assert.notEqual(cipher.encrypt("mismo"), cipher.encrypt("mismo"));
  });

  test("un ciphertext manipulado falla al descifrar en vez de devolver basura", () => {
    // The whole reason for GCM: without the tag, a tampered value would decrypt to garbage that
    // then goes out as an Authorization header.
    const cipher = new AesGcmSecretCipher(key);
    const payload = cipher.encrypt("intacto");
    const [version, iv, tag, body] = payload.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 0xff;
    assert.throws(() => cipher.decrypt([version, iv, tag, flipped.toString("base64")].join(".")));
  });

  test("una clave que no mide 32 bytes se rechaza al construir", () => {
    assert.throws(() => new AesGcmSecretCipher(Buffer.alloc(16).toString("base64")), /32 bytes/);
  });
});

describe("configuración de entorno", () => {
  test("una clave de firma corta impide arrancar", () => {
    // A signing secret with a default is a signing secret everybody knows, so there is none:
    // the process refuses to start instead.
    assert.throws(() => loadEnv({ ...TEST_ENV, JWT_ACCESS_SECRET: "corta" }), /JWT_ACCESS_SECRET/);
  });

  test("falta DATABASE_URL y falla en el arranque, no en la primera consulta", () => {
    const { DATABASE_URL, ...withoutDatabase } = TEST_ENV;
    assert.throws(() => loadEnv(withoutDatabase), /DATABASE_URL/);
  });

  test("las guardas de red tienen valores seguros por defecto", () => {
    const env = loadEnv(TEST_ENV);
    assert.equal(env.ALLOW_PRIVATE_TARGETS, false, "permitir destinos privados por defecto sería SSRF de fábrica");
    assert.equal(env.MAX_REDIRECTS, 3);
  });

  test("ALLOW_PRIVATE_TARGETS solo se activa con un valor afirmativo explícito", () => {
    assert.equal(loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: "true" }).ALLOW_PRIVATE_TARGETS, true);
    // "false", "no" and anything else must not enable it — a typo that opened the internal
    // network would be the worst possible parsing bug here.
    for (const value of ["false", "no", "0", "", "maybe"]) {
      assert.equal(
        loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: value }).ALLOW_PRIVATE_TARGETS,
        false,
        `"${value}" no debería activar destinos privados`,
      );
    }
  });
});

describe("duración del access token", () => {
  test("acepta las formas que se escriben en un .env", () => {
    assert.equal(parseDuration("15m"), 900);
    assert.equal(parseDuration("2h"), 7200);
    assert.equal(parseDuration("900"), 900);
    assert.equal(parseDuration("1d"), 86400);
  });
  test("un valor ilegible cae a 15 minutos en vez de a un token eterno", () => {
    assert.equal(parseDuration("quince minutos"), 900);
  });
});

describe("el veredicto de un caso", () => {
  test("sin pasos es «saltado», no «fallado»", () => {
    // A case that ran nothing — the environment refused every request in it — is not a finding
    // about the endpoint. Reporting it as one teaches people to ignore red.
    assert.equal(caseStatusFor({ ok: false, steps: [] }), "skipped");
    assert.equal(caseStatusFor({ ok: true, steps: [] }), "skipped");
    assert.equal(caseStatusFor({ ok: true, steps: [1] }), "passed");
    assert.equal(caseStatusFor({ ok: false, steps: [1] }), "failed");
  });
});

/**
 * `Assertion` is declared twice — once in the engine, once in the wire contracts — because
 * `@eq/contracts` carries no runtime and cannot depend on the engine. This is the only package
 * that sees both, so this is where the two are held to saying the same thing. It asserts nothing
 * at runtime: if they ever diverge, the build fails here.
 */
type _AssertionsAgree = [
  EngineAssertion extends WireAssertion ? true : never,
  WireAssertion extends EngineAssertion ? true : never,
];
const _assertionsAgree: _AssertionsAgree = [true, true];
void _assertionsAgree;
