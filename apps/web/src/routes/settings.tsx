import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useAuth, useCan, useOrganization } from "@/lib/auth";
import { canChangeRole, canRemove, ROLES } from "@/lib/roles";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { ApiTokenView, MembersView, Role } from "@/lib/types";

/**
 * The organization: who is in it, and which service credentials exist.
 *
 * Both of these were API-only. That is a defensible place to start — the endpoints are the
 * product and a screen is a convenience — but it stops being defensible the moment somebody has
 * to onboard a colleague, because the alternative to this page is asking them to `curl`.
 *
 * Every control here is decided twice: the API enforces the rule, and `@/lib/roles` decides
 * whether to offer the button at all. The second is not security — it is the difference between
 * a disabled control that says why and a 403 that arrives after a click.
 */
export function SettingsPage() {
  const organization = useOrganization();
  if (!organization) return <Empty title="Sin organización" hint="Vuelve a entrar." />;

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{organization.name}</h1>
        <p className="text-xs text-slate-500">Quién entra, con qué rol, y qué credenciales de servicio existen.</p>
      </div>
      <Members organizationId={organization.id} actorRole={organization.role} />
      <Tokens organizationId={organization.id} />
    </div>
  );
}

const roleHint: Record<Role, string> = {
  viewer: "Lee la matriz, las corridas y la configuración. No lanza nada.",
  editor: "Cura la matriz y lanza corridas. No guarda credenciales de destino.",
  admin: "Todo lo anterior, más credenciales, entornos y personas.",
  owner: "Admin, y además manda sobre otros owners.",
};

