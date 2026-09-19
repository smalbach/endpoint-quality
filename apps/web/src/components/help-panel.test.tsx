/**
 * El panel de ayuda: se abre en el primer tema o en el pedido (uno desconocido cae en el primero),
 * cambia de tema con sus pestañas, enseña los pasos con su consejo, y se cierra con la ×, Escape o
 * un clic en el fondo. Usar la ayuda fuera del proveedor es un error claro.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { HelpProvider, useHelp } from "@/components/help-panel";
import { HELP_TOPICS } from "@/lib/help-content";

function Opener() {
  const { openHelp, closeHelp } = useHelp();
  return (
    <>
      <button onClick={() => openHelp()}>ayuda</button>
      <button onClick={() => openHelp("endpoints")}>ayuda endpoints</button>
      <button onClick={() => openHelp("no-existe")}>ayuda rara</button>
      <button onClick={closeHelp}>cerrar desde fuera</button>
    </>
  );
}

const draw = () =>
  render(
    <HelpProvider>
      <Opener />
    </HelpProvider>,
  );
const title = () => screen.getByRole("dialog", { name: "Ayuda y documentación" }).querySelector("h2")!.textContent;

describe("HelpProvider", () => {
  test("abre el primer tema, cambia de pestaña y enseña pasos con su consejo", () => {
    draw();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("ayuda"));
    expect(title()).toBe(HELP_TOPICS[0]!.title);
    expect(screen.getByText(HELP_TOPICS[0]!.intro)).toBeTruthy();
    expect(screen.getAllByText("Consejo:").length).toBeGreaterThan(0);

    const second = HELP_TOPICS[1]!;
    fireEvent.click(screen.getByRole("button", { name: second.title }));
    expect(title()).toBe(second.title);
    expect(screen.getByText(second.steps[0]!.title)).toBeTruthy();
  });

  test("abre el tema pedido, y uno desconocido cae en el primero", () => {
    draw();
    fireEvent.click(screen.getByText("ayuda endpoints"));
    expect(title()).toBe("Endpoints");
    fireEvent.click(screen.getByText("ayuda rara"));
    expect(title()).toBe(HELP_TOPICS[0]!.title);
  });

  test("se cierra con la ×, con Escape, con el fondo y desde fuera", () => {
    draw();
    fireEvent.click(screen.getByText("ayuda"));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar ayuda" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("ayuda"));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("ayuda"));
    fireEvent.click(screen.getByRole("dialog").previousElementSibling!);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("ayuda"));
    fireEvent.click(screen.getByText("cerrar desde fuera"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("fuera del proveedor, useHelp falla con un mensaje claro", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Opener />)).toThrow("useHelp fuera de HelpProvider");
    } finally {
      quiet.mockRestore();
    }
  });
});
