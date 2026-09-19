/**
 * «Capturar tráfico» montado solo, para lo que la prueba del diálogo no recorre.
 *
 * Lo que se comprueba: que la última sesión del proyecto se retoma (abierta, avisando de que su
 * contraseña ya no se ve; parada, con su motivo y ofreciendo otra), que una página llena se sigue
 * pidiendo sin esperar, que parar lo pide al servidor, que cada botón dice lo que está haciendo,
 * que los fallos —de la API con sus campos, o de cualquier otra cosa— se enseñan, que el servidor
 * del proxy sale del nombre de la página cuando la configuración no lo dice, que una sesión que
 * descifra ofrece la CA, y que la lista enseña el estado, el error y el «nada coincide».
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CaptureTraffic } from "@/components/capture-traffic";
import { ApiError } from "@/lib/api";
import type { CaptureItemSummaryView, CaptureSessionView, ImportAnythingResult } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p/captures";

const session = (patch: Partial<CaptureSessionView> = {}): CaptureSessionView =>
  ({
    id: "s1",
    status: "active",
    stopReason: null,
    decryptHttps: false,
    itemCount: 1,
    limits: { durationMs: 1_800_000, maxRequests: 500, maxBodyBytes: 65_536 },
    startedAt: "2026-03-01T10:00:00.000Z",
    expiresAt: "2026-03-01T10:30:00.000Z",
    stoppedAt: null,
    ...patch,
  }) as CaptureSessionView;

const item = (id: string, seq: number, patch: Partial<CaptureItemSummaryView> = {}): CaptureItemSummaryView =>
  ({
    id,
    seq,
    at: "2026-03-01T10:00:01.000Z",
    method: "GET",
    url: `https://api.test/${id}`,
    host: "api.test",
    status: 200,
    encrypted: false,
    contentType: "application/json",
    durationMs: 3,
    error: null,
    noise: null,
    ...patch,
  }) as CaptureItemSummaryView;

type Route = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function mount(route: Route) {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => route(path, options));
  const onResult = vi.fn<(result: ImportAnythingResult) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CaptureTraffic projectId="p" onResult={onResult} />
    </QueryClientProvider>,
  );
  return { onResult, ...view };
}

const overview = (sessions: CaptureSessionView[], mitm: unknown = null) => ({
  enabled: true,
  proxy: null,
  mitm,
  sessions,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retomar la última sesión", () => {
  test("abierta: la lista sigue llegando y se avisa de que su contraseña ya no se enseña", async () => {
    mount((path) => {
      if (path === BASE) return overview([session()]);
      if (path.startsWith(`${BASE}/s1?after=`)) return { session: session(), items: [item("a", 1)] };
      throw new Error(path);
    });
    expect(await screen.findByText(/su contraseña solo se enseñó al abrirla/)).toBeDefined();
    expect(await screen.findByLabelText("Elegir GET https://api.test/a")).toBeDefined();
    expect(screen.queryByTestId("proxy-contraseña")).toBeNull();
  });

  test("parada: dice por qué y cuántas, y ofrece una nueva", async () => {
    const stopped = session({ status: "stopped", stopReason: "expired", itemCount: 1 });
    mount((path) => {
      if (path === BASE) return overview([stopped]);
      return { session: stopped, items: [] };
    });
    expect(await screen.findByText(/Parada \(se acabó su tiempo\) · 1 petición/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Nueva captura" })).toBeDefined();
    expect(screen.getByText("Todavía no ha pasado nada por el proxy.")).toBeDefined();
  });

  test("parada sin motivo conocido, con varias", async () => {
    const stopped = session({ status: "stopped", stopReason: null, itemCount: 3 });
    mount((path) => (path === BASE ? overview([stopped]) : { session: stopped, items: [] }));
    expect(await screen.findByText(/Parada \(sin motivo\) · 3 peticiones/)).toBeDefined();
  });

  test("una página llena se sigue pidiendo sin esperar, desde el último que llegó", async () => {
    const stopped = session({ status: "stopped", stopReason: "manual" });
    const full = Array.from({ length: 200 }, (_, index) => item(`i${index}`, index + 1));
    mount((path) => {
      if (path === BASE) return overview([stopped]);
      if (path === `${BASE}/s1?after=0`) return { session: stopped, items: full };
      if (path === `${BASE}/s1?after=200`) return { session: stopped, items: [item("last", 201)] };
      throw new Error(path);
    });
    expect(await screen.findByLabelText("Elegir GET https://api.test/last")).toBeDefined();
    expect(screen.getByRole("button", { name: "Importar 201 peticiones" })).toBeDefined();
  });

  test("si leer la lista falla, se dice", async () => {
    mount((path) => {
      if (path === BASE) return overview([session({ status: "stopped" })]);
      throw new TypeError("fetch failed");
    });
    expect(await screen.findByText("Algo falló con la captura")).toBeDefined();
  });

  test("si la lista falla después de irse, no se enseña nada ni se queja React", async () => {
    let fail!: (error: unknown) => void;
    const { unmount } = mount((path) => {
      if (path === BASE) return overview([session({ status: "stopped" })]);
      return new Promise((_resolve, reject) => (fail = reject));
    });
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${BASE}/s1?after=0`));
    const errors = vi.spyOn(console, "error");
    unmount();
    await act(async () => fail(new Error("tarde")));
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("abrir, parar e importar", () => {
  test("mientras abre lo dice; si el servidor se niega, sale su motivo con el detalle de cada campo", async () => {
    let refuse!: (error: unknown) => void;
    mount((path, options) => {
      if (path === BASE && !options?.method) return overview([]);
      return new Promise((_resolve, reject) => (refuse = reject));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Empezar a capturar" }));
    expect(((await screen.findByRole("button", { name: "Abriendo…" })) as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      refuse(
        new ApiError(409, {
          type: "about:blank",
          title: "Conflicto",
          status: 409,
          detail: "El proxy no está escuchando",
          errors: [{ field: "port", detail: "Puerto ocupado" }],
        }),
      ),
    );
    expect(await screen.findByText("El proxy no está escuchando")).toBeDefined();
    expect(screen.getByText("Puerto ocupado")).toBeDefined();
    expect(screen.getByRole("button", { name: "Empezar a capturar" })).toBeDefined();
  });

  test("parar lo pide al servidor y la sesión pasa a parada; mientras, el botón lo dice", async () => {
    let stopped!: (value: CaptureSessionView) => void;
    let current = session();
    mount((path, options) => {
      if (path === BASE) return overview([session()]);
      if (path === `${BASE}/s1/stop` && options?.method === "POST") return new Promise((resolve) => (stopped = resolve));
      return { session: current, items: [] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Parar la captura" }));
    expect(await screen.findByRole("button", { name: "Parando…" })).toBeDefined();
    current = session({ status: "stopped", stopReason: "manual" });
    await act(async () => stopped(current));
    expect(await screen.findByText(/Parada \(parada a mano\)/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Nueva captura" })).toBeDefined();
  });

  test("si parar falla, se dice y la sesión sigue abierta", async () => {
    mount((path, options) => {
      if (path === BASE) return overview([session()]);
      if (options?.method === "POST") throw new Error("sin red");
      return { session: session(), items: [] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Parar la captura" }));
    expect(await screen.findByText("Algo falló con la captura")).toBeDefined();
    expect(screen.getByRole("button", { name: "Parar la captura" })).toBeDefined();
  });

  test("importar: desmarcar cuenta, mientras importa lo dice, y un fallo se enseña", async () => {
    const stopped = session({ status: "stopped", stopReason: "manual" });
    let refuse!: (error: unknown) => void;
    const { onResult } = mount((path) => {
      if (path === BASE) return overview([stopped]);
      if (path.endsWith("/import")) return new Promise((_resolve, reject) => (refuse = reject));
      return { session: stopped, items: path.endsWith("after=0") ? [item("a", 1), item("b", 2)] : [] };
    });
    await screen.findByRole("button", { name: "Importar 2 peticiones" });
    fireEvent.click(screen.getByLabelText("Elegir GET https://api.test/b"));
    fireEvent.click(screen.getByLabelText("Elegir GET https://api.test/b"));
    expect(screen.getByRole("button", { name: "Importar 2 peticiones" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Elegir GET https://api.test/b"));
    fireEvent.click(screen.getByRole("button", { name: "Importar 1 petición" }));
    expect(await screen.findByRole("button", { name: "Importando…" })).toBeDefined();
    expect(call).toHaveBeenCalledWith(`${BASE}/s1/import`, { method: "POST", body: { itemIds: ["a"], flow: false } });
    await act(async () => refuse(new Error("sin red")));
    expect(await screen.findByText("Algo falló con la captura")).toBeDefined();
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("las instrucciones del proxy", () => {
  test("sin servidor configurado se usa el de la página; «copiar» lo copia; si descifra, ofrece la CA", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const decrypting = session({ decryptHttps: true });
    mount((path, options) => {
      if (path === BASE && !options?.method) return overview([], { ready: true, problem: null });
      if (path === BASE) return { session: decrypting, token: "T", proxy: { host: null, port: 8888, username: "u" } };
      if (path.endsWith("/authority/certificate")) throw new Error("sin CA");
      return { session: decrypting, items: [] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Empezar a capturar" }));
    expect((await screen.findByTestId("proxy-servidor")).textContent).toBe(window.location.hostname);
    fireEvent.click(screen.getByRole("button", { name: "Copiar usuario" }));
    expect(writeText).toHaveBeenCalledWith("u");

    expect(screen.getByText(/Esta sesión descifra HTTPS/)).toBeDefined();
    // Con la sesión abierta la opción de antes de abrir ya no está: la CA se ofrece en las instrucciones.
    expect(screen.queryByLabelText("Descifrar HTTPS")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Descargar el certificado de la CA" }));
    expect(await screen.findByText("Algo falló con la captura")).toBeDefined();
  });
});

describe("la lista", () => {
  test("enseña el error de una petición, los códigos sin respuesta o fallidos, y «nada coincide»", async () => {
    const stopped = session({ status: "stopped", stopReason: "manual" });
    mount((path) => {
      if (path === BASE) return overview([stopped]);
      return {
        session: stopped,
        items: path.endsWith("after=0")
          ? [
              item("caida", 1, { status: null, error: "ECONNRESET" }),
              item("mal", 2, { status: 500 }),
              item("tunel", 3, { encrypted: true, noise: "cifrado, sin detalle" }),
            ]
          : [],
      };
    });
    expect(await screen.findByText("ECONNRESET")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
    expect(screen.getByText("500").className).toContain("text-rose-700");

    fireEvent.click(screen.getByLabelText("Solo la API"));
    expect(screen.getByLabelText<HTMLInputElement>("Elegir GET https://api.test/tunel").disabled).toBe(true);

    // El filtro mira también el estado; una petición sin estado no casa con nada que no sea suyo.
    fireEvent.change(screen.getByLabelText("Filtrar peticiones capturadas"), { target: { value: "500" } });
    expect(screen.getByLabelText("Elegir GET https://api.test/mal")).toBeDefined();
    expect(screen.queryByLabelText("Elegir GET https://api.test/caida")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filtrar peticiones capturadas"), { target: { value: "zzz" } });
    expect(screen.getByText("Nada coincide con el filtro.")).toBeDefined();
  });
});
