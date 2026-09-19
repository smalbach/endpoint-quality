/**
 * El editor de endpoints, lo que el primer archivo de pruebas no recorre.
 *
 * Lo que se comprueba: crear uno nuevo (POST, no PATCH, y «Crear» en vez de «Guardar»); las filas
 * de query y cabeceras con su fila en blanco, su interruptor y el aviso de una cabecera con salto
 * de línea; cada modo de cuerpo —JSON que avisa si no parece JSON salvo por sus `{{variables}}`,
 * raw con su Content-Type, urlencoded, form-data con ficheros (y el que se rechaza), binario— y que
 * sin el fichero no se puede enviar; lo que «Heredar» dice que va a pasar según el proyecto y el
 * token de sesión; la pestaña Acceso; la ruta resuelta con las variables del entorno; los errores
 * de guardar y de enviar; y el panel de respuesta: sin respuesta, script previo que falla, token de
 * sesión capturado, pestañas de cabeceras, petición y cookies, y copiar.
 */
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { EndpointEditor } from "@/components/endpoint-editor";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type { EndpointView, Environment, SentRequestView, SessionTokenView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p";

const VIEW: EndpointView = {
  id: "e1",
  method: "GET",
  path: "/users/{id}",
  description: "Un usuario",
  pathParameters: [{ name: "id", type: "string", description: "", value: "7" }],
  query: [],
  headers: [],
  auth: { type: "inherit", params: {} },
  body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
  requiresAuth: true,
  tags: [],
  status: "active",
  origin: "manual",
  operationId: null,
  orderIndex: 0,
  preRequestScript: "",
  postResponseScript: "",
  createdAt: "",
  updatedAt: "",
  updatedBy: "",
  inContract: null,
};

const ENVIRONMENT: Environment = {
  id: "env1",
  name: "staging",
  baseUrl: "https://staging.example.com",
  specUrl: null,
  variables: {
    tenant: { initial: "acme", current: "", sensitive: false },
    token: { initial: "••••••••", current: "••••••••", sensitive: true },
  },
  disabledVariables: {},
  writesAllowed: false,
  authEnforced: false,
  active: true,
  credentials: [],
};

const SENT: SentRequestView = {
  request: {
    method: "GET",
    url: "https://api.example.com/users/7",
    headers: { Accept: "application/json" },
    body: '{"a":1}',
  },
  response: {
    status: 200,
    headers: { "content-type": "application/json", "x-id": "9" },
    body: '{"id":7}',
    sizeBytes: 8,
    durationMs: 42,
    timing: { dnsMs: 0, ttfbMs: 40, downloadMs: 2 },
  },
  error: null,
  auth: "Token del proyecto",
  environment: { id: "env1", name: "staging" } as SentRequestView["environment"],
  scripts: { pre: null, post: null },
  sessionToken: null,
  cookies: { sent: [], stored: [], rejected: [] },
};

type Setup = {
  endpointId?: string | null;
  view?: EndpointView;
  environments?: Environment[];
  project?: unknown;
  sessionToken?: SessionTokenView | null;
  send?: () => unknown;
  save?: () => unknown;
  endpointError?: boolean;
  onOpenFull?: () => void;
};

function mount(setup: Setup = {}) {
  const endpointId = setup.endpointId === undefined ? "e1" : setup.endpointId;
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === `${BASE}/endpoints/e1` && !options?.method) {
      if (setup.endpointError) throw new Error("No existe ese endpoint");
      return setup.view ?? VIEW;
    }
    if (path === `${BASE}/environments`) return setup.environments ?? [];
    if (path === `${BASE}/endpoints/send`) return setup.send ? setup.send() : SENT;
    if (path === `${BASE}/session-token`) return { token: setup.sessionToken ?? null };
    if (path === BASE)
      return (
        setup.project ?? {
          baseUrl: "https://api.example.com",
          auth: { type: "bearer", loginUrl: "", loginMethod: "", username: "", headerName: "" },
        }
      );
    if (options?.method === "PATCH" || options?.method === "POST") {
      if (setup.save) return setup.save();
      return { ...(setup.view ?? VIEW), id: "e9", ...(options.body as object) };
    }
    if (path.endsWith("/examples")) return { examples: [] };
    if (path.endsWith("/role-access")) return { roles: [] };
    if (path.includes("/cookies")) return { cookies: [] };
    if (path.endsWith("/activate")) return undefined;
    throw new Error(`sin respuesta para ${path}`);
  });
  const onSaved = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EndpointEditor
            base={BASE}
            projectId="p"
            endpointId={endpointId}
            layout="full"
            canEdit
            onSaved={onSaved}
            onOpenFull={setup.onOpenFull}
          />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onSaved };
}

