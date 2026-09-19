/**
 * El menú del proyecto y la insignia de bifurcación: traer y fusionar solo existen en una
 * bifurcación con original, y la insignia dice de dónde salió o que el original ya no está.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ForkBadge, ForkModal, ProjectMenu } from "@/components/project-fork-menu";
import { ToastProvider } from "@/components/toast";
import type { ProjectSummary } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));

const project = (fork: ProjectSummary["fork"]) => ({ id: "f", name: "Pedidos", fork }) as ProjectSummary;
const forked = project({
  parentProjectId: "p",
  parentName: "Original",
  forkedAt: "2026-03-01T10:00:00.000Z",
  syncedAt: "2026-03-01T10:00:00.000Z",
  version: 1,
});

function draw(node: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectMenu", () => {
  test("una bifurcación ofrece traer y fusionar; un proyecto normal solo bifurcar", () => {
    draw(<ProjectMenu project={forked} />);
    fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
    expect(screen.getByRole("menuitem", { name: "Traer cambios del original" }).getAttribute("href")).toBe(
      "/p/f/fork/pull",
    );
    expect(screen.getByRole("menuitem", { name: "Fusionar en el original" }).getAttribute("href")).toBe(
      "/p/f/fork/merge",
    );
  });

  test("las solicitudes de fusión están en el menú, también para quien solo lee", () => {
    can.edit = false;
    try {
      draw(<ProjectMenu project={forked} />);
      fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
      expect(screen.getByRole("menuitem", { name: "Solicitudes de fusión" }).getAttribute("href")).toBe(
        "/p/f/merge-requests",
      );
      expect(screen.queryByRole("menuitem", { name: "Bifurcar…" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Fusionar en el original" })).toBeNull();
    } finally {
      can.edit = true;
    }
  });

  test("sin original no hay nada que fusionar, y bifurcar abre el formulario con un nombre propuesto", () => {
    draw(<ProjectMenu project={project(null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
    expect(screen.queryByRole("menuitem", { name: "Fusionar en el original" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Bifurcar…" }));
    expect((screen.getByLabelText("Nombre de la bifurcación") as HTMLInputElement).value).toBe("Pedidos (bifurcación)");
  });
});

describe("ForkBadge", () => {
  test("enlaza al original, o dice que ya no está", () => {
    draw(<ForkBadge project={forked} />);
    expect(screen.getByRole("link", { name: "Original" }).getAttribute("href")).toBe("/p/p");
  });

  test("un original borrado se dice", () => {
    draw(<ForkBadge project={project({ ...forked.fork!, parentName: null })} />);
    expect(screen.getByText("el original ya no existe")).toBeTruthy();
  });

  test("un proyecto que no es bifurcación no lleva insignia", () => {
    draw(<ForkBadge project={project(null)} />);
    expect(screen.queryByTitle("Bifurcación")).toBeNull();
  });
});

describe("ProjectMenu: cerrar", () => {
  test("salir del menú con el ratón lo cierra", () => {
    draw(<ProjectMenu project={forked} />);
    fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
    fireEvent.mouseLeave(screen.getByRole("menu"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test.each(["Solicitudes de fusión", "Traer cambios del original", "Fusionar en el original"])(
    "ir a «%s» cierra el menú",
    (name) => {
      draw(<ProjectMenu project={forked} />);
      fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
      fireEvent.click(screen.getByRole("menuitem", { name }));
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  test("«Cancelar» en el formulario de bifurcar lo cierra", () => {
    draw(<ProjectMenu project={forked} />);
    fireEvent.click(screen.getByRole("button", { name: "Acciones del proyecto" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bifurcar…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Nombre de la bifurcación")).toBeNull();
  });
});

describe("ForkModal", () => {
  function modal() {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/p/f"]}>
            <Routes>
              <Route path="/p/f" element={<ForkModal project={forked} onClose={onClose} />} />
              <Route path="/p/:id" element={<p>proyecto nuevo</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    return onClose;
  }
  const name = () => screen.getByLabelText("Nombre de la bifurcación");
  const submit = () => screen.getByRole("button", { name: /^(Bifurcar|Bifurcando…)$/ });

  test("sin nombre no se puede bifurcar, ni enviando el formulario", () => {
    call.mockReset();
    modal();
    fireEvent.change(name(), { target: { value: "   " } });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(name().closest("form")!);
    expect(call).not.toHaveBeenCalled();
  });

  test("bifurca con el nombre limpio, lo dice mientras tanto y lleva al proyecto nuevo", async () => {
    call.mockReset();
    let done: (value: unknown) => void = () => {};
    call.mockReturnValue(new Promise((resolve) => (done = resolve)));
    const onClose = modal();
    fireEvent.change(name(), { target: { value: "  Mi copia  " } });
    fireEvent.click(submit());
    expect(await screen.findByRole("button", { name: "Bifurcando…" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/f/fork", { method: "POST", body: { name: "Mi copia" } });
    done({ projectId: "n1", skipped: [] });
    expect(await screen.findByText("proyecto nuevo")).toBeTruthy();
    expect(screen.getByText("Bifurcado")).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });

  test("lo que quedó por rellenar se cuenta en el aviso", async () => {
    call.mockReset();
    call.mockResolvedValue({ projectId: "n1", skipped: [{ kind: "secret" }, { kind: "credential" }] });
    modal();
    fireEvent.click(submit());
    expect(await screen.findByText("Bifurcado. 2 cosas por rellenar: están en su lista.")).toBeTruthy();
  });

  test("un rechazo del servidor se queda en el formulario", async () => {
    call.mockReset();
    call.mockRejectedValue(new Error("Nombre repetido"));
    modal();
    fireEvent.click(submit());
    expect(await screen.findByText("Nombre repetido")).toBeTruthy();
  });
});
