/**
 * The pieces shared by the two places a project file is handled: the settings page, which exports
 * and imports any part, and the flows drawer, which exports one flow and imports flows.
 */
import { ApiError } from "@/lib/api";
import { BUNDLE_PART_META, describeImport } from "@/lib/project-bundle";
import type { ProjectBundleImportResultView, ProjectBundlePart } from "@/lib/types";

export function PartPicker({
  parts,
  selected,
  onChange,
  counts,
}: {
  parts: ProjectBundlePart[];
  selected: Set<ProjectBundlePart>;
  onChange: (next: Set<ProjectBundlePart>) => void;
  counts?: Partial<Record<ProjectBundlePart, number>>;
}) {
  const toggle = (part: ProjectBundlePart) => {
    const next = new Set(selected);
    if (next.has(part)) next.delete(part);
    else next.add(part);
    onChange(next);
  };
  return (
    <div className="mt-3 grid gap-1 sm:grid-cols-2">
      {parts.map((part) => (
        <label key={part} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50">
          <input type="checkbox" className="mt-0.5" checked={selected.has(part)} onChange={() => toggle(part)} />
          <span>
            <span className="font-medium text-slate-700">
              {BUNDLE_PART_META[part].label}
              {counts?.[part] !== undefined && part !== "settings" ? ` (${counts[part]})` : ""}
            </span>
            <span className="block text-[11px] text-slate-400">{BUNDLE_PART_META[part].hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** What was written and, listed, what was deliberately not: secrets to retype, duplicates left alone. */
export function ImportOutcome({ result }: { result: ProjectBundleImportResultView }) {
  return (
    <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
      <p>Importado: {describeImport(result)}.</p>
      {result.skipped.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-800">
          {result.skipped.map((entry, index) => (
            <li key={index}>
              <span className="font-medium">{entry.what}</span> · {entry.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A refused file names the pieces that are wrong, so it can be fixed rather than guessed at. */
export function ImportProblems({ error }: { error: Error }) {
  const fields = error instanceof ApiError ? error.fields : [];
  return (
    <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
      <p>{error.message}</p>
      {fields.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
          {fields.slice(0, 10).map((field, index) => (
            <li key={index}>
              {field.field}: {field.detail}
            </li>
          ))}
          {fields.length > 10 && <li>…y {fields.length - 10} más</li>}
        </ul>
      )}
    </div>
  );
}
