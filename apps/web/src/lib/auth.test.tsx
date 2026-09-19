/**
 * The boot sequence and the organization in context.
 *
 * What matters here: the app decides «signed in or not» only after trying a refresh (rendering the
 * login first would sign people out on every reload), a stored organization only counts while it
 * is still one of the user's, and `useOrganization` hands back the same object while nothing that
 * decides it changed — the run screen's SSE effect depends on that identity.
 */
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CurrentUser } from "./types";

const apiMock = vi.hoisted(() => ({
  api: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  refreshOnce: vi.fn(),
  register: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { AuthProvider, useAuth, useCan, useOrganization } from "./auth";

const ada: CurrentUser = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  organizations: [
    { id: "o1", name: "Primera", slug: "primera", role: "viewer" },
    { id: "o2", name: "Segunda", slug: "segunda", role: "owner" },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

function useEverything() {
  return { auth: useAuth(), organization: useOrganization(), canAdmin: useCan("admin") };
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(apiMock)) fn.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("arranque", () => {
  test("empieza cargando y, si la renovación no llega, queda anónimo sin pedir /auth/me", async () => {
    const refresh = deferred<boolean>();
    apiMock.refreshOnce.mockReturnValue(refresh.promise);
    const { result } = renderHook(useEverything, { wrapper });
    expect(result.current.auth.status).toBe("loading");

    await act(async () => refresh.resolve(false));
    expect(result.current.auth.status).toBe("anonymous");
    expect(result.current.auth.user).toBeNull();
    expect(result.current.auth.organizationId).toBeNull();
    expect(result.current.organization).toBeNull();
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  test("con una cookie válida carga al usuario y actúa en su primera organización", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });

    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    expect(apiMock.api).toHaveBeenCalledWith("/auth/me");
    expect(result.current.auth.user).toEqual(ada);
    expect(result.current.organization).toEqual({ id: "o1", name: "Primera", role: "viewer" });
    expect(result.current.canAdmin).toBe(false);
  });

  test("si /auth/me falla tras renovar, queda anónimo", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockRejectedValue(new Error("500"));
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("anonymous"));
  });

  test("desmontado a mitad de la renovación, no toca el estado ni pide /auth/me", async () => {
    const refresh = deferred<boolean>();
    apiMock.refreshOnce.mockReturnValue(refresh.promise);
    const { unmount } = renderHook(useEverything, { wrapper });
    unmount();
    await act(async () => refresh.resolve(true));
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  test("desmontado mientras carga al usuario, un fallo posterior no toca el estado", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    const me = deferred<CurrentUser>();
    apiMock.api.mockReturnValue(me.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(apiMock.api).toHaveBeenCalled());
    unmount();
    await act(async () => me.reject(new Error("tarde")));
    // No «update on an unmounted component» or unhandled rejection leaks out of the boot.
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("la organización en contexto", () => {
  test("la guardada se respeta mientras siga siendo del usuario", async () => {
    localStorage.setItem("eq.organization", "o2");
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    expect(result.current.auth.organizationId).toBe("o2");
    expect(result.current.canAdmin).toBe(true);
  });

  test("una guardada que ya no es suya cae a la primera", async () => {
    localStorage.setItem("eq.organization", "o-que-ya-no");
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    expect(result.current.auth.organizationId).toBe("o1");
  });

  test("un usuario sin organizaciones no actúa en ninguna", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue({ ...ada, organizations: [] });
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    expect(result.current.auth.organizationId).toBeNull();
    expect(result.current.organization).toBeNull();
    expect(result.current.canAdmin).toBe(false);
  });

  test("elegir una la aplica y la recuerda para la próxima carga", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));

    act(() => result.current.auth.selectOrganization("o2"));
    expect(result.current.organization).toEqual({ id: "o2", name: "Segunda", role: "owner" });
    expect(localStorage.getItem("eq.organization")).toBe("o2");
  });

  test("sin almacenamiento (navegación privada) arranca sin elección y elegir sigue funcionando", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denegado", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denegado", "SecurityError");
    });
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    expect(result.current.auth.organizationId).toBe("o1");

    act(() => result.current.auth.selectOrganization("o2"));
    expect(result.current.auth.organizationId).toBe("o2");
  });

  test("useOrganization devuelve el mismo objeto mientras no cambie lo que lo decide", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
    const first = result.current.organization;

    // A reload replaces `user` wholesale with an equal copy; the organization must not change identity.
    apiMock.api.mockResolvedValue(structuredClone(ada));
    await act(() => result.current.auth.reload());
    expect(result.current.auth.user).not.toBe(ada);
    expect(result.current.organization).toBe(first);
  });
});

describe("entrar, registrarse y salir", () => {
  async function anonymous() {
    apiMock.refreshOnce.mockResolvedValue(false);
    const hook = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(hook.result.current.auth.status).toBe("anonymous"));
    return hook;
  }

  test("signIn entra y carga al usuario", async () => {
    const { result } = await anonymous();
    apiMock.login.mockResolvedValue({ userId: "u1", accessToken: "t", expiresIn: 900 });
    apiMock.api.mockResolvedValue(ada);
    await act(() => result.current.auth.signIn("ada@example.com", "secreto-largo"));
    expect(apiMock.login).toHaveBeenCalledWith("ada@example.com", "secreto-largo");
    expect(result.current.auth.status).toBe("authenticated");
    expect(result.current.auth.user).toEqual(ada);
  });

  test("signIn con credenciales malas propaga el error y sigue anónimo", async () => {
    const { result } = await anonymous();
    apiMock.login.mockRejectedValue(new Error("Credenciales inválidas"));
    await expect(act(() => result.current.auth.signIn("ada@example.com", "mal"))).rejects.toThrow(
      "Credenciales inválidas",
    );
    expect(result.current.auth.status).toBe("anonymous");
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  test("signUp registra y carga al usuario", async () => {
    const { result } = await anonymous();
    apiMock.register.mockResolvedValue(undefined);
    apiMock.api.mockResolvedValue(ada);
    const input = { email: "ada@example.com", password: "secreto-largo", name: "Ada", organizationName: "Primera" };
    await act(() => result.current.auth.signUp(input));
    expect(apiMock.register).toHaveBeenCalledWith(input);
    expect(result.current.auth.status).toBe("authenticated");
  });

  test("signOut cierra la sesión y olvida al usuario", async () => {
    apiMock.refreshOnce.mockResolvedValue(true);
    apiMock.api.mockResolvedValue(ada);
    const { result } = renderHook(useEverything, { wrapper });
    await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));

    apiMock.logout.mockResolvedValue(undefined);
    await act(() => result.current.auth.signOut());
    expect(apiMock.logout).toHaveBeenCalledOnce();
    expect(result.current.auth.status).toBe("anonymous");
    expect(result.current.auth.user).toBeNull();
    expect(result.current.organization).toBeNull();
  });
});

describe("fuera del proveedor", () => {
  test("useAuth avisa en vez de devolver un contexto vacío", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useAuth();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow("useAuth fuera de AuthProvider");
  });
});
