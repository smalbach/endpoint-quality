/**
 * El panel y el historial: las dos vistas de toda la organización.
 *
 * Lo que decide algo:
 *
 * - **El panel no enseña los proyectos archivados**, y sin activos dice que no hay ninguno.
 * - **Un dato que falta se enseña como «—»**, no como 0 ni como `null`.
 * - **El historial pide al servidor lo que se busca y se filtra**, y cambiar de filtro vuelve a la
 *   primera página.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { DashboardPage } from "@/routes/dashboard";
import { HistoryPage } from "@/routes/history";
import type { DashboardProjectView, DashboardView, HistoryEntryView, HistoryPageView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({
  useOrganization: () => ({ id: "o", name: "Org", role: "owner" }),
  useCan: () => true,
}));

function draw(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const project = (over: Partial<DashboardProjectView>): DashboardProjectView => ({
  id: "p1",
  name: "Tienda",
  archived: false,
  endpoints: 12,
  flows: 3,
  securityScore: 91,
  passRate: 0.756,
  perfP95Ms: 212.4,
  lastActivityAt: null,
  trends: { passRates: [0.5, 0.75], securityScores: [80, 91], perfP95Ms: [300, 212] },
  ...over,
});

describe("DashboardPage", () => {
  test("enseña los totales y una tarjeta por proyecto activo, sin los archivados", async () => {
    const view: DashboardView = {
      totals: { projects: 3, endpoints: 20, avgSecurityScore: 64 },
      projects: [
        project({}),
        project({
          id: "p2",
          name: "Pagos",
          securityScore: null,
          passRate: null,
          perfP95Ms: null,
          trends: { passRates: [], securityScores: [30], perfP95Ms: [] },
        }),
        project({ id: "p3", name: "Viejo", archived: true }),
      ],
    };
    call.mockReset();
    call.mockResolvedValue(view);
    draw(<DashboardPage />);

    expect(screen.getByText("Cargando…")).toBeTruthy();
    expect(await screen.findByText("Tienda")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/dashboard");
    expect(screen.getByText("64").className).toContain("text-amber-600");
    expect(screen.getByText("91").className).toContain("text-emerald-600");
    expect(screen.getByText("76%")).toBeTruthy();
    expect(screen.getByText("212 ms")).toBeTruthy();
    expect(screen.queryByText("Viejo")).toBeNull();

    // El proyecto sin datos: guiones, y sin línea de tendencia con un solo punto.
    const card = screen.getByText("Pagos").closest("a")!;
    expect(card.getAttribute("href")).toBe("/p/p2");
    expect(card.textContent).toContain("—");
    expect(card.querySelectorAll("svg").length).toBe(0);
    // Tienda tiene tres tendencias de más de un punto.
    expect(screen.getByText("Tienda").closest("a")!.querySelectorAll("svg").length).toBe(3);
  });

  test("sin proyectos activos dice que no hay, y un score bajo o ausente cambia de color", async () => {
    call.mockReset();
    call.mockResolvedValue({
      totals: { projects: 1, endpoints: 0, avgSecurityScore: null },
      projects: [project({ archived: true })],
    } satisfies DashboardView);
    draw(<DashboardPage />);
    expect(await screen.findByText("Sin proyectos")).toBeTruthy();
    expect(screen.getByText("—").className).toContain("text-slate-400");
  });

  test("un score por debajo de 50 se pinta en rojo", async () => {
    call.mockReset();
    call.mockResolvedValue({
      totals: { projects: 1, endpoints: 1, avgSecurityScore: 20 },
      projects: [],
    } satisfies DashboardView);
    draw(<DashboardPage />);
    expect((await screen.findByText("20")).className).toContain("text-rose-600");
  });
});

const entry = (over: Partial<HistoryEntryView>): HistoryEntryView => ({
  id: "e1",
  projectId: "p1",
  projectName: "Tienda",
  kind: "security",
  title: "Corrida de seguridad",
  status: "passed",
  metric: "91",
  href: "/p/p1/security/r1",
  createdAt: "2026-03-01T10:00:00.000Z",
  ...over,
});

describe("HistoryPage", () => {
  test("sin nada analizado lo dice", async () => {
    call.mockReset();
    call.mockResolvedValue({ entries: [], total: 0, page: 1, pageSize: 25 } satisfies HistoryPageView);
    draw(<HistoryPage />);
    expect(await screen.findByText("Nada todavía")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/history?search=&kind=all&page=1&pageSize=25");
  });

  test("lista las entradas con su enlace, pagina y el filtro vuelve a la primera página", async () => {
    call.mockReset();
    call.mockImplementation((path: string) => {
      const page = Number(/page=(\d+)/.exec(path)![1]);
      return Promise.resolve({
        entries: [
          entry({ id: `e${page}`, title: `Análisis ${page}` }),
          entry({ id: "x", kind: "scan", title: "Escaneo de código", metric: null }),
        ],
        total: 60,
        page,
        pageSize: 25,
      } satisfies HistoryPageView);
    });
    draw(<HistoryPage />);

    const link = await screen.findByRole("link", { name: "Análisis 1" });
    expect(link.getAttribute("href")).toBe("/p/p1/security/r1");
    expect(screen.getByText("60 análisis · página 1 de 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Anterior" }) as HTMLButtonElement).disabled).toBe(true);
    // Una entrada sin métrica enseña un guion.
    expect(screen.getByRole("link", { name: "Escaneo de código" }).closest("tr")!.textContent).toContain("—");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(await screen.findByRole("link", { name: "Análisis 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(await screen.findByText("60 análisis · página 3 de 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    expect(await screen.findByText("60 análisis · página 2 de 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rendimiento" }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("/orgs/o/history?search=&kind=performance&page=1&pageSize=25"),
    );

    fireEvent.change(screen.getByPlaceholderText("Buscar por proyecto o título…"), { target: { value: "tienda & co" } });
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        "/orgs/o/history?search=tienda%20%26%20co&kind=performance&page=1&pageSize=25",
      ),
    );
  });
});
