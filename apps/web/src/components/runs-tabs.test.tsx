/**
 * Las dos pestañas de «Test Runs»: seguridad y contrato.
 *
 * Lo que se comprueba: que cada una lleva a su sección del proyecto y que la de la ruta abierta es
 * la que se ve marcada.
 */
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { RunsTabs } from "@/components/runs-tabs";

function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <RunsTabs projectId="p1" />
    </MemoryRouter>,
  );
}

describe("las pestañas de corridas", () => {
  test("cada pestaña apunta a su sección del proyecto", () => {
    mount("/p/p1/security");
    expect(screen.getByRole("link", { name: "Seguridad" }).getAttribute("href")).toBe("/p/p1/security");
    expect(screen.getByRole("link", { name: "Contrato" }).getAttribute("href")).toBe("/p/p1/runs");
  });

  test("la de la ruta abierta es la marcada, también en una subruta", () => {
    mount("/p/p1/runs/r9");
    const contract = screen.getByRole("link", { name: "Contrato" });
    const security = screen.getByRole("link", { name: "Seguridad" });
    expect(contract.getAttribute("aria-current")).toBe("page");
    expect(contract.className).toContain("border-slate-900");
    expect(security.getAttribute("aria-current")).toBeNull();
    expect(security.className).toContain("border-transparent");
  });
});
