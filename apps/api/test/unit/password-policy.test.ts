import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { passwordProblems } from "@/modules/auth/domain/password-policy";

describe("la política de contraseñas", () => {
  test("acepta una larga con minúscula, mayúscula, número y símbolo", () => {
    assert.deepEqual(passwordProblems("Una-contraseña-larga-1"), []);
  });

  test("nombra cada requisito que falta, no solo el primero", () => {
    // A form that reveals one rule per attempt makes people guess four times.
    assert.deepEqual(passwordProblems("corta"), [
      "Debe tener al menos 12 caracteres",
      "Debe incluir una mayúscula",
      "Debe incluir un número",
      "Debe incluir un símbolo",
    ]);
  });

  test("las letras con tilde cuentan como letras, no como símbolo", () => {
    // `ñ` and `Á` are letters in Spanish. Counting them as symbols would accept a password with no
    // symbol at all.
    assert.ok(passwordProblems("ÁrbolÑandúes12").includes("Debe incluir un símbolo"));
    assert.deepEqual(passwordProblems("ÁrbolÑandúes12!"), []);
  });

  test("la longitud sigue siendo doce aunque cumpla lo demás", () => {
    assert.deepEqual(passwordProblems("Ab1!Ab1!Ab1"), ["Debe tener al menos 12 caracteres"]);
  });
});
