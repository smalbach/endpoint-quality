"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * The rules, checked directly.
 *
 * Everything here is a pure function over plain data. If one of these ever needs a container or
 * an HTTP request to be tested, the rule has drifted out of the domain and into infrastructure.
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const model_1 = require("../../src/modules/iam/domain/model");
const model_2 = require("../../src/modules/auth/domain/model");
const password_hasher_1 = require("../../src/shared/crypto/password-hasher");
const opaque_token_1 = require("../../src/shared/crypto/opaque-token");
const secret_cipher_1 = require("../../src/shared/crypto/secret-cipher");
const jwt_access_token_service_1 = require("../../src/modules/auth/infrastructure/jwt-access-token.service");
const env_1 = require("../../src/shared/config/env");
const test_app_1 = require("../support/test-app");
(0, node_test_1.describe)("la escalera de roles", () => {
    (0, node_test_1.test)("cada rol alcanza a los de debajo y no a los de encima", () => {
        strict_1.default.ok((0, model_1.atLeast)("owner", "viewer"));
        strict_1.default.ok((0, model_1.atLeast)("admin", "editor"));
        strict_1.default.ok((0, model_1.atLeast)("viewer", "viewer"));
        strict_1.default.ok(!(0, model_1.atLeast)("editor", "admin"));
        strict_1.default.ok(!(0, model_1.atLeast)("viewer", "editor"));
    });
    (0, node_test_1.test)("el orden declarado es el orden de privilegio", () => {
        // The guard is a comparison rather than a table of exceptions, which only holds while the
        // array stays sorted. Inserting a role in the wrong position would silently grant it more
        // than intended.
        for (let index = 1; index < model_1.ROLES.length; index += 1) {
            strict_1.default.ok((0, model_1.atLeast)(model_1.ROLES[index], model_1.ROLES[index - 1]), `${model_1.ROLES[index]} debería alcanzar a ${model_1.ROLES[index - 1]}`);
            strict_1.default.ok(!(0, model_1.atLeast)(model_1.ROLES[index - 1], model_1.ROLES[index]));
        }
    });
});
(0, node_test_1.describe)("la organización no se queda sin dueño", () => {
    const membership = (userId, role) => ({ organizationId: "org", userId, role, createdAt: new Date() });
    (0, node_test_1.test)("degradar o quitar al único owner deja la organización huérfana", () => {
        const only = [membership("a", "owner"), membership("b", "admin")];
        strict_1.default.ok((0, model_1.wouldOrphanOrganization)(only, "a", "admin"));
        strict_1.default.ok((0, model_1.wouldOrphanOrganization)(only, "a", null));
    });
    (0, node_test_1.test)("con dos owners cualquiera puede salir", () => {
        const two = [membership("a", "owner"), membership("b", "owner")];
        strict_1.default.ok(!(0, model_1.wouldOrphanOrganization)(two, "a", null));
        strict_1.default.ok(!(0, model_1.wouldOrphanOrganization)(two, "b", "viewer"));
    });
    (0, node_test_1.test)("quitar a alguien que no es owner nunca deja huérfana la organización", () => {
        const list = [membership("a", "owner"), membership("b", "admin")];
        strict_1.default.ok(!(0, model_1.wouldOrphanOrganization)(list, "b", null));
    });
});
(0, node_test_1.describe)("slug", () => {
    (0, node_test_1.test)("acentos y símbolos se pliegan a algo que cabe en una URL", () => {
        strict_1.default.equal((0, model_1.slugify)("Cañón del Chicamocha"), "canon-del-chicamocha");
        strict_1.default.equal((0, model_1.slugify)("  Ara — Digital Catalog  "), "ara-digital-catalog");
    });
    (0, node_test_1.test)("un nombre sin caracteres utilizables no produce un slug vacío", () => {
        // An empty slug would collide with every other empty one and make the URL meaningless.
        strict_1.default.equal((0, model_1.slugify)("···"), "org");
        strict_1.default.equal((0, model_1.slugify)(""), "org");
    });
});
(0, node_test_1.describe)("refresh token", () => {
    const base = {
        id: "t1", userId: "u1", sessionId: "s1", tokenHash: "h",
        expiresAt: new Date("2026-04-01T00:00:00Z"), createdAt: new Date("2026-03-01T00:00:00Z"),
        usedAt: null, revokedAt: null, replacedByHash: null,
    };
    const now = new Date("2026-03-15T00:00:00Z");
    (0, node_test_1.test)("uno fresco es utilizable", () => {
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)(base, now), { usable: true });
    });
    (0, node_test_1.test)("el reuso se distingue de la caducidad y de la revocación", () => {
        // They are three different situations: only the first is an attack signal, and only the
        // first may revoke the session.
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)({ ...base, usedAt: now }, now), { usable: false, reason: "reused" });
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)({ ...base, revokedAt: now }, now), { usable: false, reason: "revoked" });
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)({ ...base, expiresAt: new Date("2026-03-01T00:00:00Z") }, now), { usable: false, reason: "expired" });
    });
    (0, node_test_1.test)("el reuso gana sobre la revocación", () => {
        // A token that was spent *and* then revoked was still spent: reporting it as merely revoked
        // would swallow the signal that two parties held the chain.
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)({ ...base, usedAt: now, revokedAt: now }, now), { usable: false, reason: "reused" });
    });
    (0, node_test_1.test)("caduca en el instante exacto, no un momento después", () => {
        strict_1.default.deepEqual((0, model_2.verifyRefreshToken)(base, new Date("2026-04-01T00:00:00Z")), { usable: false, reason: "expired" });
    });
});
(0, node_test_1.describe)("correos", () => {
    (0, node_test_1.test)("se comparan sin distinguir mayúsculas", () => {
        // Two accounts differing only in capitalisation are one account to every person who ever
        // types one of them.
        strict_1.default.equal((0, model_2.normalizeEmail)("  Ada@Example.COM "), "ada@example.com");
    });
});
(0, node_test_1.describe)("hash de contraseñas", () => {
    (0, node_test_1.test)("el mismo texto produce digests distintos y ambos verifican", async () => {
        const hasher = new password_hasher_1.ScryptPasswordHasher();
        const [first, second] = [await hasher.hash("una-contraseña-larga"), await hasher.hash("una-contraseña-larga")];
        strict_1.default.notEqual(first, second, "sin sal aleatoria dos usuarios con la misma contraseña serían visiblemente iguales");
        strict_1.default.ok(await hasher.verify("una-contraseña-larga", first));
        strict_1.default.ok(await hasher.verify("una-contraseña-larga", second));
    });
    (0, node_test_1.test)("una contraseña incorrecta no verifica", async () => {
        const hasher = new password_hasher_1.ScryptPasswordHasher();
        strict_1.default.equal(await hasher.verify("otra-cosa", await hasher.hash("una-contraseña-larga")), false);
    });
    (0, node_test_1.test)("los parámetros de coste viajan en el digest", async () => {
        // Stored inline so an old digest keeps verifying after the parameters are raised, instead of
        // locking every existing user out on the deploy that hardens them.
        const digest = await new password_hasher_1.ScryptPasswordHasher().hash("x".repeat(12));
        const [scheme, cost] = digest.split("$");
        strict_1.default.equal(scheme, "scrypt");
        strict_1.default.equal(Number(cost), 2 ** 17);
    });
    (0, node_test_1.test)("un digest corrupto se rechaza en vez de reventar", async () => {
        const hasher = new password_hasher_1.FastTestPasswordHasher();
        strict_1.default.equal(await hasher.verify("x", "no-es-un-digest"), false);
        strict_1.default.equal(await hasher.verify("x", ""), false);
    });
    (0, node_test_1.test)("unicode equivalente se normaliza antes de derivar", async () => {
        // "contraseña" typed with a combining tilde is the same word to the person typing it; NFKC
        // is what stops it depending on which keyboard they used.
        const hasher = new password_hasher_1.FastTestPasswordHasher();
        const digest = await hasher.hash("contraseña-larga-aqui");
        strict_1.default.ok(await hasher.verify("contraseña-larga-aqui", digest));
    });
});
(0, node_test_1.describe)("tokens opacos", () => {
    (0, node_test_1.test)("solo se guarda el hash, y coincide con el original", () => {
        const token = (0, opaque_token_1.generateOpaqueToken)();
        const stored = (0, opaque_token_1.hashOpaqueToken)(token);
        strict_1.default.notEqual(stored, token);
        strict_1.default.ok((0, opaque_token_1.opaqueTokenMatches)(token, stored));
        strict_1.default.equal((0, opaque_token_1.opaqueTokenMatches)((0, opaque_token_1.generateOpaqueToken)(), stored), false);
    });
    (0, node_test_1.test)("dos generaciones nunca coinciden", () => {
        const tokens = new Set(Array.from({ length: 200 }, () => (0, opaque_token_1.generateOpaqueToken)()));
        strict_1.default.equal(tokens.size, 200);
    });
    (0, node_test_1.test)("el preview no permite reconstruir el token", () => {
        const token = (0, opaque_token_1.generateOpaqueToken)();
        const preview = (0, opaque_token_1.tokenPreview)(token);
        strict_1.default.ok(preview.length < token.length / 2);
        strict_1.default.equal(token.includes(preview), false);
    });
});
(0, node_test_1.describe)("cifrado de credenciales del target", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    (0, node_test_1.test)("ida y vuelta", () => {
        const cipher = new secret_cipher_1.AesGcmSecretCipher(key);
        strict_1.default.equal(cipher.decrypt(cipher.encrypt("Bearer super-secreto")), "Bearer super-secreto");
    });
    (0, node_test_1.test)("dos cifrados del mismo texto son distintos", () => {
        // A deterministic ciphertext leaks that two environments share a token.
        const cipher = new secret_cipher_1.AesGcmSecretCipher(key);
        strict_1.default.notEqual(cipher.encrypt("mismo"), cipher.encrypt("mismo"));
    });
    (0, node_test_1.test)("un ciphertext manipulado falla al descifrar en vez de devolver basura", () => {
        // The whole reason for GCM: without the tag, a tampered value would decrypt to garbage that
        // then goes out as an Authorization header.
        const cipher = new secret_cipher_1.AesGcmSecretCipher(key);
        const payload = cipher.encrypt("intacto");
        const [version, iv, tag, body] = payload.split(".");
        const flipped = Buffer.from(body, "base64");
        flipped[0] ^= 0xff;
        strict_1.default.throws(() => cipher.decrypt([version, iv, tag, flipped.toString("base64")].join(".")));
    });
    (0, node_test_1.test)("una clave que no mide 32 bytes se rechaza al construir", () => {
        strict_1.default.throws(() => new secret_cipher_1.AesGcmSecretCipher(Buffer.alloc(16).toString("base64")), /32 bytes/);
    });
});
(0, node_test_1.describe)("configuración de entorno", () => {
    (0, node_test_1.test)("una clave de firma corta impide arrancar", () => {
        // A signing secret with a default is a signing secret everybody knows, so there is none:
        // the process refuses to start instead.
        strict_1.default.throws(() => (0, env_1.loadEnv)({ ...test_app_1.TEST_ENV, JWT_ACCESS_SECRET: "corta" }), /JWT_ACCESS_SECRET/);
    });
    (0, node_test_1.test)("falta DATABASE_URL y falla en el arranque, no en la primera consulta", () => {
        const { DATABASE_URL, ...withoutDatabase } = test_app_1.TEST_ENV;
        strict_1.default.throws(() => (0, env_1.loadEnv)(withoutDatabase), /DATABASE_URL/);
    });
    (0, node_test_1.test)("las guardas de red tienen valores seguros por defecto", () => {
        const env = (0, env_1.loadEnv)(test_app_1.TEST_ENV);
        strict_1.default.equal(env.ALLOW_PRIVATE_TARGETS, false, "permitir destinos privados por defecto sería SSRF de fábrica");
        strict_1.default.equal(env.MAX_REDIRECTS, 3);
    });
    (0, node_test_1.test)("ALLOW_PRIVATE_TARGETS solo se activa con un valor afirmativo explícito", () => {
        strict_1.default.equal((0, env_1.loadEnv)({ ...test_app_1.TEST_ENV, ALLOW_PRIVATE_TARGETS: "true" }).ALLOW_PRIVATE_TARGETS, true);
        // "false", "no" and anything else must not enable it — a typo that opened the internal
        // network would be the worst possible parsing bug here.
        for (const value of ["false", "no", "0", "", "maybe"]) {
            strict_1.default.equal((0, env_1.loadEnv)({ ...test_app_1.TEST_ENV, ALLOW_PRIVATE_TARGETS: value }).ALLOW_PRIVATE_TARGETS, false, `"${value}" no debería activar destinos privados`);
        }
    });
});
(0, node_test_1.describe)("duración del access token", () => {
    (0, node_test_1.test)("acepta las formas que se escriben en un .env", () => {
        strict_1.default.equal((0, jwt_access_token_service_1.parseDuration)("15m"), 900);
        strict_1.default.equal((0, jwt_access_token_service_1.parseDuration)("2h"), 7200);
        strict_1.default.equal((0, jwt_access_token_service_1.parseDuration)("900"), 900);
        strict_1.default.equal((0, jwt_access_token_service_1.parseDuration)("1d"), 86400);
    });
    (0, node_test_1.test)("un valor ilegible cae a 15 minutos en vez de a un token eterno", () => {
        strict_1.default.equal((0, jwt_access_token_service_1.parseDuration)("quince minutos"), 900);
    });
});
//# sourceMappingURL=domain.test.js.map