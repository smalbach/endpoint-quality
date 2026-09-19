/**
 * El plan de carga como formulario: cambiar el tipo de carga trae sus valores por defecto y
 * conserva la duración; los números no bajan de cero; un umbral vacío desaparece del plan y la tasa
 * de error se escribe en % y se guarda en fracción; los escenarios y sus peticiones se añaden,
 * editan y quitan; lo que se extrae y se comprueba vive tras «…»; y quien solo lee no puede tocar
 * nada. Lo que se verifica es el plan que sale por onChange.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import { PerformancePlanEditor } from "@/components/performance-plan-editor";
import type { PerformancePlanDefinitionView } from "@/lib/types";

const base = (): PerformancePlanDefinitionView => ({
  scenarios: [{ id: "s1", name: "Compra", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/items" }] }],
  profile: { type: "constant", vus: 10, durationS: 30 },
  thresholds: { p95Ms: 500, maxErrorRate: 0.01 },
});

/** Guarda el plan como lo haría la pantalla y deja ver el último emitido. */
function draw(initial: PerformancePlanDefinitionView = base(), canEdit = true) {
  const emitted = vi.fn<(plan: PerformancePlanDefinitionView) => void>();
  function Harness() {
    const [plan, setPlan] = useState(initial);
    return (
      <PerformancePlanEditor
        definition={plan}
        canEdit={canEdit}
        onChange={(next) => {
          emitted(next);
          setPlan(next);
        }}
      />
    );
  }
  render(<Harness />);
  const last = () => emitted.mock.lastCall![0];
  return { emitted, last };
}

