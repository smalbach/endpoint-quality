import { describe, expect, test } from "vitest";
import {
  MASKED_VALUE,
  bulkFrom,
  mapsFrom,
  parseBulk,
  problemsWith,
  rowsFrom,
  type VariableRow,
} from "@/lib/env-variables";

/** A variable nobody has overridden: one value, in both fields, in the clear. */
const plain = (value: string) => ({ initial: value, current: value, sensitive: false });
const row = (patch: Partial<VariableRow> & { name: string }): VariableRow => ({
  initial: "",
  current: "",
  sensitive: false,
  enabled: true,
  ...patch,
});

describe("las variables de un entorno", () => {
  test("tabla y texto son la misma cosa, ida y vuelta", () => {
    const rows = rowsFrom({ userId: plain("42") }, { tenant: plain("acme") });
    const parsed = parseBulk(bulkFrom(rows), rows);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(mapsFrom(parsed.rows)).toEqual({
        variables: { userId: plain("42") },
        disabledVariables: { tenant: plain("acme") },
      });
  });

  test("una variable apagada conserva su valor y no llega al motor", () => {
    const maps = mapsFrom([
      row({ name: "userId", initial: "42", current: "42" }),
      row({ name: "legacyId", initial: "7", current: "7", enabled: false }),
    ]);
    expect(maps.variables).toEqual({ userId: plain("42") });
    expect(maps.disabledVariables).toEqual({ legacyId: plain("7") });
  });

  test("una fila a medio escribir no es una variable todavía", () => {
    expect(mapsFrom([row({ name: " ", current: "sin nombre" })]).variables).toEqual({});
    expect(mapsFrom([row({ name: " userId ", initial: "42", current: "42" })]).variables).toEqual({
      userId: plain("42"),
    });
  });

  test("el valor puede llevar dos puntos: solo se parte por el primero", () => {
    const parsed = parseBulk("base:https://api.ejemplo.com:8443");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows[0]).toEqual(row({ name: "base", ...plain("https://api.ejemplo.com:8443") }));
  });

  test("una línea comentada es una variable apagada, no una perdida", () => {
    const parsed = parseBulk("//legacyId:7");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([row({ name: "legacyId", ...plain("7"), enabled: false })]);
  });

  test("un objeto JSON pegado se acepta tal cual", () => {
    const parsed = parseBulk('{"userId": "42"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(mapsFrom(parsed.rows).variables).toEqual({ userId: plain("42") });
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
      row({ name: "userId", current: "1" }),
      row({ name: "userId", current: "2", enabled: false }),
      row({ name: "2users", current: "x" }),
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([1, 2]);
    expect(problems[0].detail).toContain("Ya hay una variable");
  });

  test("las filas guardadas llegan ordenadas, porque jsonb no guarda el orden", () => {
    expect(rowsFrom({ zeta: plain("1"), alfa: plain("2") }, { medio: plain("3") }).map((entry) => entry.name)).toEqual([
      "alfa",
      "medio",
      "zeta",
    ]);
  });

  // Lo que el texto no puede decir. Una línea lleva un valor y la fila tiene tres campos, así que
  // pasar por la vista de texto tiene que conservar lo que la línea no menciona: si no, editar
  // veinte valores de golpe desharía en silencio el reparto inicial/actual y dejaría de cifrar.
  test("editar como texto cambia el valor actual y no toca ni el inicial ni el secreto", () => {
    const rows = [
      row({ name: "userId", initial: "1", current: "42" }),
      row({ name: "token", initial: MASKED_VALUE, current: MASKED_VALUE, sensitive: true }),
    ];
    const parsed = parseBulk("userId:99\ntoken:••••••••", rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]).toEqual(row({ name: "userId", initial: "1", current: "99" }));
    expect(parsed.rows[1]).toEqual(
      row({ name: "token", initial: MASKED_VALUE, current: MASKED_VALUE, sensitive: true }),
    );
  });

  test("un nombre nuevo escrito en el texto vale para los dos valores", () => {
    const parsed = parseBulk("tenant:acme", [row({ name: "userId", ...plain("1") })]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toEqual([row({ name: "tenant", ...plain("acme") })]);
  });

  test("una variable secreta viaja enmascarada en los dos valores", () => {
    const rows = rowsFrom({ token: { initial: MASKED_VALUE, current: MASKED_VALUE, sensitive: true } }, {});
    expect(mapsFrom(rows).variables.token).toEqual({
      initial: MASKED_VALUE,
      current: MASKED_VALUE,
      sensitive: true,
    });
  });
});
