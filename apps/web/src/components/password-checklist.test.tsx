/**
 * Las reglas de la contraseña se van marcando mientras se escribe: una contraseña vacía no cumple
 * ninguna, una a medias cumple las suyas y una fuerte las cumple todas.
 */
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

import { PasswordChecklist } from "@/components/password-checklist";

const ticks = () => screen.getAllByRole("listitem").filter((item) => item.textContent?.startsWith("✓")).length;

test("marca lo que se cumple y nada más", () => {
  const { rerender } = render(<PasswordChecklist password="" />);
  expect(screen.getByRole("list", { name: "Requisitos de la contraseña" })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(ticks()).toBe(0);

  rerender(<PasswordChecklist password="abc1" />);
  expect(ticks()).toBe(2);
  expect(screen.getByText("una minúscula").className).toContain("text-emerald-700");
  expect(screen.getByText("una mayúscula").className).toContain("text-slate-400");

  rerender(<PasswordChecklist password="Muy-segura-2026" />);
  expect(ticks()).toBe(5);
});
