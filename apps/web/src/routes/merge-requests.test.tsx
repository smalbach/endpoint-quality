/**
 * Las solicitudes de fusión: la lista del proyecto y la pantalla de una.
 *
 * Lo que decide algo:
 *
 * - **La lista enseña primero lo pendiente**; lo decidido se pide.
 * - **Los botones son los que la API dice** (`can`): quien la creó retira, quien revisa aprueba o
 *   rechaza, y el comentario escrito va con la decisión.
 * - **Fusionar usa la comparación de ahora**: su huella y los conflictos decididos en esta pantalla,
 *   con confirmación; una huella vieja se dice y se ofrece comparar otra vez.
 * - **Quien solo lee no tiene caja de comentario ni botones.**
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MergeRequestDetailPage, MergeRequestsPage } from "@/routes/merge-requests";
import { ApiError } from "@/lib/api";
import type { ForkDiffView, MergeRequestDetailView, MergeRequestSummaryView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));

const summary = (id: string, status: MergeRequestSummaryView["status"], title: string): MergeRequestSummaryView => ({
  id,
  title,
  status,
  fork: { id: "f", name: "Mi bifurcación" },
  parent: { id: "p", name: "Original" },
  author: { id: "u", name: "Ana" },
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  changes: 2,
  conflicts: 1,
  comments: 0,
  approvals: 0,
});

const current: ForkDiffView = {
  direction: "merge",
  token: "huella-ahora",
  version: 3,
  syncedAt: "2026-03-01T10:00:00.000Z",
  source: { id: "f", name: "Mi bifurcación" },
  target: { id: "p", name: "Original" },
  entries: [
    {
      kind: "role",
      key: "r1",
      label: "admin",
      sourceChange: "modified",
      targetChange: "modified",
      status: "conflict",
      fields: [{ path: "color", base: "#000000", source: "#10b981", target: "#ef4444" }],
    },
  ],
};

const detail = (overrides: Partial<MergeRequestDetailView> = {}): MergeRequestDetailView => ({
  ...summary("mr-1", "open", "Describir pedidos"),
  description: "Para el equipo de pagos",
  requested: [{ ...current.entries[0]!, status: "incoming", targetChange: "none" }],
  requestedVersion: 2,
  decidedAt: null,
  mergedVersion: null,
  events: [
    {
      id: "e1",
      kind: "comment",
      author: { id: "v", name: "Bea" },
      body: "¿Y el ejemplo?",
      createdAt: "2026-03-01T11:00:00.000Z",
    },
  ],
  current,
  unavailable: null,
  can: { approve: true, decline: true, close: false, merge: true, comment: true },
  ...overrides,
});

function draw(path: string, answer: (path: string, options?: { method?: string; body?: unknown }) => unknown) {
  call.mockReset();
  call.mockImplementation((requested: string, options?: { method?: string; body?: unknown }) =>
    Promise.resolve().then(() => answer(requested, options)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:projectId/merge-requests" element={<MergeRequestsPage />} />
          <Route path="/p/:projectId/merge-requests/:requestId" element={<MergeRequestDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MergeRequestsPage", () => {
  test("enseña las pendientes, y las decididas cuando se piden", async () => {
    draw("/p/p/merge-requests", () => [
      summary("a", "open", "Pendiente"),
      summary("b", "approved", "Aprobada sin fusionar"),
      summary("c", "merged", "Ya fusionada"),
    ]);
    expect((await screen.findByRole("link", { name: "Pendiente" })).getAttribute("href")).toBe("/p/p/merge-requests/a");
    expect(screen.getByText("Aprobada sin fusionar")).toBeTruthy();
    expect(screen.queryByText("Ya fusionada")).toBeNull();
    fireEvent.click(screen.getByLabelText("Ver también las decididas (1)"));
    expect(screen.getByText("Ya fusionada")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/merge-requests");
  });

  test("sin nada pendiente lo dice", async () => {
    draw("/p/p/merge-requests", () => []);
    expect(await screen.findByText("Nada pendiente")).toBeTruthy();
  });
});

describe("MergeRequestDetailPage", () => {
  test("aprobar manda el comentario escrito con la decisión, y solo salen los botones que la API permite", async () => {
    draw("/p/p/merge-requests/mr-1", (_path, options) => (options?.method ? undefined : detail()));
    expect(await screen.findByText("Describir pedidos")).toBeTruthy();
    expect(screen.getByText("Para el equipo de pagos")).toBeTruthy();
    expect(screen.getByText("¿Y el ejemplo?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirar" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Comentario"), { target: { value: "Bien" } });
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/merge-requests/mr-1/approve", {
        method: "POST",
        body: { body: "Bien" },
      }),
    );
  });

  test("fusionar espera a los conflictos, confirma y manda la huella de ahora con lo decidido", async () => {
    draw("/p/p/merge-requests/mr-1", (_path, options) =>
      options?.method ? { direction: "merge", version: 4, applied: { role: 1 }, skipped: [] } : detail(),
    );
    const merge = (await screen.findByRole("button", { name: "Fusionar" })) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(screen.getByText("Falta decidir un conflicto")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Quedarse con Mi bifurcación"));
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(await screen.findByText("Fusionar en «Original»")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Fusionar" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/merge-requests/mr-1/merge", {
        method: "POST",
        body: { token: "huella-ahora", resolutions: { "role:r1": "source" } },
      }),
    );
  });

  test("una huella vieja se dice y ofrece volver a comparar", async () => {
    draw("/p/p/merge-requests/mr-1", (_path, options) => {
      if (!options?.method) return detail({ current: { ...current, entries: [] } });
      throw new ApiError(409, { type: "about:blank", title: "Conflict", status: 409, detail: "Algo cambió" });
    });
    expect(await screen.findByText("Nada que fusionar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fusionar" }));
    const buttons = await screen.findAllByRole("button", { name: "Fusionar" });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(await screen.findByText("Algo cambió")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Volver a comparar" }));
    await waitFor(() => expect(call.mock.calls.filter(([, options]) => !options).length).toBe(2));
  });

  test("una decidida no compara, y quien solo lee no tiene caja ni botones", async () => {
    can.edit = false;
    try {
      draw("/p/p/merge-requests/mr-1", () =>
        detail({
          status: "merged",
          current: null,
          can: { approve: false, decline: false, close: false, merge: false, comment: true },
        }),
      );
      expect(await screen.findByText("Fusionada")).toBeTruthy();
      expect(screen.queryByText("Lo que se fusionaría ahora")).toBeNull();
      expect(screen.getByText(/Lo que se pidió al crearla \(versión 2\)/)).toBeTruthy();
      expect(screen.queryByLabelText("Comentario")).toBeNull();
      expect(screen.queryByRole("button", { name: "Fusionar" })).toBeNull();
    } finally {
      can.edit = true;
    }
  });

  test("si uno de los proyectos ya no se puede comparar, se dice por qué", async () => {
    draw("/p/p/merge-requests/mr-1", () => detail({ current: null, unavailable: "El proyecto original ya no existe" }));
    expect(await screen.findByText("El proyecto original ya no existe")).toBeTruthy();
  });
});
