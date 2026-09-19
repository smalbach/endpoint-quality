/**
 * El resto del cuerpo GraphQL y de su autocompletado: una introspección que ni llegó o que reventó,
 * un fichero que no se eligió, un problema sin posición, buscar entre las operaciones, las
 * obsoletas y los argumentos opcionales; y de la lista de sugerencias, dónde se coloca en un cuadro
 * con tamaño, las teclas que la cierran o pasan de largo, el clic y la salida del cuadro.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import GraphqlBodyEditor, { forgetSchemas } from "@/components/graphql-body-editor";
import { ToastProvider } from "@/components/toast";
import type * as GraphqlSchema from "@/lib/graphql-schema";
import type { SentRequestView } from "@/lib/types";

// Los problemas de la operación los calcula la librería; aquí se puede pedir uno sin posición.
const queryProblems = vi.hoisted(() => ({ override: null as null | (() => unknown[]) }));
vi.mock("@/lib/graphql-schema", async (original) => {
  const actual = await original<typeof GraphqlSchema>();
  return {
    ...actual,
    queryProblems: (...args: Parameters<typeof actual.queryProblems>) =>
      queryProblems.override ? queryProblems.override() : actual.queryProblems(...args),
  };
});

const SDL = `
  type User { id: ID! name: String viejo: String @deprecated(reason: "usa name") }
  type Query { user(id: ID!, lang: String): User  me: User  antiguo: User @deprecated }
  type Mutation { rename(name: String!): User }
`;

function Harness({ introspect = vi.fn() }: { introspect?: (query: string) => Promise<SentRequestView> }) {
  const [body, setBody] = useState({ text: "", variables: "" });
  return (
    <ToastProvider>
      <GraphqlBodyEditor
        query={body.text}
        variables={body.variables}
        onChange={(patch) => setBody((current) => ({ ...current, ...patch }))}
        variableNames={[]}
        disabled={false}
        method="POST"
        schemaKey="https://api.test/graphql"
        introspect={introspect}
      />
    </ToastProvider>
  );
}

afterEach(() => {
  forgetSchemas();
  queryProblems.override = null;
  vi.useRealTimers();
});

async function withSchema() {
  render(<Harness />);
  const file = Object.assign(new File([SDL], "schema.graphql"), { text: async () => SDL });
  fireEvent.change(screen.getByLabelText("Esquema desde fichero"), { target: { files: [file] } });
  await screen.findByText(/de schema.graphql/);
}

describe("cargar el esquema", () => {
  test("una introspección que no llegó al servidor dice por qué, o lo dice en general", async () => {
    const introspect = vi
      .fn()
      .mockResolvedValueOnce({ response: null, error: "ECONNREFUSED" })
      .mockResolvedValueOnce({ response: null, error: null });
    render(<Harness introspect={introspect} />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("ECONNREFUSED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("La introspección no llegó al servidor")).toBeTruthy();
  });

  test("una introspección que revienta se cuenta, con su mensaje o sin él", async () => {
    const introspect = vi.fn().mockRejectedValueOnce(new Error("abortada")).mockRejectedValueOnce("raro");
    render(<Harness introspect={introspect} />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("abortada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cargar esquema" }));
    expect(await screen.findByText("La introspección falló")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cargar esquema" })).toBeTruthy();
  });

  test("cancelar el selector de fichero no cambia nada", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Esquema desde fichero"), { target: { files: [] } });
    expect(screen.getByText(/Con el esquema, la operación se valida/)).toBeTruthy();
  });
});

describe("la operación y la lista de operaciones", () => {
  test("un problema sin posición se dice sin «Línea»", () => {
    queryProblems.override = () => [{ message: "algo sin sitio", line: null, column: null }];
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Operación GraphQL"), { target: { value: "{ me }" } });
    expect(screen.getByLabelText("Problemas de la operación").textContent).toBe("algo sin sitio");
  });

  test("se busca por nombre; la obsoleta va tachada y el argumento opcional sin «!»", async () => {
    await withSchema();
    const aside = screen.getByRole("complementary", { name: "Esquema" });
    expect(within(aside).getByRole("button", { name: "antiguo" }).className).toContain("line-through");
    expect(within(aside).getByRole("button", { name: /^user/ }).textContent).toBe("user(id!, lang)");
    fireEvent.change(screen.getByLabelText("Buscar operación"), { target: { value: "REN" } });
    expect(within(aside).queryByRole("button", { name: /^user/ })).toBeNull();
    expect(within(aside).getByRole("button", { name: /^rename/ })).toBeTruthy();
    expect(within(aside).queryByText("Consultas")).toBeNull();
  });
});

describe("la lista de sugerencias", () => {
  async function mount() {
    await withSchema();
    const field = screen.getByLabelText<HTMLTextAreaElement>("Operación GraphQL");
    const type = async (text: string, caret = text.length) => {
      fireEvent.change(field, { target: { value: text } });
      field.setSelectionRange(caret, caret);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    };
    const list = () => screen.queryByLabelText("Sugerencias del esquema");
    return { field, type, list };
  }

  test("en un cuadro con tamaño se queda dentro: ni por debajo ni más a la derecha de lo que cabe", async () => {
    const { field, type, list } = await mount();
    Object.defineProperty(field, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(field, "clientWidth", { configurable: true, value: 400 });
    await type(`${"\n".repeat(9)}{ me { ${" ".repeat(60)}n`);
    expect(list()!.style.top).toBe("100px");
    expect(list()!.style.left).toBe("112px");
  });

  test("la resaltada se lleva a la vista al moverse, y ArrowUp da la vuelta", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { field, type, list } = await mount();
    await type("{ user(id: 1) { n");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    const buttons = within(list()!).getAllByRole("button");
    expect(buttons.at(-1)!.className).toContain("bg-slate-900");
    // @ts-expect-error -- jsdom no lo trae; se quita para dejarlo como estaba.
    delete Element.prototype.scrollIntoView;
  });

  test("una obsoleta se ofrece tachada", async () => {
    const { type, list } = await mount();
    // El motor sólo ofrece una obsoleta cuando no queda ninguna otra cerca de lo escrito.
    await type("{ me { viej");
    expect(within(list()!).getByText("viejo").className).toContain("line-through");
  });

  test("mover el cursor a los lados la cierra; otra tecla la deja y pasa", async () => {
    const { field, type, list } = await mount();
    await type("{ m");
    fireEvent.keyDown(field, { key: "a" });
    expect(list()).not.toBeNull();
    fireEvent.keyDown(field, { key: "ArrowLeft" });
    expect(list()).toBeNull();
  });

  test("abierta sin nada nuevo que ofrecer, mover el cursor la cierra y escribir no la abre", async () => {
    const { field, type, list } = await mount();
    // Lo único que ofrece es lo ya escrito: está abierta pero no se enseña.
    await type("{ me { id");
    expect(list()).toBeNull();
    fireEvent.keyDown(field, { key: "x" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.value).toBe("{ me { id");
  });

  test("un clic en el cuadro la cierra", async () => {
    const { field, type, list } = await mount();
    await type("{ m");
    fireEvent.click(field);
    expect(list()).toBeNull();
  });

  test("salir del cuadro la cierra un momento después, para que el clic en una sugerencia llegue", async () => {
    const { field, type, list } = await mount();
    await type("{ m");
    vi.useFakeTimers();
    fireEvent.blur(field);
    expect(list()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(list()).toBeNull();
  });
});
