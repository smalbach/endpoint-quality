/**
 * El gestor del tarro y el panel de lo que pasó con las cookies.
 *
 * Lo que se comprueba: que el valor **no** se enseña hasta que se pide —es una credencial—, que
 * borrar una manda las tres partes de su clave y no solo el nombre, y que lo rechazado se ve.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CookieManager, CookiePanel } from "@/components/cookie-manager";
import { ToastProvider } from "@/components/toast";
import type { CookieView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const cookie = (patch: Partial<CookieView> = {}): CookieView => ({
  name: "session",
  value: "•".repeat(8),
  domain: "api.ejemplo.com",
  path: "/",
  expiresAt: null,
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  hostOnly: true,
  ...patch,
});

function mount(cookies: CookieView[]) {
  call.mockReset();
  call.mockImplementation((path: string) => {
    if (path.includes("reveal=true"))
      return Promise.resolve({ cookies: cookies.map((row) => ({ ...row, value: "s3cr3t0" })) });
    if (path.includes("/cookies")) return Promise.resolve({ cookies });
    return Promise.resolve({});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CookieManager projectId="p" baseUrl="https://api.ejemplo.com" onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("el gestor del tarro", () => {
  test("enseña las cookies con el valor tapado, y lo revela solo si se pide", async () => {
    mount([cookie()]);
    await waitFor(() => expect(screen.getByText("session")).toBeTruthy());
    expect(screen.getByText("•".repeat(8))).toBeTruthy();
    expect(screen.queryByText("s3cr3t0")).toBeNull();

    fireEvent.click(screen.getByText("Ver valores"));
    await waitFor(() => expect(screen.getByText("s3cr3t0")).toBeTruthy());
    // Y es otra llamada, no un campo que ya venía en la primera.
    expect(call.mock.calls.some((args: unknown[]) => String(args[0]).includes("reveal=true"))).toBe(true);
  });

  test("dice qué significa cada marca, sin que haya que saber la RFC", async () => {
    mount([cookie()]);
    await waitFor(() => expect(screen.getByText(/solo este host/)).toBeTruthy());
    expect(screen.getByText(/Secure/)).toBeTruthy();
    expect(screen.getByText("al cerrar")).toBeTruthy();
  });

  test("borrar una manda dominio, ruta y nombre: con el nombre solo se borraría la de otra ruta", async () => {
    mount([cookie({ path: "/admin" })]);
    await waitFor(() => expect(screen.getByText("borrar")).toBeTruthy());
    fireEvent.click(screen.getByText("borrar"));
    await waitFor(() =>
      expect(
        call.mock.calls.some((args: unknown[]) => {
          const path = String(args[0]);
          const options = args[1] as { method?: string } | undefined;
          return (
            options?.method === "DELETE" &&
            path.includes("domain=api.ejemplo.com") &&
            path.includes("path=%2Fadmin") &&
            path.includes("name=session")
          );
        }),
      ).toBe(true),
    );
  });

  test("un tarro vacío lo dice, en vez de una tabla sin filas", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText(/El tarro está vacío/)).toBeTruthy());
  });

  test("escribir una manda la línea tal cual y la URL para la que vale", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByLabelText("Set-Cookie")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Set-Cookie"), { target: { value: "manual=1; Path=/" } });
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() =>
      expect(
        call.mock.calls.some((args: unknown[]) => {
          const path = String(args[0]);
          const options = args[1] as { method?: string; body?: { url: string; setCookie: string } } | undefined;
          return (
            options?.method === "POST" &&
            path.endsWith("/cookies") &&
            options.body?.setCookie === "manual=1; Path=/" &&
            options.body?.url === "https://api.ejemplo.com"
          );
        }),
      ).toBe(true),
    );
  });
});

describe("el panel de lo que pasó", () => {
  test("cuenta lo enviado, lo guardado y lo rechazado con su motivo", () => {
    render(
      <CookiePanel
        cookies={{
          sent: ["session=api.ejemplo.com/"],
          stored: ["tema=api.ejemplo.com/"],
          rejected: [{ line: "ajena=1; Domain=otro.com", why: "«otro.com» no es el dominio de api.ejemplo.com" }],
        }}
      />,
    );
    expect(screen.getByText(/Se enviaron/)).toBeTruthy();
    expect(screen.getByText(/El servidor puso/)).toBeTruthy();
    expect(screen.getByText(/no es el dominio/)).toBeTruthy();
  });

  test("sin cookies lo dice en vez de quedarse en blanco", () => {
    render(<CookiePanel cookies={{ sent: [], stored: [], rejected: [] }} />);
    expect(screen.getByText(/Ni se presentó ninguna cookie/)).toBeTruthy();
  });
});
