import { describe, expect, test } from "vitest";

import { ALL_RULE_KEYS, DEFAULT_RULES, PRESETS, RULE_LABEL, isTerminal, scoreColor } from "./security-runs";

describe("corridas de seguridad", () => {
  test("terminal es todo lo que ya no va a cambiar", () => {
    expect(isTerminal("passed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  test("los grupos cubren cada regla una vez, y cada regla tiene su etiqueta", () => {
    expect(new Set(ALL_RULE_KEYS).size).toBe(ALL_RULE_KEYS.length);
    expect([...ALL_RULE_KEYS].sort()).toEqual(Object.keys(RULE_LABEL).sort());
  });

  test("las recomendadas dejan fuera solo las ruidosas", () => {
    const off = ALL_RULE_KEYS.filter((key) => !DEFAULT_RULES[key]);
    expect(off.sort()).toEqual(["endpoint_consistency", "rate_limit", "response_size_anomaly"]);
  });

  test("cada preset nombra todas las reglas, encendidas o no", () => {
    for (const preset of PRESETS) expect(Object.keys(preset.rules).sort()).toEqual([...ALL_RULE_KEYS].sort());
    const auth = PRESETS.find((preset) => preset.id === "auth")!;
    expect(ALL_RULE_KEYS.filter((key) => auth.rules[key]).sort()).toEqual(
      ["auth_jwt", "bfla", "bola_idor", "cross_user_access", "jwt_attack"].sort(),
    );
    expect(Object.values(PRESETS.find((preset) => preset.id === "all")!.rules).every(Boolean)).toBe(true);
  });

  test("la nota se colorea por tramos", () => {
    expect(scoreColor(80)).toBe("text-emerald-600");
    expect(scoreColor(60)).toBe("text-amber-600");
    expect(scoreColor(40)).toBe("text-orange-600");
    expect(scoreColor(39)).toBe("text-rose-600");
  });
});
