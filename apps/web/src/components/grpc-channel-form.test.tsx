/**
 * El formulario de un canal gRPC.
 *
 * Lo que decide algo:
 *
 * - **El selector sale de la definición leída**: servicios y métodos del `.proto` guardado, con la
 *   forma de cada llamada dicha en palabras, y el método depende del servicio.
 * - **«Generar ejemplo» escribe el ejemplo que calculó el servidor** para el tipo de entrada.
 * - **Subir `.proto` los manda juntos**, con la ruta que nombran los `import`.
 * - **La reflexión se pide con el entorno activo**, y sus servicios alimentan el mismo selector.
 */
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GrpcChannelForm, callKind } from "@/components/grpc-channel-form";
import type { GrpcSchemaView, GrpcSettingsView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const method = (name: string, patch: Partial<GrpcSchemaView["services"][number]["methods"][number]> = {}) => ({
  name,
  requestType: "demo.v1.GetItemRequest",
  responseType: "demo.v1.Item",
  clientStreaming: false,
  serverStreaming: false,
  readOnly: false,
  example: "{}",
  ...patch,
});

const SCHEMA: GrpcSchemaView = {
  files: [
    { path: "protos/common/money.proto", bytes: 80 },
    { path: "protos/demo/v1/shop.proto", bytes: 600 },
  ],
  services: [
    {
      name: "demo.v1.Shop",
      methods: [
        method("GetItem", { readOnly: true, example: '{\n  "item_id": "",\n  "count": 0\n}' }),
        method("Chat", { clientStreaming: true, serverStreaming: true }),
      ],
    },
    { name: "demo.v1.Admin", methods: [method("Purge")] },
  ],
  problem: null,
};

const START: GrpcSettingsView = { source: "proto", service: "", method: "", message: "{}", deadlineMs: null };

function show(initial: GrpcSettingsView = START, environmentId: string | null = "env-1") {
  const seen: GrpcSettingsView[] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <GrpcChannelForm
        base="/orgs/o/projects/p1"
        channelId="c1"
        value={value}
        onChange={(next) => {
          seen.push(next);
          setValue(next);
        }}
        canEdit
        environmentId={environmentId}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return seen;
}

describe("el formulario de un canal gRPC", () => {
  test("el selector de métodos sale del .proto leído, y el ejemplo se escribe en el mensaje", async () => {
    call.mockReset();
    call.mockResolvedValue(SCHEMA);
    const seen = show();

    const [service, methodSelect] = screen.getAllByRole("combobox");
    await waitFor(() => expect(screen.getByRole("option", { name: "demo.v1.Shop" })).toBeTruthy());
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/grpc");
    expect(screen.getByText("protos/common/money.proto · protos/demo/v1/shop.proto")).toBeTruthy();
    // Sin servicio no hay métodos que elegir, ni ejemplo que generar.
    expect(screen.queryByRole("option", { name: /GetItem/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Generar ejemplo" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(service, { target: { value: "demo.v1.Shop" } });
    expect(screen.getByRole("option", { name: "GetItem (unaria)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Chat (bidireccional)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Purge/ })).toBeNull();

    fireEvent.change(methodSelect, { target: { value: "GetItem" } });
    expect(screen.getByText("unaria · demo.v1.GetItemRequest → demo.v1.Item")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generar ejemplo" }));

    expect(seen.at(-1)).toEqual({
      source: "proto",
      service: "demo.v1.Shop",
      method: "GetItem",
      message: '{\n  "item_id": "",\n  "count": 0\n}',
      deadlineMs: null,
    });
    expect((screen.getByLabelText("Mensaje de la petición") as HTMLTextAreaElement).value).toContain('"item_id"');
  });

  test("cambiar de servicio olvida el método, que era de otro", async () => {
    call.mockReset();
    call.mockResolvedValue(SCHEMA);
    const seen = show({ ...START, service: "demo.v1.Shop", method: "Chat" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Chat (bidireccional)" })).toBeTruthy());
    expect(screen.getByText(/recibe un stream: tras invocar/)).toBeTruthy();
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "demo.v1.Admin" } });
    expect(seen.at(-1)).toMatchObject({ service: "demo.v1.Admin", method: "" });
  });

  test("subir .proto los manda juntos, con su contenido, y el selector se rehace con lo leído", async () => {
    call.mockReset();
    call.mockImplementation(async (_path: string, options?: { method?: string }) =>
      options?.method === "PUT" ? SCHEMA : { files: [], services: [], problem: null },
    );
    show();
    await waitFor(() => expect(screen.getByText("Ningún .proto todavía.")).toBeTruthy());
    const shop = new File(['syntax = "proto3";'], "shop.proto");
    const money = new File(['syntax = "proto3"; package common;'], "money.proto");
    fireEvent.change(screen.getByLabelText("Ficheros .proto"), { target: { files: [shop, money] } });

    await waitFor(() => expect(screen.getByRole("option", { name: "demo.v1.Shop" })).toBeTruthy());
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/grpc/protos", {
      method: "PUT",
      body: {
        files: [
          { path: "shop.proto", content: 'syntax = "proto3";' },
          { path: "money.proto", content: 'syntax = "proto3"; package common;' },
        ],
      },
    });
  });

  test("con reflexión, los servicios se piden al servidor con el entorno activo", async () => {
    call.mockReset();
    call.mockImplementation(async (path: string) =>
      path.endsWith("/reflection") ? { ...SCHEMA, files: [] } : { files: [], services: [], problem: null },
    );
    show({ ...START, source: "reflection" });
    fireEvent.click(screen.getByRole("button", { name: "Cargar servicios" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "demo.v1.Shop" })).toBeTruthy());
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/grpc/reflection", {
      method: "POST",
      body: { environmentId: "env-1" },
    });
  });

  test("cada forma de llamada tiene su nombre", () => {
    expect(
      [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ].map(([clientStreaming, serverStreaming]) => callKind({ clientStreaming, serverStreaming })),
    ).toEqual(["unaria", "stream de servidor", "stream de cliente", "bidireccional"]);
  });

  test("el mensaje y el plazo se escriben; un plazo vacío es «sin plazo»", async () => {
    call.mockReset();
    call.mockResolvedValue(SCHEMA);
    const seen = show();
    fireEvent.change(screen.getByLabelText("Mensaje de la petición"), { target: { value: '{"a":1}' } });
    expect(seen.at(-1)!.message).toBe('{"a":1}');
    const deadline = screen.getByRole("spinbutton");
    fireEvent.change(deadline, { target: { value: "1500" } });
    expect(seen.at(-1)!.deadlineMs).toBe(1500);
    fireEvent.change(deadline, { target: { value: "" } });
    expect(seen.at(-1)!.deadlineMs).toBeNull();
  });

  test("los problemas que devolvió «Guardar» salen junto a su campo", async () => {
    call.mockReset();
    call.mockResolvedValue(SCHEMA);
    const problems: Record<string, string> = {
      "grpc.service": "Elige un servicio",
      "grpc.method": "Elige un método",
      "grpc.message": "El mensaje no es JSON",
      "grpc.deadlineMs": "Tiene que ser positivo",
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GrpcChannelForm
          base="/orgs/o/projects/p1"
          channelId="c1"
          value={START}
          onChange={vi.fn()}
          canEdit
          environmentId={null}
          problemOf={(field) => problems[field]}
        />
      </QueryClientProvider>,
    );
    for (const text of Object.values(problems)) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  });

  test("elegir la reflexión cambia la fuente", async () => {
    call.mockReset();
    call.mockResolvedValue(SCHEMA);
    const seen = show();
    fireEvent.click(screen.getByRole("radio", { name: "Reflexión del servidor" }));
    expect(seen.at(-1)!.source).toBe("reflection");
    expect(screen.getByRole("button", { name: "Cargar servicios" })).toBeTruthy();
  });

  test("un .proto guardado que no se puede leer dice por qué", async () => {
    call.mockReset();
    call.mockResolvedValue({
      files: [{ path: "roto.proto", bytes: 3 }],
      services: [],
      problem: "roto.proto:1: falta syntax",
    });
    show();
    expect(await screen.findByText("roto.proto:1: falta syntax")).toBeTruthy();
  });

  test("una subida rechazada se cuenta, y el selector sin ficheros no manda nada", async () => {
    call.mockReset();
    call.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === "PUT") throw new Error("import sin resolver: common/money.proto");
      return { files: [], services: [], problem: null };
    });
    show();
    await screen.findByText("Ningún .proto todavía.");
    fireEvent.change(screen.getByLabelText("Ficheros .proto"), { target: { files: null } });
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Ficheros .proto"), { target: { files: [new File(["x"], "a.proto")] } });
    expect(await screen.findByText("import sin resolver: common/money.proto")).toBeTruthy();
  });

  test("sin entorno la reflexión se pide sin él; mientras pregunta lo dice, y un fallo se cuenta", async () => {
    call.mockReset();
    let fail: (reason: unknown) => void = () => {};
    call.mockImplementation((path: string) =>
      path.endsWith("/reflection")
        ? new Promise((_, reject) => (fail = reject))
        : Promise.resolve({ files: [], services: [], problem: null }),
    );
    show({ ...START, source: "reflection" }, null);
    fireEvent.click(screen.getByRole("button", { name: "Cargar servicios" }));
    expect(await screen.findByRole("button", { name: "Preguntando…" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/grpc/reflection", { method: "POST", body: {} });
    fail("UNIMPLEMENTED: reflection");
    expect(await screen.findByText("UNIMPLEMENTED: reflection")).toBeTruthy();
  });
});

describe("leer un .proto", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Un `FileReader` que contesta lo que se le dice, para los casos que el de jsdom no da. */
  function reader(outcome: { result?: unknown; error?: unknown }) {
    vi.stubGlobal(
      "FileReader",
      class {
        result: unknown = null;
        error: unknown = null;
        onload: () => void = () => {};
        onerror: () => void = () => {};
        readAsText() {
          queueMicrotask(() => {
            if ("result" in outcome) {
              this.result = outcome.result;
              this.onload();
            } else {
              this.error = outcome.error;
              this.onerror();
            }
          });
        }
      },
    );
  }

  const upload = async (name: string) => {
    call.mockReset();
    call.mockImplementation(async (_path: string, options?: { method?: string }) =>
      options?.method === "PUT" ? SCHEMA : { files: [], services: [], problem: null },
    );
    show();
    await screen.findByText("Ningún .proto todavía.");
    fireEvent.change(screen.getByLabelText("Ficheros .proto"), { target: { files: [new File(["x"], name)] } });
  };

  test("un fichero que el navegador no deja leer dice cuál", async () => {
    reader({ error: null });
    await upload("vacio.proto");
    expect(await screen.findByText("No se pudo leer vacio.proto")).toBeTruthy();
  });

  test("y con el error del navegador cuando lo hay", async () => {
    reader({ error: new Error("NotReadableError") });
    await upload("a.proto");
    expect(await screen.findByText("NotReadableError")).toBeTruthy();
  });

  test("un resultado vacío se manda como texto vacío", async () => {
    reader({ result: null });
    await upload("a.proto");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/grpc/protos", {
        method: "PUT",
        body: { files: [{ path: "a.proto", content: "" }] },
      }),
    );
  });
});
