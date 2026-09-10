import { describe, expect, test } from "vitest";
import { jsonFrom, parseVariables, recordFrom, rowsFrom } from "@/lib/env-variables";

describe("las variables de un entorno", () => {
  test("filas y JSON son la misma cosa, ida y vuelta", () => {
    const variables = { userId: "42", tenant: "acme" };
    const parsed = parseVariables(jsonFrom(rowsFrom(variables)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(recordFrom(parsed.rows)).toEqual(variables);
  });

  test("una fila a medio escribir no es una variable todavía", () => {
    expect(
      recordFrom([
        ["", "sin nombre"],
        [" userId ", "42"],
      ]),
    ).toEqual({ userId: "42" });
  });

  test("un valor que no es texto se rechaza aquí y no como un 422", () => {
    const parsed = parseVariables('{"userId": 42}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no es texto");
  });

  test("un nombre inválido se nombra", () => {
    const parsed = parseVariables('{"2users": "x"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("2users");
  });

  test("una lista no es un mapa de variables", () => {
    expect(parseVariables("[]").ok).toBe(false);
    expect(parseVariables("{").ok).toBe(false);
  });
});
