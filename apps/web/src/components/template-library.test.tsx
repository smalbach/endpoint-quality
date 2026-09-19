/**
 * La biblioteca de peticiones del editor de flujos: el catálogo del contrato se filtra por ruta,
 * método o resumen y un clic añade la operación; una prueba guardada se añade o se elimina (y sin
 * flujo abierto no se puede añadir); el formulario de «Nueva prueba» exige nombre, interpreta los
 * JSON, manda body «none» cuando está vacío y enseña el error de un JSON roto. Quien solo lee ve
 * las pruebas pero no el catálogo, ni el formulario, ni el botón de eliminar.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TemplateLibrary } from "@/components/template-library";
import type { RequestTemplateView } from "@/lib/types";
import type { OperationSummary } from "@/lib/workflow-draft";

const operations: OperationSummary[] = [
  { id: "listUsers", method: "get", path: "/users", summary: "Lista usuarios" },
  { id: "createOrder", method: "POST", path: "/orders", summary: "" },
  { id: "trace", method: "TRACE", path: "/debug", summary: "Traza" },
];
const templates = [
  { id: "t1", name: "Listar", operationId: "listUsers" },
  { id: "t2", name: "Huérfana", operationId: "gone" },
] as RequestTemplateView[];

function draw(patch: Partial<Parameters<typeof TemplateLibrary>[0]> = {}) {
  const mocks = {
    templates,
    operations,
    canEdit: true,
    onCreate: vi.fn(),
    onAdd: vi.fn(),
    onAddOperation: vi.fn(),
    onDelete: vi.fn(),
    addDisabled: false,
    adding: false,
    error: null,
  };
  const props = { ...mocks, ...patch } as typeof mocks;
  const view = render(<TemplateLibrary {...props} />);
  return { ...props, ...view };
}

describe("TemplateLibrary · catálogo", () => {
  test("filtra por ruta, método o resumen, y un clic añade la operación", () => {
    const { onAddOperation } = draw({ templates: [] });
    const filter = screen.getByPlaceholderText("Filtrar por ruta o método…");
    fireEvent.change(filter, { target: { value: "usuarios" } });
    expect(screen.getByText("/users")).toBeTruthy();
    expect(screen.queryByText("/debug")).toBeNull();
    fireEvent.change(filter, { target: { value: "post" } });
    expect(screen.getByText("/orders")).toBeTruthy();
    expect(screen.queryByText("/users")).toBeNull();
    fireEvent.click(screen.getByText("/orders"));
    expect(onAddOperation).toHaveBeenCalledWith(operations[1]);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText("Nada coincide.")).toBeTruthy();
  });

  test("sin flujo o mientras añade, las operaciones no se pulsan y dicen por qué", () => {
    const { onAddOperation, rerender, ...props } = draw({ addDisabled: true, templates: [] });
    const button = screen.getByText("/users").closest("button")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Selecciona un flujo primero");
    rerender(<TemplateLibrary {...props} onAddOperation={onAddOperation} addDisabled={false} adding />);
    expect(screen.getByText("/users").closest("button")!.title).toBe("Añadiendo…");
    fireEvent.click(screen.getByText("/users"));
    expect(onAddOperation).not.toHaveBeenCalled();
  });

  test("un entorno sin operaciones lo dice, y la lista vacía de pruebas también", () => {
    draw({ operations: [], templates: [] });
    expect(screen.getByText("Este entorno no expone operaciones.")).toBeTruthy();
    expect(screen.getByText("Ninguna guardada todavía.")).toBeTruthy();
  });
});

describe("TemplateLibrary · pruebas guardadas", () => {
  test("una prueba se añade o se elimina; la ruta sale de su operación, o su id si ya no está", () => {
    const { onAdd, onDelete } = draw({ error: "No se pudo crear" });
    expect(screen.getAllByText("/users")).toHaveLength(2);
    expect(screen.getByText("gone")).toBeTruthy();
    expect(screen.getByText("No se pudo crear")).toBeTruthy();
    fireEvent.click(screen.getByText("+ Listar"));
    expect(onAdd).toHaveBeenCalledWith(templates[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[1]!);
    expect(onDelete).toHaveBeenCalledWith(templates[1]);
  });

  test("quien solo lee ve las pruebas pero no el catálogo ni el formulario", () => {
    const { onAdd } = draw({ canEdit: false, addDisabled: true });
    expect(screen.queryByText("Operaciones del contrato")).toBeNull();
    expect(screen.queryByText("Nueva prueba")).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    const add = screen.getByText("+ Listar").closest("button")!;
    expect(add.title).toBe("Selecciona un flujo primero");
    fireEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("TemplateLibrary · nueva prueba", () => {
  test("exige nombre, interpreta los JSON y con un body vacío manda «none»", () => {
    const { onCreate } = draw();
    const create = screen.getByRole("button", { name: "Crear prueba" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Operación"), { target: { value: "createOrder" } });
    fireEvent.change(screen.getByPlaceholderText("Actualizar perfil"), { target: { value: "  Crear pedido " } });
    fireEvent.change(screen.getByLabelText("Estado esperado"), { target: { value: "201" } });
    fireEvent.change(screen.getByLabelText(/Parámetros JSON/), { target: { value: '{"id":"{{id}}"}' } });
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith({
      name: "Crear pedido",
      operationId: "createOrder",
      expectedStatus: 201,
      parameters: { id: "{{id}}" },
      body: { type: "none" },
    });
    expect((screen.getByPlaceholderText("Actualizar perfil") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByPlaceholderText("Actualizar perfil"), { target: { value: "Con body" } });
    fireEvent.change(screen.getByLabelText("Body JSON"), { target: { value: '{"qty":2}' } });
    fireEvent.click(create);
    expect(onCreate.mock.lastCall![0].body).toEqual({ type: "json", json: { qty: 2 } });
  });

  test("un JSON roto enseña el error y no crea nada", () => {
    const { onCreate } = draw();
    fireEvent.change(screen.getByPlaceholderText("Actualizar perfil"), { target: { value: "Rota" } });
    fireEvent.change(screen.getByLabelText("Body JSON"), { target: { value: "{no es json" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear prueba" }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(document.querySelector("p.text-rose-600")?.textContent).toMatch(/JSON/);
    expect((screen.getByPlaceholderText("Actualizar perfil") as HTMLInputElement).value).toBe("Rota");
  });

  test("si las operaciones llegan después, la primera queda elegida", () => {
    const { rerender, ...props } = draw({ operations: [] });
    expect((screen.getByLabelText("Operación") as HTMLSelectElement).value).toBe("");
    rerender(<TemplateLibrary {...props} operations={operations} />);
    expect((screen.getByLabelText("Operación") as HTMLSelectElement).value).toBe("listUsers");
  });
});
