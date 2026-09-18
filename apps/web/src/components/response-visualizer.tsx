/**
 * The «Visualizar» tab of a response: what the post script drew with `pm.visualizer.set`.
 *
 * Loaded apart from the editor (see `ResponsePanel`): it carries Handlebars as text, ~90 kB that
 * only whoever opens the tab needs. The rendering itself happens in the frame, never here — see
 * `lib/visualizer-frame` for why.
 */
import { useMemo } from "react";
import handlebarsSource from "handlebars/dist/handlebars.min.js?raw";

import { frameDocument, type Visualization } from "@/lib/visualizer-frame";

export default function ResponseVisualizer({ visualization }: { visualization: Visualization | null }) {
  const document = useMemo(
    () => (visualization ? frameDocument(visualization, handlebarsSource) : null),
    [visualization],
  );
  if (!document)
    return (
      <div className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
        <p>Sin visualización. El script posterior la dibuja con una plantilla Handlebars y sus datos:</p>
        <code className="mt-1 inline-block font-mono text-[10px] text-slate-500">
          {"pm.visualizer.set('<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>', pm.response.json())"}
        </code>
      </div>
    );
  return (
    <div className="mt-2 resize-y overflow-hidden rounded-xl border border-slate-200 bg-white" style={{ height: 420 }}>
      <iframe
        title="Visualización"
        // Scripts yes, and nothing else: no same origin, so no cookies, storage or access to this
        // page; no popups, no top navigation, no forms.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={document}
        className="h-full w-full"
      />
    </div>
  );
}
