/**
 * El ciclo de vida, por sus bordes.
 *
 * Lo que no se ve en una prueba por HTTP: el orden que el servicio compartido comprueba —archivar
 * lo borrado, purgar lo vivo, borrar dos veces, restaurar lo que no está borrado— y que el filtro
 * de la lista rechaza un valor inventado en vez de contestar con otra lista.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import {
  LIFECYCLE_STATES,
  archivedRow,
  deletedRow,
  inLifecycleState,
  lifecycleSql,
  lifecycleState,
  parseLifecycleState,
  restoredRow,
  viewLifecycle,
  type Lifecycle,
} from "@/shared/lifecycle/lifecycle";
import { archiveIn, deleteIn, restoreIn, type LifecycleNoun } from "@/shared/lifecycle/lifecycle-store";

const NOUN: LifecycleNoun = { code: "mock", that: "Ese mock", the: "el mock" };
const AT = new Date("2026-03-01T10:00:00.000Z");

type Row = Lifecycle & { id: string; updatedAt?: Date };

/** Un almacén de mentira con lo justo: encontrar, guardar y borrar de verdad. */
function store(rows: Row[] = []) {
  const kept = new Map(rows.map((row) => [row.id, row]));
  const removed: string[] = [];
  return {
    kept,
    removed,
    findById: async (_projectId: string, id: string) => kept.get(id) ?? null,
    save: async (row: Row) => void kept.set(row.id, row),
    remove: async (_projectId: string, id: string) => {
      removed.push(id);
      return kept.delete(id);
    },
  };
}

const row = (patch: Partial<Row> = {}): Row => ({ id: "a", archivedAt: null, deletedAt: null, ...patch });

describe("el estado de una fila", () => {
  test("se deriva de las fechas, y borrado gana a archivado", () => {
    assert.deepEqual([...LIFECYCLE_STATES], ["active", "archived", "deleted"]);
    assert.equal(lifecycleState(row()), "active");
    assert.equal(lifecycleState(row({ archivedAt: AT })), "archived");
    assert.equal(lifecycleState(row({ archivedAt: AT, deletedAt: AT })), "deleted");
    assert.ok(inLifecycleState(row({ archivedAt: AT }), "archived"));
    assert.ok(!inLifecycleState(row(), "deleted"));
  });

  test("las dos fechas salen como texto, y los nulos como nulos", () => {
    assert.deepEqual(viewLifecycle(row()), { archivedAt: null, deletedAt: null });
    assert.deepEqual(viewLifecycle(row({ archivedAt: AT, deletedAt: AT })), {
      archivedAt: "2026-03-01T10:00:00.000Z",
      deletedAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("archivar, borrar y restaurar devuelven copias, y restaurar **solo** quita el borrado", () => {
    const original = row();
    assert.equal(archivedRow(original, AT).archivedAt, AT);
    assert.equal(original.archivedAt, null, "la fila que se recibe no se toca");
    assert.equal(archivedRow(row({ archivedAt: AT }), null).archivedAt, null);
    assert.equal(deletedRow(original, AT).deletedAt, AT);
    const back = restoredRow(row({ archivedAt: AT, deletedAt: AT }));
    assert.equal(back.deletedAt, null);
    assert.equal(back.archivedAt, AT, "lo que se archivó sigue archivado al volver");
  });
});

describe("el filtro de la lista", () => {
  test("sin parámetro, y con uno vacío, es la lista de lo activo", () => {
    assert.equal(parseLifecycleState(undefined), "active");
    assert.equal(parseLifecycleState(""), "active");
    assert.equal(parseLifecycleState("archived"), "archived");
    assert.equal(parseLifecycleState("deleted"), "deleted");
  });

  test("un valor inventado es un 422 que nombra el campo, no otra lista", () => {
    assert.throws(
      () => parseLifecycleState("papelera"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.fields, [{ field: "state", detail: "Uno de active, archived, deleted" }]);
        return true;
      },
    );
  });

  test("el SQL de cada estado nombra las dos columnas que decide", () => {
    assert.equal(lifecycleSql("m", "active"), `m."deletedAt" IS NULL AND m."archivedAt" IS NULL`);
    assert.equal(lifecycleSql("m", "archived"), `m."deletedAt" IS NULL AND m."archivedAt" IS NOT NULL`);
    assert.equal(lifecycleSql("m", "deleted"), `m."deletedAt" IS NOT NULL`);
  });
});

describe("archivar", () => {
  test("pone y quita la fecha, y aplica el retoque cuando se da", async () => {
    const kept = store([row()]);
    const archived = await archiveIn(kept, "p", "a", true, AT, NOUN, {
      patch: (current, now) => ({ ...current, updatedAt: now }),
    });
    assert.equal(archived.archivedAt, AT);
    assert.equal(archived.updatedAt, AT);
    // Sin retoque la fila se guarda tal cual: hay recursos sin fecha de modificación.
    const unarchived = await archiveIn(kept, "p", "a", false, AT, NOUN);
    assert.equal(unarchived.archivedAt, null);
  });

  test("lo que no existe es un 404, y lo borrado es un 409 que dice qué hacer antes", async () => {
    const kept = store([row({ deletedAt: AT })]);
    await assert.rejects(archiveIn(kept, "p", "no", true, AT, NOUN), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.message, "Ese mock no existe");
      return true;
    });
    await assert.rejects(archiveIn(kept, "p", "a", true, AT, NOUN), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, "Restaura el mock antes de archivarlo");
      return true;
    });
  });
});

