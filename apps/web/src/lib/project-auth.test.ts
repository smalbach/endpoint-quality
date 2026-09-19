import { describe, expect, test } from "vitest";
import { authDraft, authPayload, authProblems, EMPTY_AUTH, MASK, parseTags } from "./project-auth";
import { passwordIsStrong } from "./password-rules";

describe("la autenticación del proyecto en el formulario", () => {
  test("solo manda los campos del tipo elegido", () => {
    // A draft that was bearer and became basic still holds a token in memory; sending it would
    // put a secret in a request that has no use for it.
    const draft = { ...EMPTY_AUTH, type: "basic" as const, token: "eyJ", username: "ana", password: "x" };
    expect(authPayload(draft)).toEqual({ type: "basic", username: "ana", password: "x" });
  });

  test("la máscara viaja tal cual, que para la API es «sin cambios»", () => {
    const draft = authDraft({ ...EMPTY_AUTH, type: "api_key", apiKey: MASK, headerName: "" });
    expect(draft.headerName).toBe("X-API-Key");
    expect(authPayload(draft)).toEqual({ type: "api_key", headerName: "X-API-Key", apiKey: MASK });
    expect(authProblems(draft)).toEqual({});
  });

  test("avisa de lo mismo que la API rechazaría", () => {
    expect(Object.keys(authProblems({ ...EMPTY_AUTH, type: "bearer" }))).toEqual(["auth.token"]);
    expect(authProblems({ ...EMPTY_AUTH, type: "bearer", loginUrl: "/login", loginBody: "[1]" })).toEqual({
      "auth.loginBody": "Tiene que ser un objeto JSON",
    });
    expect(Object.keys(authProblems({ ...EMPTY_AUTH, type: "basic" }))).toEqual(["auth.username", "auth.password"]);
  });

  test("las etiquetas se escriben separadas por comas", () => {
    expect(parseTags(" produccion, v2,, v2 ")).toEqual(["produccion", "v2"]);
  });
});

describe("las reglas de contraseña del formulario", () => {
  test("coinciden con las del servidor", () => {
    expect(passwordIsStrong("Una-contraseña-larga-1")).toBe(true);
    expect(passwordIsStrong("una-contraseña-larga-1")).toBe(false);
    expect(passwordIsStrong("ÁrbolÑandúes12")).toBe(false);
  });
});

describe("cada tipo, entero", () => {
  test("sin vista de la API, el borrador vacío; con ella, se respeta el método que trae", () => {
    expect(authDraft(undefined)).toBe(EMPTY_AUTH);
    const draft = authDraft({ ...EMPTY_AUTH, type: "bearer", loginMethod: "PUT", headerName: "X-Clave" });
    expect(draft.loginMethod).toBe("PUT");
    expect(draft.headerName).toBe("X-Clave");
    expect(authDraft({ ...EMPTY_AUTH, loginMethod: "" }).loginMethod).toBe("POST");
  });

  test("ninguna manda solo el tipo; bearer manda su login recortado", () => {
    expect(authPayload({ ...EMPTY_AUTH, token: "t" })).toEqual({ type: "none" });
    expect(
      authPayload({
        ...EMPTY_AUTH,
        type: "bearer",
        token: MASK,
        loginUrl: " /login ",
        loginMethod: "POST",
        loginBody: '{"u":"a"}',
        tokenPath: " data.token ",
        password: "no-viaja",
      }),
    ).toEqual({
      type: "bearer",
      token: MASK,
      loginUrl: "/login",
      loginMethod: "POST",
      loginBody: '{"u":"a"}',
      tokenPath: "data.token",
    });
  });

  test("bearer: la URL de login es http(s) o una ruta, y el cuerpo un objeto JSON", () => {
    expect(authProblems({ ...EMPTY_AUTH, type: "bearer", token: "t", loginUrl: "ftp://x" })).toEqual({
      "auth.loginUrl": "Una URL http(s) o una ruta que empiece por /",
    });
    expect(authProblems({ ...EMPTY_AUTH, type: "bearer", loginUrl: "https://api/login", loginBody: "{" })).toEqual({
      "auth.loginBody": "No es JSON válido",
    });
    expect(authProblems({ ...EMPTY_AUTH, type: "bearer", loginUrl: "HTTP://api/login", loginBody: '{"u":1}' })).toEqual(
      {},
    );
    // The mask is «unchanged» to the API: it is not JSON and must not be judged as such.
    expect(authProblems({ ...EMPTY_AUTH, type: "bearer", loginUrl: "/login", loginBody: MASK })).toEqual({});
  });

  test("basic completo no tiene problemas", () => {
    expect(authProblems({ ...EMPTY_AUTH, type: "basic", username: "ana", password: "x" })).toEqual({});
  });

  test("api key: un nombre de cabecera válido y una clave", () => {
    expect(authProblems({ ...EMPTY_AUTH, type: "api_key", headerName: "X Clave", apiKey: "" })).toEqual({
      "auth.headerName": "No es un nombre de cabecera válido",
      "auth.apiKey": "Falta la clave",
    });
  });
});
