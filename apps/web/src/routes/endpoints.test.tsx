/**
 * La página de endpoints: la lista, el editor y lo que los une.
 *
 * La lista y el editor tienen sus propias pruebas; aquí se sustituyen por dobles que exponen sus
 * callbacks, porque lo que decide esta página es lo de en medio:
 *
 * - **El endpoint abierto está en la URL** (`?e=`), y crear uno nuevo lo abre por su id.
 * - **Salir de un endpoint con cambios sin guardar pregunta**; sin cambios, no.
 * - **Borrar el endpoint abierto lo cierra.**
 * - **Filtrar o buscar vuelve a la primera página**, y la búsqueda va codificada.
 * - **El ancho del panel se arrastra, se limita y se recuerda**; doble clic lo devuelve.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { EndpointEditorPage, EndpointsPage, SPLIT, clampWidth } from "@/routes/endpoints";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org", role: "owner" }),
  useCan: () => true,
}));
vi.mock("@/components/endpoints-tabs", () => ({ EndpointsTabs: () => null }));

type ListProps = {
  loading: boolean;
  page?: { hasContract: boolean };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onStatus: (status: string) => void;
  onSearch: (search: string) => void;
  onPage: (page: number) => void;
  onRemoved: (ids: string[]) => void;
  onChanged: () => void;
};
vi.mock("@/components/endpoint-list", () => ({
  EndpointList: (props: ListProps) => (
    <div>
      <span>{props.loading ? "lista cargando" : "lista lista"}</span>
      <span>seleccionado: {props.selectedId ?? "ninguno"}</span>
      <button onClick={() => props.onSelect("e1")}>abrir e1</button>
      <button onClick={() => props.onSelect("e2")}>abrir e2</button>
      <button onClick={() => props.onSelect("e1")}>abrir e1 otra vez</button>
      <button onClick={props.onNew}>nuevo</button>
      <button onClick={() => props.onStatus("deleted")}>ver borrados</button>
      <button onClick={() => props.onSearch("pedidos & co")}>buscar</button>
      <button onClick={() => props.onPage(3)}>página 3</button>
      <button onClick={() => props.onRemoved(["e1"])}>borrar e1</button>
      <button onClick={() => props.onRemoved(["e9"])}>borrar e9</button>
      <button onClick={props.onChanged}>cambiado</button>
    </div>
  ),
}));

type EditorProps = {
  endpointId: string | null;
  layout: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: (endpoint: { id: string }, created: boolean) => void;
  onOpenFull?: () => void;
};
vi.mock("@/components/endpoint-editor", () => ({
  EndpointEditor: (props: EditorProps) => (
    <div>
      <span>
        editor {props.layout}: {props.endpointId ?? "nuevo"}
      </span>
      <button onClick={() => props.onDirtyChange?.(true)}>ensuciar</button>
      <button onClick={() => props.onSaved({ id: "creado" }, true)}>guardar nuevo</button>
      <button onClick={() => props.onSaved({ id: "e1" }, false)}>guardar</button>
      {props.onOpenFull && <button onClick={props.onOpenFull}>pantalla completa</button>}
    </div>
  ),
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function draw(at = "/p/p1", hasContract = false) {
  call.mockReset();
  call.mockResolvedValue({ items: [], total: 0, hasContract });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/p/:projectId" element={<EndpointsPage />} />
          <Route path="/p/:projectId/endpoints/:endpointId" element={<EndpointEditorPage />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

afterEach(() => window.localStorage.clear());

describe("clampWidth", () => {
  test("un ancho fuera de los límites o que no es número vuelve al inicial", () => {
    expect(clampWidth("500")).toBe(500);
    expect(clampWidth(null)).toBe(SPLIT.initial);
    expect(clampWidth("100")).toBe(SPLIT.initial);
    expect(clampWidth("9999")).toBe(SPLIT.initial);
    expect(clampWidth("abc")).toBe(SPLIT.initial);
  });
});

describe("EndpointsPage", () => {
  test("pide la lista y, sin nada abierto, invita a elegir o importar el contrato", async () => {
    draw("/p/p1", false);
    expect(await screen.findByText("lista lista")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/endpoints?status=active&page=1&limit=100");
    expect(screen.getByText("Elige un endpoint para verlo y probarlo")).toBeTruthy();
    expect(screen.getByText(/Importar el contrato en Settings también los crea/)).toBeTruthy();
  });

  test("abrir un endpoint lo pone en la URL; sin cambios se cambia de uno a otro sin preguntar", async () => {
    draw("/p/p1", true);
    await screen.findByText("lista lista");
    expect(screen.queryByText(/Importar el contrato/)).toBeNull();
    click("abrir e1");
    expect(where()).toBe("/p/p1?e=e1");
    expect(screen.getByText("editor inline: e1")).toBeTruthy();
    // Volver a pedir el mismo no hace nada.
    click("abrir e1 otra vez");
    click("abrir e2");
    expect(where()).toBe("/p/p1?e=e2");
    expect(screen.queryByText("Cambios sin guardar")).toBeNull();
  });

  test("con cambios sin guardar pregunta; cancelar se queda, descartar cambia", async () => {
    draw("/p/p1?e=e1");
    expect(await screen.findByText("editor inline: e1")).toBeTruthy();
    click("ensuciar");
    click("abrir e2");
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    click("Cancelar");
    await waitFor(() => expect(screen.queryByText("Cambios sin guardar")).toBeNull());
    expect(where()).toBe("/p/p1?e=e1");

    click("abrir e2");
    click("Descartar");
    expect(where()).toBe("/p/p1?e=e2");
  });

  test("crear uno nuevo lo abre por su id al guardarlo; borrar el abierto lo cierra", async () => {
    draw("/p/p1");
    await screen.findByText("lista lista");
    click("nuevo");
    expect(where()).toBe("/p/p1?e=new");
    expect(screen.getByText("editor inline: nuevo")).toBeTruthy();
    click("ensuciar");
    click("guardar nuevo");
    expect(where()).toBe("/p/p1?e=creado");

    click("abrir e1");
    click("guardar");
    expect(where()).toBe("/p/p1?e=e1");
    click("borrar e9");
    expect(where()).toBe("/p/p1?e=e1");
    click("ensuciar");
    click("borrar e1");
    expect(where()).toBe("/p/p1");
  });

  test("filtrar y buscar vuelven a la primera página", async () => {
    draw();
    await screen.findByText("lista lista");
    click("página 3");
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("/orgs/o/projects/p1/endpoints?status=active&page=3&limit=100"),
    );
    click("ver borrados");
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("/orgs/o/projects/p1/endpoints?status=deleted&page=1&limit=100"),
    );
    click("página 3");
    click("buscar");
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        "/orgs/o/projects/p1/endpoints?status=deleted&page=1&limit=100&search=pedidos%20%26%20co",
      ),
    );
    const before = call.mock.calls.length;
    click("cambiado");
    await waitFor(() => expect(call.mock.calls.length).toBeGreaterThan(before));
  });

  test("el panel se arrastra dentro de sus límites, se recuerda y el doble clic lo devuelve", async () => {
    window.localStorage.setItem("eq.endpoints-split-width", "500");
    draw();
    await screen.findByText("lista lista");
    const separator = screen.getByRole("separator", { name: "Redimensionar" });
    const panel = separator.previousElementSibling as HTMLElement;
    expect(panel.style.width).toBe("500px");

    fireEvent.mouseDown(separator, { clientX: 100 });
    expect(document.body.style.cursor).toBe("col-resize");
    fireEvent.mouseMove(window, { clientX: 150 });
    expect(panel.style.width).toBe("550px");
    fireEvent.mouseMove(window, { clientX: 5000 });
    expect(panel.style.width).toBe(`${SPLIT.max}px`);
    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe("");
    expect(window.localStorage.getItem("eq.endpoints-split-width")).toBe(String(SPLIT.max));
    // Mover sin arrastrar no cambia nada.
    fireEvent.mouseMove(window, { clientX: 0 });
    expect(panel.style.width).toBe(`${SPLIT.max}px`);

    fireEvent.doubleClick(separator);
    expect(panel.style.width).toBe(`${SPLIT.initial}px`);
  });

  test("«pantalla completa» lleva a la página del endpoint", async () => {
    draw("/p/p1?e=e1");
    click("pantalla completa");
    expect(where()).toBe("/p/p1/endpoints/e1");
    expect(screen.getByText("editor full: e1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Endpoints" }).getAttribute("href")).toBe("/p/p1?e=e1");
  });
});

describe("EndpointEditorPage", () => {
  test("uno nuevo, al guardarse, pasa a su propia dirección", () => {
    draw("/p/p1/endpoints/new");
    expect(screen.getByText("editor full: nuevo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Endpoints" }).getAttribute("href")).toBe("/p/p1");
    click("guardar nuevo");
    expect(where()).toBe("/p/p1/endpoints/creado");
    click("guardar");
    expect(where()).toBe("/p/p1/endpoints/creado");
  });
});
