/**
 * Ajustes de la organización: personas y credenciales de servicio.
 *
 * Lo que decide algo:
 *
 * - **Lo que no se puede hacer no se ofrece**: el único owner no puede bajarse de rol ni salir, y
 *   el control lo dice en vez de esperar al 403.
 * - **Cambiar un rol recarga la sesión**, porque el propio rol decide qué pinta toda la app.
 * - **Invitar enseña el enlace** por si el correo no llega.
 * - **Un token de servicio se enseña una vez**; el listado solo tiene su vista previa.
 * - **Quien no es admin no ve credenciales ni invita.**
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsPage } from "@/routes/settings";
import type { ApiTokenView, MembersView, Role } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  role: "owner" as string,
  organization: true,
  reload: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", async () => {
  const { atLeast } = await import("@/lib/roles");
  return {
    useAuth: () => ({ user: { id: "u-me" }, reload: session.reload }),
    useOrganization: () => (session.organization ? { id: "o", name: "Acme", role: session.role } : null),
    useCan: (needed: Role) => atLeast(session.role as Role, needed),
  };
});

const members: MembersView = {
  members: [
    { userId: "u-me", email: "yo@acme.test", name: "Yo", role: "owner", since: "2026-01-01T00:00:00.000Z" },
    { userId: "u-ana", email: "ana@acme.test", name: "Ana", role: "editor", since: "2026-02-01T00:00:00.000Z" },
  ],
  invitations: [{ id: "i1", email: "luis@acme.test", role: "viewer", expiresAt: "2026-04-01T00:00:00.000Z" }],
};

const tokens: ApiTokenView[] = [
  {
    id: "t1",
    name: "CI nightly",
    preview: "eq_ab12",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  },
  {
    id: "t2",
    name: "Viejo",
    preview: "eq_cd34",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-02T00:00:00.000Z",
    revokedAt: "2026-01-03T00:00:00.000Z",
  },
];

function draw(role: Role, mutate: (path: string, options: { method: string; body?: unknown }) => Promise<unknown>) {
  session.role = role;
  session.organization = true;
  session.reload.mockReset().mockResolvedValue(undefined);
  call.mockReset();
  call.mockImplementation((path: string, options?: { method: string; body?: unknown }) => {
    if (options?.method) return mutate(path, options);
    if (path === "/orgs/o/members") return Promise.resolve(members);
    if (path === "/orgs/o/tokens") return Promise.resolve(tokens);
    return Promise.reject(new Error(`inesperado ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByText(name).closest("div.flex") as HTMLElement;

describe("SettingsPage", () => {
  test("sin organización pide volver a entrar", () => {
    session.organization = false;
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Sin organización")).toBeTruthy();
  });

  test("el único owner no puede bajarse ni salir, y lo dice; a otro sí se le cambia el rol", async () => {
    draw("owner", () => Promise.resolve({}));
    expect(await screen.findByText("ana@acme.test")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("luis@acme.test")).toBeTruthy();

    const me = row("yo@acme.test");
    const mySelect = within(me).getByRole("combobox") as HTMLSelectElement;
    expect(mySelect.disabled).toBe(true);
    expect(mySelect.title).toContain("Eres el único owner");
    const leave = within(me).getByRole("button", { name: "Salir" }) as HTMLButtonElement;
    expect(leave.disabled).toBe(true);

    const ana = row("ana@acme.test");
    fireEvent.change(within(ana).getByRole("combobox"), { target: { value: "admin" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/members/u-ana", { method: "PATCH", body: { role: "admin" } }),
    );
    await waitFor(() => expect(session.reload).toHaveBeenCalled());
  });

  test("sacar a alguien lo borra, y un error del servidor se enseña", async () => {
    draw("owner", (_path, options) =>
      options.method === "DELETE" ? Promise.reject(new Error("No se puede sacar ahora")) : Promise.resolve({}),
    );
    await screen.findByText("ana@acme.test");
    fireEvent.click(within(row("ana@acme.test")).getByRole("button", { name: "Sacar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/members/u-ana", { method: "DELETE" }));
    expect(await screen.findByText("No se puede sacar ahora")).toBeTruthy();
  });

  test("sacar a alguien bien vuelve a pedir la lista y recarga la sesión", async () => {
    draw("owner", () => Promise.resolve({}));
    await screen.findByText("ana@acme.test");
    const lists = call.mock.calls.filter(([path]) => path === "/orgs/o/members").length;
    fireEvent.click(within(row("ana@acme.test")).getByRole("button", { name: "Sacar" }));
    await waitFor(() => expect(session.reload).toHaveBeenCalled());
    expect(call.mock.calls.filter(([path]) => path === "/orgs/o/members").length).toBeGreaterThan(lists);
  });

  test("invitar manda correo y rol, y enseña el enlace", async () => {
    draw("admin", (path) =>
      path === "/orgs/o/invitations" ? Promise.resolve({ token: "inv-123" }) : Promise.resolve({}),
    );
    await screen.findByText("ana@acme.test");
    // Un admin no puede tocar a un owner.
    const me = within(row("yo@acme.test")).getByRole("combobox") as HTMLSelectElement;
    expect(me.title).toBe("Solo un owner cambia a otro owner");

    const invite = screen.getByRole("button", { name: "Invitar" }) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("colega@example.com"), { target: { value: "eva@acme.test" } });
    const roleSelect = invite.parentElement!.querySelector("select")!;
    // Owner no se ofrece al invitar.
    expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(["viewer", "editor", "admin"]);
    fireEvent.change(roleSelect, { target: { value: "viewer" } });
    expect(screen.getByText(/Lee la matriz, las corridas/)).toBeTruthy();
    fireEvent.click(invite);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/invitations", {
        method: "POST",
        body: { email: "eva@acme.test", role: "viewer" },
      }),
    );
    expect(await screen.findByText(/\/register\?invitation=inv-123/)).toBeTruthy();
    expect((screen.getByPlaceholderText("colega@example.com") as HTMLInputElement).value).toBe("");
  });

  test("una invitación rechazada dice por qué", async () => {
    draw("admin", () => Promise.reject(new Error("Ya es miembro")));
    await screen.findByText("ana@acme.test");
    fireEvent.change(screen.getByPlaceholderText("colega@example.com"), { target: { value: "ana@acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invitar" }));
    expect(await screen.findByText("Ya es miembro")).toBeTruthy();
  });

  test("un token se enseña una vez al emitirlo, y se puede revocar", async () => {
    draw("owner", (path, options) =>
      options.method === "POST" && path === "/orgs/o/tokens"
        ? Promise.resolve({ token: "eq_secreto_completo" })
        : Promise.resolve({}),
    );
    expect(await screen.findByText("CI nightly")).toBeTruthy();
    expect(screen.getByText("eq_ab12…")).toBeTruthy();
    expect(screen.getByText("revocado")).toBeTruthy();
    expect(screen.getByText(/sin usar/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("CI de nightly"), { target: { value: "Deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Emitir" }));
    expect(await screen.findByText("eq_secreto_completo")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/tokens", { method: "POST", body: { name: "Deploy" } });

    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/orgs/o/tokens/t1", { method: "DELETE" }));
  });

  test("sin credenciales de servicio lo dice", async () => {
    const saved = tokens.splice(0, tokens.length);
    try {
      draw("owner", () => Promise.resolve({}));
      expect(await screen.findByText("Todavía no hay ninguna.")).toBeTruthy();
    } finally {
      tokens.push(...saved);
    }
  });

  test("emitir un token que falla dice por qué", async () => {
    draw("owner", () => Promise.reject(new Error("Nombre repetido")));
    await screen.findByText("CI nightly");
    fireEvent.change(screen.getByPlaceholderText("CI de nightly"), { target: { value: "CI nightly" } });
    fireEvent.click(screen.getByRole("button", { name: "Emitir" }));
    expect(await screen.findByText("Nombre repetido")).toBeTruthy();
  });

  test("un editor no ve credenciales ni invita, ni puede cambiar roles", async () => {
    draw("editor", () => Promise.resolve({}));
    await screen.findByText("ana@acme.test");
    expect(screen.queryByText("Credenciales de servicio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Invitar" })).toBeNull();
    expect(call).not.toHaveBeenCalledWith("/orgs/o/tokens");
    for (const select of screen.getAllByRole("combobox") as HTMLSelectElement[]) {
      expect(select.disabled).toBe(true);
    }
  });
});
