/**
 * «Capturar tráfico», dentro del diálogo de importar.
 *
 * Lo que fijan: que la pestaña está en el import y no en otra puerta; que abrir enseña el proxy y
 * la contraseña; que la lista llega por cursor y con el ruido sin marcar; que el filtro filtra; y
 * que importar manda lo elegido y termina en el resumen de siempre. Y que «Descifrar HTTPS» solo
 * aparece si el servidor lo ofrece, desactivado con el motivo si no puede usarse, y con la CA para
 * descargar.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportDialog } from "@/components/import-dialog";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const session = {
  id: "s1",
  status: "active",
  stopReason: null,
  itemCount: 2,
  limits: { durationMs: 1_800_000, maxRequests: 500, maxBodyBytes: 65_536 },
  startedAt: "2026-03-01T10:00:00.000Z",
  expiresAt: "2026-03-01T10:30:00.000Z",
  stoppedAt: null,
};
const item = (id: string, seq: number, url: string, noise: string | null) => ({
  id,
  seq,
  at: "2026-03-01T10:00:01.000Z",
  method: "GET",
  url,
  host: "api.test",
  status: 200,
  encrypted: false,
  contentType: "application/json",
  durationMs: 3,
  error: null,
  noise,
});

function wire() {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path.endsWith("/captures") && !options?.method) return { enabled: true, proxy: null, sessions: [] };
    if (path.endsWith("/captures") && options?.method === "POST")
      return { session, token: "TOKEN-UNA-VEZ", proxy: { host: "proxy.local", port: 8888, username: "captura" } };
    if (path.includes("/captures/s1?after=0"))
      return {
        session,
        items: [
          item("a", 1, "https://api.test/pedidos", null),
          item("b", 2, "https://app.test/main.js", "son recursos de la página y no de la API (text/javascript)"),
        ],
      };
    if (path.includes("/captures/s1?after=")) return { session, items: [] };
    if (path.endsWith("/captures/s1/import"))
      return {
        dryRun: false,
        items: [
          {
            name: "captura.har",
            kind: "har",
            pieces: [],
            reason: null,
            results: [
              {
                target: "endpoints",
                name: "captura",
                summary: "1 nuevos",
                error: null,
                endpoints: [{ id: "e1", method: "GET", path: "/pedidos" }],
              },
            ],
          },
        ],
      };
    throw new Error(`inesperado: ${path}`);
  });
}

const dialog = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ImportDialog projectId="p" initial={[]} onClose={() => {}} onImported={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("capturar tráfico", () => {
  test("es una pestaña del import: abrir enseña el proxy, la lista llega y el ruido va sin marcar", async () => {
    wire();
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empezar a capturar" }));

    expect(await screen.findByTestId("proxy-contraseña")).toHaveProperty("textContent", "TOKEN-UNA-VEZ");
    expect(screen.getByTestId("proxy-servidor").textContent).toBe("proxy.local");
    expect(screen.getByTestId("proxy-puerto").textContent).toBe("8888");

    const api = await screen.findByLabelText("Elegir GET https://api.test/pedidos");
    expect((api as HTMLInputElement).checked).toBe(true);
    // «Solo la API» viene puesto: el bundle ni se ve. Quitándolo aparece, sin marcar y con su motivo.
    expect(screen.queryByLabelText("Elegir GET https://app.test/main.js")).toBeNull();
    fireEvent.click(screen.getByLabelText("Solo la API"));
    expect((screen.getByLabelText("Elegir GET https://app.test/main.js") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/recursos de la página/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filtrar peticiones capturadas"), { target: { value: "pedidos" } });
    expect(screen.queryByLabelText("Elegir GET https://app.test/main.js")).toBeNull();
  });

  test("importar manda lo elegido y termina en el resumen de siempre", async () => {
    wire();
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empezar a capturar" }));
    await screen.findByLabelText("Elegir GET https://api.test/pedidos");

    fireEvent.click(screen.getByLabelText(/Crear también un flujo/));
    fireEvent.click(screen.getByRole("button", { name: "Importar 1 petición" }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/captures/s1/import", {
        method: "POST",
        body: { itemIds: ["a"], flow: true },
      }),
    );
    expect(await screen.findByText("Esto es lo que se hizo:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GET /pedidos" })).toBeTruthy();
  });

  test("apagada en el servidor, lo dice en vez de enseñar un botón que falla", async () => {
    call.mockReset();
    call.mockResolvedValue({ enabled: false, proxy: null, sessions: [] });
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    expect(await screen.findByText(/no está activada en esta instalación/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empezar a capturar" })).toBeNull();
  });
});

describe("descifrar HTTPS", () => {
  const ready = { ready: true, problem: null };

  function wireMitm(mitm: { ready: boolean; problem: string | null } | null) {
    wire();
    const base = call.getMockImplementation()!;
    call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path.endsWith("/captures") && !options?.method) return { enabled: true, proxy: null, mitm, sessions: [] };
      if (path.endsWith("/captures/authority/certificate"))
        return {
          pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
          fileName: "endpoint-quality-captura-ca.pem",
          fingerprint: "AB:CD",
          notAfter: "2031-01-01T00:00:00.000Z",
        };
      return base(path, options);
    });
  }

  test("apagado en el servidor, la opción no aparece y abrir no la manda", async () => {
    wireMitm(null);
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empezar a capturar" }));
    expect(screen.queryByLabelText("Descifrar HTTPS")).toBeNull();
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/captures", { method: "POST" }));
  });

  test("encendido, se marca antes de abrir y la sesión se pide descifrando", async () => {
    wireMitm(ready);
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    const toggle = (await screen.findByLabelText("Descifrar HTTPS")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Empezar a capturar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/captures", {
        method: "POST",
        body: { decryptHttps: true },
      }),
    );
  });

  test("sin poder usarse, la opción sale desactivada con el motivo", async () => {
    wireMitm({ ready: false, problem: "Define una SECRETS_KEY válida (32 bytes en base64)." });
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    const toggle = (await screen.findByLabelText("Descifrar HTTPS")) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/SECRETS_KEY válida/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descargar el certificado de la CA" })).toBeNull();
  });

  test("el certificado de la CA se descarga como fichero y enseña su huella", async () => {
    wireMitm(ready);
    const created = vi.fn((_blob: Blob) => "blob:ca");
    const revoked = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Capturar tráfico" }));
    fireEvent.click(await screen.findByRole("button", { name: "Descargar el certificado de la CA" }));

    expect(await screen.findByTestId("ca-fingerprint")).toHaveProperty("textContent", "SHA-256 AB:CD");
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p/captures/authority/certificate");
    expect(created).toHaveBeenCalledTimes(1);
    // El fichero es el PEM tal cual: solo el certificado.
    const blob = created.mock.calls[0][0];
    expect(blob.type).toBe("application/x-pem-file");
    expect(blob.size).toBe("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n".length);
    expect(clicked).toHaveBeenCalled();
    clicked.mockRestore();
  });
});
