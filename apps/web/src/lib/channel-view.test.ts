import { describe, expect, test } from "vitest";

import {
  MAX_SAVED_MESSAGES,
  filterMessages,
  gap,
  mergeMessage,
  prettyBody,
  stopText,
  visibleMessages,
  withSavedMessage,
} from "@/lib/channel-view";
import type { ChannelMessageView } from "@/lib/types";

const message = (seq: number, patch: Partial<ChannelMessageView> = {}): ChannelMessageView => ({
  seq,
  direction: "in",
  atMs: seq * 10,
  kind: "text",
  body: "",
  bytes: 0,
  truncated: false,
  ...patch,
});

describe("cómo se lee una conversación", () => {
  test("huecos y no relojes: el tiempo desde el mensaje anterior", () => {
    expect(gap(12, null)).toBe("+12 ms");
    expect(gap(3_212, 12)).toBe("+3,2 s");
  });

  test("el motivo de parada en palabras, con el tope cuando se sabe", () => {
    expect(stopText("idle-cap")).toBe("se cortó: demasiado tiempo sin mensajes");
    expect(stopText("message-cap", { maxMessages: 200 })).toBe("se cortó: tope de 200 mensajes");
    expect(stopText(null)).toBe("");
  });

  test("un JSON se enseña sangrado; lo demás, tal cual", () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody("hola")).toBe("hola");
    expect(prettyBody("{no es json")).toBe("{no es json");
  });

  test("cada mensaje una vez y en orden, aunque la instantánea y el stream se solapen", () => {
    const merged = [message(2), message(0), message(1), message(1)].reduce(mergeMessage, [] as ChannelMessageView[]);
    expect(merged.map((row) => row.seq)).toEqual([0, 1, 2]);
  });

  test("la apertura y el cierre no son filas de la conversación", () => {
    const rows = visibleMessages([
      message(0, { direction: "open" }),
      message(1),
      message(2, { direction: "out" }),
      message(3, { direction: "close" }),
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  test("el filtro busca en el cuerpo sin mayúsculas, y los errores pasan cualquier dirección", () => {
    const rows = [
      message(1, { body: '{"type":"Welcome"}' }),
      message(2, { direction: "out", body: '{"type":"subscribe"}' }),
      message(3, { direction: "error", body: "la conexión se rompió" }),
    ];
    const seqs = (text: string, direction: "all" | "in" | "out") =>
      filterMessages(rows, { text, direction }).map((row) => row.seq);
    expect(seqs("", "all")).toEqual([1, 2, 3]);
    expect(seqs("welcome", "all")).toEqual([1]);
    // Filtrar por «recibidos» y no ver el error sería esconder por qué no llega nada.
    expect(seqs("", "in")).toEqual([1, 3]);
    expect(seqs("", "out")).toEqual([2, 3]);
    expect(seqs("subscribe", "in")).toEqual([]);
  });
});

describe("la biblioteca de tramas", () => {
  test("una trama nueva se añade al final", () => {
    expect(withSavedMessage([{ name: "ping", body: "p" }], { name: " auth ", body: "{}" })).toEqual([
      { name: "ping", body: "p" },
      { name: "auth", body: "{}" },
    ]);
  });

  test("la del mismo nombre se sustituye: dos botones «auth» que mandan cosas distintas no sirven", () => {
    expect(
      withSavedMessage(
        [
          { name: "auth", body: "vieja" },
          { name: "ping", body: "p" },
        ],
        { name: "auth", body: "nueva" },
      ),
    ).toEqual([
      { name: "auth", body: "nueva" },
      { name: "ping", body: "p" },
    ]);
  });

  test("llena, no cabe una más, y no se tira la más vieja por su cuenta", () => {
    const full = Array.from({ length: MAX_SAVED_MESSAGES }, (_, index) => ({ name: `t${index}`, body: "" }));
    expect(withSavedMessage(full, { name: "otra", body: "" })).toBeNull();
    // Sustituir sí se puede: no crece.
    expect(withSavedMessage(full, { name: "t0", body: "x" })?.[0]).toEqual({ name: "t0", body: "x" });
  });
});
