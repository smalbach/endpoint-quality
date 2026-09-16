import { describe, expect, it } from "vitest";

import { SECTION_GROUPS, SECTION_GUIDE } from "@/lib/config-sections";

describe("las secciones de configuración", () => {
  it("cada sección de un grupo tiene su explicación", () => {
    for (const group of SECTION_GROUPS) {
      for (const section of group.sections) expect(SECTION_GUIDE[section], section).toBeDefined();
    }
  });

  it("ninguna sección aparece en dos grupos", () => {
    const listed = SECTION_GROUPS.flatMap((group) => group.sections);
    expect(listed).toHaveLength(new Set(listed).size);
  });

  // `access` se edita desde Roles y por eso no está en ningún grupo; cualquier otra que se quede
  // fuera no se vería en la pantalla, que es la forma silenciosa de perder una sección.
  it("todas las secciones explicadas salen en la pantalla, salvo la de Roles", () => {
    const listed = new Set(SECTION_GROUPS.flatMap((group) => group.sections));
    expect(Object.keys(SECTION_GUIDE).filter((section) => !listed.has(section))).toEqual(["access"]);
  });
});
