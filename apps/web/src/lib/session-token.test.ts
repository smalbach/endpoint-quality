import { describe, expect, test } from "vitest";

import { countdownTone, formatCountdown, visibleClaims } from "@/lib/session-token";
import { resolveActive } from "@/lib/active-environment";

describe("el token de sesión en la barra", () => {
  test("la cuenta atrás usa la precisión que todavía cambia", () => {
    expect(formatCountdown(0)).toBe("Caducado");
    expect(formatCountdown(-5)).toBe("Caducado");
    expect(formatCountdown(9_400)).toBe("9s");
    expect(formatCountdown(4 * 60_000 + 12_000)).toBe("4m 12s");
    expect(formatCountdown(2 * 3_600_000 + 5 * 60_000 + 59_000)).toBe("2h 5m");
  });

  test("rojo en el último minuto, ámbar en los últimos cinco", () => {
    expect(countdownTone(0)).toBe("expired");
    expect(countdownTone(59_999)).toBe("urgent");
    expect(countdownTone(60_000)).toBe("soon");
    expect(countdownTone(5 * 60_000)).toBe("ok");
  });

  test("los claims sin iat ni nbf, y lo que no es texto como JSON", () => {
    expect(visibleClaims({ sub: "u-1", iat: 1, nbf: 2, exp: 3, roles: ["a", "b"] })).toEqual([
      ["sub", "u-1"],
      ["exp", "3"],
      ["roles", '["a","b"]'],
    ]);
    expect(visibleClaims(null)).toEqual([]);
  });
});

describe("el entorno activo", () => {
  const list = [
    { id: "a", active: false },
    { id: "b", active: true },
  ];

  test("el pedido si existe; si no, el activo; nunca el primero por defecto", () => {
    expect(resolveActive("a", list)?.id).toBe("a");
    expect(resolveActive("borrado", list)?.id).toBe("b");
    expect(resolveActive(null, list)?.id).toBe("b");
    expect(resolveActive(null, [{ id: "a", active: false }])).toBeNull();
  });
});
