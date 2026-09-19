/**
 * Las piezas del archivo de proyecto: el selector de partes marca y desmarca y enseña el recuento
 * salvo en ajustes y contrato (que no se cuentan); el resultado dice qué entró y lista lo que se
 * dejó fuera; un archivo rechazado nombra sus campos mal, como mucho diez y «…y N más».
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ImportOutcome, ImportProblems, PartPicker } from "@/components/project-transfer";
import { ApiError } from "@/lib/api";
import type { ProjectBundleImportResultView, ProjectBundlePart } from "@/lib/types";

describe("PartPicker", () => {
  test("marca y desmarca, y cuenta lo que tiene recuento", () => {
    const onChange = vi.fn();
    render(
      <PartPicker
        parts={["settings", "contract", "endpoints", "flows"]}
        selected={new Set<ProjectBundlePart>(["endpoints"])}
        onChange={onChange}
        counts={{ settings: 1, contract: 1, endpoints: 12 }}
      />,
    );
    expect(screen.getByText("Endpoints (12)")).toBeTruthy();
    expect(screen.getByText("Ajustes")).toBeTruthy();
    expect(screen.getByText("Contrato")).toBeTruthy();
    expect(screen.getByText("Flujos")).toBeTruthy();

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, false, true, false]);
    fireEvent.click(boxes[2]!);
    expect([...onChange.mock.lastCall![0]]).toEqual([]);
    fireEvent.click(boxes[3]!);
    expect([...onChange.mock.lastCall![0]]).toEqual(["endpoints", "flows"]);
  });
});

const result = (patch: Partial<ProjectBundleImportResultView> = {}) =>
  ({
    parts: [],
    settings: false,
    contract: null,
    sections: [],
    endpoints: 0,
    examples: 0,
    roles: 0,
    permissions: 0,
    requestTemplates: 0,
    workflows: 0,
    datasets: 0,
    suites: 0,
    channels: 0,
    environments: 0,
    performancePlans: 0,
    skipped: [],
    ...patch,
  }) as ProjectBundleImportResultView;

describe("ImportOutcome", () => {
  test("dice qué entró y lista lo que se dejó fuera", () => {
    const { rerender } = render(<ImportOutcome result={result({ endpoints: 3, workflows: 1 })} />);
    expect(screen.getByText("Importado: 3 endpoints, 1 flujo.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    rerender(<ImportOutcome result={result({ skipped: [{ what: "Entorno prod", detail: "secreto sin valor" }] })} />);
    expect(screen.getByText("Importado: nada nuevo.")).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("Entorno prod · secreto sin valor");
  });
});

describe("ImportProblems", () => {
  test("un error cualquiera es solo su mensaje", () => {
    render(<ImportProblems error={new Error("Archivo ilegible")} />);
    expect(screen.getByText("Archivo ilegible")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("un rechazo de la API nombra hasta diez campos y cuenta el resto", () => {
    const errors = Array.from({ length: 12 }, (_, index) => ({ field: `f${index}`, detail: "no vale" }));
    render(<ImportProblems error={new ApiError(422, { title: "Archivo no válido", errors } as never)} />);
    expect(screen.getByText("Archivo no válido")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(11);
    expect(items[0]!.textContent).toBe("f0: no vale");
    expect(items[10]!.textContent).toBe("…y 2 más");
  });
});
