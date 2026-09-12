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