function Members({ organizationId, actorRole }: { organizationId: string; actorRole: Role }) {
  const { user, reload } = useAuth();
  const canManage = useCan("admin");
  const queryClient = useQueryClient();
  const base = `/orgs/${organizationId}`;

  const members = useQuery({ queryKey: ["members", organizationId], queryFn: () => api<MembersView>(`${base}/members`) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["members", organizationId] });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api(`${base}/members/${userId}`, { method: "PATCH", body: { role } }),
    // `reload` and not only `invalidate`: changing your own role changes what the whole app may
    // render, and the session's copy of it is what every other screen reads.
    onSuccess: async () => {
      invalidate();
      await reload();
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api(`${base}/members/${userId}`, { method: "DELETE" }),
    onSuccess: async () => {
      invalidate();
      await reload();
    },
  });

  const owners = members.data?.members.filter((member) => member.role === "owner").length ?? 0;
  const error = (changeRole.error ?? remove.error) as ApiError | null;

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Personas</p>

      {canManage && <Invite base={base} onInvited={invalidate} />}

      {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error.message}</p>}

      <div className="mt-4 divide-y divide-slate-100">
        {members.data?.members.map((member) => {
          const isSelf = member.userId === user?.id;
          const blockedChange = canChangeRole(actorRole, { role: member.role, isSelf }, owners);
          const blockedRemove = canRemove(actorRole, { role: member.role, isSelf }, owners);
          return (
            <div key={member.userId} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-800">
                  {member.name} {isSelf && <span className="text-[10px] text-slate-400">(tú)</span>}
                </p>
                <p className="truncate font-mono text-[11px] text-slate-500">{member.email}</p>
              </div>
              <span className="ml-auto text-[10px] text-slate-400">desde {formatDate(member.since)}</span>
              <select
                className={`${inputClass} h-8 w-28`}
                value={member.role}
                disabled={blockedChange !== null || changeRole.isPending}
                title={blockedChange ?? roleHint[member.role]}
                onChange={(event) => changeRole.mutate({ userId: member.userId, role: event.target.value as Role })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                className="h-8 text-xs text-rose-600"
                disabled={blockedRemove !== null || remove.isPending}
                title={blockedRemove ?? undefined}
                onClick={() => remove.mutate(member.userId)}
              >
                {isSelf ? "Salir" : "Sacar"}
              </Button>
            </div>
          );
        })}
      </div>

      {members.data && members.data.invitations.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          {/* Invitadas y no miembros todavía. Se listan aquí porque, para quien espera acceso,
              «invitado» y «dentro» se parecen demasiado. */}
          <p className="text-[11px] uppercase tracking-wide text-slate-400">Invitaciones pendientes</p>
          {members.data.invitations.map((invitation) => (
            <div key={invitation.id} className="flex items-center gap-3 py-1.5">
              <span className="font-mono text-[11px] text-slate-600">{invitation.email}</span>
              <Badge className="border-slate-200 bg-slate-50 text-slate-500">{invitation.role}</Badge>
              <span className="ml-auto text-[10px] text-slate-400">caduca {formatDate(invitation.expiresAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Invite({ base, onInvited }: { base: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");

  const invite = useMutation({
    mutationFn: () => api<{ token: string }>(`${base}/invitations`, { method: "POST", body: { email, role } }),
    onSuccess: () => {
      setEmail("");
      onInvited();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    invite.mutate();
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
      <div className="min-w-56 flex-1">
        <Field label="Invitar por correo" hint={roleHint[role]}>
          <input className={inputClass} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="colega@example.com" required />
        </Field>
      </div>
      <select className={`${inputClass} h-9 w-28`} value={role} onChange={(event) => setRole(event.target.value as Role)}>
        {ROLES.filter((candidate) => candidate !== "owner").map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={!email || invite.isPending}>
        Invitar
      </Button>

      {invite.error && <p className="w-full text-xs text-rose-700">{(invite.error as Error).message}</p>}
      {invite.data && (
        // No hay correo saliente en este producto. Decirlo aquí es mejor que dejar a alguien
        // esperando un mensaje que no va a llegar.
        <p className="w-full rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Invitación creada. Este producto no manda correos: pásale este enlace tú mismo.
          <code className="mt-1 block break-all font-mono text-[11px]">{`${window.location.origin}/register?invitation=${invite.data.token}`}</code>
        </p>
      )}
    </form>
  );
}

function Tokens({ organizationId }: { organizationId: string }) {
  const canManage = useCan("admin");
  const queryClient = useQueryClient();
  const base = `/orgs/${organizationId}/tokens`;
  const [name, setName] = useState("");

  const tokens = useQuery({ queryKey: ["tokens", organizationId], enabled: canManage, queryFn: () => api<ApiTokenView[]>(base) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tokens", organizationId] });

  const issue = useMutation({
    mutationFn: () => api<{ token: string }>(base, { method: "POST", body: { name } }),
    onSuccess: () => {
      setName("");
      invalidate();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`${base}/${id}`, { method: "DELETE" }), onSuccess: invalidate });

  if (!canManage) return null;

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Credenciales de servicio</p>
      <p className="mt-1 text-xs text-slate-500">
        Lo que usa una pipeline para lanzar la matriz sin que nadie entre. Un token vale como <span className="font-mono">editor</span>: cura y lanza, pero no
        guarda credenciales de destino ni toca personas.
      </p>

      <form
        className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          issue.mutate();
        }}
      >
        <div className="min-w-56 flex-1">
          <Field label="Nombre" hint="Para qué es. Es lo único que se ve después.">
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="CI de nightly" required />
          </Field>
        </div>
        <Button type="submit" disabled={!name || issue.isPending}>
          Emitir
        </Button>
      </form>

      {issue.data && (
        // Se enseña una vez y nunca más: se guarda su hash, no él. Un listado que pudiera
        // volver a enseñarlo sería un listado que vale la pena robar.
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Cópialo ahora. No se vuelve a mostrar: se guarda su hash, no el token.
          <code className="mt-1 block break-all font-mono text-[11px]">{issue.data.token}</code>
        </p>
      )}
      {issue.error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(issue.error as ApiError).message}</p>}

      <div className="mt-3 divide-y divide-slate-100">
        {tokens.data?.length === 0 && <p className="py-2 text-xs text-slate-400">Todavía no hay ninguna.</p>}
        {tokens.data?.map((token) => (
          <div key={token.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="text-sm text-slate-800">{token.name}</span>
            <span className="font-mono text-[11px] text-slate-400">{token.preview}…</span>
            <span className="text-[10px] text-slate-400">
              {token.lastUsedAt ? `usado ${formatDate(token.lastUsedAt)}` : "sin usar"} · creado {formatDate(token.createdAt)}
            </span>
            <span className="ml-auto">
              {token.revokedAt ? (
                <Badge className="border-slate-200 bg-slate-50 text-slate-400">revocado</Badge>
              ) : (
                <Button variant="ghost" className="h-8 text-xs text-rose-600" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>
                  Revocar
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
