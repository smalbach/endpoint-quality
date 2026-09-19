/**
 * «Configurar ejecución»: cómo recorre el flujo la próxima corrida.
 *
 * Lo que se comprueba: que cada cambio se aplica al hacerlo (no hay «guardar»), que el modo «Puntos
 * de parada» enseña la lista de nodos y avisa si no hay ninguno marcado, que los números se quedan
 * dentro de sus límites, y que «Restablecer» vuelve a lo de siempre.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RunSettingsDialog } from "@/components/run-settings-dialog";
import { CONCURRENCY_LIMIT, DEFAULT_RUN_SETTINGS, DELAY_LIMIT_MS, type RunSettings } from "@/lib/run-settings";

const NODES = [
  { id: "login", label: "Iniciar sesión", kind: "login" },
  { id: "list", label: "Listar pedidos", kind: "request" },
];

/** El diálogo con el estado de verdad detrás, como lo tiene la página. */
function mount(initial: Partial<RunSettings> = {}, nodes = NODES) {
  const seen: RunSettings[] = [];
  const onClose = vi.fn();
  function Host() {
    const [settings, setSettings] = useState<RunSettings>({ ...DEFAULT_RUN_SETTINGS, ...initial });
    return (
      <RunSettingsDialog
        settings={settings}
        nodes={nodes}
        onChange={(next) => {
          seen.push(next);
          setSettings(next);
        }}
        onClose={onClose}
      />
    );
  }
  render(<Host />);
  return { seen, onClose, last: () => seen[seen.length - 1] };
}

describe("configurar ejecución", () => {
  test("el modo se elige con un clic y queda marcado", () => {
    const { last } = mount();
    const continuo = screen.getByRole("radio", { name: /Continuo/ });
    expect(continuo.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: /Paso a paso/ }));
    expect(last().pauseMode).toBe("step");
    expect(screen.getByRole("radio", { name: /Paso a paso/ }).getAttribute("aria-checked")).toBe("true");
    // En modo paso a paso no hay lista de nodos.
    expect(screen.queryByText("Todos")).toBeNull();
  });

  test("puntos de parada: la lista de nodos, el aviso sin marcas, Todos y Ninguno", () => {
    const { last } = mount();
    fireEvent.click(screen.getByRole("radio", { name: /Puntos de parada/ }));
    expect(screen.getByText("0 de 2 marcados")).toBeTruthy();
    expect(screen.getByText("Marca al menos un nodo donde detenerse")).toBeTruthy();
    expect(screen.getByText("Listar pedidos")).toBeTruthy();

    fireEvent.click(screen.getByText("Todos"));
    expect(last().breakpoints).toEqual(["login", "list"]);
    expect(screen.getByText("2 de 2 marcados")).toBeTruthy();
    expect(screen.queryByText("Marca al menos un nodo donde detenerse")).toBeNull();

    fireEvent.click(screen.getByText("Ninguno"));
    expect(last().breakpoints).toEqual([]);
  });

  test("marcar y desmarcar un nodo suelto", () => {
    const { last } = mount({ pauseMode: "breakpoints", breakpoints: ["login"] });
    const boxes = screen.getAllByRole("checkbox");
    // login, list, y el «Detener al primer fallo» del final.
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(boxes[1]);
    expect(last().breakpoints).toEqual(["login", "list"]);
    fireEvent.click(boxes[0]);
    expect(last().breakpoints).toEqual(["list"]);
  });

  test("un flujo sin nodos lo dice", () => {
    mount({ pauseMode: "breakpoints" }, []);
    expect(screen.getByText("El flujo no tiene nodos.")).toBeTruthy();
  });

  test("la pausa: los atajos y el número a mano, sin salirse del límite", () => {
    const { last } = mount();
    fireEvent.click(screen.getByText("1 s"));
    expect(last().delayMs).toBe(1000);

    const field = screen.getByLabelText("Pausa en milisegundos");
    fireEvent.change(field, { target: { value: "999999" } });
    expect(last().delayMs).toBe(DELAY_LIMIT_MS);
    fireEvent.change(field, { target: { value: "-5" } });
    expect(last().delayMs).toBe(0);
    fireEvent.change(field, { target: { value: "abc" } });
    expect(last().delayMs).toBe(0);
  });

  test("nodos a la vez: entre 1 y el límite, y el aviso con pausas", () => {
    const { last } = mount({ pauseMode: "step" });
    const field = screen.getByLabelText("Nodos a la vez");
    fireEvent.change(field, { target: { value: "50" } });
    expect(last().concurrency).toBe(CONCURRENCY_LIMIT);
    expect(screen.getByText(/Con pausas conviene 1/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "0" } });
    expect(last().concurrency).toBe(1);
    expect(screen.queryByText(/Con pausas conviene 1/)).toBeNull();
  });

  test("detener al primer fallo, Restablecer y Listo", () => {
    const { last, onClose } = mount({ delayMs: 300 });
    fireEvent.click(screen.getByText("Detener al primer fallo"));
    expect(last().stopOnFailure).toBe(true);

    fireEvent.click(screen.getByText("Restablecer"));
    expect(last()).toEqual(DEFAULT_RUN_SETTINGS);

    fireEvent.click(screen.getByText("Listo"));
    expect(onClose).toHaveBeenCalled();
  });
});