describe("eliminar", () => {
  test("el blando marca la fecha; hacerlo dos veces no es un error, es la misma operación", async () => {
    const kept = store([row()]);
    await deleteIn(kept, "p", "a", false, AT, NOUN);
    assert.equal(kept.kept.get("a")!.deletedAt, AT);
    await deleteIn(kept, "p", "a", false, new Date("2026-04-01T00:00:00.000Z"), NOUN);
    assert.equal(kept.kept.get("a")!.deletedAt, AT, "la segunda vez no reescribe la fecha");
    assert.deepEqual(kept.removed, []);
  });

  test("el definitivo pide que antes esté eliminado, y entonces se lleva la fila", async () => {
    const kept = store([row()]);
    await assert.rejects(deleteIn(kept, "p", "a", true, AT, NOUN), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, "Elimina el mock antes de borrarlo para siempre");
      return true;
    });
    await deleteIn(kept, "p", "a", false, AT, NOUN);
    await deleteIn(kept, "p", "a", true, AT, NOUN);
    assert.deepEqual(kept.removed, ["a"]);
    assert.equal(kept.kept.has("a"), false);
  });

  test("lo que no existe es un 404, también al purgar una fila que se fue entre medias", async () => {
    const kept = store();
    await assert.rejects(deleteIn(kept, "p", "no", false, AT, NOUN), NotFoundError);

    // La fila está, dice que está borrada, y el borrado de verdad no encuentra nada: otra petición
    // se la llevó entre la lectura y el borrado. Es un 404 y no un «hecho» que no pasó.
    const racing = {
      findById: async () => row({ deletedAt: AT }),
      save: async () => {},
      remove: async () => false,
    };
    await assert.rejects(deleteIn(racing, "p", "a", true, AT, NOUN), NotFoundError);
  });
});

describe("restaurar", () => {
  test("quita el borrado y deja el archivado donde estaba", async () => {
    const kept = store([row({ archivedAt: AT, deletedAt: AT })]);
    const back = await restoreIn(kept, "p", "a", AT, NOUN, { patch: (current) => ({ ...current, updatedAt: AT }) });
    assert.equal(back.deletedAt, null);
    assert.equal(back.archivedAt, AT);
  });

  test("lo que no está borrado se devuelve tal cual, y lo que no existe es un 404", async () => {
    const kept = store([row({ archivedAt: AT })]);
    const same = await restoreIn(kept, "p", "a", AT, NOUN);
    assert.equal(same.archivedAt, AT);
    assert.equal(same.deletedAt, null);
    await assert.rejects(restoreIn(kept, "p", "no", AT, NOUN), NotFoundError);
  });
});
