import { useEffect, useState } from "react";

import { Field, inputClass } from "@/components/ui";
import { VariableSuggest } from "@/components/variable-suggest";

/**
 * A JSON object edited as text, parsed on blur.
 *
 * On blur and not on every keystroke: half a JSON object is invalid JSON, and reporting that while
 * somebody is still typing it makes the field shout at every character.
 */
export function JsonObjectField({
  label,
  value,
  onChange,
  variables = [],
}: {
  label: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** What `{{` can name here. A JSON payload is where most variables are spent, and the suggestion
   * list reads the text being typed rather than the parsed object — it has to, because half a JSON
   * object does not parse and that is exactly when somebody is writing a name. */
  variables?: string[];
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Field label={`${label} JSON`} error={error ?? undefined}>
      <VariableSuggest variables={variables} value={text} onChange={setText}>
        {(suggest) => (
          <textarea
            {...suggest}
            className={`${inputClass} h-20 font-mono text-[10px]`}
            spellCheck={false}
            onBlur={() => {
              // The suggestions close on their own blur; this one is the parse, and it has to run
              // whether or not a list was open.
              suggest.onBlur();
              try {
                onChange(JSON.parse(text) as Record<string, unknown>);
                setError(null);
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "JSON inválido");
              }
            }}
          />
        )}
      </VariableSuggest>
    </Field>
  );
}
