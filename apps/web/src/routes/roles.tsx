import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { ConfirmDialog, Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { SectionEditor } from "@/routes/config";
import { buildEndpointTree, endpointIdsOf, type EndpointFolder } from "@/lib/endpoint-tree";
import {
  ACCESS_LABEL,
  ROLE_COLORS,
  SCOPE_LABEL,
  cellOf,
  cellsFrom,
  changesBetween,
  groupAccess,
  groupScope,
  ruleOf,
  setCells,
  toggleRule,
  type Cell,
  type Cells,
  type RuleFlag,
} from "@/lib/role-permissions";
import { cn, methodStyle } from "@/lib/format";
import type {
  ConfigView,
  DataScope,
  EndpointPage,
  EndpointView,
  Environment,
  RoleAccess,
  RolePermissionView,
  RoleRuleView,
  RoleView,
} from "@/lib/types";

/**
 * The roles of the API and what each one may reach — the analyzer's Roles section.
 *
 * A list of roles on the left, the selected role's permission over every endpoint on the right,
 * and below them the rules between roles. What the contract matrix reads — the `access` section —
 * is derived from all of this by the API; the part of that section that is not role data, the
 * refusal codes and the cross-role cases, is still edited here at the bottom.
 */
export function RolesPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const canAdmin = useCan("admin");
  const toast = useToast();
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);

  const roles = useQuery({
    queryKey: ["roles", projectId],
    enabled,
    queryFn: () => api<RoleView[]>(`${base}/roles`),
  });
  const list = useMemo(() => roles.data ?? [], [roles.data]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!list.length) setSelected(null);
    else if (!list.some((role) => role.id === selected)) setSelected(list[0].id);
  }, [list, selected]);

  const [editing, setEditing] = useState<RoleView | "new" | null>(null);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["roles", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["role-rules", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["config", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["environments", projectId] }),
    ]);

  const remove = useMutation({
    mutationFn: (role: RoleView) => api<void>(`${base}/roles/${role.id}`, { method: "DELETE" }),
    onSuccess: async (_, role) => {
      setDeleting(null);
      await invalidate();
      toast.success(`Rol «${role.name}» eliminado`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const current = list.find((role) => role.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h1 className="text-base font-semibold text-slate-900">Roles</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
          Los roles de la API y qué endpoints alcanza cada uno. Permitido y denegado se convierten en casos de la matriz
          del contrato y en expectativas de las pruebas de seguridad; «sin decidir» no genera nada. La credencial de
          cada rol se guarda en cada entorno.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Roles</p>
            {canEdit && (
              <button
                className="text-xs font-medium text-slate-600 hover:text-slate-950"
                onClick={() => setEditing("new")}
              >
                + Nuevo rol
              </button>
            )}
          </div>
          {roles.isLoading && <p className="px-1 text-xs text-slate-500">Cargando…</p>}
          {!roles.isLoading && list.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-500">
              Sin roles. Añade los de tu API —vendedor, comprador, admin…— para decidir qué alcanza cada uno.
            </p>
          )}
          {list.map((role) => (
            <div
              key={role.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(role.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setSelected(role.id);
              }}
              className={cn(
                "group cursor-pointer rounded-xl border px-3 py-2 transition-colors",
                role.id === selected
                  ? "border-slate-900 bg-white shadow-sm"
                  : "border-slate-200 bg-white hover:bg-slate-50",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: role.color }} />
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-slate-800">{role.name}</span>
                {role.sameRoleDataIsolation && (
                  <Badge className="border-amber-200 bg-amber-50 text-amber-700">Aislado</Badge>
                )}
              </div>
              {role.description && <p className="mt-0.5 truncate text-[11px] text-slate-500">{role.description}</p>}
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                <span>
                  {role.allowed} permitidos · {role.denied} denegados
                </span>
                <span
                  className={cn(
                    "ml-auto flex gap-2",
                    role.id === selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  {canEdit && (
                    <button
                      className="text-slate-500 hover:text-slate-900"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditing(role);
                      }}
                    >
                      Editar
                    </button>
                  )}
                  {canAdmin && (
                    <button
                      className="text-rose-600 hover:text-rose-700"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleting(role);
                      }}
                    >
                      Eliminar
                    </button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>

        {current ? (
          <PermissionsPanel key={current.id} base={base} projectId={projectId!} role={current} canEdit={canEdit} />
        ) : (
          <Card className="grid place-items-center p-8 text-center text-xs text-slate-500">
            Elige un rol para decidir qué endpoints alcanza.
          </Card>
        )}
      </div>

      {list.length >= 2 ? (
        <RulesMatrix base={base} projectId={projectId!} roles={list} canEdit={canEdit} />
      ) : (
        list.length === 1 && (
          <Card className="p-4 text-xs text-slate-500">
            Con dos roles o más aparecen las reglas entre roles: qué puede leer, cambiar y borrar cada uno de lo que
            creó otro.
          </Card>
        )
      )}

      {list.length > 0 && <CredentialsByEnvironment base={base} projectId={projectId!} roles={list} />}
      <MatrixSettings base={base} projectId={projectId!} canEdit={canEdit} />

      {editing && (
        <RoleFormModal
          base={base}
          role={editing === "new" ? null : editing}
          nextColor={ROLE_COLORS[list.length % ROLE_COLORS.length]}
          onClose={() => setEditing(null)}
          onSaved={async (role, created) => {
            setEditing(null);
            await invalidate();
            if (created) setSelected(role.id);
            toast.success(created ? `Rol «${role.name}» creado` : "Rol guardado");
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Eliminar rol"
          message={`«${deleting.name}» se elimina con sus permisos, sus reglas y la credencial que tenga en cada entorno. No se puede deshacer.`}
          pending={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function RoleFormModal({
  base,
  role,
  nextColor,
  onClose,
  onSaved,
}: {
  base: string;
  role: RoleView | null;
  nextColor: string;
  onClose: () => void;
  onSaved: (role: RoleView, created: boolean) => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [color, setColor] = useState(role?.color ?? nextColor);
  const [isolated, setIsolated] = useState(role?.sameRoleDataIsolation ?? false);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, color, sameRoleDataIsolation: isolated };
      return role
        ? api<RoleView>(`${base}/roles/${role.id}`, { method: "PATCH", body })
        : api<RoleView>(`${base}/roles`, { method: "POST", body });
    },
    onSuccess: (saved) => onSaved(saved, !role),
  });
  const fields = save.error instanceof ApiError ? save.error.fields : [];
  const fieldError = (field: string) => fields.find((entry) => entry.field === field)?.detail;

  return (
    <Modal
      title={role ? "Editar rol" : "Nuevo rol"}
      description="Un rol de la API que se prueba, con lo que debe ver cuando dos usuarios lo comparten."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Guardando…" : role ? "Guardar" : "Crear rol"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <label className="block text-xs text-slate-600">
          Nombre
          <input
            className={`${inputClass} font-mono`}
            value={name}
            placeholder="vendedor"
            maxLength={20}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <span className={cn("mt-1 block text-[11px]", fieldError("name") ? "text-rose-600" : "text-slate-400")}>
            {fieldError("name") ??
              (role
                ? "Renombrarlo renombra su credencial en cada entorno y sus casos en la matriz."
                : "El mismo nombre que la credencial de cada entorno: letras, cifras, «_», «-» o «.».")}
          </span>
        </label>
        <label className="block text-xs text-slate-600">
          Descripción <span className="text-slate-400">(opcional)</span>
          <input
            className={inputClass}
            value={description}
            placeholder="Gestiona su catálogo y sus pedidos"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="text-xs text-slate-600">
          Color
          <div className="mt-1 flex flex-wrap gap-2">
            {ROLE_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Color ${swatch}`}
                aria-pressed={color === swatch}
                onClick={() => setColor(swatch)}
                className={cn(
                  "size-7 rounded-full ring-offset-2 transition",
                  color === swatch ? "ring-2 ring-slate-900" : "hover:ring-2 hover:ring-slate-300",
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={isolated}
            onChange={(event) => setIsolated(event.target.checked)}
          />
          <span>
            <span className="block font-medium text-slate-800">Aislamiento entre usuarios del mismo rol</span>
            <span className="mt-0.5 block text-[11px] leading-5 text-slate-500">
              Dos usuarios con este rol solo deben ver sus propios datos, no los del otro. Lo comprueban las pruebas de
              seguridad que cruzan usuarios.
            </span>
          </span>
        </label>
        {save.error && !fields.length && <p className="text-xs text-rose-700">{save.error.message}</p>}
      </form>
    </Modal>
  );
}

type Row = Pick<EndpointView, "id" | "method" | "path" | "status" | "operationId">;

function PermissionsPanel({
  base,
  projectId,
  role,
  canEdit,
}: {
  base: string;
  projectId: string;
  role: RoleView;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const endpoints = useQuery({
    queryKey: ["endpoints", projectId, "all", "", 1, "roles"],
    queryFn: () => api<EndpointPage>(`${base}/endpoints?status=all&limit=500`),
  });
  const permissions = useQuery({
    queryKey: ["role-permissions", projectId, role.id],
    queryFn: () => api<{ permissions: RolePermissionView[] }>(`${base}/roles/${role.id}/permissions`),
  });
  const saved = useMemo(() => cellsFrom(permissions.data?.permissions ?? []), [permissions.data]);
  const [draft, setDraft] = useState<Cells>({});
  useEffect(() => setDraft(saved), [saved]);
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const rows: Row[] = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (endpoints.data?.data ?? []).filter(
      (endpoint) => !term || endpoint.path.toLowerCase().includes(term) || endpoint.method.toLowerCase() === term,
    );
  }, [endpoints.data, search]);
  const tree = useMemo(() => buildEndpointTree(rows), [rows]);
  const changes = changesBetween(saved, draft);

  const save = useMutation({
    mutationFn: () => api(`${base}/roles/${role.id}/permissions`, { method: "PUT", body: { permissions: changes } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["role-permissions", projectId, role.id] }),
        queryClient.invalidateQueries({ queryKey: ["roles", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["role-access", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["config", projectId] }),
      ]);
      toast.success(`Permisos de «${role.name}» guardados`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const apply = (ids: string[], patch: Partial<Cell>) => setDraft((cells) => setCells(cells, ids, patch));

  return (
    <Card className="flex min-h-[20rem] flex-col p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-slate-900">Permisos de</p>
        <span className="rounded-full px-2 py-0.5 font-mono text-xs text-white" style={{ backgroundColor: role.color }}>
          {role.name}
        </span>
        <input
          aria-label="Filtrar endpoints"
          className="ml-auto h-8 w-48 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900"
          placeholder="Filtrar por ruta o método"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Una carpeta cambia todos los endpoints que tiene dentro. Solo los endpoints del contrato generan casos en la
        matriz; los demás quedan para las pruebas de seguridad.
      </p>

      <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200">
        {endpoints.isLoading || permissions.isLoading ? (
          <p className="p-4 text-xs text-slate-500">Cargando…</p>
        ) : tree.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">
            {search ? "Ningún endpoint coincide." : "Este proyecto no tiene endpoints todavía."}
          </p>
        ) : (
          tree.map((folder) => (
            <FolderRows
              key={folder.id}
              folder={folder}
              depth={0}
              cells={draft}
              canEdit={canEdit}
              closed={closed}
              onToggle={(id) =>
                setClosed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onApply={apply}
            />
          ))
        )}
      </div>

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={!changes.length || save.isPending} onClick={() => save.mutate()}>
            Guardar permisos
          </Button>
          <Button variant="ghost" disabled={!changes.length} onClick={() => setDraft(saved)}>
            Descartar
          </Button>
          <span className="text-xs text-slate-500">
            {changes.length ? `${changes.length} ${changes.length === 1 ? "cambio" : "cambios"} sin guardar` : ""}
          </span>
        </div>
      )}
    </Card>
  );
}

function AccessSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: RoleAccess | "mixed";
  disabled: boolean;
  onChange: (access: RoleAccess) => void;
}) {
  return (
    <select
      aria-label={label}
      className={cn(
        "h-7 w-28 rounded-md border border-slate-200 bg-white px-1 text-[11px]",
        value === "allow" && "text-emerald-700",
        value === "deny" && "text-rose-700",
        value === "mixed" && "text-slate-400",
      )}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as RoleAccess)}
    >
      {value === "mixed" && (
        <option value="mixed" disabled>
          Mixto
        </option>
      )}
      {(["undecided", "allow", "deny"] as const).map((access) => (
        <option key={access} value={access}>
          {ACCESS_LABEL[access]}
        </option>
      ))}
    </select>
  );
}

function ScopeSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: DataScope | "mixed" | null;
  disabled: boolean;
  onChange: (scope: DataScope) => void;
}) {
  return (
    <select
      aria-label={label}
      className="h-7 w-32 rounded-md border border-slate-200 bg-white px-1 text-[11px] disabled:text-slate-300"
      value={value ?? "all"}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as DataScope)}
    >
      {value === "mixed" && (
        <option value="mixed" disabled>
          Mixto
        </option>
      )}
      {(["all", "own", "none"] as const).map((scope) => (
        <option key={scope} value={scope}>
          {SCOPE_LABEL[scope]}
        </option>
      ))}
    </select>
  );
}

function FolderRows({
  folder,
  depth,
  cells,
  canEdit,
  closed,
  onToggle,
  onApply,
}: {
  folder: EndpointFolder<Row>;
  depth: number;
  cells: Cells;
  canEdit: boolean;
  closed: Set<string>;
  onToggle: (id: string) => void;
  onApply: (ids: string[], patch: Partial<Cell>) => void;
}) {
  const ids = endpointIdsOf(folder);
  const open = !closed.has(folder.id);
  // A folder exists because an endpoint lives under it, so there is always an access to show.
  const access = groupAccess(ids, cells)!;
  const scope = groupScope(ids, cells);
  return (
    <div>
      <div
        className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 py-1 pr-3"
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
      >
        <button
          aria-label={open ? `Cerrar ${folder.label}` : `Abrir ${folder.label}`}
          className="w-4 text-xs text-slate-400"
          onClick={() => onToggle(folder.id)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
          {folder.label}
          {folder.isVersion && (
            <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] text-slate-600">versión</span>
          )}
          <span className="ml-1 text-slate-400">{ids.length}</span>
        </span>
        <AccessSelect
          label={`Acceso a ${folder.label}`}
          value={access}
          disabled={!canEdit}
          onChange={(next) => onApply(ids, { access: next })}
        />
        <ScopeSelect
          label={`Datos en ${folder.label}`}
          value={scope}
          disabled={!canEdit || scope === null}
          onChange={(next) =>
            onApply(
              ids.filter((id) => cellOf(cells, id).access === "allow"),
              { dataScope: next },
            )
          }
        />
      </div>
      {open && (
        <>
          {folder.folders.map((child) => (
            <FolderRows
              key={child.id}
              folder={child}
              depth={depth + 1}
              cells={cells}
              canEdit={canEdit}
              closed={closed}
              onToggle={onToggle}
              onApply={onApply}
            />
          ))}
          {folder.endpoints.map((endpoint) => {
            const cell = cellOf(cells, endpoint.id);
            return (
              <div
                key={endpoint.id}
                className="flex items-center gap-2 border-b border-slate-100 py-1 pr-3 last:border-b-0"
                style={{ paddingLeft: `${2 + depth * 1.25}rem` }}
              >
                <span
                  className={cn(
                    "w-14 shrink-0 rounded px-1 text-center font-mono text-[10px] font-semibold",
                    methodStyle(endpoint.method),
                  )}
                >
                  {endpoint.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700" title={endpoint.path}>
                  {endpoint.path}
                </span>
                {endpoint.operationId && <span className="text-[10px] text-slate-400">contrato</span>}
                {endpoint.status !== "active" && (
                  <span className="text-[10px] text-slate-400">
                    {endpoint.status === "archived" ? "archivado" : "inactivo"}
                  </span>
                )}
                <AccessSelect
                  label={`Acceso a ${endpoint.method} ${endpoint.path}`}
                  value={cell.access}
                  disabled={!canEdit}
                  onChange={(next) => onApply([endpoint.id], { access: next })}
                />
                <ScopeSelect
                  label={`Datos en ${endpoint.method} ${endpoint.path}`}
                  value={cell.dataScope}
                  disabled={!canEdit || cell.access !== "allow"}
                  onChange={(next) => onApply([endpoint.id], { dataScope: next })}
                />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

const FLAGS: { flag: RuleFlag; letter: string; title: string; on: string }[] = [
  { flag: "canRead", letter: "R", title: "Leer", on: "bg-emerald-600 text-white" },
  { flag: "canWrite", letter: "W", title: "Cambiar", on: "bg-sky-600 text-white" },
  { flag: "canDelete", letter: "D", title: "Borrar", on: "bg-rose-600 text-white" },
];

function RulesMatrix({
  base,
  projectId,
  roles,
  canEdit,
}: {
  base: string;
  projectId: string;
  roles: RoleView[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["role-rules", projectId],
    queryFn: () => api<{ rules: RoleRuleView[] }>(`${base}/role-rules`),
  });
  const saved = useMemo(() => rules.data?.rules ?? [], [rules.data]);
  const [draft, setDraft] = useState<RoleRuleView[]>([]);
  useEffect(() => setDraft(saved), [saved]);
  const key = (list: RoleRuleView[]) =>
    JSON.stringify(
      [...list]
        .map((rule) => [rule.sourceRoleId, rule.targetRoleId, rule.canRead, rule.canWrite, rule.canDelete])
        .sort(),
    );
  const dirty = key(saved) !== key(draft);

  const save = useMutation({
    mutationFn: () => api(`${base}/role-rules`, { method: "PUT", body: { rules: draft } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["role-rules", projectId] });
      toast.success("Reglas entre roles guardadas");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Reglas entre roles</p>
      <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">
        Qué puede hacer cada rol (fila) con los datos que creó otro rol (columna). Las pruebas de seguridad que cruzan
        usuarios lo comparan con lo que la API deja hacer. Un rol consigo mismo es su aislamiento, no una regla.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1.5 text-left text-[10px] font-medium text-slate-400">Rol ↓ sobre datos de →</th>
              {roles.map((source) => (
                <th key={source.id} className="px-2 py-1.5 text-left">
                  <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-slate-700">
                    <span className="size-2 rounded-full" style={{ backgroundColor: source.color }} />
                    {source.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((target) => (
              <tr key={target.id} className="border-t border-slate-100">
                <th className="px-2 py-1.5 text-left">
                  <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-slate-700">
                    <span className="size-2 rounded-full" style={{ backgroundColor: target.color }} />
                    {target.name}
                  </span>
                  {target.sameRoleDataIsolation && (
                    <span className="block text-[10px] font-normal text-amber-600">aislado</span>
                  )}
                </th>
                {roles.map((source) => (
                  <td key={source.id} className="px-2 py-1.5">
                    {source.id === target.id ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span className="inline-flex gap-1">
                        {FLAGS.map(({ flag, letter, title, on }) => {
                          const active = ruleOf(draft, source.id, target.id)[flag];
                          return (
                            <button
                              key={flag}
                              aria-label={`${target.name} ${title.toLowerCase()} datos de ${source.name}`}
                              aria-pressed={active}
                              title={`${title}: ${target.name} sobre lo que creó ${source.name}`}
                              disabled={!canEdit}
                              onClick={() => setDraft((rulesNow) => toggleRule(rulesNow, source.id, target.id, flag))}
                              className={cn(
                                "size-6 rounded text-[10px] font-semibold transition-colors",
                                active ? on : "bg-slate-100 text-slate-400 hover:bg-slate-200",
                              )}
                            >
                              {letter}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">R = leer · W = cambiar · D = borrar</p>
      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Guardar reglas
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
            Descartar
          </Button>
        </div>
      )}
    </Card>
  );
}

function CredentialsByEnvironment({ base, projectId, roles }: { base: string; projectId: string; roles: RoleView[] }) {
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const list = environments.data ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Credenciales por entorno</p>
        <Link
          to={`/p/${projectId}/settings/environments`}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          Gestionar entornos
        </Link>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-3 text-xs text-slate-500">
          Sin entornos todavía: un rol no se puede ejercitar hasta que un entorno tenga su credencial.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-[11px] text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Rol</th>
                {list.map((environment) => (
                  <th key={environment.id} className="px-4 py-2 font-medium">
                    {environment.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roles.map((role) => (
                <tr key={role.id}>
                  <td className="px-4 py-2 font-mono text-slate-800">{role.name}</td>
                  {list.map((environment) => {
                    const has = environment.credentials.some((credential) => credential.role === role.name);
                    return (
                      <td key={environment.id} className="px-4 py-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium",
                            has ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
                          )}
                        >
                          {has ? "con credencial" : "sin credencial"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The part of `access` that is not role data: what counts as a refusal, and the cross-role cases. */
function MatrixSettings({ base, projectId, canEdit }: { base: string; projectId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ contract: { versionId: string } | null }>(base),
  });
  const config = useQuery({
    queryKey: ["config", projectId],
    queryFn: () => api<ConfigView>(`${base}/config`),
  });
  const operationIds = useQuery({
    queryKey: ["operation-ids", projectId, project.data?.contract?.versionId],
    enabled: Boolean(project.data?.contract),
    queryFn: async () =>
      (await api<{ operations: { id: string }[] }>(`${base}/operations`)).operations.map((operation) => operation.id),
  });
  const access = config.data?.sections.access;
  if (!access) return null;
  return (
    <SectionEditor
      base={base}
      section="access"
      title="Matriz del contrato: rechazos y casos entre roles"
      data={access}
      disabled={!canEdit}
      derivedRoles
      operationIds={operationIds.data ?? []}
      onSaved={() => queryClient.invalidateQueries({ queryKey: ["config", projectId] })}
    />
  );
}
