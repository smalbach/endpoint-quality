/**
 * El marco del inspector: el flujo en sí y lo que comparten todos los nodos.
 *
 * Lo que decide algo:
 *
 * - **Sin nodo elegido se ve el flujo**: nombre, descripción, entorno, «Configurar ejecución», y
 *   «Ejecutar flujo» solo con entorno y con pasos; sin permiso de edición no hay «Eliminar flujo».
 * - **Cada nodo tiene sus pestañas, más «Ayuda» y «Flujo»**: la pestaña abierta se conserva al
 *   cambiar de sección, la ayuda enseña qué hace el nodo, y la pestaña «Flujo» trae los ajustes.
 * - **«Eliminar nodo» quita el paso** de la lista, y sin permiso de edición no aparece.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { field, openTab, renderInspector, visiblePanel } from "@/test/workflow-inspector-harness";
import type { Environment, WorkflowStepView } from "@/lib/types";

const ENV = {
  id: "env1",
  name: "Staging",
  baseUrl: "https://staging.example.com",
  specUrl: null,
  variables: { baseUrl: { value: "x", sensitive: false } },
  disabledVariables: {},
  writesAllowed: true,
  authEnforced: false,
  active: true,
  credentials: [],
} as unknown as Environment;

const wait: WorkflowStepView = { id: "espera", kind: "wait", waitMs: 500 };

describe("el inspector sin nodo elegido", () => {
  test("edita nombre y descripción, elige el entorno y abre la configuración de la ejecución", () => {
    const view = renderInspector({ steps: [wait], selected: "", environments: [ENV] });
    expect(screen.getByText("Selecciona un nodo en el lienzo para configurarlo.")).toBeTruthy();

    fireEvent.change(field("Nombre del flujo"), { target: { value: "Alta de pedido" } });
    expect(view.onWorkflow).toHaveBeenLastCalledWith({ name: "Alta de pedido" });
    fireEvent.change(field<HTMLTextAreaElement>("Descripción"), { target: { value: "Crea y lee" } });
    expect(view.onWorkflow).toHaveBeenLastCalledWith({ description: "Crea y lee" });

    fireEvent.change(field<HTMLSelectElement>("Entorno"), { target: { value: "env1" } });
    expect(view.onEnvironment).toHaveBeenCalledWith("env1");

    // Sin ajustes propios dice el modo por defecto.
    expect(screen.getByText("Continuo, sin pausa")).toBeTruthy();
    fireEvent.click(screen.getByText("Configurar ejecución"));
    expect(view.onRunSettings).toHaveBeenCalled();

    // Sin entorno elegido no se puede ejecutar.
    expect((screen.getByRole("button", { name: "Ejecutar flujo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar flujo" }));
    expect(view.onDelete).toHaveBeenCalled();
  });

  test("con entorno y pasos se ejecuta; el resumen de la ejecución se enseña; sin edición no se borra", () => {
    const view = renderInspector({
      steps: [wait],
      selected: "",
      environments: [ENV],
      environmentId: "env1",
      canEdit: false,
      runSummary: "Paso a paso · 500 ms",
    });
    expect(screen.getByText("Paso a paso · 500 ms")).toBeTruthy();
    expect((field("Nombre del flujo") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar flujo" }));
    expect(view.onRun).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Eliminar flujo" })).toBeNull();
  });

  test("mientras corre, «Ejecutar flujo» está apagado", () => {
    renderInspector({ steps: [wait], selected: "", environments: [ENV], environmentId: "env1", running: true });
    expect((screen.getByRole("button", { name: "Ejecutar flujo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("el marco de pestañas de un nodo", () => {
  test("la ayuda y los ajustes del flujo son pestañas del nodo", () => {
    renderInspector({ steps: [wait], selected: "espera" });
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Espera", "Ayuda", "Flujo"]);
    expect(screen.getByRole("tab", { name: "Espera" }).getAttribute("aria-selected")).toBe("true");

    openTab("Ayuda");
    const help = visiblePanel();
    expect(within(help).getByText(/Qué hace/)).toBeTruthy();
    expect(within(help).getByText("Cómo funciona")).toBeTruthy();
    expect(within(help).getByText("Errores comunes")).toBeTruthy();

    openTab("Flujo");
    expect(within(visiblePanel()).getByText("Configurar ejecución")).toBeTruthy();
  });

  test("«Eliminar nodo» quita el paso, y sin edición no se ofrece", () => {
    const view = renderInspector({ steps: [wait, { id: "otra", kind: "wait" }], selected: "espera" });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar nodo" }));
    expect(view.last().map((step) => step.id)).toEqual(["otra"]);
  });

  test("sin permiso de edición no hay botón de eliminar", () => {
    renderInspector({ steps: [wait], selected: "espera", canEdit: false });
    expect(screen.queryByRole("button", { name: "Eliminar nodo" })).toBeNull();
    expect((field("Milisegundos") as HTMLInputElement).disabled).toBe(true);
  });
});
