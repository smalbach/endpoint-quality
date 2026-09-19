/**
 * La lista de flujos: la puerta de entrada a los lienzos.
 *
 * - **Cada flujo dice cómo se conecta**: los sub-flujos que ejecuta (y los de ellos, en árbol), los
 *   flujos que lo ejecutan a él y las suites que lo incluyen.
 * - **Un clic abre su lienzo** en `workflows/:id`.
 * - **Los archivados no se ven** salvo en su filtro.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { WorkflowListPage } from "@/routes/workflow-list";
import type { WorkflowStepView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));
vi.mock("@/components/import-provider", () => ({ useImport: () => ({ open: () => {} }) }));

const subflow = (id: string, workflowId: string) =>
  ({ id, kind: "subflow", subflow: { workflowId } }) as WorkflowStepView;
const request = (id: string) => ({ id, kind: "request", requestTemplateId: "t" }) as WorkflowStepView;
const flow = (id: string, name: string, steps: WorkflowStepView[], status = "ready") => ({
  id,
  name,
  description: null,
  status,
  steps,
  updatedAt: "2026-09-01T00:00:00.000Z",
});

function draw() {
  call.mockReset();
  call.mockImplementation((path: string) => {
    if (path.endsWith("/environments")) return Promise.resolve([{ id: "env-1", name: "local" }]);
    return Promise.resolve({
      requestTemplates: [],
      datasets: [],
      suites: [{ id: "s1", name: "Regresión", description: null, workflowIds: ["checkout"], updatedAt: "" }],
      workflows: [
        flow("checkout", "Checkout", [request("r1"), subflow("n1", "login"), subflow("n2", "pay")]),
        flow("login", "Login", [request("r1")]),
        flow("pay", "Pago", [subflow("n1", "login")], "draft"),
        flow("old", "Viejo", [], "archived"),
      ],
    });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Opened = () => <p>lienzo de {useParams().workflowId}</p>;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/workflows"]}>
        <Routes>
          <Route path="/p/:projectId/workflows" element={<WorkflowListPage projectId="p1" />} />
          <Route path="/p/:projectId/workflows/:workflowId" element={<Opened />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) =>
  screen
    .getAllByRole("listitem")
    .find((item) => within(item).queryAllByText(name).length > 0 && item.querySelector("a.min-w-0"))!;

describe("la lista de flujos", () => {
  test("cada flujo enseña sus sub-flujos en árbol, quién lo ejecuta y sus suites", async () => {
    draw();
    await waitFor(() => expect(screen.getByText("Checkout")).toBeTruthy());
    const checkout = rowOf("Checkout");
    expect(within(checkout).getByText("Sub-flujos (2)", { exact: false })).toBeTruthy();
    // Pago ejecuta Login: aparece anidado bajo Pago dentro de Checkout.
    expect(within(checkout).getAllByText("Login")).toHaveLength(2);
    expect(within(checkout).getByText("Regresión")).toBeTruthy();
    expect(within(checkout).getByText("2 sub-flujos · 1 petición", { exact: false })).toBeTruthy();

    const login = screen
      .getAllByRole("listitem")
      .find((item) => item.querySelector("a.min-w-0")?.textContent?.startsWith("Login"))!;
    expect(within(login).getByText("Lo ejecutan")).toBeTruthy();
    expect(within(login).getByText("↰ Checkout")).toBeTruthy();
    expect(within(login).getByText("↰ Pago")).toBeTruthy();
  });

  test("los archivados sólo aparecen en su filtro", async () => {
    draw();
    await waitFor(() => expect(screen.getByText("Checkout")).toBeTruthy());
    expect(screen.queryByText("Viejo")).toBeNull();
    fireEvent.click(screen.getByText("Archivados"));
    expect(screen.getByText("Viejo")).toBeTruthy();
    expect(screen.queryByText("Checkout")).toBeNull();
  });

  test("un clic abre el lienzo del flujo", async () => {
    draw();
    await waitFor(() => expect(screen.getByText("Checkout")).toBeTruthy());
    fireEvent.click(within(rowOf("Checkout")).getByText("Abrir lienzo"));
    expect(screen.getByText("lienzo de checkout")).toBeTruthy();
  });
});
