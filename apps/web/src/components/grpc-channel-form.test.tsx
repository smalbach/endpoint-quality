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
import { describe, expect, test, vi } from "vitest";
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

function show(initial: GrpcSettingsView = START) {
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
        environmentId="env-1"
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
});
