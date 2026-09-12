import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import {
  MASK,
  NO_AUTH,
  projectAuthProblems,
  storeProjectAuth,
  viewProjectAuth,
} from "@/modules/projects/domain/project-auth";

const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7).toString("base64"));
const secrets = (stored: { secretCiphertext: string | null }) =>
  stored.secretCiphertext ? (JSON.parse(cipher.decrypt(stored.secretCiphertext)) as Record<string, string>) : {};

describe("la autenticación de un proyecto", () => {
  test("un bearer guarda el token cifrado y lo devuelve enmascarado", () => {
    const stored = storeProjectAuth({ type: "bearer", token: "eyJ.secreto" }, NO_AUTH, cipher);
    assert.equal(stored.secretCiphertext?.includes("eyJ.secreto"), false);
    assert.deepEqual(secrets(stored), { token: "eyJ.secreto" });
    assert.equal(viewProjectAuth(stored).token, MASK);
  });

  test("la máscara de vuelta significa «déjalo como estaba»", () => {
    // Saving the settings form without retyping the token is the ordinary case, and it must not
    // store eight dots as the token.
    const first = storeProjectAuth({ type: "bearer", token: "eyJ.secreto", tokenPath: "data.token" }, NO_AUTH, cipher);
    const second = storeProjectAuth({ type: "bearer", token: MASK, tokenPath: "data.accessToken" }, first, cipher);
    assert.deepEqual(secrets(second), { token: "eyJ.secreto" });
    assert.equal(second.settings.tokenPath, "data.accessToken");
  });

  test("un secreto vacío se borra", () => {
    const first = storeProjectAuth({ type: "bearer", token: "eyJ", loginUrl: "/auth/login" }, NO_AUTH, cipher);
    const second = storeProjectAuth({ type: "bearer", token: "", loginUrl: "/auth/login" }, first, cipher);
    assert.equal(second.secretCiphertext, null);
    assert.equal(viewProjectAuth(second).token, "");
  });

  test("cambiar de tipo no arrastra los secretos del anterior", () => {
    const bearer = storeProjectAuth({ type: "bearer", token: "eyJ" }, NO_AUTH, cipher);
    const basic = storeProjectAuth({ type: "basic", username: "ana", password: "clave" }, bearer, cipher);
    assert.deepEqual(secrets(basic), { password: "clave" });
    assert.equal(storeProjectAuth({ type: "none" }, basic, cipher).secretCiphertext, null);
  });

  test("sin secretos no hace falta la clave de cifrado", () => {
    // An install that never set SECRETS_KEY can still save a login URL.
    const refusing = {
      encrypt: () => assert.fail("no debía cifrar"),
      decrypt: () => assert.fail("no debía descifrar"),
    };
    const stored = storeProjectAuth({ type: "bearer", loginUrl: "https://api.x/login" }, NO_AUTH, refusing);
    assert.deepEqual(stored.settings, { loginUrl: "https://api.x/login", loginMethod: "POST" });
  });

  test("dice qué falta según el tipo", () => {
    assert.deepEqual(
      projectAuthProblems({ type: "bearer" }, NO_AUTH).map((problem) => problem.field),
      ["auth.token"],
    );
    assert.deepEqual(
      projectAuthProblems({ type: "basic" }, NO_AUTH).map((problem) => problem.field),
      ["auth.username", "auth.password"],
    );
    assert.deepEqual(
      projectAuthProblems({ type: "api_key", headerName: "con espacio" }, NO_AUTH).map((problem) => problem.field),
      ["auth.headerName", "auth.apiKey"],
    );
    assert.deepEqual(
      projectAuthProblems({ type: "bearer", loginUrl: "/login", loginBody: "{no" }, NO_AUTH).map((p) => p.field),
      ["auth.loginBody"],
    );
  });

  test("la máscara solo cuenta como secreto si había uno guardado", () => {
    assert.equal(projectAuthProblems({ type: "api_key", apiKey: MASK }, NO_AUTH).length, 1);
    const stored = storeProjectAuth({ type: "api_key", apiKey: "k" }, NO_AUTH, cipher);
    assert.equal(projectAuthProblems({ type: "api_key", apiKey: MASK }, stored).length, 0);
  });
});
