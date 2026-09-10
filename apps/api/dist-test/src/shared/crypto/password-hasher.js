"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FastTestPasswordHasher = exports.ScryptPasswordHasher = exports.PASSWORD_HASHER = void 0;
exports.decoyDigest = decoyDigest;
/**
 * Password hashing, behind a port so the algorithm can be replaced without touching a handler.
 *
 * The adapter is **scrypt** (RFC 7914), from Node's own crypto module. Argon2id would be the
 * first choice and the port exists so it can become one — but it is a native dependency, and a
 * self-hosted product whose `pnpm install` can fail to compile a binary on the operator's
 * machine has a worse security outcome than one that ships a memory-hard KDF from the standard
 * library. The parameters below are OWASP's recommended scrypt floor.
 *
 * Two properties the handlers depend on:
 *
 * - **the salt lives in the digest**, so `verify` needs nothing but the stored string;
 * - **`verify` is constant-time** and always does the full work, including against a user that
 *   does not exist. A login that returns faster for an unknown email is an account enumeration
 *   oracle, and it is the cheapest one to leave open by accident.
 */
const node_crypto_1 = require("node:crypto");
/**
 * `promisify(scrypt)` resolves to the three-argument overload, which silently discards the
 * options object — the cost parameters would be dropped and every digest computed at Node's
 * defaults. Wrapped by hand so the parameters are actually applied.
 */
function scryptAsync(password, salt, keylen, options) {
    return new Promise((resolve, reject) => {
        (0, node_crypto_1.scrypt)(password, salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
    });
}
exports.PASSWORD_HASHER = Symbol("PASSWORD_HASHER");
/** OWASP's floor for scrypt: N = 2^17, r = 8, p = 1. `maxmem` has to be raised explicitly or
 * Node refuses the call — its default cap sits below what these parameters need. */
const COST = 2 ** 17;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 256 * 1024 * 1024;
class ScryptPasswordHasher {
    async hash(plain) {
        const salt = (0, node_crypto_1.randomBytes)(16);
        const derived = (await scryptAsync(plain.normalize("NFKC"), salt, KEY_LENGTH, {
            N: COST,
            r: BLOCK_SIZE,
            p: PARALLELISM,
            maxmem: MAX_MEMORY,
        }));
        return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString("base64")}$${derived.toString("base64")}`;
    }
    async verify(plain, digest) {
        const [scheme, cost, blockSize, parallelism, salt, expected] = digest.split("$");
        if (scheme !== "scrypt" || !salt || !expected)
            return false;
        const expectedBytes = Buffer.from(expected, "base64");
        const derived = (await scryptAsync(plain.normalize("NFKC"), Buffer.from(salt, "base64"), expectedBytes.length, {
            N: Number(cost),
            r: Number(blockSize),
            p: Number(parallelism),
            maxmem: MAX_MEMORY,
        }));
        return derived.length === expectedBytes.length && (0, node_crypto_1.timingSafeEqual)(derived, expectedBytes);
    }
}
exports.ScryptPasswordHasher = ScryptPasswordHasher;
/**
 * A digest of a password nobody has, used to spend the same time on an unknown email as on a
 * known one. Computed once at startup rather than per request — the cost that matters is the
 * verification, not the hashing.
 */
async function decoyDigest(hasher) {
    return hasher.hash((0, node_crypto_1.randomBytes)(32).toString("hex"));
}
/**
 * A fast hasher for tests.
 *
 * Real scrypt at OWASP parameters takes ~100 ms per call by design, and a suite that logs in
 * forty times would spend four seconds proving nothing about the KDF. The KDF itself is tested
 * directly, once, against the real adapter.
 */
class FastTestPasswordHasher {
    async hash(plain) {
        const salt = (0, node_crypto_1.randomBytes)(8);
        const derived = (await scryptAsync(plain.normalize("NFKC"), salt, KEY_LENGTH, { N: 2 ** 12, r: 8, p: 1, maxmem: MAX_MEMORY }));
        return `scrypt$4096$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
    }
    async verify(plain, digest) {
        const [scheme, cost, blockSize, parallelism, salt, expected] = digest.split("$");
        if (scheme !== "scrypt" || !salt || !expected)
            return false;
        const expectedBytes = Buffer.from(expected, "base64");
        const derived = (await scryptAsync(plain.normalize("NFKC"), Buffer.from(salt, "base64"), expectedBytes.length, {
            N: Number(cost),
            r: Number(blockSize),
            p: Number(parallelism),
            maxmem: MAX_MEMORY,
        }));
        return derived.length === expectedBytes.length && (0, node_crypto_1.timingSafeEqual)(derived, expectedBytes);
    }
}
exports.FastTestPasswordHasher = FastTestPasswordHasher;
//# sourceMappingURL=password-hasher.js.map