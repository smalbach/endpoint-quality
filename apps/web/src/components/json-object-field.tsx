import { useEffect, useState } from "react";

import { Field, inputClass } from "@/components/ui";

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
}: {
  label: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Field label={`${label} JSON`} error={error ?? undefined}>
      <textarea
        className={`${inputClass} h-20 font-mono text-[10px]`}
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(text) as Record<string, unknown>);
            setError(null);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "JSON inválido");
          }
        }}
      />
    </Field>
  );
}
