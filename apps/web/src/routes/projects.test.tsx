/**
 * La lista de proyectos.
 *
 * Lo que decide algo:
 *
 * - **Activos y archivados salen de una sola respuesta**, repartidos aquí.
 * - **Archivar desde la tarjeta no abre el proyecto** (la tarjeta es un enlace), y solo lo ofrece a
 *   quien puede.
 * - **Crear manda solo lo escrito**, y al crearlo lleva a importar su contrato.
 * - **La salud de la última corrida** es el porcentaje de casos que pasaron, o «en curso».
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Health, ProjectsPage } from "@/routes/projects";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import { EMPTY_AUTH } from "@/lib/project-auth";
import type { ProjectSummary } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org", role: "owner" }),
  useCan: () => can.value,
}));

const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: "p1",
  name: "Tienda",
  slug: "tienda",
  description: "La API de la tienda",
  archivedAt: null,
  baseUrl: "https://api.tienda.test",
  activeEnvironmentId: null,
  tags: ["prod", "v2"],
  auth: EMPTY_AUTH,
  lastRun: {
    id: "r1",
    status: "passed",
    startedAt: "2026-03-01T10:00:00.000Z",
    finishedAt: "2026-03-01T10:01:00.000Z",
    totals: { cases: 10, completed: 10, passed: 9, failed: 1, skipped: 0 },
  },
  contract: {
    versionId: "v1",
    title: "Tienda API",
    version: "1.2.0",
    operationCount: 14,
    importedAt: "2026-02-01T10:00:00.000Z",
  },
  source: null,
  fork: null,
  ...over,
});

function draw(list: ProjectSummary[] | Error, onPost?: (path: string, body: unknown) => Promise<unknown>) {
  call.mockReset();
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) return onPost ? onPost(path, options.body) : Promise.resolve(undefined);
    return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/projects"]}>
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/p/:id" element={<p>Proyecto abierto</p>} />
            <Route path="/p/:id/settings/contract" element={<p>Importar contrato</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectsPage", () => {
  test("reparte activos y archivados de una sola respuesta", async () => {
    can.value = true;
    draw([
      project({}),
      project({
        id: "p2",
        name: "Pagos",
        slug: "pagos",
        contract: null,
        tags: [],
        description: "",
        lastRun: null,
        baseUrl: "",
      }),
      project({ id: "p3", name: "Viejo", archivedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(screen.getByText("Cargando proyectos…")).toBeTruthy();
    const tienda = (await screen.findByText("Tienda")).closest("a")!;
    expect(call).toHaveBeenCalledWith("/orgs/o/projects?includeArchived=true");
    expect(tienda.getAttribute("href")).toBe("/p/p1");
    expect(within(tienda).getByText("Tienda API")).toBeTruthy();
    expect(within(tienda).getByText("14 operaciones")).toBeTruthy();
    expect(within(tienda).getByText("prod")).toBeTruthy();
    expect(within(tienda).getByText("90%")).toBeTruthy();

    const pagos = screen.getByText("Pagos").closest("a")!;
    expect(within(pagos).getByText("Sin contrato importado todavía")).toBeTruthy();
    expect(within(pagos).getByText("Sin corridas todavía")).toBeTruthy();
    expect(within(pagos).getByText("pagos")).toBeTruthy(); // sin URL base, el slug
    expect(screen.queryByText("Viejo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archivados" }));
    expect(screen.getByText("Viejo")).toBeTruthy();
    expect(screen.getByText("archivado")).toBeTruthy();
    expect(screen.queryByText("Tienda")).toBeNull();
    // En archivados no se crea.
    expect(screen.queryByRole("button", { name: "Nuevo proyecto" })).toBeNull();
  });

  test("archivar desde la tarjeta no abre el proyecto y lo confirma", async () => {
    can.value = true;
    draw([project({})]);
    fireEvent.click(await screen.findByRole("button", { name: "Archivar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/archived", { method: "PATCH", body: { archived: true } }),
    );
    expect(await screen.findByText("«Tienda» archivado")).toBeTruthy();
    expect(screen.queryByText("Proyecto abierto")).toBeNull();
  });

  test("restaurar un archivado, y un fallo se dice", async () => {
    can.value = true;
    draw([project({ archivedAt: "2026-01-01T00:00:00.000Z" })], () => Promise.reject(new Error("No se pudo")));
    fireEvent.click(await screen.findByRole("button", { name: "Archivados" }));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/archived", { method: "PATCH", body: { archived: false } }),
    );
    expect(await screen.findByText("No se pudo")).toBeTruthy();
  });

  test("sin permisos no se ofrece crear ni archivar", async () => {
    can.value = false;
    draw([]);
    expect(await screen.findByText("Todavía no hay proyectos")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Crear el primer proyecto" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nuevo proyecto" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archivados" }));
    expect(screen.getByText("Ningún proyecto archivado")).toBeTruthy();
  });

  test("un error al listar se enseña", async () => {
    can.value = true;
    draw(new Error("Servidor caído"));
    expect(await screen.findByText("Servidor caído")).toBeTruthy();
  });

  test("crear manda solo lo escrito y lleva a importar el contrato", async () => {
    can.value = true;
    const posted: unknown[] = [];
    draw([], (_path, body) => {
      posted.push(body);
      return Promise.resolve({ projectId: "nuevo" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Crear el primer proyecto" }));
    const create = screen.getByRole("button", { name: "Crear proyecto" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Digital Catalog"), { target: { value: "  Catálogo  " } });
    fireEvent.change(screen.getByPlaceholderText("produccion, v2, interno"), { target: { value: "a, b" } });
    fireEvent.change(screen.getByLabelText(/^Tipo/), { target: { value: "basic" } });
    fireEvent.change(screen.getByLabelText(/Usuario/), { target: { value: "ana" } });
    // Sin contraseña, basic no está completo y no deja crear.
    expect(screen.getByText("Falta la contraseña")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Contraseña/), { target: { value: "s3creta" } });
    fireEvent.click(create);
    expect(await screen.findByText("Importar contrato")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects", expect.objectContaining({ method: "POST" }));
    expect(posted[0]).toEqual({
      name: "Catálogo",
      tags: ["a", "b"],
      auth: { type: "basic", username: "ana", password: "s3creta" },
    });
  });

  test("un error del servidor por campo va junto al campo; uno general, arriba", async () => {
    can.value = true;
    let attempt = 0;
    draw([], () => {
      attempt += 1;
      return Promise.reject(
        attempt === 1
          ? new ApiError(422, {
              type: "",
              title: "",
              status: 422,
              detail: "Inválido",
              errors: [{ field: "name", detail: "Nombre repetido" }],
            })
          : new Error("Sin conexión"),
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Crear el primer proyecto" }));
    fireEvent.change(screen.getByPlaceholderText("Digital Catalog"), { target: { value: "Tienda" } });
    fireEvent.change(screen.getByPlaceholderText("https://api.example.com"), { target: { value: "https://x.test" } });
    fireEvent.change(screen.getByPlaceholderText("Opcional"), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear proyecto" }));
    expect(await screen.findByText("Nombre repetido")).toBeTruthy();
    expect(screen.queryByText("Inválido")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Crear proyecto" }));
    expect(await screen.findByText("Sin conexión")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByText("Nuevo proyecto", { selector: "h2" })).toBeNull());
  });
});

describe("ProjectsPage: esperas y restauración", () => {
  test("restaurar un archivado lo confirma", async () => {
    can.value = true;
    draw([project({ archivedAt: "2026-01-01T00:00:00.000Z" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Archivados" }));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(await screen.findByText("«Tienda» restaurado")).toBeTruthy();
  });

  test("mientras se archiva, solo se bloquea el botón de ese proyecto", async () => {
    can.value = true;
    draw([project({}), project({ id: "p2", name: "Pagos", slug: "pagos" })], () => new Promise(() => {}));
    const [first, second] = (await screen.findAllByRole("button", { name: "Archivar" })) as HTMLButtonElement[];
    fireEvent.click(first!);
    await waitFor(() => expect(first!.disabled).toBe(true));
    expect(second!.disabled).toBe(false);
  });

  test("«Nuevo proyecto» abre el alta, y mientras se crea el botón lo dice", async () => {
    can.value = true;
    draw([project({})], () => new Promise(() => {}));
    await screen.findByText("Tienda");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo proyecto" }));
    fireEvent.change(screen.getByPlaceholderText("Digital Catalog"), { target: { value: "Catálogo" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear proyecto" }));
    const busy = (await screen.findByRole("button", { name: "Creando…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });
});

describe("Health", () => {
  const run = (status: "running" | "failed", passed: number, failed: number, cases: number) => ({
    id: "r",
    status,
    startedAt: "2026-03-01T10:00:00.000Z",
    finishedAt: null,
    totals: { cases, completed: passed + failed, passed, failed, skipped: 0 },
  });

  test("una corrida en curso dice cuánto lleva", () => {
    render(<Health lastRun={run("running", 3, 1, 10)} />);
    expect(screen.getByText(/Corrida en curso · 4\/10/)).toBeTruthy();
  });

  test("el color sigue al porcentaje: ámbar desde 60, rojo por debajo, 0% sin casos", () => {
    const { rerender } = render(<Health lastRun={run("failed", 7, 3, 10)} />);
    expect(screen.getByText("70%").className).toContain("text-amber-700");
    rerender(<Health lastRun={run("failed", 1, 9, 10)} />);
    expect(screen.getByText("10%").className).toContain("text-rose-700");
    rerender(<Health lastRun={run("failed", 0, 0, 0)} />);
    expect(screen.getByText("0%")).toBeTruthy();
  });
});
