/**
 * La pantalla de traer y fusionar.
 *
 * Lo que decide algo:
 *
 * - **Un conflicto no tiene lado por defecto**: el botón no se activa hasta que se elige, y lo que
 *   se manda es la huella que se vio y la decisión tomada.
 * - **Fusionar pide confirmación nombrando el original**, porque escribe en un proyecto de todos.
 * - **Una huella vieja se dice y se ofrece comparar otra vez**, en vez de un error sin salida.
 * - **Los campos se enseñan con su valor en común y en cada lado.**
 * - **Al fusionar se puede pedir en vez de hacer**: la solicitud se crea desde la bifurcación y se
 *   abre en el original, donde se revisa.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ForkSyncPage } from "@/routes/fork-sync";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type { ForkDiffView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const diff = (direction: "pull" | "merge"): ForkDiffView => ({
  direction,
  token: "huella-1",
  version: 3,
  syncedAt: "2026-03-01T10:00:00.000Z",
  source: direction === "pull" ? { id: "p", name: "Original" } : { id: "f", name: "Mi bifurcación" },
  target: direction === "pull" ? { id: "f", name: "Mi bifurcación" } : { id: "p", name: "Original" },
  entries: [
    {
      kind: "endpoint",
      key: "GET /orders",
      label: "GET /orders",
      sourceChange: "modified",
      targetChange: "modified",
      status: "conflict",
      fields: [{ path: "description", base: "", source: "del origen", target: "del destino" }],
    },
    {
      kind: "workflow",
      key: "w1",
      label: "Pedidos",
      sourceChange: "modified",
      targetChange: "none",
      status: "incoming",
      fields: [{ path: "name", base: "Pedidos", source: "Pedidos v2", target: "Pedidos" }],
    },
  ],
});

function draw(direction: "pull" | "merge", post: (body: unknown) => Promise<unknown> = () => Promise.resolve(outcome)) {
  call.mockReset();
  call.mockImplementation((_path: string, options?: { method?: string; body?: unknown }) =>
    options?.method === "POST" ? post(options.body) : Promise.resolve(diff(direction)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/f/fork/${direction}`]}>
        <Routes>
          <Route path="/p/:projectId/fork/:direction" element={<ForkSyncPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const outcome = {
  direction: "pull",
  version: 4,
  applied: { endpoint: 1, template: 0, workflow: 1, environment: 0 },
  skipped: [{ what: "secreto", detail: "staging: hay que escribir token" }],
};

describe("ForkSyncPage", () => {
  test("un conflicto bloquea el botón hasta que se elige un lado, y se manda la huella y la decisión", async () => {
    draw("pull");
    const button = await screen.findByRole("button", { name: "Traer cambios" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Falta decidir un conflicto")).toBeTruthy();
    // Los valores de cada lado, con la foto común.
    expect(screen.getByText("del origen")).toBeTruthy();
    expect(screen.getByText("del destino")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Quedarse con Mi bifurcación"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/f/fork/pull", {
        method: "POST",
        body: { token: "huella-1", resolutions: { "endpoint:GET /orders": "target" } },
      }),
    );
    expect(await screen.findByText(/Cambios traídos \(versión 4\)/)).toBeTruthy();
    expect(screen.getByText(/hay que escribir token/)).toBeTruthy();
  });

  test("fusionar pide confirmación nombrando el original antes de escribir", async () => {
    draw("merge");
    fireEvent.click(await screen.findByLabelText("Quedarse con Mi bifurcación"));
    fireEvent.click(screen.getByRole("button", { name: "Fusionar" }));
    expect(await screen.findByText("Fusionar en «Original»")).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));

    const buttons = screen.getAllByRole("button", { name: "Fusionar" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/f/fork/merge", {
        method: "POST",
        body: { token: "huella-1", resolutions: { "endpoint:GET /orders": "source" } },
      }),
    );
  });

  test("una huella vieja se dice y ofrece volver a comparar", async () => {
    draw("pull", () =>
      Promise.reject(
        new ApiError(409, {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Alguno de los dos proyectos cambió",
        }),
      ),
    );
    fireEvent.click(await screen.findByLabelText("Quedarse con Original"));
    fireEvent.click(screen.getByRole("button", { name: "Traer cambios" }));
    expect(await screen.findByText("Alguno de los dos proyectos cambió")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Volver a comparar" }));
    await waitFor(() => expect(call.mock.calls.filter(([, options]) => !options).length).toBe(2));
  });

  test("en vez de fusionar, se crea una solicitud y se abre en el original", async () => {
    call.mockReset();
    call.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === "POST" ? Promise.resolve({ id: "mr-1" }) : Promise.resolve(diff("merge")),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/p/f/fork/merge"]}>
            <Routes>
              <Route path="/p/:projectId/fork/:direction" element={<ForkSyncPage />} />
              <Route path="/p/:projectId/merge-requests/:requestId" element={<p>Solicitud abierta</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Crear solicitud de fusión" }));
    expect(screen.getByText("Pedir la fusión en «Original»")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Crear solicitud" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "  Describir pedidos " } });
    fireEvent.change(screen.getByLabelText(/Descripción/), { target: { value: "Para pagos" } });
    fireEvent.click(create);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/f/merge-requests", {
        method: "POST",
        body: { title: "Describir pedidos", description: "Para pagos" },
      }),
    );
    expect(await screen.findByText("Solicitud abierta")).toBeTruthy();
  });

  test("sin diferencias no hay nada que aplicar", async () => {
    call.mockReset();
    call.mockResolvedValue({ ...diff("pull"), entries: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/p/f/fork/pull"]}>
          <Routes>
            <Route path="/p/:projectId/fork/:direction" element={<ForkSyncPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Nada que sincronizar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Traer cambios" })).toBeNull();
  });
});
