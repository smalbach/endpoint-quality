/**
 * The document a `pm.visualizer.set` renders in: its template, its data and Handlebars, in one page.
 *
 * Everything that runs the template runs **inside the frame**. The template is code — Handlebars
 * compiles it to a function, and a `<script>` in it runs as written — and it comes from a script
 * anybody with edit rights wrote or an imported collection brought. So it never touches this page:
 * the frame is `sandbox="allow-scripts"` without `allow-same-origin`, an opaque origin with no
 * cookies, no storage and no reach into the app that holds the session. Postman draws it the same
 * way, and templates written for it — `pm.getData`, a chart library from a CDN — work unchanged.
 */
import type { ScriptRunView } from "@/lib/types";

export type Visualization = NonNullable<ScriptRunView["visualization"]>;

/**
 * A value as a JavaScript literal that is safe inside `<script>`: JSON, with `<` escaped so no
 * `</script>` in the data can close the element early, and the two line separators JSON allows but
 * older parsers did not.
 */
const literal = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Runs in the frame. `document.write` while the page is still being parsed inserts the rendered
 * template right after this script, so its own `<script>` elements run as a normal page's would.
 * `pm.getData` answers asynchronously, as Postman's does: templates call it expecting that.
 */
const BOOT = `(function () {
  var template = __TEMPLATE__;
  var data = JSON.parse(__DATA__);
  var options = JSON.parse(__OPTIONS__);
  window.pm = {
    getData: function (callback) {
      setTimeout(function () { callback(null, data); }, 0);
    }
  };
  var html;
  try {
    html = Handlebars.compile(template, options)(data);
  } catch (error) {
    var message = String((error && error.message) || error).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
    html = '<pre style="color:#be123c;white-space:pre-wrap;font:12px monospace">La plantilla no se pudo dibujar: ' + message + "</pre>";
  }
  document.write(html);
})();`;

export function frameDocument(visualization: Visualization, handlebarsSource: string): string {
  const boot = BOOT.replace("__TEMPLATE__", () => literal(visualization.template))
    .replace("__DATA__", () => literal(visualization.data))
    .replace("__OPTIONS__", () => literal(visualization.options));
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">',
    "<style>body{font:13px system-ui,sans-serif;margin:12px;color:#0f172a}</style>",
    `<script>${handlebarsSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    "</head><body>",
    `<script>${boot}</script>`,
    "</body></html>",
  ].join("\n");
}
