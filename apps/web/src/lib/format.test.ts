import { describe, expect, test } from "vitest";

import { cn, formatBytes, formatDate, formatDuration, httpStatusStyle, methodStyle } from "./format";

describe("format", () => {
  test("cn une clases y deja ganar a la última de Tailwind que choca", () => {
    const hidden = ["oculta"].includes("otra");
    expect(cn("px-2 py-1", hidden && "oculta", "px-4")).toBe("py-1 px-4");
  });

  test("un método conocido lleva su color y uno desconocido cae a neutro", () => {
    expect(methodStyle("DELETE")).toContain("rose");
    expect(methodStyle("PURGE")).toBe("bg-slate-50 text-slate-700 border-slate-200");
  });

  test("la duración usa ms por debajo del segundo y un guion si no hay dato", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1_540)).toBe("1.5 s");
  });

  test("una fecha ausente es un guion; una presente, la hora local", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    const iso = "2026-01-02T03:04:05.000Z";
    expect(formatDate(iso)).toBe(new Date(iso).toLocaleString());
  });

  test("el estado HTTP se colorea por clase, no por veredicto", () => {
    expect(httpStatusStyle(204)).toContain("emerald");
    expect(httpStatusStyle(301)).toContain("sky");
    expect(httpStatusStyle(404)).toContain("amber");
    expect(httpStatusStyle(503)).toContain("rose");
  });

  test("los bytes usan unidades decimales, como el panel de red", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1.0 kB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });
});