const sentRequest = () => {
  const sent = call.mock.calls.find(([path]) => path === `${BASE}/endpoints/send`)!;
  return { request: JSON.parse((sent[1].body as FormData).get("request") as string), form: sent[1].body as FormData };
};

const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

describe("cargar y crear", () => {
  test("si el endpoint no se puede leer, se dice por qué", async () => {
    mount({ endpointError: true });
    expect(await screen.findByText("No existe ese endpoint")).toBeDefined();
  });

  test("uno nuevo se crea con POST y avisa como creado", async () => {
    const { onSaved } = mount({ endpointId: null });
    const path = await screen.findByDisplayValue("/");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Crear" }).disabled).toBe(true);
    fireEvent.change(path, { target: { value: "/widgets" } });
    fireEvent.change(screen.getByLabelText("Método"), { target: { value: "POST" } });
    fireEvent.click(screen.getByRole("button", { name: /Crear/ }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/endpoints`,
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ path: "/widgets", method: "POST" }),
        }),
      ),
    );
    expect(await screen.findByText("Endpoint creado")).toBeDefined();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ path: "/widgets" }), true);
  });

  test("uno nuevo no tiene permisos por rol que decidir hasta guardarse", async () => {
    mount({ endpointId: null });
    await screen.findByDisplayValue("/");
    tab("Acceso");
    expect(screen.getByText("Guarda el endpoint para decidir qué roles lo alcanzan.")).toBeDefined();
  });

  test("guardar un existente es PATCH y avisa como guardado", async () => {
    const { onSaved } = mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.change(screen.getByLabelText("Descripción"), { target: { value: "Otra" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/ }));
    expect(await screen.findByText("Endpoint guardado")).toBeDefined();
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), false);
    expect(screen.queryByLabelText("Cambios sin guardar")).toBeNull();
  });

  test("un rechazo al guardar enseña cada campo y el de la ruta debajo de ella", async () => {
    mount({
      save: () => {
        throw new ApiError(422, {
          type: "about:blank",
          title: "Inválido",
          status: 422,
          detail: "Hay campos inválidos",
          errors: [{ field: "path", detail: "La ruta empieza por /" }],
        });
      },
    });
    const path = await screen.findByDisplayValue("/users/{id}");
    fireEvent.change(path, { target: { value: "users" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/ }));
    expect(await screen.findByText("Hay campos inválidos: path — La ruta empieza por /")).toBeDefined();
    expect(screen.getByText("La ruta empieza por /")).toBeDefined();
  });

  test("«Abrir a pantalla completa» sale solo si hay dónde ir", async () => {
    const onOpenFull = vi.fn();
    mount({ onOpenFull });
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByLabelText("Abrir a pantalla completa"));
    expect(onOpenFull).toHaveBeenCalled();
  });
});

describe("parámetros, query y cabeceras", () => {
  test("el tipo, el valor y la descripción de un parámetro de ruta se editan y se envían", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.change(screen.getByLabelText("Tipo de id"), { target: { value: "uuid" } });
    fireEvent.change(screen.getByLabelText("Valor de id"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Descripción de id"), { target: { value: "El usuario" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect(sentRequest().request.pathParameters).toEqual([{ name: "id", value: "8" }]);
  });

  test("una ruta sin parámetros explica cómo declararlos", async () => {
    mount();
    const path = await screen.findByDisplayValue("/users/{id}");
    fireEvent.change(path, { target: { value: "/users" } });
    expect(screen.getByText(/La ruta no tiene parámetros/)).toBeDefined();
  });

  test("la fila en blanco de query se convierte en una al teclear, cuenta en la pestaña, y se apaga o se borra", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.change(screen.getByPlaceholderText("nombre"), { target: { value: "page" } });
    fireEvent.change(screen.getByLabelText("Valor de page"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Descripción de page"), { target: { value: "La página" } });
    expect(screen.getByRole("button", { name: "Params1" })).toBeDefined();
    // Y aparece otra fila en blanco debajo.
    expect(screen.getAllByPlaceholderText("nombre")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Enviar page"));
    expect(screen.getByRole("button", { name: "Params" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Enviar page"));

    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect(sentRequest().request.query).toEqual([
      expect.objectContaining({ name: "page", value: "2", enabled: true, description: "La página" }),
    ]);

    fireEvent.click(screen.getByLabelText("Eliminar page"));
    expect(screen.queryByLabelText("Valor de page")).toBeNull();
  });

  test("una cabecera con salto de línea se señala en su fila, y cuenta en la pestaña", async () => {
    // Un <input> no deja teclear un salto de línea; llega en uno guardado o importado.
    mount({ view: { ...VIEW, headers: [{ name: "X-Trace", value: "a\nb", enabled: true }] } });
    await screen.findByDisplayValue("/users/{id}");
    expect(screen.getByRole("button", { name: "Headers1" })).toBeDefined();
    tab("Headers");
    expect(screen.getByText("Una cabecera no lleva saltos de línea")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("nombre"), { target: { value: "Accept" } });
    expect(screen.getByRole("button", { name: "Headers2" })).toBeDefined();
  });

  test("la ruta con variables se enseña resuelta: conocida, secreta y desconocida", async () => {
    mount({ environments: [ENVIRONMENT] });
    const path = await screen.findByDisplayValue("/users/{id}");
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>("Entorno").value).toBe("env1"));
    fireEvent.change(path, { target: { value: "/{{tenant}}/{{token}}/{{nada}}" } });
    expect(screen.getByText("Resuelta:")).toBeDefined();
    expect(screen.getByText("acme")).toBeDefined();
    expect(screen.getByText("••••")).toBeDefined();
    expect(screen.getByTitle("No está definida en el entorno activo").textContent).toBe("{{nada}}");
  });

  test("sin URL base en ningún sitio se avisa de que no se podrá enviar", async () => {
    mount({ project: { baseUrl: "", auth: { type: "none" } } });
    await screen.findByDisplayValue("/users/{id}");
    expect(await screen.findByText(/No hay URL base/)).toBeDefined();
    expect(screen.getByText("Sin entornos · URL base del proyecto")).toBeDefined();
  });

  test("elegir otro entorno lo activa en el servidor", async () => {
    mount({ environments: [ENVIRONMENT, { ...ENVIRONMENT, id: "env2", name: "prod", active: false }] });
    await screen.findByDisplayValue("/users/{id}");
    const select = await screen.findByLabelText<HTMLSelectElement>("Entorno");
    await waitFor(() => expect(select.value).toBe("env1"));
    fireEvent.change(select, { target: { value: "env2" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/environments/env2/activate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("el cuerpo", () => {
  async function body() {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    tab("Body");
    expect(screen.getByText("Esta petición no lleva cuerpo.")).toBeDefined();
  }

  test("JSON avisa si no lo parece, pero no por sus {{variables}}", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const text = screen.getByLabelText("Cuerpo");
    fireEvent.change(text, { target: { value: '{"id": {{id}}}' } });
    expect(screen.queryByText("No parece JSON válido")).toBeNull();
    fireEvent.change(text, { target: { value: "{roto" } });
    expect(screen.getByText("No parece JSON válido")).toBeDefined();
    expect(screen.getByRole("button", { name: "Body•" })).toBeDefined();
  });

  test("raw lleva su Content-Type y se envía", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "raw" }));
    fireEvent.change(screen.getByLabelText("Content-Type"), { target: { value: "application/xml" } });
    fireEvent.change(screen.getByLabelText("Cuerpo"), { target: { value: "<a/>" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect(sentRequest().request.body).toMatchObject({ mode: "raw", contentType: "application/xml", text: "<a/>" });
  });

  test("urlencoded son filas de texto", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "x-www-form-urlencoded" }));
    fireEvent.change(screen.getByPlaceholderText("nombre"), { target: { value: "q" } });
    fireEvent.change(screen.getByLabelText("Valor de q"), { target: { value: "hola" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect(sentRequest().request.body.fields).toEqual([{ name: "q", value: "hola", enabled: true, kind: "text" }]);
  });

  test("form-data: un campo de fichero sin fichero no deja enviar; elegido, viaja en el formulario", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "form-data" }));
    fireEvent.change(screen.getByPlaceholderText("clave"), { target: { value: "doc" } });
    fireEvent.change(screen.getByLabelText("Valor de doc"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Tipo de doc"), { target: { value: "file" } });
    expect(screen.getByText("Elegir fichero…")).toBeDefined();
    expect(screen.getByText("Falta elegir el fichero de: doc.")).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enviar" }).disabled).toBe(true);

    // Un ejecutable se rechaza y no cuenta como elegido.
    fireEvent.change(screen.getByLabelText("Fichero de doc"), {
      target: { files: [new File(["x"], "malo.exe")] },
    });
    expect(await screen.findByText("malo.exe: No se admiten ficheros .exe")).toBeDefined();
    expect(screen.getByText("Falta elegir el fichero de: doc.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Fichero de doc"), {
      target: { files: [new File(["hola"], "a.txt", { type: "text/plain" })] },
    });
    expect(screen.getByText(/^a\.txt · /)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect((sentRequest().form.get("file:doc") as File).name).toBe("a.txt");
  });

  test("form-data: una fila sin clave pide la clave antes del fichero; apagar y quitar", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "form-data" }));
    fireEvent.change(screen.getByLabelText("Tipo de campo"), { target: { value: "file" } });
    expect(screen.getByText("Pon antes la clave")).toBeDefined();
    fireEvent.change(screen.getAllByLabelText("Clave")[0], { target: { value: "f" } });
    fireEvent.click(screen.getByLabelText("Enviar f"));
    expect(screen.getByLabelText<HTMLInputElement>("Enviar f").checked).toBe(false);
    fireEvent.click(screen.getByLabelText("Eliminar f"));
    expect(screen.queryByLabelText("Enviar f")).toBeNull();
  });

  test("GraphQL: «Cargar esquema» pregunta por el mismo envío, sin el script posterior", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "Scripts" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Estado 200" }));
    fireEvent.click(screen.getByRole("button", { name: /^Body/ }));
    fireEvent.click(screen.getByRole("button", { name: "GraphQL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cargar esquema" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    const { request } = sentRequest();
    expect(request.body.mode).toBe("graphql");
    expect(request.body.text).toContain("__schema");
    expect(request.postResponseScript).toBe("");
  });

  test("binario: sin fichero no se envía; con él, sale su nombre y su tipo", async () => {
    await body();
    fireEvent.click(screen.getByRole("button", { name: "binary" }));
    expect(screen.getByText("Haz clic para elegir el fichero que se envía como cuerpo")).toBeDefined();
    expect(screen.getByText("Falta elegir el fichero de: cuerpo binario.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Fichero binario"), { target: { files: [new File(["1"], "blob.bin")] } });
    expect(screen.getByText("blob.bin")).toBeDefined();
    expect(screen.getByText(/application\/octet-stream/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    expect((sentRequest().form.get("binary") as File).name).toBe("blob.bin");
  });
});

describe("lo que «Heredar» dice que va a pasar", () => {
  const auth = (patch: Record<string, string>) => ({
    baseUrl: "https://api.example.com",
    auth: { type: "none", loginUrl: "", loginMethod: "", username: "", headerName: "", ...patch },
  });

  test.each([
    [auth({ type: "bearer", loginUrl: "/login" }), null, "Login del proyecto (POST /login)"],
    [auth({ type: "bearer" }), null, "Bearer token del proyecto"],
    [auth({ type: "basic", username: "qa" }), null, "Basic auth del proyecto (qa)"],
    [auth({ type: "api_key" }), null, "API key del proyecto en X-API-Key"],
    [auth({ type: "none" }), null, "El proyecto no tiene autenticación"],
    [
      auth({ type: "bearer" }),
      { source: "login", expired: false, capturedAt: "", expiresAt: null, claims: null, preview: "" },
      "Token de sesión capturado del login. Sin él: Bearer token del proyecto",
    ],
    [
      auth({ type: "bearer" }),
      { source: "script", expired: false, capturedAt: "", expiresAt: null, claims: null, preview: "" },
      "Token de sesión capturado por un script. Sin él: Bearer token del proyecto",
    ],
  ])("%#: dice lo que de verdad pasará", async (project, sessionToken, expected) => {
    mount({ project, sessionToken: sessionToken as SessionTokenView | null });
    await screen.findByDisplayValue("/users/{id}");
    tab("Auth");
    expect(await screen.findByText(expected)).toBeDefined();
  });

  test("sin autenticación en el proyecto pero con entorno, se nombra su credencial primary", async () => {
    mount({ project: auth({ type: "none" }), environments: [ENVIRONMENT] });
    await screen.findByDisplayValue("/users/{id}");
    tab("Auth");
    expect(
      await screen.findByText(
        "El proyecto no tiene autenticación: se usa la credencial primary de «staging» si la hay",
      ),
    ).toBeDefined();
  });
});

describe("las pestañas Acceso, Ejemplos y Scripts", () => {
  test("visibilidad, estado y etiquetas se guardan", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    tab("Acceso");
    expect(screen.getByText(/Las pruebas de seguridad marcarán este endpoint/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^Público/ }));
    expect(screen.getByText(/Es público/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "archived" } });
    fireEvent.change(screen.getByLabelText("Etiquetas"), { target: { value: "critico, pagos" } });
    expect(await screen.findByText(/Este proyecto no tiene roles/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Guardar/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        `${BASE}/endpoints/e1`,
        expect.objectContaining({
          method: "PATCH",
          body: expect.objectContaining({ requiresAuth: false, status: "archived", tags: ["critico", "pagos"] }),
        }),
      ),
    );
  });

  test("Ejemplos pide los del endpoint", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    tab("Ejemplos");
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/endpoints/e1/examples`));
  });

  test("un fragmento previo se añade al script vacío tal cual", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    tab("Scripts");
    fireEvent.click(screen.getByRole("button", { name: "+ Marca de tiempo" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Script Pre-request").value).toBe(
      'pm.environment.set("timestamp", Date.now().toString());',
    );
    fireEvent.change(screen.getByLabelText("Script Pre-request"), { target: { value: "// nada" } });
    expect(screen.getByLabelText<HTMLTextAreaElement>("Script Pre-request").value).toBe("// nada");
  });
});

describe("la respuesta", () => {
  async function sendWith(send?: () => unknown, setup: Setup = {}) {
    mount({ ...setup, send });
    const path = await screen.findByDisplayValue("/users/{id}");
    fireEvent.keyDown(path, { key: "Enter", ctrlKey: true });
  }

  test("antes de enviar invita a hacerlo", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    expect(screen.getByText("Envía la petición para ver aquí la respuesta.")).toBeDefined();
  });

  test("Ctrl+Enter envía; las pestañas enseñan cabeceras y la petición, y «copiar» lo copia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await sendWith();
    expect(await screen.findByText("200")).toBeDefined();
    expect(screen.getByText("staging · Token del proyecto")).toBeDefined();

    tab("Cabeceras");
    expect(screen.getByText(/x-id: 9/)).toBeDefined();
    tab("Petición");
    expect(screen.getByText(/GET https:\/\/api.example.com\/users\/7/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "copiar" }));
    expect(await screen.findByRole("button", { name: "copiado" })).toBeDefined();
    expect(writeText).toHaveBeenCalledWith('GET https://api.example.com/users/7\nAccept: application/json\n\n{"a":1}');
  });

  test("si el portapapeles se niega, el botón sigue diciendo «copiar»", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    await sendWith();
    await screen.findByText("200");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "copiar" }));
    });
    expect(screen.getByRole("button", { name: "copiar" })).toBeDefined();
  });

  test("sin respuesta lo dice, y la consola sin scripts explica qué saldría ahí", async () => {
    await sendWith(() => ({ ...SENT, response: null, error: "ECONNREFUSED", environment: null }));
    expect(await screen.findByText("Sin respuesta: ECONNREFUSED")).toBeDefined();
    expect(screen.getByText("(sin cuerpo)")).toBeDefined();
    tab("Consola");
    expect(screen.getByText(/Sin scripts\./)).toBeDefined();
  });

  test("si el script previo falla, se abre la consola con su error", async () => {
    await sendWith(() => ({
      ...SENT,
      response: null,
      error: "El script previo falló",
      scripts: {
        pre: {
          error: "ReferenceError: x is not defined",
          logs: [],
          tests: [],
          environmentUpdates: [],
          visualization: null,
          durationMs: 3,
        },
        post: {
          error: null,
          logs: [],
          tests: [{ name: "ok", passed: true, message: null }],
          environmentUpdates: [],
          visualization: null,
          durationMs: 1,
        },
      },
    }));
    expect(await screen.findByText("ReferenceError: x is not defined")).toBeDefined();
    expect(screen.getByText("Script previo")).toBeDefined();
    expect(screen.getByText("1/1 pruebas", { selector: "span:not([class*='border'])" })).toBeDefined();
  });

  test("un script sin salida lo dice", async () => {
    await sendWith(() => ({
      ...SENT,
      scripts: {
        pre: {
          error: null,
          logs: [{ level: "warn", text: "ojo" }],
          tests: [],
          environmentUpdates: [],
          visualization: null,
          durationMs: 1,
        },
        post: { error: null, logs: [], tests: [], environmentUpdates: [], visualization: null, durationMs: 1 },
      },
    }));
    await screen.findByText("200");
    tab("Consola");
    expect(screen.getByText("ojo")).toBeDefined();
    expect(screen.getByText("Sin salida.")).toBeDefined();
  });

  test("un token de sesión capturado se anuncia según de dónde vino", async () => {
    await sendWith(() => ({ ...SENT, sessionToken: "login" }));
    expect(await screen.findByText("Token de sesión capturado del login")).toBeDefined();
  });

  test("capturado por un script también", async () => {
    await sendWith(() => ({ ...SENT, sessionToken: "script" }));
    expect(await screen.findByText("Token de sesión capturado por el script")).toBeDefined();
  });

  test("la pestaña Cookies cuenta y enseña las de la respuesta", async () => {
    await sendWith(() => ({
      ...SENT,
      cookies: {
        sent: [],
        stored: ["sid"],
        rejected: [{ line: "bad=1; Domain=otro.com", why: "dominio ajeno" }],
      },
    }));
    await screen.findByText("200");
    fireEvent.click(screen.getByRole("button", { name: "Cookies2" }));
    expect(screen.getByText("sid")).toBeDefined();
    expect(screen.getByText(/no se guardó: dominio ajeno/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "copiar" })).toBeNull();
  });
  test("un envío rechazado enseña el mensaje y el detalle de cada campo", async () => {
    await sendWith(() => {
      throw new ApiError(400, {
        type: "about:blank",
        title: "Bad",
        status: 400,
        detail: "Petición inválida",
        errors: [{ field: "path", detail: "Falta la URL base" }],
      });
    });
    expect(await screen.findByText("Petición inválida")).toBeDefined();
    expect(screen.getByText("Falta la URL base")).toBeDefined();
  });
});

describe("Código y Cookies", () => {
  test("«Código» abre los fragmentos y «Cookies» el tarro", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByRole("button", { name: "Código" }));
    expect(await screen.findByRole("dialog", { name: "Código" })).toBeDefined();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "Cookies" })[0]);
    expect(await screen.findByRole("dialog", { name: "Cookies" })).toBeDefined();
  });
});
