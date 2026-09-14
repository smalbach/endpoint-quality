/**
 * Code scan: connect a repo or upload files, scan, read the diff and impact, and import.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { cn, formatDate } from "@/lib/format";
import type { CodeConnectorView, CodeScanDetailView, CodeScanSummaryView } from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

const STATUS_CLASS: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function CodeScanPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);

  const [form, setForm] = useState({ repo: "", branch: "main", basePath: "", prefix: "", token: "" });
  const [tokenTouched, setTokenTouched] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [createRoles, setCreateRoles] = useState(false);

  const connector = useQuery({
    queryKey: ["connector", projectId],
    enabled,
    queryFn: () => api<CodeConnectorView | null>(`${base}/code-scan/connector`),
  });
  const scans = useQuery({
    queryKey: ["scans", projectId],
    enabled,
    queryFn: () => api<CodeScanSummaryView[]>(`${base}/code-scan/scans`),
  });
  const scan = useQuery({
    queryKey: ["scan", projectId, selectedId],
    enabled: enabled && Boolean(selectedId),
    queryFn: () => api<CodeScanDetailView>(`${base}/code-scan/scans/${selectedId}`),
  });

  useEffect(() => {
    if (!connector.data) return;
    setForm({
      repo: connector.data.repo,
      branch: connector.data.branch || "main",
      basePath: connector.data.basePath,
      prefix: connector.data.prefix,
      token: "",
    });
  }, [connector.data]);

  const invalidateScans = () => queryClient.invalidateQueries({ queryKey: ["scans", projectId] });

  const saveConnector = useMutation({
    mutationFn: () =>
      api<{ connectorId: string }>(`${base}/code-scan/connector`, {
        method: "PUT",
        body: {
          repo: form.repo,
          branch: form.branch,
          basePath: form.basePath,
          prefix: form.prefix,
          // Only send the token when someone typed in the field, so a save that did not touch it
          // keeps the stored one.
          ...(tokenTouched ? { token: form.token } : {}),
        },
      }),
    onSuccess: () => {
      setTokenTouched(false);
      void queryClient.invalidateQueries({ queryKey: ["connector", projectId] });
    },
  });
  const scanGithub = useMutation({
    mutationFn: () => api<{ scanId: string }>(`${base}/code-scan/scans`, { method: "POST", body: {} }),
    onSuccess: async ({ scanId }) => {
      await invalidateScans();
      setSelectedId(scanId);
    },
  });
  const scanUpload = useMutation({
    mutationFn: (files: { path: string; content: string }[]) =>
      api<{ scanId: string }>(`${base}/code-scan/scans/upload`, {
        method: "POST",
        body: { files, prefix: form.prefix },
      }),
    onSuccess: async ({ scanId }) => {
      await invalidateScans();
      setSelectedId(scanId);
    },
  });
  const importScan = useMutation({
    mutationFn: () =>
      api<{ created: number; updated: number; rolesCreated: number }>(`${base}/code-scan/scans/${selectedId}/import`, {
        method: "POST",
        body: { createRoles },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["endpoints", projectId] }),
  });

  async function onFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    const files = await Promise.all(
      [...fileList].map(async (file) => ({ path: file.name, content: await file.text() })),
    );
    scanUpload.mutate(files);
  }

  if (connector.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h1 className="text-base font-semibold text-slate-900">Escáner de código</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
          Lee los controladores NestJS y compara sus rutas, guards y roles con lo que el proyecto tiene. El código se
          lee desde el servidor, detrás del guard SSRF; el token del repositorio se guarda cifrado y no se muestra.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Repositorio de GitHub</p>
            <div className="mt-2 space-y-2">
              <Field label="owner/repo">
                <input
                  className={inputClass}
                  value={form.repo}
                  disabled={!canEdit}
                  placeholder="acme/api"
                  onChange={(event) => setForm({ ...form, repo: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Rama">
                  <input
                    className={inputClass}
                    value={form.branch}
                    disabled={!canEdit}
                    onChange={(event) => setForm({ ...form, branch: event.target.value })}
                  />
                </Field>
                <Field label="Prefijo global">
                  <input
                    className={inputClass}
                    value={form.prefix}
                    disabled={!canEdit}
                    placeholder="api"
                    onChange={(event) => setForm({ ...form, prefix: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="Base path">
                <input
                  className={inputClass}
                  value={form.basePath}
                  disabled={!canEdit}
                  placeholder="apps/api/src"
                  onChange={(event) => setForm({ ...form, basePath: event.target.value })}
                />
              </Field>
              <Field label="Token">
                <input
                  className={inputClass}
                  type="password"
                  value={form.token}
                  disabled={!canEdit}
                  placeholder={
                    connector.data?.tokenSet ? "•••••••• (guardado)" : "ghp_… (opcional para repos públicos)"
                  }
                  onChange={(event) => {
                    setTokenTouched(true);
                    setForm({ ...form, token: event.target.value });
                  }}
                />
              </Field>
            </div>
            {canEdit && (
              <div className="mt-3 flex gap-2">
                <Button
                  className="h-8 flex-1 text-xs"
                  disabled={saveConnector.isPending}
                  onClick={() => saveConnector.mutate()}
                >
                  Guardar conector
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 text-xs"
                  disabled={!connector.data || scanGithub.isPending}
                  onClick={() => scanGithub.mutate()}
                >
                  Escanear
                </Button>
              </div>
            )}
            {(message(saveConnector.error) ?? message(scanGithub.error)) && (
              <p className="mt-2 text-[11px] text-rose-700">
                {message(saveConnector.error) ?? message(scanGithub.error)}
              </p>
            )}
          </Card>

          {canEdit && (
            <Card className="p-4">
              <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">O sube el código</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Los ficheros <span className="font-mono">*.controller.ts</span> del proyecto. Se aplican con el prefijo
                de arriba.
              </p>
              <label className="mt-2 block">
                <span className="sr-only">Subir ficheros</span>
                <input
                  type="file"
                  multiple
                  accept=".ts"
                  disabled={scanUpload.isPending}
                  className="block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-2 file:py-1 file:text-white"
                  onChange={(event) => void onFiles(event.target.files)}
                />
              </label>
              {message(scanUpload.error) && (
                <p className="mt-2 text-[11px] text-rose-700">{message(scanUpload.error)}</p>
              )}
            </Card>
          )}

          <Card className="p-3">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
            <div className="mt-2 space-y-1">
              {scans.data?.length === 0 && <p className="text-[11px] text-slate-400">Ningún escaneo todavía.</p>}
              {scans.data?.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
                    item.id === selectedId ? "bg-slate-900 text-white" : "hover:bg-slate-50",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{formatDate(item.createdAt)}</span>
                    <span
                      className={cn("block text-[10px]", item.id === selectedId ? "text-slate-300" : "text-slate-400")}
                    >
                      {item.source === "github" ? item.ref : "subida"} · +{item.counts.added} ~{item.counts.changed} −
                      {item.counts.removed}
                    </span>
                  </span>
                  <Badge className={cn("shrink-0 ring-1 ring-inset", STATUS_CLASS[item.status])}>{item.status}</Badge>
                </button>
              ))}
            </div>
          </Card>
        </div>

        <Card className="p-4">
          {!selectedId || !scan.data ? (
            <Empty title="Escanea el código" hint="Conecta un repositorio y pulsa Escanear, o sube los ficheros." />
          ) : scan.data.status === "error" ? (
            <p className="text-xs text-rose-700">El escaneo falló: {scan.data.error}</p>
          ) : (
            <ScanDetail
              scan={scan.data}
              canEdit={canEdit}
              createRoles={createRoles}
              onCreateRoles={setCreateRoles}
              importing={importScan.isPending}
              onImport={() => importScan.mutate()}
              importResult={importScan.data}
              importError={message(importScan.error)}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function ScanDetail({
  scan,
  canEdit,
  createRoles,
  onCreateRoles,
  importing,
  onImport,
  importResult,
  importError,
}: {
  scan: CodeScanDetailView;
  canEdit: boolean;
  createRoles: boolean;
  onCreateRoles: (value: boolean) => void;
  importing: boolean;
  onImport: () => void;
  importResult: { created: number; updated: number; rolesCreated: number } | undefined;
  importError: string | null;
}) {
  const { diff, impact } = scan;
  const nothing = diff.added.length + diff.changed.length + diff.removed.length === 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">
          {scan.result.controllers} controladores · {scan.result.files} ficheros · {scan.result.endpoints.length} rutas
        </p>
        <span className="text-[11px] text-slate-400">{scan.source === "github" ? scan.ref : "subida"}</span>
      </div>

      {(impact.unknownRoles.length > 0 ||
        impact.removedWithPermissions.length > 0 ||
        impact.removedWithFlows.length > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">Impacto</p>
          {impact.unknownRoles.length > 0 && (
            <p className="mt-1">
              Roles que el código nombra y el proyecto no define:{" "}
              {impact.unknownRoles.map((role) => (
                <span key={role} className="font-mono">
                  {role}{" "}
                </span>
              ))}
            </p>
          )}
          {impact.removedWithPermissions.map((entry) => (
            <p key={`${entry.method} ${entry.path}`} className="mt-1">
              <span className="font-mono">
                {entry.method} {entry.path}
              </span>{" "}
              ya no está en el código pero {entry.permissions} permiso(s) de rol lo referencian.
            </p>
          ))}
          {impact.removedWithFlows.map((entry) => (
            <p key={`${entry.method} ${entry.path}`} className="mt-1">
              <span className="font-mono">
                {entry.method} {entry.path}
              </span>{" "}
              ya no está en el código pero {entry.flows} flujo(s) lo usan.
            </p>
          ))}
        </div>
      )}

      <DiffList
        title={`Nuevos (${diff.added.length})`}
        tone="emerald"
        rows={diff.added.map((endpoint) => ({
          key: `${endpoint.method} ${endpoint.path}`,
          label: `${endpoint.method} ${endpoint.path}`,
          note: [endpoint.requiresAuth ? "auth" : "público", ...endpoint.roles.map((role) => `rol:${role}`)].join(
            " · ",
          ),
        }))}
      />
      <DiffList
        title={`Cambiados (${diff.changed.length})`}
        tone="sky"
        rows={diff.changed.map((change) => ({
          key: `${change.method} ${change.path}`,
          label: `${change.method} ${change.path}`,
          note: change.changes.join("; "),
        }))}
      />
      <DiffList
        title={`Ya no en el código (${diff.removed.length})`}
        tone="rose"
        rows={diff.removed.map((endpoint) => ({
          key: `${endpoint.method} ${endpoint.path}`,
          label: `${endpoint.method} ${endpoint.path}`,
          note: "",
        }))}
      />
      <p className="text-[11px] text-slate-400">{diff.unchanged} sin cambios.</p>

      {canEdit && (
        <div className="border-t border-slate-100 pt-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={createRoles}
              onChange={(event) => onCreateRoles(event.target.checked)}
              disabled={impact.unknownRoles.length === 0}
            />
            Crear también los roles que faltan ({impact.unknownRoles.length})
          </label>
          <Button className="mt-2" disabled={importing || nothing} onClick={onImport}>
            Importar al proyecto
          </Button>
          <p className="mt-1 text-[10px] text-slate-400">Crea los nuevos y actualiza los cambiados. No borra nada.</p>
          {importResult && (
            <p className="mt-2 text-xs text-emerald-700">
              Importado: {importResult.created} creados, {importResult.updated} actualizados,{" "}
              {importResult.rolesCreated} roles.
            </p>
          )}
          {importError && <p className="mt-2 text-xs text-rose-700">{importError}</p>}
        </div>
      )}
    </div>
  );
}

function DiffList({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "emerald" | "sky" | "rose";
  rows: { key: string; label: string; note: string }[];
}) {
  if (rows.length === 0) return null;
  const dot = tone === "emerald" ? "bg-emerald-500" : tone === "sky" ? "bg-sky-500" : "bg-rose-500";
  return (
    <section>
      <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{title}</p>
      <div className="mt-1 space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
            <span className="font-mono text-slate-700">{row.label}</span>
            {row.note && <span className="ml-auto text-slate-400">{row.note}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
