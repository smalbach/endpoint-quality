import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SectionEditor } from "@/routes/config";
import { SECTION_GUIDE } from "@/lib/config-sections";

/**
 * El acordeón cerrado tiene que decir de qué va.
 *
 * La pantalla enseñaba nueve cajas con la clave del motor por todo título —`budgets`, `envelope`—
 * y la explicación escondida detrás del clic. Esto fija lo contrario: nombre y una línea antes de
 * abrir, y el detalle completo al abrir.
 */
function mount(section: string, title?: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SectionEditor
        base="/orgs/o/projects/p"
        section={section}
        title={title}
        data={{ data: {}, configured: false, updatedAt: null }}
        disabled={false}
        operationIds={[]}
        onSaved={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("una sección de configuración", () => {
  test("cerrada enseña el nombre, la clave y para qué sirve", () => {
    mount("budgets");
    expect(screen.getByText(SECTION_GUIDE.budgets.title)).toBeTruthy();
    expect(screen.getByText("budgets")).toBeTruthy();
    expect(screen.getByText(SECTION_GUIDE.budgets.summary)).toBeTruthy();
    expect(screen.queryByText("Cuándo tocarlo")).toBeNull();
  });

  test("abierta explica cuándo tocarla y qué pasa si no", () => {
    mount("envelope");
    fireEvent.click(screen.getByText(SECTION_GUIDE.envelope.title));
    for (const term of ["Qué es", "Cuándo tocarlo", "Si no lo tocas", "Cómo suele quedar"]) {
      expect(screen.getByText(term), term).toBeTruthy();
    }
    expect(screen.getByText(SECTION_GUIDE.envelope.fallback)).toBeTruthy();
  });
});

describe("una sección sin guía", () => {
  test("se nombra por su clave y abierta solo ofrece el JSON", () => {
    mount("custom");
    fireEvent.click(screen.getByText("custom", { selector: ".font-semibold" }));
    expect(screen.queryByText("Qué es")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ver como/ })).toBeNull();
    expect(document.querySelector("textarea")?.value).toBe("{}");
  });

  test("un título propio manda sobre el nombre de la guía", () => {
    mount("budgets", "Mis presupuestos");
    expect(screen.getByText("Mis presupuestos")).toBeTruthy();
    expect(screen.queryByText(SECTION_GUIDE.budgets.title)).toBeNull();
  });
});
