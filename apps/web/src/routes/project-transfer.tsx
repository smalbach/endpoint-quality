import { useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card } from "@/components/ui";
import { ImportOutcome, ImportProblems, PartPicker } from "@/components/project-transfer";
import { BUNDLE_PARTS, bundleFileName, downloadJson, readBundle, type BundleFile } from "@/lib/project-bundle";
import { formatDate } from "@/lib/format";
import type { ProjectBundleImportResultView, ProjectBundlePart, ProjectSummary } from "@/lib/types";

/**
 * Exporting the project to a JSON file and importing one.
 *
 * Next to the copy between projects rather than instead of it: that one only reaches projects of
 * this organization on this server, and a file reaches everything else — another installation, a
 * backup, a colleague's laptop.
 */
export function ProjectTransferPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(base),
  });

  if (!canEdit) {
    return (
      <Card className="max-w-2xl p-4 text-xs text-slate-500">
        Exportar e importar un proyecto necesita permiso de edición.
      </Card>
    );
  }
  return (
    <div className="max-w-2xl space-y-4">
      <ExportCard base={base} projectName={project.data?.name ?? "proyecto"} />
      <ImportCard base={base} archived={Boolean(project.data?.archivedAt)} />
    </div>
  );
}

function ExportCard({ base, projectName }: { base: string; projectName: string }) {
  const [parts, setParts] = useState<Set<ProjectBundlePart>>(new Set(BUNDLE_PARTS));
  const exporter = useMutation({
    mutationFn: () => api<unknown>(`${base}/export?parts=${BUNDLE_PARTS.filter((part) => parts.has(part)).join(",")}`),
    onSuccess: (bundle) => downloadJson(bundleFileName(projectName), bundle),
  });
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Exportar</p>
      <p className="mt-1 text-xs text-slate-500">
        Descarga el proyecto como un fichero JSON para guardarlo, llevarlo a otra instalación o importarlo en otro
        proyecto. No lleva credenciales, ni el login del proyecto, ni el valor de las variables sensibles: viajan con su
        nombre y vacías.
      </p>
      <PartPicker parts={BUNDLE_PARTS} selected={parts} onChange={setParts} />
      <Button className="mt-3" disabled={!parts.size || exporter.isPending} onClick={() => exporter.mutate()}>
        {exporter.isPending ? "Preparando…" : "Descargar .json"}
      </Button>
      {exporter.error && <p className="mt-2 text-[11px] text-rose-700">{exporter.error.message}</p>}
    </Card>
  );
}

function ImportCard({ base, archived }: { base: string; archived: boolean }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<BundleFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [parts, setParts] = useState<Set<ProjectBundlePart>>(new Set());

  const importer = useMutation({
    mutationFn: (chosen: BundleFile) =>
      api<ProjectBundleImportResultView>(`${base}/import-bundle`, {
        method: "POST",
        body: { bundle: chosen.bundle, parts: chosen.parts.filter((part) => parts.has(part)) },
      }),
    // Everything a file can touch is cached somewhere else in the app.
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    importer.reset();
    if (!picked) return;
    const read = readBundle(await picked.text());
    if (!read.ok) {
      setFile(null);
      setFileError(read.error);
      return;
    }
    setFileError(null);
    setFile(read.file);
    setParts(new Set(read.file.parts));
  }

  const replaces = parts.has("settings") || parts.has("config");
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Importar</p>
      <p className="mt-1 text-xs text-slate-500">
        Trae a este proyecto lo que elijas de un fichero exportado. Se valida entero antes de escribir: si algo no es
        válido no se importa nada. Los nombres repetidos se numeran y los endpoints que ya existen se dejan como están.
      </p>
      {archived ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          El proyecto está archivado. Restáuralo para importar.
        </p>
      ) : (
        <label className="mt-3 block">
          <span className="sr-only">Elegir fichero</span>
          <input
            type="file"
            accept=".json,application/json"
            disabled={importer.isPending}
            className="block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-2 file:py-1 file:text-white"
            onChange={(event) => void onFile(event)}
          />
        </label>
      )}
      {fileError && <p className="mt-2 text-[11px] text-rose-700">{fileError}</p>}

      {file && !archived && (
        <div className="mt-3">
          <p className="text-xs text-slate-600">
            {file.projectName ? `Exportado de «${file.projectName}»` : "Fichero de proyecto"}
            {file.exportedAt ? ` el ${formatDate(file.exportedAt)}` : ""}.
          </p>
          <PartPicker parts={file.parts} selected={parts} onChange={setParts} counts={file.counts} />
          {replaces && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Los ajustes y las secciones de configuración del fichero sustituyen a los de este proyecto.
            </p>
          )}
          <Button className="mt-3" disabled={!parts.size || importer.isPending} onClick={() => importer.mutate(file)}>
            {importer.isPending ? "Importando…" : "Importar"}
          </Button>
        </div>
      )}
      {importer.error && <ImportProblems error={importer.error} />}
      {importer.data && <ImportOutcome result={importer.data} />}
    </Card>
  );
}
