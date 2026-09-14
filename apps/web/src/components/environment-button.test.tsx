import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EnvironmentButton } from "@/components/environment-button";
import { ToastProvider } from "@/components/toast";
import type { Environment, SessionTokenView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const BASE = "/orgs/o/projects/p";

const environment = (id: string, name: string, active: boolean): Environment => ({
  id,
  name,
  baseUrl: `https://${name}.example.com`,
  specUrl: null,
  variables: {
    userId: { initial: "42", current: "43", sensitive: false },
    token: { initial: "••••••••", current: "••••••••", sensitive: true },
  },
  disabledVariables: {},
  writesAllowed: false,
  authEnforced: false,
  active,
  credentials: [],
});

function mount(token: SessionTokenView | null) {
  call.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === `${BASE}/environments`) return [environment("a", "local", true), environment("b", "staging", false)];
    if (path === `${BASE}/session-token` && !options?.method) return { token };
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <EnvironmentButton projectId="p" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("el botón de entorno", () => {
  test("dice cuál es el activo y activar otro lo pide al servidor", async () => {
    mount(null);
    fireEvent.click(await screen.findByRole("button", { name: /local/ }));
    expect(screen.getByText("Variables de local")).toBeDefined();
    expect(screen.getByText("43")).toBeDefined();
    expect(screen.getByText(/Ninguno capturado/)).toBeDefined();

    fireEvent.click(screen.getByText("staging"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/environments/b/activate`, expect.objectContaining({ method: "POST" })),
    );
  });

  test("el token de sesión: de dónde vino, cuánto le queda, sus claims sin iat, y olvidarlo", async () => {
    mount({
      source: "login",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString(),
      expired: false,
      claims: { sub: "user-7", iat: 1, role: "admin" },
      preview: "eyJhbGciOi…abcd",
    });
    fireEvent.click(await screen.findByRole("button", { name: /Token/ }));
    expect(screen.getByText(/Del login/)).toBeDefined();
    expect(screen.getByText("eyJhbGciOi…abcd")).toBeDefined();
    expect(screen.getByText(/^2h \d+m$/)).toBeDefined();
    expect(screen.getByText("user-7")).toBeDefined();
    expect(screen.queryByText("iat:")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Olvidar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${BASE}/session-token`, expect.objectContaining({ method: "DELETE" })),
    );
  });
});
