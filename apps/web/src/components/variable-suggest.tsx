import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/format";
import { applySuggestion, openTokenAt, suggestionsFor } from "@/lib/variable-suggestions";

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * The names, offered where the `{{` is being typed.
 *
 * The engine has interpolated `{{nombre}}` from the start and the editor never helped: the names
 * live on the environments screen, so writing one meant remembering it exactly. Getting it wrong
 * is not a typo anybody sees — it is a run that goes out with `{{userID}}` in the path and comes
 * back 404, and only the `config` failure kind saves it from reading as a broken endpoint.
 *
 * A render prop rather than a wrapped `<input>`, because the fields it has to serve are not the
 * same element: the parameter rows are inputs, a raw body is a textarea, and each of them already
 * carries its own classes, `aria-label` and placeholder. The child gets `value`, `onChange`,
 * `onKeyDown`, `onBlur` and a `ref`; everything else is the caller's.
 *
 * What it deliberately does not do is filter as a combobox would. The list appears only while a
 * token is open, so typing ordinary text never puts a dropdown over the form — which is what made
 * the first version unusable in a field where most of what is typed is a path.
 */
export function VariableSuggest({
  variables,
  value,
  onChange,
  children,
}: {
  variables: string[];
  value: string;
  onChange: (value: string) => void;
  children: (props: {
    ref: (element: Field | null) => void;
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    onKeyDown: (event: React.KeyboardEvent<Field>) => void;
    onBlur: () => void;
  }) => ReactNode;
}) {
  const field = useRef<Field | null>(null);
  const [open, setOpen] = useState<{ caret: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  /**
   * Where the caret should be after a suggestion is written in.
   *
   * Applied in a layout effect and not right after `onChange`, because at that moment the field
   * still holds the old text: React has not re-rendered it yet, so setting the selection would
   * place it against a string that is about to be replaced — and the browser then puts it at the
   * end, which is the wrong place in `{{id}}/detalle`.
   */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !field.current) return;
    field.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const token = open ? openTokenAt(value, open.caret) : null;
  const matches = token && variables.length ? suggestionsFor(variables, token.query) : [];
  const showing = matches.length > 0;

  function accept(name: string) {
    if (!token || !open) return;
    const applied = applySuggestion(value, token, open.caret, name);
    pendingCaret.current = applied.caret;
    onChange(applied.text);
    setOpen(null);
  }

  function trackCaret() {
    // Read from the element and not from the event: `selectionStart` after a paste or an arrow key
    // is the only thing that knows where the caret actually ended up.
    const caret = field.current?.selectionStart ?? 0;
    setOpen({ caret });
    setHighlighted(0);
  }

  return (
    <div className="relative">
      {children({
        ref: (element) => {
          field.current = element;
        },
        value,
        onChange: (event) => {
          onChange(event.target.value);
          // After the state change, so the caret read is the one the new text will have.
          window.requestAnimationFrame(trackCaret);
        },
        onKeyDown: (event) => {
          if (!showing) {
            // Arrow keys and clicks move the caret without changing the text, and the token under
            // it changes with them. Tracked on the next frame, when the move has happened.
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              window.requestAnimationFrame(trackCaret);
            }
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
            setHighlighted((current) => (current + step) % matches.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            // Enter in a one-line field would submit, and Tab would leave for the next one. While
            // the list is up they mean «esta», which is what they mean in every editor.
            event.preventDefault();
            accept(matches[highlighted]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(null);
          }
        },
        // A frame's delay, because a click on a suggestion blurs the field before the click lands.
        onBlur: () => window.setTimeout(() => setOpen(null), 120),
      })}

      {showing && (
        <ul className="absolute top-full right-0 left-0 z-20 mt-0.5 max-h-40 overflow-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg">
          {matches.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                className={cn(
                  "block w-full px-2 py-1 text-left font-mono text-[11px]",
                  index === highlighted ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
                )}
                // `onMouseDown` and not `onClick`: the click would arrive after the blur that
                // closes the list, so by then there is nothing left to click.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(name);
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
