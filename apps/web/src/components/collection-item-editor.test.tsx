/**
 * El editor de lo que se esté mirando: una petición, una carpeta o la colección.
 *
 * Lo que fijan: cada pestaña edita lo suyo sin pisar las demás, el cuerpo cambia de modo llevándose
 * lo escrito, y el panel de respuesta enseña las cuatro caras de un envío —el cuerpo, las
 * cabeceras, los `pm.test` y la consola— además de lo que pasa cuando no hubo respuesta.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  BodyEditor,
  CollectionFolderEditor,
  CollectionRequestEditor,
  CollectionVariablesEditor,
  ResponsePanel,
} from "@/components/collection-item-editor";
import { newFolder, newRequest } from "@/lib/collections";
import type { CollectionItemView, EndpointBodyView, SentRequestView } from "@/lib/types";

const idle = { data: undefined, error: null, isPending: false };

const request = (patch: Partial<CollectionItemView> = {}): CollectionItemView => ({
  ...newRequest("Crear", "r1"),
  ...patch,
  request: {
    ...newRequest("Crear", "r1").request!,
    method: "POST",
    url: "{{baseUrl}}/things",
    headers: [{ name: "Accept", value: "application/json", enabled: true }],
    query: [{ name: "full", type: "string", required: false, description: "", value: "true", enabled: true }],
    ...(patch.request ?? {}),
  },
});

function drawRequest(over: Partial<Parameters<typeof CollectionRequestEditor>[0]> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  render(
    <CollectionRequestEditor
      item={request()}
      onChange={onChange}
      variables={["baseUrl"]}
      canEdit
      onSend={onSend}
      send={idle}
      {...over}
    />,
  );
  return { onChange, onSend };
}

describe("una petición", () => {
  test("el nombre, el método y la URL se editan y suben al padre", () => {
    const { onChange } = drawRequest();
    fireEvent.change(screen.getByLabelText("Nombre de la petición"), { target: { value: "Otro" } });
    expect(onChange.mock.calls[0][0].name).toBe("Otro");
    fireEvent.change(screen.getByLabelText("Método"), { target: { value: "PUT" } });
    expect(onChange.mock.calls[1][0].request.method).toBe("PUT");
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "{{baseUrl}}/otra" } });
    expect(onChange.mock.calls[2][0].request.url).toBe("{{baseUrl}}/otra");
  });

  test("«Enviar» no se ofrece sin URL", () => {
    drawRequest({ item: request({ request: { ...request().request!, url: "" } }) });
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("los params guardan query y variables de ruta por separado", () => {
    const { onChange } = drawRequest();
    const rows = screen.getAllByPlaceholderText("limit");
    fireEvent.change(rows[rows.length - 1], { target: { value: "limit" } });
    expect(onChange.mock.calls[0][0].request.query.at(-1)).toMatchObject({ name: "limit", enabled: true });

    const path = screen.getAllByPlaceholderText("id");
    fireEvent.change(path[path.length - 1], { target: { value: "id" } });
    expect(onChange.mock.calls[1][0].request.pathParameters).toEqual([
      { name: "id", type: "string", description: "", value: "" },
    ]);
  });

  test("las cabeceras se editan en su pestaña", () => {
    const { onChange } = drawRequest();
    fireEvent.click(screen.getByRole("button", { name: "Headers" }));
    const rows = screen.getAllByPlaceholderText("Accept");
    fireEvent.change(rows[rows.length - 1], { target: { value: "X-Tenant" } });
    expect(onChange.mock.calls[0][0].request.headers.at(-1)).toMatchObject({ name: "X-Tenant" });
  });

  test("la autenticación de la petición se elige en la suya", () => {
    const { onChange } = drawRequest();
    fireEvent.click(screen.getByRole("button", { name: "Auth" }));
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "bearer" } });
    expect(onChange.mock.calls[0][0].request.auth.type).toBe("bearer");
  });

  test("los scripts se guardan en el nodo, no en la petición", () => {
    const { onChange } = drawRequest();
    fireEvent.click(screen.getByRole("button", { name: "Scripts" }));
    fireEvent.change(screen.getByLabelText("Tests"), { target: { value: "pm.test('x', () => {})" } });
    expect(onChange.mock.calls[0][0].postResponseScript).toBe("pm.test('x', () => {})");
    fireEvent.change(screen.getByLabelText("Script previo"), { target: { value: "const a = 1" } });
    expect(onChange.mock.calls[1][0].preRequestScript).toBe("const a = 1");
  });

  test("el cuerpo se edita desde su pestaña, y mientras se envía el botón lo dice", () => {
    const { onChange } = drawRequest({ send: { ...idle, isPending: true } });
    expect(screen.getByRole("button", { name: "Enviando…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Body" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(onChange.mock.calls[0][0].request.body.mode).toBe("json");
  });

  test("quien solo mira no puede escribir nada", () => {
    drawRequest({ canEdit: false });
    expect((screen.getByLabelText("URL") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("el cuerpo", () => {
  const body = (patch: Partial<EndpointBodyView> = {}): EndpointBodyView => ({
    mode: "none",
    text: "",
    contentType: "text/plain",
    fields: [],
    ...patch,
  });

  test("sin cuerpo lo dice, y elegir un modo lo sube tal cual", () => {
    const onChange = vi.fn();
    render(<BodyEditor body={body()} disabled={false} onChange={onChange} />);
    expect(screen.getByText("Esta petición no manda cuerpo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(onChange.mock.calls[0][0].mode).toBe("json");
  });

  test("JSON y raw comparten el texto; raw además elige su Content-Type", () => {
    const onChange = vi.fn();
    const { rerender } = render(<BodyEditor body={body({ mode: "json", text: "{}" })} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Cuerpo"), { target: { value: '{"a":1}' } });
    expect(onChange.mock.calls[0][0].text).toBe('{"a":1}');

    rerender(<BodyEditor body={body({ mode: "raw", text: "hola" })} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue("text/plain"), { target: { value: "text/csv" } });
    expect(onChange.mock.calls[1][0].contentType).toBe("text/csv");
  });

  test("GraphQL edita la operación y sus variables por separado", () => {
    const onChange = vi.fn();
    render(<BodyEditor body={body({ mode: "graphql", text: "query { x }" })} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Operación GraphQL"), { target: { value: "query { y }" } });
    expect(onChange.mock.calls[0][0].text).toBe("query { y }");
    fireEvent.change(screen.getByLabelText("Variables GraphQL"), { target: { value: "{}" } });
    expect(onChange.mock.calls[1][0].variables).toBe("{}");
  });

  test("un formulario guarda sus filas como campos de texto", () => {
    const onChange = vi.fn();
    render(<BodyEditor body={body({ mode: "form-data" })} disabled={false} onChange={onChange} />);
    const rows = screen.getAllByPlaceholderText("campo");
    fireEvent.change(rows[rows.length - 1], { target: { value: "archivo" } });
    expect(onChange.mock.calls[0][0].fields).toEqual([{ name: "archivo", value: "", kind: "text", enabled: true }]);
  });
});

describe("una carpeta y la colección", () => {
  test("la carpeta edita nombre, descripción, autenticación y scripts", () => {
    const onChange = vi.fn();
    render(
      <CollectionFolderEditor item={newFolder("Carpeta", "f1")} onChange={onChange} variables={[]} canEdit />,
    );
    fireEvent.change(screen.getByDisplayValue("Carpeta"), { target: { value: "Otra" } });
    expect(onChange.mock.calls[0][0].name).toBe("Otra");
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "basic" } });
    expect(onChange.mock.calls[1][0].auth.type).toBe("basic");
    fireEvent.change(screen.getByLabelText("Script previo"), { target: { value: "x" } });
    expect(onChange.mock.calls[2][0].preRequestScript).toBe("x");
  });

  test("la descripción de una carpeta se guarda", () => {
    const onChange = vi.fn();
    render(<CollectionFolderEditor item={newFolder("Carpeta", "f1")} onChange={onChange} variables={[]} canEdit />);
    const description = screen.getAllByRole("textbox").find((node) => node.tagName === "TEXTAREA")!;
    fireEvent.change(description, { target: { value: "Lo que hace" } });
    expect(onChange.mock.calls[0][0].description).toBe("Lo que hace");
  });

  test("una carpeta sin bloque de autenticación empieza heredando", () => {
    const onChange = vi.fn();
    render(
      <CollectionFolderEditor
        item={{ ...newFolder("Carpeta", "f1"), auth: null }}
        onChange={onChange}
        variables={[]}
        canEdit
      />,
    );
    expect((screen.getByLabelText("Tipo") as HTMLSelectElement).value).toBe("inherit");
  });

  test("las variables de la colección se escriben en filas", () => {
    const onChange = vi.fn();
    render(
      <CollectionVariablesEditor
        variables={[{ key: "base", value: "https://api", enabled: true }]}
        disabled={false}
        onChange={onChange}
      />,
    );
    const rows = screen.getAllByPlaceholderText("baseUrl");
    fireEvent.change(rows[rows.length - 1], { target: { value: "token" } });
    expect(onChange.mock.calls[0][0].at(-1)).toEqual({ key: "token", value: "", enabled: true });
  });
});

describe("el panel de respuesta", () => {
  const sent = (patch: Partial<SentRequestView> = {}): SentRequestView => ({
    request: { method: "GET", url: "https://api/x", headers: {}, body: null },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      sizeBytes: 11,
      durationMs: 7,
      timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
    },
    error: null,
    auth: "—",
    environment: null,
    scripts: {
      pre: null,
      post: {
        error: null,
        logs: [{ level: "warn", text: "ojo" }],
        tests: [{ name: "va", passed: true, message: null }],
        environmentUpdates: [],
        visualization: null,
        durationMs: 1,
      },
    },
    sessionToken: null,
    cookies: { sent: [], stored: [], rejected: [] },
    variables: {},
    ...patch,
  });

  test("sin envío no enseña nada; mientras va, lo dice; si revienta, enseña el porqué", () => {
    const { rerender, container } = render(<ResponsePanel send={idle} />);
    expect(container.textContent).toBe("");
    rerender(<ResponsePanel send={{ ...idle, isPending: true }} />);
    expect(screen.getByText("Enviando…")).toBeTruthy();
    rerender(<ResponsePanel send={{ ...idle, error: new Error("se cayó") }} />);
    expect(screen.getByText("se cayó")).toBeTruthy();
  });

  test("con respuesta enseña estado, tiempo, tests y cada pestaña", () => {
    render(<ResponsePanel send={{ ...idle, data: sent() }} />);
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText("7 ms")).toBeTruthy();
    expect(screen.getByText("1/1 tests")).toBeTruthy();
    expect(screen.getByText('{"ok":true}')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cabeceras" }));
    expect(screen.getByText("content-type: application/json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByText(/✓ va/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Consola" }));
    expect(screen.getByText("[warn] ojo")).toBeTruthy();
  });

  test("un test rojo con su mensaje, y una consola vacía", () => {
    render(
      <ResponsePanel
        send={{
          ...idle,
          data: sent({
            scripts: {
              pre: null,
              post: {
                error: null,
                logs: [],
                tests: [{ name: "existe", passed: false, message: "esperaba 200" }],
                environmentUpdates: [],
                visualization: null,
                durationMs: 1,
              },
            },
          }),
        }}
      />,
    );
    expect(screen.getByText("0/1 tests")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByText(/✕ existe — esperaba 200/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Consola" }));
    expect(screen.getByText("—")).toBeTruthy();
  });

  test("sin respuesta y sin error propio, lo dice igual", () => {
    render(<ResponsePanel send={{ ...idle, data: sent({ response: null, error: null }) }} />);
    expect(screen.getByText("Sin respuesta")).toBeTruthy();
  });

  test("los logs del script previo también salen", () => {
    render(
      <ResponsePanel
        send={{
          ...idle,
          data: sent({
            scripts: {
              pre: { error: null, logs: [{ level: "log", text: "antes" }], tests: [], environmentUpdates: [], visualization: null, durationMs: 1 },
              post: null,
            },
          }),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Consola" }));
    expect(screen.getByText("[log] antes")).toBeTruthy();
  });

  test("sin respuesta enseña el error del envío, y sin tests lo dice", () => {
    render(
      <ResponsePanel
        send={{ ...idle, data: sent({ response: null, error: "no se pudo llegar", scripts: { pre: null, post: null } }) }}
      />,
    );
    expect(screen.getByText("no se pudo llegar")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByText("Esta petición no trae tests.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cabeceras" }));
    expect(screen.getByText("—")).toBeTruthy();
  });
});
