/**
 * El cuerpo GraphQL del editor.
 *
 * Lo que decide algo:
 *
 * - **El esquema se pide por «Enviar»**, con la consulta de introspección, y la lista de operaciones
 *   sale de lo que contestó el servidor.
 * - **Elegir una operación la escribe** con sus variables, y la operación escrita se valida contra el
 *   esquema.
 * - **Una introspección apagada se dice**, con el mensaje del servidor, y el SDL de un fichero es la
 *   salida.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { buildSchema, graphqlSync } from "graphql";
import { useState } from "react";

import GraphqlBodyEditor, { forgetSchemas } from "@/components/graphql-body-editor";
import { ToastProvider } from "@/components/toast";
import { INTROSPECTION_QUERY } from "@/lib/graphql-schema";
import type { SentRequestView } from "@/lib/types";

const SDL = `
  type User { id: ID! name: String }
  type Query { user(id: ID!): User  me: User }
  type Mutation { rename(name: String!): User }
`;

const answered = (body: unknown, status = 200): SentRequestView =>
  ({
    request: { method: "POST", url: "https://api.test/graphql", headers: {}, body: null },
    response: {
      status,
      headers: {},
      body: JSON.stringify(body),
      sizeBytes: 0,
      durationMs: 1,
      timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
    },
    error: null,
  }) as unknown as SentRequestView;

function Harness({
  introspect,
  method = "POST",
  variableNames = [],
}: {
  introspect: (query: string) => Promise<SentRequestView>;
  method?: string;
  variableNames?: string[];
}) {
  const [body, setBody] = useState({ text: "", variables: "" });
  return (
    <ToastProvider>
      <GraphqlBodyEditor
        query={body.text}
        variables={body.variables}
        onChange={(patch) => setBody((current) => ({ ...current, ...patch }))}
        variableNames={variableNames}
        disabled={false}
        method={method}
        schemaKey="https://api.test/graphql"
        introspect={introspect}
      />
    </ToastProvider>
  );
}

afterEach(() => forgetSchemas());

describe("el cuerpo GraphQL", () => {
  test("carga el esquema por introspección, elige una operación y la escribe con sus variables", async () => {
    const schema = buildSchema(SDL);
    const introspect = vi.fn(async (query: string) => answered(graphqlSync({ schema, source: query })));
    render(<Harness introspect={introspect} />);

    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText(/tipos · de introspección · no se guarda/)).toBeTruthy();
    expect(introspect).toHaveBeenCalledWith(INTROSPECTION_QUERY);

    fireEvent.click(screen.getByRole("button", { name: /^user/ }));
    const query = screen.getByLabelText("Operación GraphQL") as HTMLTextAreaElement;
    expect(query.value).toMatch(/^query User\(\$id: ID!\)/);
    expect(JSON.parse((screen.getByLabelText("Variables GraphQL") as HTMLTextAreaElement).value)).toEqual({ id: "" });
    expect(screen.queryByLabelText("Problemas de la operación")).toBeNull();

    // Un campo que no existe, contra el esquema cargado.
    fireEvent.change(query, { target: { value: "{ me { nombre } }" } });
    expect(screen.getByLabelText("Problemas de la operación").textContent).toMatch(/nombre/);
  });

  test("una introspección apagada se dice con el mensaje del servidor; el SDL de un fichero la sustituye", async () => {
    const introspect = vi.fn(async () => answered({ errors: [{ message: "introspection is disabled" }] }));
    render(<Harness introspect={introspect} />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("El servidor no dio su esquema: introspection is disabled")).toBeTruthy();

    // jsdom no implementa `Blob.text()`; el navegador sí.
    const file = Object.assign(new File([SDL], "schema.graphql", { type: "text/plain" }), { text: async () => SDL });
    fireEvent.change(screen.getByLabelText("Esquema desde fichero"), { target: { files: [file] } });
    expect(await screen.findByText(/de schema.graphql/)).toBeTruthy();
    expect(screen.getByText("Mutaciones")).toBeTruthy();
    expect(screen.queryByText(/introspection is disabled/)).toBeNull();
  });

  test("un estado que no es 2xx no se lee como esquema", async () => {
    render(<Harness introspect={async () => answered({ message: "no" }, 401)} />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("El servidor contestó 401 a la introspección")).toBeTruthy();
  });

  test("por GET se dice dónde va la operación, y una mutación avisa", async () => {
    render(<Harness introspect={vi.fn()} method="GET" />);
    expect(screen.getByText(/van en la query de la URL/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Operación GraphQL"), {
      target: { value: 'mutation { rename(name: "x") { id } }' },
    });
    await waitFor(() => expect(screen.getByText(/Una mutación por GET/)).toBeTruthy());
  });

  test("unas variables que no son un objeto se dicen mientras se escriben", () => {
    render(<Harness introspect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Variables GraphQL"), { target: { value: "[1]" } });
    expect(screen.getByText("Las variables tienen que ser un objeto JSON.")).toBeTruthy();
  });
});

/**
 * El autocompletado, montado: lo que ofrece en cada sitio está en `lib/graphql-suggestions`; aquí,
 * cuándo sale la lista, qué teclas se queda y que convive con la de `{{variables}}`.
 */
