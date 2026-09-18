import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EndpointEditor } from "@/components/endpoint-editor";
import { ToastProvider } from "@/components/toast";
import type { EndpointView, SentRequestView } from "@/lib/types";

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

const SENT: SentRequestView = {
  request: {
    method: "GET",
    url: "https://api.example.com/users/7",
    headers: { Authorization: "••••••••" },
    body: null,
  },
  response: {
    status: 201,
    headers: { "content-type": "application/json" },
    body: '{"id":7}',
    sizeBytes: 8,
    durationMs: 42,
    timing: { dnsMs: 0, ttfbMs: 40, downloadMs: 2 },
  },
  error: null,
  auth: "Token del proyecto",
  environment: null,
  scripts: {
    pre: null,
    post: {
      error: null,
      logs: [{ level: "log", text: "id recibido 7" }],
      tests: [
        { name: "responde 201", passed: true, message: null },
        { name: "id", passed: false, message: "se esperaba 8 y llegó 7" },
      ],
      environmentUpdates: ["lastId"],
      durationMs: 31,
    },
  },
  sessionToken: null,
  cookies: { sent: [], stored: [], rejected: [] },
};

function mount() {
  call.mockReset();
  call.mockImplementation(async (path: string) => {
    if (path === `${BASE}/endpoints/e1`) return VIEW;
    if (path === `${BASE}/environments`) return [];
    if (path === `${BASE}/endpoints/send`) return SENT;
    if (path === `${BASE}/session-token`) return { token: null };
    if (path === BASE)
      return {
        baseUrl: "https://api.example.com",
        auth: { type: "bearer", loginUrl: "", loginMethod: "", username: "", headerName: "" },
      };
    throw new Error(`sin respuesta para ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <EndpointEditor base={BASE} projectId="p" endpointId="e1" layout="inline" canEdit onSaved={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("el editor de endpoints", () => {
  test("cambiar la ruta añade su parámetro, conserva el valor del que sigue y marca cambios sin guardar", async () => {
    mount();
    const path = await screen.findByDisplayValue("/users/{id}");
    expect(screen.queryByLabelText("Cambios sin guardar")).toBeNull();

    fireEvent.change(path, { target: { value: "/users/{id}/posts/:postId" } });
    expect(screen.getByText("{postId}")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Valor de id").value).toBe("7");
    expect(screen.getByLabelText("Cambios sin guardar")).toBeDefined();
  });

  test("Enviar manda lo que hay en pantalla y enseña la respuesta indentada", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("201")).toBeDefined();
    expect(screen.getByText(/"id": 7/)).toBeDefined();
    expect(screen.getByText(/Token del proyecto/)).toBeDefined();

    const sent = call.mock.calls.find(([path]) => path === `${BASE}/endpoints/send`)!;
    const form = sent[1].body as FormData;
    const request = JSON.parse(form.get("request") as string);
    expect(request).toMatchObject({
      method: "GET",
      path: "/users/{id}",
      auth: { type: "inherit", params: {} },
      environmentId: null,
      preRequestScript: "",
      postResponseScript: "",
    });
    expect(request.pathParameters).toEqual([{ name: "id", value: "7" }]);
  });

  test("el modo GraphQL abre su editor y «Enviar» manda la operación y sus variables", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByRole("button", { name: "Body" }));
    fireEvent.click(screen.getByRole("button", { name: "GraphQL" }));
    // Se carga aparte: la primera vez tarda lo que tarda el import.
    const query = await screen.findByLabelText("Operación GraphQL");
    fireEvent.change(query, { target: { value: "{ me { id } }" } });
    fireEvent.change(screen.getByLabelText("Variables GraphQL"), { target: { value: '{"a": 1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(call.mock.calls.some(([path]) => path === `${BASE}/endpoints/send`)).toBe(true));
    const sent = call.mock.calls.find(([path]) => path === `${BASE}/endpoints/send`)!;
    const request = JSON.parse((sent[1].body as FormData).get("request") as string);
    expect(request.body).toMatchObject({ mode: "graphql", text: "{ me { id } }", variables: '{"a": 1}' });
  });

  test("la consola enseña lo que imprimió y probó cada script, y la cabecera cuenta las pruebas", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("1/2 pruebas")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^Consola/ }));
    expect(screen.getByText("Script posterior")).toBeDefined();
    expect(screen.getByText("id recibido 7")).toBeDefined();
    expect(screen.getByText(/se esperaba 8 y llegó 7/)).toBeDefined();
    expect(screen.getByText("Guardó en el entorno: lastId")).toBeDefined();
  });

  test("un fragmento se añade al final del script", async () => {
    mount();
    await screen.findByDisplayValue("/users/{id}");
    fireEvent.click(screen.getByRole("button", { name: "Scripts" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Estado 200" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Imprimir" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Script Post-response").value).toBe(
      'pm.test("responde 200", () => pm.response.to.have.status(200));\nconsole.log(pm.response.json());',
    );
    expect(screen.getByLabelText("Cambios sin guardar")).toBeDefined();
  });

  test("Ctrl+S guarda solo si hay cambios", async () => {
    mount();
    const path = await screen.findByDisplayValue("/users/{id}");
    fireEvent.keyDown(path, { key: "s", ctrlKey: true });
    expect(call.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);

    fireEvent.change(screen.getByLabelText("Descripción"), { target: { value: "Otro" } });
    fireEvent.keyDown(path, { key: "s", ctrlKey: true });
    await waitFor(() => expect(call.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
  });
});
