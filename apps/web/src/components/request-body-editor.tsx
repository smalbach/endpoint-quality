import { useRef } from "react";

import { JsonObjectField } from "@/components/json-object-field";
import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { inputClass } from "@/components/ui";
import { VariableSuggest } from "@/components/variable-suggest";
import { fieldMapsFrom, fieldProblems, fieldRowsFrom } from "@/lib/request-fields";
import type { RequestBodyView } from "@/lib/types";

/**
 * The payload of a request, and the five things it can be.
 *
 * The editor used to show one textarea holding JSON, which is what the generated matrix sends and
 * not what an API asks for: a login is very often `x-www-form-urlencoded`, a webhook is tested by
 * posting the exact XML its provider sends, and neither fits in a JSON object.
 *
 * Switching type **keeps what the other types hold**. Somebody comparing «lo mismo como JSON y
 * como formulario» switches back and forth, and a selector that wiped the field each time would
 * make that a retype rather than a comparison — so the previous variants are carried in state and
 * only the selected one is what gets saved.
 */
const TYPES: { value: RequestBodyView["type"]; label: string }[] = [
  { value: "none", label: "Sin cuerpo" },
  { value: "json", label: "JSON" },
  { value: "raw", label: "Texto" },
  { value: "form-data", label: "form-data" },
  { value: "x-www-form-urlencoded", label: "urlencoded" },
];

/** What the «Texto» option offers, which is most of what people paste into it. The field stays a
 * free text box: a target that wants `application/vnd.acme+json` is exactly the case this type
 * exists for, and a closed list would send it back to JSON. */
const RAW_TYPES = ["application/json", "text/plain", "application/xml", "text/csv", "text/html"];

export function RequestBodyEditor({
  body,
  canEdit,
  onChange,
  variables = [],
}: {
  body: RequestBodyView;
  canEdit: boolean;
  onChange: (body: RequestBodyView) => void;
  /** What `{{` can name here: the environment's variables plus what the steps this one depends on
   * capture. A payload is where most of them are spent. */
  variables?: string[];
}) {
  const rows =
    body.type === "form-data" || body.type === "x-www-form-urlencoded"
      ? fieldRowsFrom(body.fields, body.disabledFields)
      : [];

  /**
   * What the other types held before the selector moved.
   *
   * A ref and not state: it is not rendered, so writing to it must not re-render — and it is not
   * saved either, which is the point. Only the selected variant reaches the row; the rest live as
   * long as this panel is open, which is exactly as long as somebody is comparing «lo mismo como
   * JSON y como formulario».
   */
  const remembered = useRef<Partial<Record<RequestBodyView["type"], RequestBodyView>>>({});
  remembered.current[body.type] = body;
  const switchTo = (type: RequestBodyView["type"]) => onChange(remembered.current[type] ?? emptyOf(type));

  return (
    <div className="mt-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-slate-600">Cuerpo</span>
        <select
          aria-label="Tipo de cuerpo"
          className="ml-auto h-6 rounded-md border border-slate-200 bg-white px-1 text-[10px] text-slate-600"
          value={body.type}
          disabled={!canEdit}
          onChange={(event) => switchTo(event.target.value as RequestBodyView["type"])}
        >
          {TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      {body.type === "none" && (
        <p className="mt-1 text-[10px] leading-4 text-slate-400">
          No se manda nada. No es lo mismo que un JSON vacío: hay destinos que rechazan un cuerpo de longitud cero y el
          error no dice por qué.
        </p>
      )}

      {body.type === "json" && (
        <JsonObjectField
          label="Body"
          value={body.json}
          variables={variables}
          onChange={(json) => onChange({ type: "json", json })}
        />
      )}

      {body.type === "raw" && (
        <div className="mt-1">
          <input
            aria-label="Content-Type"
            className={`${inputClass} h-7 font-mono text-[11px]`}
            value={body.contentType}
            list="eq-raw-content-types"
            placeholder="application/xml"
            disabled={!canEdit}
            spellCheck={false}
            onChange={(event) => onChange({ ...body, contentType: event.target.value })}
          />
          <datalist id="eq-raw-content-types">
            {RAW_TYPES.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <VariableSuggest variables={variables} value={body.text} onChange={(text) => onChange({ ...body, text })}>
            {(suggest) => (
              <textarea
                {...suggest}
                aria-label="Cuerpo en texto"
                className={`${inputClass} mt-1 h-24 font-mono text-[10px]`}
                placeholder={"<pedido>\n  <id>{{pedidoId}}</id>\n</pedido>"}
                disabled={!canEdit}
                spellCheck={false}
              />
            )}
          </VariableSuggest>
        </div>
      )}

      {(body.type === "form-data" || body.type === "x-www-form-urlencoded") && (
        <RequestFieldsEditor
          label="Campos"
          hint={
            body.type === "form-data"
              ? "Solo texto: subir un fichero necesitaría bytes que este editor no tiene."
              : "Se codifican al enviar, después de sustituir las variables."
          }
          rows={rows}
          problems={fieldProblems(rows, "parameter")}
          namePlaceholder="usuario"
          valuePlaceholder="{{email}}"
          disabled={!canEdit}
          onChange={(next) => {
            const maps = fieldMapsFrom(next);
            onChange({ ...body, fields: maps.enabled, disabledFields: maps.disabled });
          }}
          variables={variables}
        />
      )}
    </div>
  );
}

/** A body of the chosen type with nothing in it. Written out rather than assembled, because each
 * variant carries different fields and a partial one is the state the union exists to forbid. */
export function emptyOf(type: RequestBodyView["type"]): RequestBodyView {
  if (type === "json") return { type: "json", json: {} };
  if (type === "raw") return { type: "raw", text: "", contentType: "application/json" };
  if (type === "none") return { type: "none" };
  return { type, fields: {}, disabledFields: {} };
}
