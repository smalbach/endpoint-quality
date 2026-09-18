/**
 * El autocompletado de la operación GraphQL: lo que el esquema permite escribir donde está el cursor.
 *
 * Va **por dentro** de `VariableSuggest` y no en su lugar: recibe las props que este le da al cuadro
 * de texto, se queda con las teclas mientras su lista está abierta y le pasa todo lo demás. Las dos
 * listas no se abren a la vez porque `suggestionsAt` no ofrece nada con el cursor dentro de un
 * `{{`, que es justo donde se abre la otra.
 *
 * Se abre al escribir una palabra, `$`, `@` o `(` —no al mover el cursor, ni tras un salto de
 * línea—, y con Ctrl+Espacio en cualquier sitio, como en Postman. Una lista que apareciera con
 * cada tecla taparía la operación que se está escribiendo.
 *
 * Solo lo importa el editor GraphQL, así que viaja en su trozo con `graphql`.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";

import type { VariableSuggest } from "@/components/variable-suggest";
import { cn } from "@/lib/format";
import type { GraphQLSchema } from "@/lib/graphql-schema";
import { applyGraphqlSuggestion, suggestionsAt, type GraphqlSuggestion } from "@/lib/graphql-suggestions";

/** Lo que `VariableSuggest` le da al cuadro de texto: se recibe, se envuelve y se entrega igual. */
type FieldProps = Parameters<ComponentProps<typeof VariableSuggest>["children"]>[0];
type Field = Parameters<FieldProps["ref"]>[0];

/** Lo que abre la lista al escribirlo justo antes del cursor. */
const OPENS = /[_A-Za-z0-9$@(]$/;

/**
 * La caja de la operación en `graphql-body-editor`: `p-3`, `leading-5`, `text-[11px]` monoespaciada.
 * La lista se coloca bajo la línea del cursor con estas medidas en vez de medir el texto: un cuadro
 * de texto no dice dónde pinta cada carácter, y una línea que se parte la desplaza como mucho una fila.
 */
const PADDING = 12;
const LINE = 20;
const CHAR = 11 * 0.6;
const LIST_WIDTH = 288;

export function GraphqlSuggest({
  schema,
  field: inner,
  children,
}: {
  schema: GraphQLSchema | null;
  field: FieldProps;
  children: (props: FieldProps & { onClick: () => void }) => ReactNode;
}) {
  const field = useRef<Field>(null);
  const [open, setOpen] = useState<{ caret: number; top: number; left: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const value = inner.value;

  /** Como en `VariableSuggest`: el cursor se coloca cuando el cuadro ya tiene el texto nuevo. */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !field.current) return;
    field.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const found = useMemo(
    () => (open && schema ? suggestionsAt(schema, value, open.caret) : null),
    [open, schema, value],
  );
  const items = found?.items ?? [];
  // Si lo único que ofrece es lo que ya está escrito, la lista solo se comería el Enter del salto de
  // línea que viene detrás.
  const showing = items.length > 0 && !items.every((item) => item.insert === found?.word);

  useLayoutEffect(() => {
    list.current?.children[highlighted]?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  /** Abre (o cierra) la lista donde está el cursor ahora; `always` es Ctrl+Espacio. */
  function track(always: boolean) {
    const element = field.current;
    if (!element || !schema) return;
    const caret = element.selectionStart ?? 0;
    const before = element.value.slice(0, caret);
    if (!always && !OPENS.test(before)) {
      setOpen(null);
      return;
    }
    const lines = before.split("\n");
    const word = /[_A-Za-z0-9$@]*$/.exec(before)?.[0].length ?? 0;
    const column = lines[lines.length - 1].length - word;
    const height = element.clientHeight;
    const width = element.clientWidth;
    let top = PADDING + lines.length * LINE - element.scrollTop + 2;
    if (height) top = Math.min(Math.max(top, LINE), height);
    let left = PADDING + column * CHAR - element.scrollLeft;
    if (width) left = Math.max(0, Math.min(left, width - LIST_WIDTH));
    setOpen({ caret, top, left });
    setHighlighted(0);
  }

  function accept(item: GraphqlSuggestion) {
    if (!found) return;
    const applied = applyGraphqlSuggestion(value, found, item);
    pendingCaret.current = applied.caret;
    inner.onChange({ target: { value: applied.text } });
    setOpen(null);
  }

  return (
    <div className="relative">
      {children({
        ...inner,
        ref: (element) => {
          field.current = element;
          inner.ref(element);
        },
        onChange: (event) => {
          inner.onChange(event);
          // Al fotograma siguiente, como `VariableSuggest`: ahora el cuadro aún tiene el texto viejo.
          window.requestAnimationFrame(() => track(false));
        },
        onKeyDown: (event) => {
          if (event.key === " " && event.ctrlKey) {
            event.preventDefault();
            track(true);
            return;
          }
          if (!showing) {
            // Mover el cursor deja atrás la palabra por la que se abrió la lista.
            if (open && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              setOpen(null);
            }
            inner.onKeyDown(event);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : items.length - 1;
            setHighlighted((current) => (current + step) % items.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            accept(items[Math.min(highlighted, items.length - 1)]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(null);
          } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            setOpen(null);
            inner.onKeyDown(event);
          } else {
            inner.onKeyDown(event);
          }
        },
        onClick: () => setOpen(null),
        onBlur: () => {
          inner.onBlur();
          // Con retraso por lo mismo que `VariableSuggest`: el clic en una sugerencia llega después.
          window.setTimeout(() => setOpen(null), 120);
        },
      })}

      {showing && open && (
        <ul
          ref={list}
          aria-label="Sugerencias del esquema"
          className="absolute z-20 max-h-56 w-72 overflow-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg"
          style={{ top: open.top, left: open.left }}
        >
          {items.map((item, index) => {
            const active = index === highlighted;
            return (
              <li key={item.label}>
                <button
                  type="button"
                  aria-label={item.label}
                  className={cn(
                    "block w-full px-2 py-1 text-left",
                    active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50",
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(item);
                  }}
                >
                  <span className="flex items-baseline gap-2 font-mono text-[11px]">
                    <span className={cn("truncate", item.deprecated && "line-through opacity-60")}>{item.label}</span>
                    {item.type && (
                      <span className={cn("ml-auto shrink-0", active ? "text-slate-300" : "text-slate-400")}>
                        {item.type}
                      </span>
                    )}
                  </span>
                  {item.description && (
                    <span
                      className={cn("block truncate text-[10px]", active ? "text-slate-300" : "text-slate-400")}
                      title={item.description}
                    >
                      {item.description}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
