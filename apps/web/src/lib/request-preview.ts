/**
 * The request the editor sends when somebody presses «Enviar».
 *
 * A module of its own for one function, because that function is where the form stops being a form
 * and becomes a request, and the two edges of that are invisible until a target rejects it: a
 * half-typed parameter name with no value is a row in progress and not an instruction to send
 * `?=`, and a row somebody switched off is simply not in what gets sent — it lives in the
 * `disabled…` map, which nothing here reads.
 *
 * The body travels whole, tag and all: `{ type: "none" }` is «no envíes cuerpo» and a `json` body
 * of `{}` is «envía uno vacío», and those are two different requests against plenty of targets.
 */
import type { RequestBodyView, RequestTemplateView } from "@/lib/types";

export type PreviewRequestBody = {
  environmentId: string;
  name: string;
  operationId: string;
  expectedStatus: number;
  parameters: Record<string, string>;
  headers: Record<string, string>;
  body: RequestBodyView;
  auth: string;
};

export function previewBodyFor(template: RequestTemplateView, environmentId: string): PreviewRequestBody {
  return {
    environmentId,
    name: template.name,
    operationId: template.operationId,
    expectedStatus: template.expectedStatus,
    // The blanks are dropped here rather than on the server: a half-typed parameter name with no
    // value is a form in progress, not an instruction to send `?=`.
    parameters: Object.fromEntries(
      Object.entries(template.parameters ?? {}).filter(([name, value]) => name.trim() !== "" && value !== ""),
    ),
    // Only the switched-on ones travel, and that needs no filtering here: what is off is stored in
    // `disabledHeaders`, a map this function never reads. A blank name is still dropped, for the
    // same reason a blank parameter is — it is a row being typed, not an instruction.
    headers: Object.fromEntries(
      Object.entries(template.headers ?? {}).filter(([name, value]) => name.trim() !== "" && value !== ""),
    ),
    body: template.body,
    auth: template.auth,
  };
}