describe("el autocompletado de la operación", () => {
  async function mount(variableNames: string[] = [], withSchema = true) {
    render(<Harness introspect={vi.fn()} variableNames={variableNames} />);
    if (withSchema) {
      const file = Object.assign(new File([SDL], "schema.graphql"), { text: async () => SDL });
      fireEvent.change(screen.getByLabelText("Esquema desde fichero"), { target: { files: [file] } });
      await screen.findByText(/de schema.graphql/);
    }
    const field = screen.getByLabelText<HTMLTextAreaElement>("Operación GraphQL");
    /** El texto y el cursor, que es lo que el navegador deja; el seguimiento va al fotograma siguiente. */
    const type = async (text: string, caret = text.length) => {
      fireEvent.change(field, { target: { value: text } });
      field.setSelectionRange(caret, caret);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    };
    const list = () => screen.queryByLabelText("Sugerencias del esquema");
    const offered = () =>
      within(list()!)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    return { field, type, list, offered };
  }

  test("al escribir un campo ofrece los del tipo, con su tipo; las flechas eligen y Enter lo escribe", async () => {
    const { field, type, list, offered } = await mount();
    await type("{ us");
    expect(offered()).toEqual(["user"]);
    expect(list()!.textContent).toContain("User");

    await type("{ user(id: 1) { ");
    expect(list()).toBeNull();

    await type("{ user(id: 1) { n");
    expect(offered()).toEqual(["name", "__typename"]);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("{ user(id: 1) { name");
    expect(list()).toBeNull();
    expect(field.selectionStart).toBe(field.value.length);
  });

  test("dentro de `(` ofrece los argumentos; un clic escribe `nombre: `, y Escape cierra", async () => {
    const { field, type, list, offered } = await mount();
    await type("mutation { rename(");
    expect(offered()).toEqual(["name"]);
    fireEvent.mouseDown(screen.getByRole("button", { name: "name" }));
    expect(field.value).toBe("mutation { rename(name: ");

    await type("{ m");
    expect(offered()).toContain("me");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(list()).toBeNull();
    expect(field.value).toBe("{ m");
  });

  test("Tab acepta la resaltada y Ctrl+Espacio abre la lista sin haber escrito nada", async () => {
    const { field, type, offered } = await mount();
    await type("{ me { }", 7);
    fireEvent.keyDown(field, { key: " ", ctrlKey: true });
    expect(offered()).toEqual(expect.arrayContaining(["id", "name", "__typename"]));
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("{ me { name}");
  });

  test("sin esquema no ofrece nada", async () => {
    const { field, type, list } = await mount([], false);
    await type("{ us");
    fireEvent.keyDown(field, { key: " ", ctrlKey: true });
    expect(list()).toBeNull();
  });

  test("dentro de un `{{` manda la lista de variables del entorno, y la del esquema sigue después", async () => {
    const { field, type, list, offered } = await mount(["userId"]);
    await type("{ user(id: {{us");
    expect(list()).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("{ user(id: {{userId}}");

    await type("{ user(id: {{userId}}) { na");
    expect(offered()[0]).toBe("name");
  });
});
