import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Button, Field, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";

/**
 * Pedir la fusión en vez de hacerla: un título, una descripción, y la solicitud queda en el original
 * para que la revise quien lo cuida.
 *
 * Lo que se lleva no se elige aquí: es la comparación de fusionar de este momento, la misma que la
 * pantalla tiene debajo. Al crearla se va a la solicitud, que es donde sigue la conversación.
 */
export function CreateMergeRequestModal({
  forkId,
  parent,
  onClose,
}: {
  forkId: string;
  parent: { id: string; name: string };
  onClose: () => void;
}) {
  const organization = useOrganization();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/orgs/${organization!.id}/projects/${forkId}/merge-requests`, {
        method: "POST",
        body: { title: title.trim(), description },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["merge-requests"] });
      toast.success("Solicitud creada");
      onClose();
      void navigate(`/p/${parent.id}/merge-requests/${created.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim()) create.mutate();
  }

  return (
    <Modal
      title={`Pedir la fusión en «${parent.name}»`}
      description="Quien pueda escribir en el original la revisa, la comenta y decide. Al fusionarla se vuelve a comparar: lo que llegue será lo de ese momento."
      onClose={onClose}
    >
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Título">
          <input
            autoFocus
            className={inputClass}
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Descripción" hint="Qué cambia y por qué. Opcional.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={description}
            maxLength={10_000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {create.error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{create.error.message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!title.trim() || create.isPending}>
            {create.isPending ? "Creando…" : "Crear solicitud"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
