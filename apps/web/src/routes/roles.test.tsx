/**
 * La pantalla de roles.
 *
 * Lo que decide algo:
 *
 * - **Un rol se crea, se edita y se borra**, y borrarlo pide confirmación nombrándolo.
 * - **Los permisos son un borrador por endpoint**: una carpeta cambia todo lo que tiene dentro, el
 *   alcance de datos solo se decide sobre lo permitido, y se manda solo lo que cambió.
 * - **Las reglas entre roles** aparecen con dos roles y se guardan enteras.
 * - **Las credenciales por entorno** dicen qué rol no se puede ejercitar todavía.
 * - **Sin `editor` no se edita; sin `admin` no se borra.**
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { RolesPage } from "@/routes/roles";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type {
  ConfigView,
  EndpointPage,
  EndpointView,
  Environment,
  RolePermissionView,
  RoleRuleView,
  RoleView,
} from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ editor: true, admin: true }) as Record<string, boolean>);
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org" }),
  useCan: (role: string) => can[role] ?? true,
}));

const role = (patch: Partial<RoleView>): RoleView => ({
  id: "r1",
  name: "vendedor",
  description: "",
  color: "#6366f1",
  sameRoleDataIsolation: false,
  position: 0,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  allowed: 1,
  denied: 0,
  archivedAt: null,
  deletedAt: null,
  ...patch,
});

const seller = role({ id: "r1", name: "vendedor", description: "Gestiona su catálogo", sameRoleDataIsolation: true });
const buyer = role({ id: "r2", name: "comprador", color: "#ec4899", allowed: 0, denied: 2 });

const endpoint = (id: string, method: string, path: string, patch: Partial<EndpointView> = {}) =>
  ({ id, method, path, status: "active", operationId: null, ...patch }) as EndpointView;

const endpoints: EndpointPage = {
  data: [
    endpoint("a", "GET", "/orders", { operationId: "listOrders" }),
    endpoint("b", "POST", "/orders", { status: "archived" }),
    endpoint("c", "GET", "/v1/users", { status: "inactive" }),
  ],
  meta: { page: 1, limit: 500, total: 3, totalPages: 1 },
  counts: { active: 1, inactive: 1, archived: 1 } as EndpointPage["counts"],
  deleted: 0,
  hasContract: true,
};

const envs: Environment[] = [
  {
    id: "e1",
    name: "staging",
    baseUrl: "https://s.test",
    specUrl: null,
    variables: {},
    disabledVariables: {},
    writesAllowed: true,
    authEnforced: true,
    active: true,
    archivedAt: null,
    deletedAt: null,
    credentials: [
      {
        id: "c1",
        name: "vendedor",
        role: "vendedor",
        kind: "bearer",
        headerName: null,
        updatedAt: "2026-03-01T10:00:00.000Z",
      },
    ],
  },
];

type Handlers = {
  roles?: RoleView[] | (() => Promise<RoleView[]>);
  permissions?: RolePermissionView[];
  rules?: RoleRuleView[];
  environments?: Environment[];
  config?: ConfigView;
  endpoints?: EndpointPage;
  write?: (path: string, options: { method: string; body?: unknown }) => Promise<unknown>;
};

function draw(handlers: Handlers = {}) {
  call.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) return (handlers.write ?? (() => Promise.resolve({})))(path, options as { method: string });
    if (path.endsWith("/roles")) {
      const roles = handlers.roles ?? [seller, buyer];
      return typeof roles === "function" ? roles() : Promise.resolve(roles);
    }
    if (path.endsWith("/permissions")) return Promise.resolve({ permissions: handlers.permissions ?? [] });
    if (path.endsWith("/role-rules")) return Promise.resolve({ rules: handlers.rules ?? [] });
    if (path.endsWith("/environments")) return Promise.resolve(handlers.environments ?? envs);
    if (path.includes("/endpoints?")) return Promise.resolve(handlers.endpoints ?? endpoints);
    if (path.endsWith("/config")) return Promise.resolve(handlers.config ?? { sections: {} });
    if (path.endsWith("/operations")) return Promise.resolve({ operations: [{ id: "listOrders" }] });
    if (path === "/orgs/o/projects/p1") return Promise.resolve({ contract: { versionId: "v1" } });
    return Promise.reject(new Error(`inesperado ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/p1/roles"]}>
          <Routes>
            <Route path="/p/:projectId/roles" element={<RolesPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const roleCard = (name: string) =>
  screen.getAllByText(name, { selector: "span.font-mono.text-sm" })[0].closest('[role="button"]') as HTMLElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  call.mockReset();
  can.editor = true;
  can.admin = true;
});

describe("RolesPage", () => {
  test("mientras carga lo dice, y sin roles invita a añadirlos", async () => {
    let resolve: (roles: RoleView[]) => void = () => {};
    draw({ roles: () => new Promise((done) => (resolve = done)) });
    expect(screen.getByText("Cargando…")).toBeTruthy();
    resolve([]);
    expect(await screen.findByText(/Sin roles\. Añade los de tu API/)).toBeTruthy();
    expect(screen.getByText("Elige un rol para decidir qué endpoints alcanza.")).toBeTruthy();
    expect(screen.queryByText("Reglas entre roles")).toBeNull();
    expect(screen.queryByText("Credenciales por entorno")).toBeNull();
  });

  test("un solo rol explica que las reglas llegan con el segundo", async () => {
    draw({ roles: [seller] });
    expect(await screen.findByText(/Con dos roles o más aparecen las reglas entre roles/)).toBeTruthy();
  });

  test("la lista enseña cada rol con su resumen, y el primero queda elegido", async () => {
    draw();
    await screen.findByText("Gestiona su catálogo");
    expect(screen.getByText("Aislado")).toBeTruthy();
    expect(screen.getByText("1 permitidos · 0 denegados")).toBeTruthy();
    expect(screen.getByText("0 permitidos · 2 denegados")).toBeTruthy();
    // El panel de permisos es del primero.
    expect(await screen.findByText("Permisos de")).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r1/permissions"));

    fireEvent.keyDown(roleCard("comprador"), { key: "Tab" });
    expect(call).not.toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r2/permissions");
    fireEvent.keyDown(roleCard("comprador"), { key: "Enter" });
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r2/permissions"));
    // Y con el ratón, de vuelta al primero.
    const sellerFetches = () =>
      call.mock.calls.filter(([path]) => path === "/orgs/o/projects/p1/roles/r1/permissions").length;
    const before = sellerFetches();
    fireEvent.click(roleCard("vendedor"));
    await waitFor(() => expect(sellerFetches()).toBeGreaterThan(before));
  });

  test("mientras se guarda un rol el botón lo dice y no deja repetir", async () => {
    draw({ write: () => new Promise(() => {}) });
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(within(roleCard("vendedor")).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    const pending = await within(dialog).findByRole("button", { name: "Guardando…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });

  test("crear un rol manda nombre, descripción, color y aislamiento, y lo deja elegido", async () => {
    const created = role({ id: "r3", name: "admin" });
    let roles = [seller, buyer];
    draw({
      roles: () => Promise.resolve(roles),
      write: (path, options) => {
        roles = [seller, buyer, created];
        return Promise.resolve(path.endsWith("/roles") && options.method === "POST" ? created : {});
      },
    });
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(button("+ Nuevo rol"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Nuevo rol")).toBeTruthy();
    const create = within(dialog).getByRole("button", { name: "Crear rol" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(within(dialog).getByPlaceholderText("vendedor"), { target: { value: " admin " } });
    fireEvent.change(within(dialog).getByPlaceholderText("Gestiona su catálogo y sus pedidos"), {
      target: { value: "Todo" },
    });
    fireEvent.click(within(dialog).getByLabelText("Color #10b981"));
    expect(within(dialog).getByLabelText("Color #10b981").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(create);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles", {
        method: "POST",
        body: { name: "admin", description: "Todo", color: "#10b981", sameRoleDataIsolation: true },
      }),
    );
    expect(await screen.findByText("Rol «admin» creado")).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r3/permissions"));
  });

  test("un nuevo rol propone el siguiente color de la paleta y se envía con Enter", async () => {
    draw();
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(button("+ Nuevo rol"));
    const dialog = await screen.findByRole("dialog");
    // Dos roles: el tercero de la paleta.
    expect(within(dialog).getByLabelText("Color #ec4899").getAttribute("aria-pressed")).toBe("true");
    const name = within(dialog).getByPlaceholderText("vendedor");
    fireEvent.change(name, { target: { value: "soporte" } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles", expect.objectContaining({ method: "POST" })),
    );
  });

  test("editar manda un PATCH, y los errores de campo van junto al campo", async () => {
    draw({
      write: () =>
        Promise.reject(
          new ApiError(422, {
            type: "about:blank",
            title: "Unprocessable",
            status: 422,
            detail: "inválido",
            errors: [{ field: "name", detail: "Ya hay un rol con ese nombre" }],
          }),
        ),
    });
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(within(roleCard("vendedor")).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Editar rol")).toBeTruthy();
    expect(within(dialog).getByText(/Renombrarlo renombra su credencial/)).toBeTruthy();
    const name = within(dialog).getByPlaceholderText("vendedor") as HTMLInputElement;
    expect(name.value).toBe("vendedor");
    fireEvent.change(name, { target: { value: "comprador" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r1", {
        method: "PATCH",
        body: { name: "comprador", description: "Gestiona su catálogo", color: "#6366f1", sameRoleDataIsolation: true },
      }),
    );
    expect(await within(dialog).findByText("Ya hay un rol con ese nombre")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("un error sin campo se enseña bajo el formulario, y guardar bien avisa", async () => {
    let fail = true;
    draw({ write: () => (fail ? Promise.reject(new Error("sin conexión")) : Promise.resolve(seller)) });
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(within(roleCard("vendedor")).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByText("sin conexión")).toBeTruthy();

    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Rol guardado")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("borrar pide confirmación nombrando el rol y avisa al terminar", async () => {
    draw();
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(within(roleCard("comprador")).getByRole("button", { name: "Eliminar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/«comprador» sale de la matriz/)).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), { method: "DELETE" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r2", { method: "DELETE" }));
    expect(await screen.findByText("Rol «comprador» eliminado")).toBeTruthy();
  });

  test("si borrar falla, se dice con un aviso", async () => {
    draw({ write: () => Promise.reject(new Error("no se puede")) });
    await screen.findByText("Gestiona su catálogo");
    fireEvent.click(within(roleCard("vendedor")).getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("no se puede")).toBeTruthy();
    // Cerrar el diálogo sin borrar.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("los permisos se agrupan por carpetas y solo se manda lo que cambió", async () => {
    draw({ permissions: [{ endpointId: "a", access: "allow", dataScope: "all" }] });
    await screen.findByLabelText("Acceso a GET /orders");
    expect(screen.getByText("contrato")).toBeTruthy();
    expect(screen.getByText("archivado")).toBeTruthy();
    expect(screen.getByText("inactivo")).toBeTruthy();
    expect(screen.getByText("versión")).toBeTruthy();

    // Una carpeta con uno permitido y otro sin decidir es «mixto».
    expect(select("Acceso a orders").value).toBe("mixed");
    expect(select("Acceso a GET /orders").value).toBe("allow");
    // El alcance de datos solo se decide sobre lo permitido.
    expect(select("Datos en POST /orders").disabled).toBe(true);
    expect(select("Datos en GET /orders").disabled).toBe(false);
    expect(button("Guardar permisos").disabled).toBe(true);

    fireEvent.change(select("Acceso a orders"), { target: { value: "allow" } });
    expect(select("Acceso a POST /orders").value).toBe("allow");
    fireEvent.change(select("Datos en orders"), { target: { value: "own" } });
    expect(select("Datos en GET /orders").value).toBe("own");
    fireEvent.change(select("Acceso a GET /v1/users"), { target: { value: "deny" } });
    expect(screen.getByText("3 cambios sin guardar")).toBeTruthy();

    fireEvent.click(button("Guardar permisos"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/roles/r1/permissions", {
        method: "PUT",
        body: {
          permissions: [
            { endpointId: "a", access: "allow", dataScope: "own" },
            { endpointId: "b", access: "allow", dataScope: "own" },
            { endpointId: "c", access: "deny", dataScope: "all" },
          ],
        },
      }),
    );
    expect(await screen.findByText("Permisos de «vendedor» guardados")).toBeTruthy();
  });

  test("una carpeta con alcances distintos en lo permitido dice «Mixto» hasta que se elige uno", async () => {
    draw({
      permissions: [
        { endpointId: "a", access: "allow", dataScope: "all" },
        { endpointId: "b", access: "allow", dataScope: "own" },
      ],
    });
    await screen.findByLabelText("Acceso a GET /orders");
    const folder = select("Datos en orders");
    expect(folder.value).toBe("mixed");
    const mixed = Array.from(folder.options).find((option) => option.value === "mixed")!;
    expect(mixed.textContent).toBe("Mixto");
    expect(mixed.disabled).toBe(true);
    fireEvent.change(folder, { target: { value: "none" } });
    expect(select("Datos en GET /orders").value).toBe("none");
    expect(select("Datos en POST /orders").value).toBe("none");
    expect(Array.from(select("Datos en orders").options).some((option) => option.value === "mixed")).toBe(false);
  });

  test("descartar vuelve a lo guardado, y un error al guardar se avisa", async () => {
    draw({ write: () => Promise.reject(new Error("permiso denegado")) });
    await screen.findByLabelText("Acceso a GET /orders");
    fireEvent.change(select("Datos en GET /orders"), { target: { value: "none" } });
    // Sin permitir, el alcance no cuenta como cambio.
    expect(screen.queryByText(/sin guardar/)).toBeNull();
    fireEvent.change(select("Acceso a GET /orders"), { target: { value: "deny" } });
    expect(screen.getByText("1 cambio sin guardar")).toBeTruthy();
    const panel = screen.getByText("Permisos de").closest("div")!.parentElement as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Descartar" }));
    expect(select("Acceso a GET /orders").value).toBe("undecided");

    fireEvent.change(select("Acceso a GET /orders"), { target: { value: "allow" } });
    fireEvent.click(button("Guardar permisos"));
    expect(await screen.findByText("permiso denegado")).toBeTruthy();
  });

  test("filtrar y plegar carpetas", async () => {
    draw();
    await screen.findByLabelText("Acceso a GET /orders");
    fireEvent.click(button("Cerrar orders"));
    expect(screen.queryByLabelText("Acceso a GET /orders")).toBeNull();
    fireEvent.click(button("Abrir orders"));
    expect(screen.getByLabelText("Acceso a GET /orders")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filtrar endpoints"), { target: { value: "post" } });
    expect(screen.getByLabelText("Acceso a POST /orders")).toBeTruthy();
    expect(screen.queryByLabelText("Acceso a GET /orders")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filtrar endpoints"), { target: { value: "/nada" } });
    expect(screen.getByText("Ningún endpoint coincide.")).toBeTruthy();
  });

  test("un proyecto sin endpoints lo dice", async () => {
    draw({ endpoints: { ...endpoints, data: [] } });
    expect(await screen.findByText("Este proyecto no tiene endpoints todavía.")).toBeTruthy();
  });

  test("las reglas entre roles se conmutan y se guardan enteras", async () => {
    draw({ rules: [{ sourceRoleId: "r2", targetRoleId: "r1", canRead: true, canWrite: false, canDelete: false }] });
    const read = await screen.findByLabelText("vendedor leer datos de comprador");
    await waitFor(() => expect(read.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("aislado")).toBeTruthy();
    expect(button("Guardar reglas").disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("comprador borrar datos de vendedor"));
    fireEvent.click(read);
    expect(read.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Guardar reglas"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/role-rules", {
        method: "PUT",
        body: { rules: [{ sourceRoleId: "r1", targetRoleId: "r2", canRead: false, canWrite: false, canDelete: true }] },
      }),
    );
    expect(await screen.findByText("Reglas entre roles guardadas")).toBeTruthy();
  });

  test("descartar reglas vuelve a lo guardado, y un error al guardarlas se avisa", async () => {
    draw({
      rules: [{ sourceRoleId: "r2", targetRoleId: "r1", canRead: true, canWrite: false, canDelete: false }],
      write: () => Promise.reject(new Error("reglas rotas")),
    });
    const write = () => screen.getByLabelText("vendedor cambiar datos de comprador");
    // Las reglas guardadas ya están: lo que se toque después no lo pisa su llegada.
    const read = await screen.findByLabelText("vendedor leer datos de comprador");
    await waitFor(() => expect(read.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(write());
    expect(write().getAttribute("aria-pressed")).toBe("true");
    const actions = button("Guardar reglas").parentElement as HTMLElement;
    fireEvent.click(within(actions).getByRole("button", { name: "Descartar" }));
    expect(write().getAttribute("aria-pressed")).toBe("false");
    expect(button("Guardar reglas").disabled).toBe(true);

    fireEvent.click(write());
    fireEvent.click(button("Guardar reglas"));
    expect(await screen.findByText("reglas rotas")).toBeTruthy();
  });

  test("las credenciales por entorno dicen qué rol no tiene la suya", async () => {
    draw();
    expect(await screen.findByText("Credenciales por entorno")).toBeTruthy();
    const table = (await screen.findByText("staging")).closest("table") as HTMLElement;
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("con credencial")).toBeTruthy();
    expect(within(rows[2]).getByText("sin credencial")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gestionar entornos" }).getAttribute("href")).toBe(
      "/p/p1/settings/environments",
    );
  });

  test("sin entornos, las credenciales avisan de que no se puede ejercitar ningún rol", async () => {
    draw({ environments: [] });
    expect(await screen.findByText(/Sin entornos todavía: un rol no se puede ejercitar/)).toBeTruthy();
  });

  test("la parte de la matriz que no es de roles se edita abajo cuando hay sección de acceso", async () => {
    draw({
      config: {
        sections: { access: { data: { access: { roles: [] } }, configured: true, updatedAt: null } },
      },
    });
    const heading = await screen.findByText("Matriz del contrato: rechazos y casos entre roles");
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/operations"));

    // Guardarla vuelve a pedir la configuración, para que lo que se ve sea lo guardado.
    const card = heading.closest("div.overflow-hidden") as HTMLElement;
    if (!within(card).queryByRole("button", { name: "Guardar" })) fireEvent.click(heading);
    const configFetches = () => call.mock.calls.filter(([path]) => path === "/orgs/o/projects/p1/config").length;
    const before = configFetches();
    fireEvent.click(within(card).getByRole("button", { name: "Ver como JSON" }));
    fireEvent.change(card.querySelector("textarea")!, { target: { value: '{ "access": { "roles": [], "x": 1 } }' } });
    fireEvent.click(within(card).getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/config/access", {
        method: "PUT",
        body: { access: { roles: [], x: 1 } },
      }),
    );
    await waitFor(() => expect(configFetches()).toBeGreaterThan(before));
  });

  test("sin editor no se crea, edita ni guarda; sin admin no se borra", async () => {
    can.editor = false;
    can.admin = false;
    draw();
    await screen.findByLabelText("Acceso a GET /orders");
    expect(screen.queryByRole("button", { name: "+ Nuevo rol" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar permisos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar reglas" })).toBeNull();
    expect(select("Acceso a GET /orders").disabled).toBe(true);
    expect((screen.getByLabelText("vendedor leer datos de comprador") as HTMLButtonElement).disabled).toBe(true);
  });

  test("editor sin admin edita pero no borra", async () => {
    can.admin = false;
    draw();
    await screen.findByText("Gestiona su catálogo");
    expect(within(roleCard("vendedor")).getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(within(roleCard("vendedor")).queryByRole("button", { name: "Eliminar" })).toBeNull();
  });
});
