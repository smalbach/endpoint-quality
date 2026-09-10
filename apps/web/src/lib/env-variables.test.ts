import { describe, expect, test } from "vitest";
import { bulkFrom, mapsFrom, parseBulk, problemsWith, rowsFrom } from "@/lib/env-variables";

describe("las variables de un entorno", () => {
  test("tabla y texto son la misma cosa, ida y vuelta", () => {
    const rows = rowsFrom({ userId: "42" }, { tenant: "acme" });
    const parsed = parseBulk(bulkFrom(rows));
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(mapsFrom(parsed.rows)).toEqual({ variables: { userId: "42" }, disabledVariables: { tenant: "acme" } });
  });

  test("una variable apagada conserva su valor y no llega al motor", () => {
    const maps = mapsFrom([
      { name: "userId", value: "42", enabled: true },
      { name: "legacyId", value: "7", enabled: false },
    ]);
    expect(maps.variables).toEqual({ userId: "42" });
    expect(maps.disabledVariables).toEqual({ legacyId: "7" });
  });

  test("una fila a medio escribir no es una variable todavía", () => {
    expect(mapsFrom([{ name: " ", value: "sin nombre", enabled: true }]).variables).toEqual({});
    expect(mapsFrom([{ name: " userId ", value: "42", enabled: true }]).variables).toEqual({ userId: "42" });
  });

  test("el valor puede llevar dos puntos: solo se parte por el primero", () => {
    const parsed = parseBulk("base:https://api.ejemplo.com:8443");
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.rows[0]).toEqual({ name: "base", value: "https://api.ejemplo.com:8443", enabled: true });
  });

  test("una línea comentada es una variable apagada, no una perdida", () => {
    const parsed = parseBulk("//legacyId:7");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([{ name: "legacyId", value: "7", enabled: false }]);
  });

  test("un objeto JSON pegado se acepta tal cual", () => {
    const parsed = parseBulk('{"userId": "42"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(mapsFrom(parsed.rows).variables).toEqual({ userId: "42" });
  });

  test("un valor que no es texto se rechaza aquí y no como un 422", () => {
    const parsed = parseBulk('{"userId": 42}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no es texto");
  });

  test("un nombre inválido se nombra, y en la línea en la que está", () => {
    const parsed = parseBulk("userId:42\n2users:x");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Línea 2");
  });

  test("una lista no es un mapa de variables", () => {
    expect(parseBulk("[]").ok).toBe(false);
    expect(parseBulk("{").ok).toBe(false);
  });

  test("el duplicado se señala en la segunda fila, que es la recién escrita", () => {
    const problems = problemsWith([
      { name: "userId", value: "1", enabled: true },
      { name: "userId", value: "2", enabled: false },
      { name: "2users", value: "x", enabled: true },
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([1, 2]);
    expect(problems[0].detail).toContain("Ya hay una variable");
  });

  test("las filas guardadas llegan ordenadas, porque jsonb no guarda el orden", () => {
    expect(rowsFrom({ zeta: "1", alfa: "2" }, { medio: "3" }).map((row) => row.name)).toEqual([
      "alfa",
      "medio",
      "zeta",
    ]);
  });
});