const number = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("PerformancePlanEditor · carga", () => {
  test("cambiar de tipo trae sus valores por defecto y conserva la duración", () => {
    const { emitted, last } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Constante" }));
    expect(emitted).not.toHaveBeenCalled();

    fireEvent.change(number("Duración (s)"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Rampa" }));
    expect(last().profile).toEqual({ type: "ramp", startVus: 0, endVus: 50, durationS: 90 });
    fireEvent.change(number("De"), { target: { value: "5" } });
    fireEvent.change(number("A"), { target: { value: "100" } });
    expect(last().profile).toEqual({ type: "ramp", startVus: 5, endVus: 100, durationS: 90 });

    fireEvent.click(screen.getByRole("button", { name: "Pico" }));
    expect(last().profile).toEqual({ type: "spike", baseVus: 5, peakVus: 50, durationS: 90 });
    fireEvent.change(number("Base"), { target: { value: "2" } });
    fireEvent.change(number("Pico"), { target: { value: "300" } });
    expect(last().profile).toEqual({ type: "spike", baseVus: 2, peakVus: 300, durationS: 90 });

    fireEvent.click(screen.getByRole("button", { name: "Constante" }));
    expect(last().profile).toEqual({ type: "constant", vus: 10, durationS: 90 });
  });

  test("los usuarios no bajan de cero y un texto vacío cuenta como cero", () => {
    const { last } = draw();
    fireEvent.change(number("Usuarios"), { target: { value: "-4" } });
    expect(last().profile).toMatchObject({ vus: 0 });
    fireEvent.change(number("Usuarios"), { target: { value: "25" } });
    expect(last().profile).toMatchObject({ vus: 25 });
    fireEvent.change(number("Usuarios"), { target: { value: "" } });
    expect(last().profile).toMatchObject({ vus: 0 });
  });
});

describe("PerformancePlanEditor · umbrales", () => {
  test("la tasa de error se ve en % y se guarda en fracción; un umbral vacío sale del plan", () => {
    const { last } = draw();
    expect(number("Tasa de error máx. (%)").value).toBe("1");
    expect(number("p99 (ms)").value).toBe("");

    fireEvent.change(number("Tasa de error máx. (%)"), { target: { value: "5" } });
    expect(last().thresholds.maxErrorRate).toBe(0.05);
    fireEvent.change(number("p99 (ms)"), { target: { value: "900" } });
    fireEvent.change(number("req/s mín."), { target: { value: "20" } });
    expect(last().thresholds).toEqual({ p95Ms: 500, maxErrorRate: 0.05, p99Ms: 900, minRps: 20 });

    fireEvent.change(number("p95 (ms)"), { target: { value: "" } });
    fireEvent.change(number("Tasa de error máx. (%)"), { target: { value: "" } });
    expect(last().thresholds).toEqual({ p99Ms: 900, minRps: 20 });
    expect("p95Ms" in last().thresholds).toBe(false);
  });
});

describe("PerformancePlanEditor · escenarios y peticiones", () => {
  test("añade, renombra, pondera y quita escenarios", () => {
    const { last } = draw();
    fireEvent.click(screen.getByRole("button", { name: "+ Escenario" }));
    expect(last().scenarios).toHaveLength(2);
    expect(last().scenarios[1]).toMatchObject({ name: "Escenario", weight: 1, requests: [{ method: "GET", path: "/" }] });
    expect(last().scenarios[1]!.id).toMatch(/^s2-/);

    const names = screen.getAllByPlaceholderText("Nombre") as HTMLInputElement[];
    fireEvent.change(names[1]!, { target: { value: "Búsqueda" } });
    fireEvent.change(screen.getAllByLabelText("Peso")[1]!, { target: { value: "3" } });
    fireEvent.change(screen.getAllByLabelText("Think (ms)")[1]!, { target: { value: "250" } });
    expect(last().scenarios[1]).toMatchObject({ name: "Búsqueda", weight: 3, thinkMs: 250 });
    expect(last().scenarios[0]!.name).toBe("Compra");

    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]!);
    expect(last().scenarios.map((s) => s.name)).toEqual(["Búsqueda"]);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(last().scenarios).toEqual([]);
    expect(screen.getByText("Ningún escenario todavía.")).toBeTruthy();
  });

  test("añade una petición, cambia su método y su ruta, y la quita", () => {
    const { last } = draw();
    fireEvent.click(screen.getByRole("button", { name: "+ Petición" }));
    expect(last().scenarios[0]!.requests).toEqual([
      { method: "GET", path: "/items" },
      { method: "GET", path: "/" },
    ]);
    const methods = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(methods[1]!, { target: { value: "POST" } });
    fireEvent.change(screen.getAllByPlaceholderText("/ruta/{{var}}")[1]!, { target: { value: "/orders" } });
    expect(last().scenarios[0]!.requests[1]).toEqual({ method: "POST", path: "/orders" });

    fireEvent.click(screen.getAllByRole("button", { name: "×" })[0]!);
    expect(last().scenarios[0]!.requests).toEqual([{ method: "POST", path: "/orders" }]);
  });

  test("tras «…» se añaden, editan y quitan extracciones y comprobaciones", () => {
    const { last } = draw();
    expect(screen.queryByText("Extrae")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "…" }));
    expect(screen.getByText("Extrae")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ Extraer" }));
    fireEvent.change(screen.getByPlaceholderText("variable"), { target: { value: "id" } });
    fireEvent.change(screen.getByPlaceholderText("data.id"), { target: { value: "data.items[0].id" } });
    expect(last().scenarios[0]!.requests[0]!.extract).toEqual([{ variable: "id", path: "data.items[0].id" }]);

    fireEvent.click(screen.getByRole("button", { name: "+ Comprobar" }));
    expect(last().scenarios[0]!.requests[0]!.checks).toEqual([{ source: "status", operator: "equals", value: 200 }]);
    expect((screen.getByPlaceholderText("valor") as HTMLInputElement).value).toBe("200");
    expect(screen.queryByPlaceholderText("ruta")).toBeNull();

    const check = screen.getByPlaceholderText("valor").parentElement!;
    const [source, operator] = within(check).getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(source!, { target: { value: "body" } });
    fireEvent.change(screen.getByPlaceholderText("ruta"), { target: { value: "data.ok" } });
    fireEvent.change(screen.getByPlaceholderText("valor"), { target: { value: "true" } });
    expect(last().scenarios[0]!.requests[0]!.checks![0]).toEqual({
      source: "body",
      operator: "equals",
      value: "true",
      path: "data.ok",
    });
    fireEvent.change(operator!, { target: { value: "exists" } });
    expect(last().scenarios[0]!.requests[0]!.checks![0]!.operator).toBe("exists");
    expect(screen.queryByPlaceholderText("valor")).toBeNull();

    // La × de la comprobación, luego la de la extracción; la última × es la de la petición.
    const removeCheck = within(check).getByRole("button", { name: "×" });
    fireEvent.click(removeCheck);
    expect(last().scenarios[0]!.requests[0]!.checks).toEqual([]);
    const removeExtract = within(screen.getByPlaceholderText("variable").parentElement!).getByRole("button", {
      name: "×",
    });
    fireEvent.click(removeExtract);
    expect(last().scenarios[0]!.requests[0]!.extract).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "−" }));
    expect(screen.queryByText("Extrae")).toBeNull();
  });
});

describe("PerformancePlanEditor · solo lectura", () => {
  test("todo deshabilitado y sin botones de añadir ni quitar", () => {
    const plan = base();
    plan.scenarios[0]!.requests[0] = {
      method: "GET",
      path: "/items",
      extract: [{ variable: "id", path: "data.id" }],
      checks: [{ source: "body", path: "ok", operator: "exists" }],
    };
    const { emitted } = draw(plan, false);
    expect(screen.queryByRole("button", { name: "+ Escenario" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Petición" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    expect((screen.getByRole("button", { name: "Rampa" }) as HTMLButtonElement).disabled).toBe(true);
    expect(number("Usuarios").disabled).toBe(true);
    expect(number("p95 (ms)").disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "…" }));
    expect((screen.getByPlaceholderText("variable") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("ruta") as HTMLInputElement).value).toBe("ok");
    expect(screen.queryByRole("button", { name: "+ Extraer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "×" })).toBeNull();
    expect(emitted).not.toHaveBeenCalled();
  });
});
