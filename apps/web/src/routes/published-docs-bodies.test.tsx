/**
 * La página publicada con todo lo que un endpoint puede traer: cada modo de cuerpo, cada
 * autenticación, GraphQL por GET, y la clave guardada en el navegador.
 *
 * Lo que se comprueba es el código que sale para pegar y lo que la página enseña al lado, que tienen
 * que decir lo mismo.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError } from "@/lib/api";
import { PublishedDocsPage, bodyWithPlaceholders } from "@/routes/published-docs";
import type { DocEndpointView, DocPageView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
}));

const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";

const endpoint = (patch: Partial<DocEndpointView> = {}): DocEndpointView => ({
  id: "e1",
  method: "POST",
  path: "/v1/pedidos",
  url: "https://api.ejemplo.com/v1/pedidos",
  description: "",
  tags: [],
  requiresAuth: false,
  auth: { type: "none", label: "Sin autenticación", detail: "", keyName: "", in: "header" },
  pathParameters: [],
  query: [],
  headers: [],
  body: null,
  examples: [],
  ...patch,
});

const page = (endpoints: DocEndpointView[], patch: Partial<DocPageView> = {}): DocPageView => ({
  title: "Pedidos",
  description: "",
  intro: "",
  baseUrl: "https://api.ejemplo.com",
  groups: [{ tag: "General", endpoints }],
  counts: { endpoints: endpoints.length, documented: 0, examples: 0 },
  generatedAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/docs/${PUBLIC_ID}`]}>
        <Routes>
          <Route path="/docs/:publicId" element={<PublishedDocsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** El fragmento de código del endpoint `id`, en el lenguaje elegido. */
const codeOf = (id: string) => document.getElementById(id)!.querySelectorAll("pre");
const snippet = (id: string) => {
  const blocks = codeOf(id);
  return blocks[blocks.length - 1]!.textContent ?? "";
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("los cuerpos en el código", () => {
  test("multipart, urlencoded, binario y texto crudo salen cada uno como es", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page([
        endpoint({
          id: "multi",
          body: {
            mode: "form-data",
            contentType: "multipart/form-data",
            text: "",
            fields: [
              { name: "nombre", value: "Ana", file: false },
              { name: "foto", value: "", file: true },
            ],
            masked: [],
          },
        }),
        endpoint({
          id: "form",
          body: {
            mode: "x-www-form-urlencoded",
            contentType: "application/x-www-form-urlencoded",
            text: "",
            fields: [{ name: "q", value: "rojo", file: false }],
            masked: [],
          },
        }),
        endpoint({
          id: "bin",
          body: { mode: "binary", contentType: "application/octet-stream", text: "", fields: [], masked: [] },
        }),
        endpoint({
          id: "xml",
          body: { mode: "raw", contentType: "application/xml", text: "<pedido/>", fields: [], masked: [] },
        }),
        endpoint({
          id: "json",
          body: { mode: "json", contentType: "application/json", text: '{"a":1}', fields: [], masked: [] },
        }),
      ]),
    );
    draw();
    await waitFor(() => expect(document.getElementById("multi")).toBeTruthy());

    // La página enseña los campos, y el fichero como fichero y no con un valor vacío.
    expect(screen.getByText("(un fichero)")).toBeTruthy();
    expect(document.getElementById("multi")!.textContent).toContain("nombre: Ana");
    expect(screen.getAllByText(/^Cuerpo ·/).length).toBe(5);

    expect(snippet("multi")).toContain("nombre=Ana");
    expect(snippet("multi")).toContain("foto=@");
    expect(snippet("form")).toContain("q=rojo");
    expect(snippet("bin")).toContain("el-fichero");
    expect(snippet("xml")).toContain("<pedido/>");
    expect(snippet("xml")).toContain("application/xml");
    // Sin campos tapados el JSON sale tal cual se escribió, sin reformatear.
    expect(snippet("json")).toContain('{"a":1}');
    // Sin descripción se dice, en vez de dejar el hueco.
    expect(screen.getAllByText("Sin descripción.").length).toBe(5);
  });

  test("una operación GraphQL por GET va en la URL, con sus variables tapadas como marcador", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page([
        endpoint({
          id: "gql-get",
          method: "GET",
          url: "https://api.ejemplo.com/graphql?v=1",
          body: {
            mode: "graphql",
            contentType: "application/json",
            text: "{ pedidos { id } }",
            fields: [],
            masked: ["token"],
            variables: '{"token":"••••••••"}',
          },
        }),
        endpoint({
          id: "gql-post",
          body: { mode: "graphql", contentType: "application/json", text: "{ ping }", fields: [], masked: [] },
        }),
        endpoint({
          id: "gql-head",
          method: "HEAD",
          url: "https://api.ejemplo.com/graphql",
          body: { mode: "graphql", contentType: "application/json", text: "{ ping }", fields: [], masked: [] },
        }),
      ]),
    );
    draw();
    await waitFor(() => expect(document.getElementById("gql-get")).toBeTruthy());

    const get = snippet("gql-get");
    // La URL ya traía `?`: lo que se añade va detrás de `&`.
    expect(get).toContain(`graphql?v=1&query=${encodeURIComponent("{ pedidos { id } }")}`);
    expect(get).toContain(`variables=${encodeURIComponent('{\n  "token": "{{token}}"\n}')}`);
    expect(get).not.toContain("--data");

    // Sin variables no se manda un `variables=` vacío.
    const head = snippet("gql-head");
    expect(head).toContain(`graphql?query=${encodeURIComponent("{ ping }")}`);
    expect(head).not.toContain("variables=");

    // Por POST, sin variables, la operación va en el cuerpo y sola.
    const post = snippet("gql-post");
    expect(post).toContain('"query": "{ ping }"');
    expect(post).not.toContain('"variables"');
  });

  test("bodyWithPlaceholders recorre las listas y sin nada tapado no toca el texto", () => {
    expect(JSON.parse(bodyWithPlaceholders('[{"password":"••••••••"},1]', ["password"]))).toEqual([
      { password: "{{password}}" },
      1,
    ]);
    expect(bodyWithPlaceholders('{ "a" : 1 }', [])).toBe('{ "a" : 1 }');
  });
});

