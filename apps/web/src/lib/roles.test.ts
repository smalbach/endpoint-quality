/**
 * The rules the settings screen uses to decide which buttons are real.
 *
 * The API enforces every one of these; this is about not offering a control that cannot work.
 * The case worth the test is the last owner: an organization with nobody who can administer it is
 * reached by an edit that looks entirely ordinary until it is done.
 */
import { describe, expect, test } from "vitest";

import { atLeast, canChangeRole, canRemove, rank } from "./roles";

describe("la escalera de roles", () => {
  test("se compara por posición y no por texto", () => {
    // Alfabéticamente «admin» va antes que «viewer», que es exactamente al revés.
    expect(rank("owner")).toBeGreaterThan(rank("admin"));
    expect(rank("admin")).toBeGreaterThan(rank("editor"));
    expect(rank("editor")).toBeGreaterThan(rank("viewer"));
    expect(atLeast("editor", "admin")).toBe(false);
    expect(atLeast("admin", "editor")).toBe(true);
    expect(atLeast(undefined, "viewer")).toBe(false);
  });
});

describe("cambiar el rol de alguien", () => {
  test("un editor no administra a nadie", () => {
    expect(canChangeRole("editor", { role: "viewer", isSelf: false }, 1)).toBe("Hace falta ser admin");
  });

  test("un admin no toca a un owner", () => {
    expect(canChangeRole("admin", { role: "owner", isSelf: false }, 2)).toMatch(/owner/);
    expect(canChangeRole("owner", { role: "owner", isSelf: false }, 2)).toBe(null);
  });

  test("el último owner no puede bajarse el rol a sí mismo", () => {
    // Una organización sin owner es una organización que nadie puede administrar, y se llega ahí
    // con una edición que parece normal hasta que está hecha.
    expect(canChangeRole("owner", { role: "owner", isSelf: true }, 1)).toMatch(/único owner/);
    expect(canChangeRole("owner", { role: "owner", isSelf: true }, 2)).toBe(null);
  });
});

describe("salir o sacar a alguien", () => {
  test("salir no es expulsar: un viewer siempre puede irse", () => {
    expect(canRemove("viewer", { role: "viewer", isSelf: true }, 1)).toBe(null);
    expect(canRemove("viewer", { role: "viewer", isSelf: false }, 1)).toBe("Hace falta ser admin");
  });

  test("el último owner nombra a otro antes de irse", () => {
    expect(canRemove("owner", { role: "owner", isSelf: true }, 1)).toMatch(/único owner/);
    expect(canRemove("owner", { role: "owner", isSelf: true }, 2)).toBe(null);
  });

  test("un admin saca a quien está por debajo, y solo un owner saca a otro owner", () => {
    expect(canRemove("admin", { role: "editor", isSelf: false }, 1)).toBe(null);
    expect(canRemove("admin", { role: "owner", isSelf: false }, 2)).toBe("Solo un owner puede sacar a otro owner");
    expect(canRemove("owner", { role: "owner", isSelf: false }, 2)).toBe(null);
  });
});
