/**
 * The corners of `exampleFromPattern` the main suite does not walk: every group kind, every escape,
 * negated classes, the length and depth limits, and the branch-skipping that keeps one broken
 * alternative from poisoning the rest.
 *
 * As in `pattern.test.ts`, every value that comes back is also checked against the real `RegExp`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exampleFromPattern } from "../src/pattern.ts";

function satisfying(pattern: string, minLength = 0): string | undefined {
  const value = exampleFromPattern(pattern, minLength);
  if (value !== undefined) assert.match(value, new RegExp(pattern), `«${value}» no cumple ${pattern}`);
  return value;
}

const nested = (levels: number, inner: string) => "(".repeat(levels) + inner + ")".repeat(levels);

describe("exampleFromPattern: grupos", () => {
  test("un grupo con nombre aporta su cuerpo; uno sin cerrar el nombre no se construye", () => {
    assert.equal(satisfying("^(?<codigo>[A-Z]{2})-\\d$"), "AA-0");
    assert.equal(exampleFromPattern("(?<codigo"), undefined);
  });

  test("las aserciones de lookahead y lookbehind no producen caracteres", () => {
    assert.equal(satisfying("^(?!x)ab$"), "ab");
    assert.equal(satisfying("^a(?<=a)b$"), "ab");
    assert.equal(satisfying("^a(?<!x)b$"), "ab");
    // `(?=…)` no consume nada: aquí basta porque lo que sigue cumple la aserción.
    assert.equal(satisfying("^(?=a)a$"), "a");
  });

  test("un modificador de grupo desconocido o un grupo sin cerrar se rinden", () => {
    assert.equal(exampleFromPattern("(?x)"), undefined);
    assert.equal(exampleFromPattern("(abc"), undefined);
  });

  test("un grupo cuyo cuerpo no se puede construir cede a la siguiente alternativa", () => {
    assert.equal(satisfying("^(?:\\p{L})|x$"), "x");
    assert.equal(exampleFromPattern("(\\1)"), undefined);
  });

  test("una rama rota que contiene | o ) dentro de una clase no corta la alternancia ahí", () => {
    // Antes el salto se detenía en el `|` de la clase y devolvía «]», que no cumple el patrón.
    assert.equal(satisfying("^(?:\\1[|]|ok)$"), "ok");
    assert.equal(satisfying("^(?:\\1[)\\]]|ok)$"), "ok");
  });

  test("doce niveles de anidación se construyen y trece no", () => {
    assert.equal(satisfying(nested(12, "b")), "b");
    assert.equal(exampleFromPattern(nested(13, "a")), undefined);
  });

  test("una rama demasiado profunda no deja más profunda a la siguiente", () => {
    // Antes el contador de profundidad quedaba subido tras rendirse, y la segunda rama —válida por
    // sí sola— se juzgaba un nivel más honda de lo que era.
    assert.equal(satisfying(`${nested(13, "a")}|${nested(12, "b")}`), "b");
  });
});

describe("exampleFromPattern: cuantificadores", () => {
  test("las formas perezosas repiten igual que las codiciosas", () => {
    assert.equal(satisfying("^a+?$"), "a");
    assert.equal(satisfying("^a*?b$"), "b");
    assert.equal(satisfying("^a??b$"), "b");
    assert.equal(satisfying("^a{2}?$"), "aa");
  });

  test("{n,} crece hacia minLength y {n,m} se queda dentro del máximo", () => {
    assert.equal(satisfying("^a{2,}$", 5), "aaaaa");
    assert.equal(satisfying("^a{2,4}$", 10), "aaaa");
  });

  test("una llave que no es un cuantificador es un literal", () => {
    assert.equal(satisfying("^a{$"), "a{");
    assert.equal(satisfying("^a{x}$"), "a{x}");
  });

  test("un rango invertido no se construye", () => {
    assert.equal(exampleFromPattern("a{3,1}"), undefined);
  });

  test("nada pasa de 200 caracteres, ni de una repetición ni de la suma", () => {
    assert.equal(exampleFromPattern("a{201}"), undefined);
    assert.equal(exampleFromPattern("a{200}b"), undefined);
    assert.equal(satisfying("^a{200}$")?.length, 200);
  });
});

describe("exampleFromPattern: clases de caracteres", () => {
  test("el punto produce una letra", () => {
    assert.equal(satisfying("^.{3}$"), "aaa");
  });

  test("una clase negada da la primera letra, cifra o signo que no excluye", () => {
    assert.equal(satisfying("^[^a]$"), "b");
    assert.equal(satisfying("^[^a-z]$"), "0");
    assert.equal(satisfying("^[^\\d]$"), "a");
    assert.equal(satisfying("^[^a-z0-9]$"), "-");
  });

  test("una clase negada que lo excluye todo, o una clase vacía, se rinden", () => {
    assert.equal(exampleFromPattern("[^a-z0-9\\-_.]"), undefined);
    assert.equal(exampleFromPattern("[]"), undefined);
  });

  test("un rango al revés o una clase sin cerrar se rinden", () => {
    assert.equal(exampleFromPattern("[z-a]"), undefined);
    assert.equal(exampleFromPattern("[abc"), undefined);
  });

  test("los atajos y escapes dentro de una clase valen lo que representan", () => {
    assert.equal(satisfying("^[\\d]$"), "0");
    assert.equal(satisfying("^[\\w]$"), "a");
    assert.equal(satisfying("^[\\s]$"), " ");
    assert.equal(satisfying("^[\\n]$"), "\n");
    assert.equal(satisfying("^[\\.]$"), ".");
  });

  test("[\\b] es un retroceso, no la letra b", () => {
    assert.equal(satisfying("^[\\b]$"), "\b");
  });

  test("los atajos negados y los escapes por código dentro de una clase se rinden", () => {
    for (const pattern of ["[\\D]", "[\\W]", "[\\S]", "[\\x41]", "[\\u0041]", "[\\cA]", "[\\p{L}]", "[\\1]"])
      assert.equal(exampleFromPattern(pattern), undefined, pattern);
    assert.equal(exampleFromPattern("[\\"), undefined);
  });
});

describe("exampleFromPattern: escapes fuera de clase", () => {
  test("los atajos producen un carácter de su clase", () => {
    assert.equal(satisfying("^\\w\\s\\D\\S\\W$"), "a aa-");
  });

  test("\\b y \\B marcan una posición y no producen nada", () => {
    assert.equal(satisfying("^\\bab$"), "ab");
    assert.equal(satisfying("^a\\Bb$"), "ab");
  });

  test("\\xHH produce el carácter de ese código y uno mal escrito se rinde", () => {
    assert.equal(satisfying("^\\x41$"), "A");
    assert.equal(exampleFromPattern("\\xZZ"), undefined);
  });

  test("\\cX se rinde en lugar de producir «cX»", () => {
    assert.equal(exampleFromPattern("\\cA"), undefined);
  });

  test("los escapes de control y los literales escapados valen lo que representan", () => {
    assert.equal(satisfying("^\\t\\.$"), "\t.");
  });

  test("una barra al final del patrón se rinde", () => {
    assert.equal(exampleFromPattern("a\\"), undefined);
  });
});
