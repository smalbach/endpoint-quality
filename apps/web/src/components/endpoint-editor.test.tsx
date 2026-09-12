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
};

function mount() {
  call.mockReset();
  call.mockImplementation(async (path: string) => {
    if (path === `${BASE}/endpoints/e1`) return VIEW;
    if (path === `${BASE}/environments`) return [];
    if (path === `${BASE}/endpoints/send`) return SENT;
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
      auth: { mode: "inherit" },
      environmentId: null,
    });
    expect(request.pathParameters).toEqual([{ name: "id", value: "7" }]);
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