describe("la autenticación en el código", () => {
  test("basic y digest piden usuario y contraseña; una API key dice dónde va", async () => {
    call.mockReset();
    call.mockResolvedValue(
      page([
        endpoint({
          id: "basic",
          method: "TRACE",
          auth: { type: "basic", label: "Basic", detail: "Usuario y contraseña.", keyName: "", in: "header" },
        }),
        endpoint({
          id: "digest",
          auth: { type: "digest", label: "Digest", detail: "", keyName: "", in: "header" },
        }),
        endpoint({
          id: "key-query",
          auth: { type: "apikey", label: "API key", detail: "", keyName: "api_key", in: "query" },
        }),
        endpoint({
          id: "key-header",
          auth: { type: "apikey", label: "API key", detail: "", keyName: "X-Key", in: "header" },
        }),
        endpoint({
          id: "key-sin-nombre",
          auth: { type: "apikey", label: "API key", detail: "", keyName: "", in: "header" },
        }),
      ]),
    );
    draw();
    await waitFor(() => expect(document.getElementById("basic")).toBeTruthy());

    // Un método sin tono propio sale igual, con el gris de los que no son de escritura.
    expect(document.getElementById("basic")!.querySelector("span")!.className).toContain("bg-slate-100");
    expect(snippet("basic")).toContain("{{usuario}}");
    expect(snippet("digest")).toContain("{{contraseña}}");

    expect(document.getElementById("key-query")!.textContent).toContain("Va en el parámetro api_key.");
    expect(snippet("key-query")).toContain("api_key={{clave}}");
    expect(document.getElementById("key-header")!.textContent).toContain("Va en la cabecera X-Key.");
    expect(snippet("key-header")).toContain("X-Key: {{clave}}");
    // Sin el nombre no se inventa un par.
    expect(snippet("key-sin-nombre")).not.toContain("{{clave}}");
  });
});

describe("la página", () => {
  test("la introducción sale, y el lenguaje del código se cambia y se copia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    call.mockReset();
    call.mockResolvedValue(page([endpoint({ id: "uno" })], { intro: "Empieza por aquí" }));
    draw();
    expect(await screen.findByText("Empieza por aquí")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Lenguaje"), { target: { value: "httpie" } });
    expect(snippet("uno")).toMatch(/^http /);
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith(snippet("uno"));
  });

  test("una clave guardada se manda sin pedirla, y la que funciona se guarda", async () => {
    window.localStorage.setItem(`eq.doc-key.${PUBLIC_ID}`, "guardada");
    call.mockReset();
    call.mockResolvedValue(page([endpoint()]));
    draw();
    await waitFor(() => expect(document.getElementById("e1")).toBeTruthy());
    expect(call).toHaveBeenCalledWith(`/shared/docs/${PUBLIC_ID}`, {
      headers: { "x-api-key": "guardada" },
      retryOnUnauthorized: false,
    });
  });

  test("una clave que no vale lo dice y se puede escribir otra", async () => {
    window.localStorage.setItem(`eq.doc-key.${PUBLIC_ID}`, "vieja");
    call.mockReset();
    call.mockImplementation((_path: string, options?: { headers?: Record<string, string> }) =>
      options?.headers?.["x-api-key"] === "nueva"
        ? Promise.resolve(page([endpoint()]))
        : Promise.reject(new ApiError(401, { type: "about:blank", title: "No", status: 401, detail: "No" })),
    );
    draw();
    expect(await screen.findByText("Esa clave no vale.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: "  nueva  " } });
    fireEvent.submit(screen.getByLabelText("Clave").closest("form")!);
    await waitFor(() => expect(document.getElementById("e1")).toBeTruthy());
    expect(window.localStorage.getItem(`eq.doc-key.${PUBLIC_ID}`)).toBe("nueva");
  });

  test("sin almacenamiento en el navegador la página funciona igual", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    call.mockReset();
    call.mockImplementation((_path: string, options?: { headers?: Record<string, string> }) =>
      options?.headers?.["x-api-key"]
        ? Promise.resolve(page([endpoint()]))
        : Promise.reject(new ApiError(401, { type: "about:blank", title: "No", status: 401, detail: "No" })),
    );
    draw();
    // Sin clave recordada la pide, y no dice que la guardada no vale: no había ninguna.
    await screen.findByLabelText("Clave");
    expect(screen.queryByText("Esa clave no vale.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(document.getElementById("e1")).toBeTruthy());
    expect(setItem).toHaveBeenCalled();
  });
});
