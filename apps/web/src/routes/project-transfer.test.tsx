/**
 * Exportar e importar un proyecto como fichero.
 *
 * Lo que decide algo:
 *
 * - **Se exporta solo lo marcado**, y el fichero se llama como el proyecto.
 * - **Postman dice lo que se quedó fuera**, nunca en silencio.
 * - **Un fichero que no es nuestro se rechaza sin ir al servidor.**
 * - **Si las peticiones del fichero apuntan a operaciones que este contrato no tiene, se avisa**
 *   antes de importar; y traer el contrato o los ajustes avisa de que sustituyen a los de aquí.
 * - **Un proyecto archivado no importa**, y sin permiso de edición no hay nada.
 */
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ProjectTransferPage } from "@/routes/project-transfer";
import { ApiError } from "@/lib/api";
import type { ProjectBundleImportResultView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/project-bundle", async (original) => ({ ...(await original<object>()), downloadJson: download }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org", role: "owner" }),
  useCan: () => can.value,
}));

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;

function draw(handler: Handler, archived = false) {
  can.value = true;
  call.mockReset();
  download.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) =>
    path === "/orgs/o/projects/p1"
      ? Promise.resolve({ id: "p1", name: "Mi API", archivedAt: archived ? "2026-01-01T00:00:00.000Z" : null })
      : handler(path, options),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/transfer"]}>
        <Routes>
          <Route path="/p/:projectId/transfer" element={<ProjectTransferPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const bundle = (extra: Record<string, unknown> = {}) => ({
  format: "endpoint-quality/project",
  version: 1,
  exportedAt: "2026-03-01T10:00:00.000Z",
  project: { name: "Origen" },
  settings: { description: "x" },
  flows: {
    workflows: [{ id: "w" }],
    requestTemplates: [
      { name: "Crear pedido", operationId: "createOrder" },
      { name: "Listar", operationId: "listOrders" },
    ],
  },
  ...extra,
});

function pick(content: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  // jsdom's File has no `text()`; the page only needs that.
  const file = Object.assign(new File([content], "p.eq.json", { type: "application/json" }), {
    text: () => Promise.resolve(content),
  });
  fireEvent.change(input, { target: { files: [file] } });
}

const outcome: ProjectBundleImportResultView = {
  parts: ["flows"],
  settings: false,
  contract: null,
  sections: [],
  endpoints: 0,
  examples: 0,
  roles: 0,
  permissions: 0,
  requestTemplates: 2,
  workflows: 1,
  datasets: 0,
  suites: 0,
  channels: 0,
  environments: 0,
  performancePlans: 0,
  skipped: [{ what: "variable", detail: "token va vacía" }],
};

describe("ProjectTransferPage", () => {
  test("sin permiso de edición no hay nada que hacer", () => {
    draw(() => Promise.resolve({}));
    can.value = false;
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/p/p1/transfer"]}>
          <Routes>
            <Route path="/p/:projectId/transfer" element={<ProjectTransferPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/necesita permiso de edición/)).toBeTruthy();
  });

  test("exporta solo las partes marcadas y lo descarga con el nombre del proyecto", async () => {
    draw(() => Promise.resolve({ format: "endpoint-quality/project" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1"));
    // El nombre del proyecto llega con su consulta; el fichero se llama como él.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // Desmarca el contrato y los planes de rendimiento.
    fireEvent.click(screen.getAllByLabelText(/Contrato/)[0]!);
    fireEvent.click(screen.getByLabelText(/Planes de rendimiento/));
    fireEvent.click(screen.getAllByRole("button", { name: "Descargar .json" })[0]!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "/orgs/o/projects/p1/export?parts=settings,config,endpoints,roles,flows,environments",
      ),
    );
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(download.mock.calls[0]![0]).toMatch(/^mi-api-\d{4}-\d{2}-\d{2}\.eq\.json$/);
  });

  test("un fallo al exportar se enseña", async () => {
    draw(() => Promise.reject(new Error("Exportación fallida")));
    fireEvent.click(screen.getAllByRole("button", { name: "Descargar .json" })[0]!);
    expect(await screen.findByText("Exportación fallida")).toBeTruthy();
  });

  test("Postman: el tipo elegido va en la petición y lo que se queda fuera se nombra", async () => {
    draw((path) =>
      path.includes("/export/postman")
        ? Promise.resolve({
            kind: "environments",
            filename: "mi-api.postman_environment.json",
            file: { values: [] },
            counts: { collections: 0, environments: 1 },
            skipped: [{ what: "Nodo de carga", detail: "Postman no tiene cómo expresarlo" }],
          })
        : Promise.resolve({}),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Entornos/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Descargar .json" })[1]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/export/postman?kind=environments"));
    expect(await screen.findByText("mi-api.postman_environment.json")).toBeTruthy();
    expect(screen.getByText("Se quedó fuera del fichero:")).toBeTruthy();
    expect(screen.getByText("Nodo de carga")).toBeTruthy();
    expect(download).toHaveBeenCalledWith("mi-api.postman_environment.json", { values: [] });
  });

  test("Postman: un error se enseña", async () => {
    draw(() => Promise.reject(new Error("Sin permiso")));
    fireEvent.click(screen.getAllByRole("button", { name: "Descargar .json" })[1]!);
    expect(await screen.findByText("Sin permiso")).toBeTruthy();
  });

  test("un fichero que no es nuestro se rechaza sin ir al servidor", async () => {
    draw(() => Promise.resolve({}));
    pick("no es json");
    expect(await screen.findByText("El fichero no es JSON.")).toBeTruthy();
    pick(JSON.stringify({ format: "otra-cosa" }));
    expect(await screen.findByText("No es un fichero exportado de endpoint-quality.")).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith(expect.stringContaining("import-bundle"), expect.anything());
  });

  test("avisa de las peticiones sin operación y sin contrato, e importa lo marcado", async () => {
    const posted: unknown[] = [];
    draw((path, options) => {
      if (path.endsWith("/operations")) return Promise.resolve({ operations: [{ id: "listOrders" }] });
      if (options?.method === "POST") {
        posted.push(options.body);
        return Promise.resolve(outcome);
      }
      return Promise.resolve({});
    });
    pick(JSON.stringify(bundle({ contract: { raw: "openapi: 3.0.0" } })));
    expect(await screen.findByText(/Exportado de «Origen»/)).toBeTruthy();
    // Con el contrato del fichero marcado no se consulta nada: avisa de que será el activo.
    expect(screen.getByText(/El contrato del fichero pasa a ser el activo/)).toBeTruthy();
    expect(screen.getByText(/sustituyen a los de este proyecto/)).toBeTruthy();

    // Sin él, las peticiones se comprueban contra el contrato de aquí.
    fireEvent.click(screen.getAllByLabelText(/^Contrato/)[1]!);
    expect(await screen.findByText(/El contrato de este proyecto no tiene la operación de 1 petición/)).toBeTruthy();
    expect(screen.getByText("Crear pedido (createOrder)")).toBeTruthy();
    expect(screen.getByText(/Marca «Contrato» para traer el del fichero/)).toBeTruthy();

    // Solo los flujos.
    fireEvent.click(screen.getAllByLabelText(/^Ajustes/)[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    expect(await screen.findByText(/Importado: 2 peticiones, 1 flujo/)).toBeTruthy();
    expect(screen.getByText("token va vacía", { exact: false })).toBeTruthy();
    expect((posted[0] as { parts: string[] }).parts).toEqual(["flows"]);
  });

  test("sin contrato en el proyecto (409) todas las peticiones se quedan sin operación", async () => {
    draw((path) =>
      path.endsWith("/operations")
        ? Promise.reject(new ApiError(409, { type: "", title: "", status: 409, detail: "Sin contrato" }))
        : Promise.resolve({}),
    );
    pick(JSON.stringify(bundle()));
    expect(await screen.findByText(/Este proyecto no tiene contrato/)).toBeTruthy();
  });

  test("un fichero rechazado por el servidor nombra lo que falla", async () => {
    draw((path, options) =>
      options?.method === "POST"
        ? Promise.reject(
            new ApiError(422, {
              type: "",
              title: "",
              status: 422,
              detail: "El fichero no es válido",
              errors: [{ field: "flows.workflows[0].name", detail: "vacío" }],
            }),
          )
        : Promise.resolve({ operations: [{ id: "createOrder" }, { id: "listOrders" }] }),
    );
    pick(JSON.stringify(bundle()));
    fireEvent.click(await screen.findByRole("button", { name: "Importar" }));
    expect(await screen.findByText("El fichero no es válido")).toBeTruthy();
    expect(screen.getByText("flows.workflows[0].name: vacío")).toBeTruthy();
  });

  test("un proyecto archivado no deja elegir fichero", async () => {
    draw(() => Promise.resolve({}), true);
    expect(await screen.findByText(/El proyecto está archivado/)).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  test("mientras se prepara cada exportación su botón lo dice", async () => {
    draw(() => new Promise(() => {}));
    const [own, postman] = screen.getAllByRole("button", { name: "Descargar .json" });
    fireEvent.click(own!);
    fireEvent.click(postman!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Preparando…" })).toHaveLength(2));
  });

  test("cerrar el selector sin elegir fichero no cambia nada", async () => {
    draw(() => Promise.resolve({}));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("button", { name: "Importar" })).toBeNull();
    expect(screen.queryByText(/El fichero no/)).toBeNull();
  });

  test("un fichero sin nombre ni fecha se presenta como tal, y muchas peticiones sin operación se resumen", async () => {
    const requestTemplates = Array.from({ length: 6 }, (_, index) => ({
      name: `P${index}`,
      operationId: `op${index}`,
    }));
    draw((path, options) => {
      if (path.endsWith("/operations")) return Promise.resolve({ operations: [{ id: "otra" }] });
      if (options?.method === "POST") return new Promise(() => {});
      return Promise.resolve({});
    });
    pick(
      JSON.stringify(
        bundle({ project: {}, exportedAt: undefined, flows: { workflows: [{ id: "w" }], requestTemplates } }),
      ),
    );
    expect(await screen.findByText("Fichero de proyecto.")).toBeTruthy();
    expect(await screen.findByText(/El contrato de este proyecto no tiene la operación de 6 peticiones/)).toBeTruthy();
    // Se nombran cinco y el resto se indica.
    expect(screen.getByText(/P4 \(op4\)…/)).toBeTruthy();
    expect(screen.queryByText(/P5/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    const busy = (await screen.findByRole("button", { name: "Importando…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });

  test("si las operaciones no se pueden consultar por otro motivo, no se inventa un aviso", async () => {
    draw((path) =>
      path.endsWith("/operations")
        ? Promise.reject(new ApiError(500, { type: "", title: "", status: 500, detail: "Caído" }))
        : Promise.resolve({}),
    );
    pick(JSON.stringify(bundle()));
    expect(await screen.findByText(/Exportado de «Origen»/)).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/operations"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByText(/no se podrán ejecutar/)).toBeNull();
    expect((screen.getByRole("button", { name: "Importar" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
