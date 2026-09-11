/**
 * The request the editor sends when somebody presses «Enviar».
 *
 * A module of its own for one function, because that function is where two absences have to be
 * told apart and getting it wrong is invisible until a target rejects the request: the API reads
 * `body: null` as «no envíes cuerpo» and `body: {}` as «envía uno vacío», and a form that has
 * never been touched holds `{}` for both. The editor's rule is the same one the row uses — an
 * object with no keys is no body.
 */
import type { RequestTemplateView } from "@/lib/types";

export type PreviewRequestBody = {
  environmentId: string;
  name: string;
  operationId: string;
  expectedStatus: number;
  parameters: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
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
    body: template.body && Object.keys(template.body).length ? template.body : null,
    auth: template.auth,
  };
}
