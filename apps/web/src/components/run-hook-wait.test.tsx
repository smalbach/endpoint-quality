/**
 * La tarjeta de un nodo webhook que espera: la URL que hay que llamar, copiable, mientras su caso
 * sigue en marcha, y nada en cuanto termina.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RunHookWait } from "@/components/run-hook-wait";
import type { RunCase, RunHookWaitView } from "@/lib/types";

const URL = `http://localhost:3001/hooks/flows/${"a".repeat(43)}`;
const hook: RunHookWaitView = {
  caseId: "c1",
  stepId: "pago",
  url: URL,
  method: "PUT",
  expiresAt: "2026-01-01T10:00:00Z",
};
const runCase = (status: RunCase["status"]) => ({ id: "c1", status, path: "espera 60 s" }) as RunCase;

describe("la espera de un webhook en la corrida", () => {
  test("enseña la URL con su verbo y la copia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RunHookWait hooks={[hook]} cases={[runCase("running")]} />);
    expect(screen.getByText(/Esperando webhook · pago/)).toBeTruthy();
    expect((screen.getByLabelText("URL del webhook") as HTMLInputElement).value).toBe(URL);
    expect(screen.getByText("PUT")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copiar URL" }));
    await screen.findByRole("button", { name: "Copiada" });
    expect(writeText).toHaveBeenCalledWith(URL);
  });

  test("cuando su caso ya terminó no queda nada que copiar", () => {
    const { container } = render(<RunHookWait hooks={[hook]} cases={[runCase("passed")]} />);
    expect(container.textContent).toBe("");
  });
});
