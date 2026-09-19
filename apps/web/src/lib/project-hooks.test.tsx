/**
 * The two project hooks that read from the API: the active environment (a server answer, moved
 * in the cache the moment it is chosen) and the session token.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  organization: { id: "o1", name: "Org", role: "editor" } as { id: string; name: string; role: string } | null,
  canEdit: true,
}));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => mocks.organization,
  useCan: () => mocks.canEdit,
}));

import { useActiveEnvironment } from "./active-environment";
import { useSessionToken } from "./session-token";

const environments = [
  { id: "e1", name: "Dev", active: false },
  { id: "e2", name: "Prod", active: true },
];

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.organization = { id: "o1", name: "Org", role: "editor" };
  mocks.canEdit = true;
});

describe("useActiveEnvironment", () => {
  test("lee el activo que dice el servidor", async () => {
    mocks.api.mockResolvedValue(environments);
    const { wrapper } = setup();
    const { result } = renderHook(() => useActiveEnvironment("p1"), { wrapper });
    expect(result.current[0]).toBeNull();
    await waitFor(() => expect(result.current[0]).toBe("e2"));
    expect(mocks.api).toHaveBeenCalledWith("/orgs/o1/projects/p1/environments");
  });

  test("elegir otro lo mueve en la caché al instante y lo escribe en el servidor", async () => {
    let list = environments;
    mocks.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/activate")) {
        list = list.map((environment) => ({ ...environment, active: environment.id === "e1" }));
        return undefined;
      }
      return list;
    });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActiveEnvironment("p1"), { wrapper });
    await waitFor(() => expect(result.current[0]).toBe("e2"));

    act(() => result.current[1]("e1"));
    await waitFor(() => expect(result.current[0]).toBe("e1"));
    expect(mocks.api).toHaveBeenCalledWith("/orgs/o1/projects/p1/environments/e1/activate", { method: "POST" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["project", "p1"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["environments", "p1"] });
  });

  test("elegir el que ya está activo, ninguno, o sin permiso, no escribe nada", async () => {
    mocks.api.mockResolvedValue(environments);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(() => useActiveEnvironment("p1"), { wrapper });
    await waitFor(() => expect(result.current[0]).toBe("e2"));

    act(() => result.current[1]("e2"));
    act(() => result.current[1](null));
    mocks.canEdit = false;
    rerender();
    act(() => result.current[1]("e1"));
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe("e2");
  });

  test("sin proyecto no pide nada, y elegir no hace nada", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useActiveEnvironment(undefined), { wrapper });
    act(() => result.current[1]("e1"));
    expect(mocks.api).not.toHaveBeenCalled();
    expect(result.current[0]).toBeNull();
  });

  test("antes de que llegue la lista, elegir escribe igual; la caché vacía se queda vacía", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path.endsWith("/activate") ? undefined : new Promise(() => {}),
    );
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useActiveEnvironment("p1"), { wrapper });
    act(() => result.current[1]("e1"));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/orgs/o1/projects/p1/environments/e1/activate", { method: "POST" }),
    );
    expect(client.getQueryData(["environments", "p1"])).toBeUndefined();
  });
});

describe("useSessionToken", () => {
  test("devuelve el token del proyecto, o null si no hay", async () => {
    const token = { source: "login", preview: "eyJ…", expired: false, claims: null, capturedAt: "", expiresAt: null };
    mocks.api.mockResolvedValue({ token });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSessionToken("p1"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(token));
    expect(mocks.api).toHaveBeenCalledWith("/orgs/o1/projects/p1/session-token");
  });

  test("sin organización no pregunta", () => {
    mocks.organization = null;
    const { wrapper } = setup();
    const { result } = renderHook(() => useSessionToken("p1"), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
