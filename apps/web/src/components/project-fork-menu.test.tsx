/**
 * El menú del proyecto y la insignia de bifurcación: traer y fusionar solo existen en una
 * bifurcación con original, y la insignia dice de dónde salió o que el original ya no está.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { ForkBadge, ProjectMenu } from "@/components/project-fork-menu";
import { ToastProvider } from "@/components/toast";
import type { ProjectSummary } from "@/lib/types";

vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

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
});
