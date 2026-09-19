/**
 * Importar piezas sueltas de otro proyecto: cerrado es un botón (que respeta «deshabilitado");
 * abierto pide los proyectos de la organización y no ofrece el propio; al elegir el origen pide su
 * vista previa; se marcan endpoints, flujos y entornos uno a uno o todos, el botón cuenta lo marcado,
 * y al importar manda exactamente lo marcado, dice qué entró y avisa al padre. Un fallo se ve.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportElements } from "@/components/import-elements";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const preview = {
  endpoints: [
    { id: "e1", method: "GET", path: "/users" },
    { id: "e2", method: "POST", path: "/users" },
  ],
  workflows: [{ id: "w1", name: "Login", steps: 3 }],
  environments: [],
};

function mount({
  projects = [
    { id: "p", name: "Este" },
    { id: "q", name: "Otro" },
  ],
  importer = () => Promise.resolve({ endpoints: 2, workflows: 1, environments: 0, skipped: [{ what: "x" }] }),
}: { projects?: { id: string; name: string }[]; importer?: () => Promise<unknown> } = {}) {
  call.mockReset();
  call.mockImplementation((path: string) => {
    if (path === "/orgs/o/projects") return Promise.resolve(projects);
    if (path.includes("/import-preview")) return Promise.resolve(preview);
    if (path.includes("/import-elements")) return importer();
    return Promise.resolve({});
  });
  const onImported = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ImportElements base="/projects/p" projectId="p" organizationId="o" disabled={false} onImported={onImported} />
    </QueryClientProvider>,
  );
  return { onImported };
}

const section = (title: string) => screen.getByText(new RegExp(`^${title} \\(`)).parentElement!.parentElement!;

describe("ImportElements", () => {
  test("cerrado no pide nada; deshabilitado no se abre", () => {
    call.mockReset();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ImportElements base="/projects/p" projectId="p" organizationId="o" disabled onImported={vi.fn()} />
      </QueryClientProvider>,
    );
    expect((screen.getByRole("button", { name: "Importar por elementos" }) as HTMLButtonElement).disabled).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  test("elige el origen, marca piezas e importa exactamente lo marcado", async () => {
    const { onImported } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Importar por elementos" }));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect(select.options[1]!.text).toBe("Otro");

    fireEvent.change(select, { target: { value: "q" } });
    await waitFor(() => expect(screen.getByText("GET /users")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("/projects/p/import-preview?sourceProjectId=q");
    // Una sección sin elementos no se dibuja.
    expect(screen.queryByText(/^Entornos \(/)).toBeNull();
    expect((screen.getByRole("button", { name: /^Importar/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(section("Endpoints")).getByRole("button", { name: "Todos" }));
    expect(within(section("Endpoints")).getByRole("button", { name: "Ninguno" })).toBeTruthy();
    fireEvent.click(within(section("Endpoints")).getAllByRole("checkbox")[0]!);
    fireEvent.click(within(section("Flujos")).getByRole("checkbox"));
    fireEvent.click(within(section("Flujos")).getByRole("checkbox"));
    fireEvent.click(within(section("Flujos")).getByRole("checkbox"));
    expect(screen.getByText("Login · 3 pasos")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Importar (2)" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith("/projects/p/import-elements", {
      method: "POST",
      body: { sourceProjectId: "q", endpointIds: ["e2"], workflowIds: ["w1"], environmentIds: [] },
    });
    expect(screen.getByText(/Importado: 2 endpoints, 1 flujos, 0\s+entornos\. 1 avisos\./)).toBeTruthy();
    // Lo marcado se vacía tras importar.
    expect(
      within(section("Endpoints"))
        .getAllByRole("checkbox")
        .every((box) => !(box as HTMLInputElement).checked),
    ).toBe(true);

    fireEvent.click(within(section("Endpoints")).getByRole("button", { name: "Todos" }));
    fireEvent.click(within(section("Endpoints")).getByRole("button", { name: "Ninguno" }));
    expect(screen.getByRole("button", { name: /^Importar/ }).textContent?.trim()).toBe("Importar");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.getByRole("button", { name: "Importar por elementos" })).toBeTruthy();
  });

  test("los canales importados se cuentan, y sin avisos no se habla de ellos", async () => {
    const { onImported } = mount({
      importer: () => Promise.resolve({ endpoints: 1, workflows: 0, environments: 0, channels: 2, skipped: [] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar por elementos" }));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    fireEvent.change(select, { target: { value: "q" } });
    await waitFor(() => expect(screen.getByText("GET /users")).toBeTruthy());
    fireEvent.click(within(section("Endpoints")).getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Importar (1)" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const summary = screen.getByText(/^Importado:/).textContent!;
    expect(summary).toContain(", 2 canales.");
    expect(summary).not.toContain("avisos");
  });

  test("sin otro proyecto del que importar, lo dice", async () => {
    mount({ projects: [{ id: "p", name: "Este" }] });
    fireEvent.click(screen.getByRole("button", { name: "Importar por elementos" }));
    expect(await screen.findByText("No hay otro proyecto del que importar.")).toBeTruthy();
  });

  test("un fallo al importar se enseña y no avisa al padre", async () => {
    const { onImported } = mount({ importer: () => Promise.reject(new Error("Sin permiso en el origen")) });
    fireEvent.click(screen.getByRole("button", { name: "Importar por elementos" }));
    const select = screen.getByRole("combobox");
    await waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(2));
    fireEvent.change(select, { target: { value: "q" } });
    await waitFor(() => expect(screen.getByText("GET /users")).toBeTruthy());
    fireEvent.click(within(section("Flujos")).getByRole("button", { name: "Todos" }));
    fireEvent.click(screen.getByRole("button", { name: "Importar (1)" }));
    expect(await screen.findByText("Sin permiso en el origen")).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
  });
});
