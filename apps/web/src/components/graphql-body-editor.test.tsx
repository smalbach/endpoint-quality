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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
}: {
  introspect: (query: string) => Promise<SentRequestView>;
  method?: string;
}) {
  const [body, setBody] = useState({ text: "", variables: "" });
  return (
    <ToastProvider>
      <GraphqlBodyEditor
        query={body.text}
        variables={body.variables}
        onChange={(patch) => setBody((current) => ({ ...current, ...patch }))}
        variableNames={[]}
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
