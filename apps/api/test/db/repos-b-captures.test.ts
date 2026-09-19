/**
 * The capture repositories against a real Postgres: sessions, their numbered items, expiry, and
 * the installation's single capture CA.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { CaptureAuthorityEntity, CaptureItemEntity, CaptureSessionEntity } from "@/shared/database/entities";
import { TypeOrmCaptureRepository } from "@/modules/captures/infrastructure/persistence/typeorm-capture.repository";
import { TypeOrmCaptureAuthorityRepository } from "@/modules/captures/infrastructure/persistence/typeorm-capture-authority.repository";
import type { CaptureItem, CaptureSession } from "@/modules/captures/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, plain, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

describe("TypeOrmCaptureRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmCaptureRepository;

  const session = (projectId: string, fields: Partial<CaptureSession> = {}): CaptureSession =>
    ({
      id: randomUUID(),
      projectId,
      status: "active",
      tokenHash: randomBytes(32).toString("hex"),
      limits: { durationMs: 60_000, maxRequests: 100, maxBodyBytes: 1024 },
      itemCount: 0,
      startedAt: at(0),
      expiresAt: at(60),
      stoppedAt: null,
      stopReason: null,
      startedBy: tenant.userId,
      decryptHttps: false,
      ...fields,
    }) as CaptureSession;

  const item = (s: CaptureSession, fields: Partial<CaptureItem> = {}): CaptureItem =>
    ({
      id: randomUUID(),
      sessionId: s.id,
      projectId: s.projectId,
      seq: 1,
      at: at(1),
      method: "GET",
      url: "https://api.example.test/x",
      status: 200,
      encrypted: false,
      requestHeaders: { accept: "application/json" },
      requestBody: "",
      requestBodyTruncated: false,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{}",
      responseBodyTruncated: false,
      responseContentType: "application/json",
      durationMs: 4,
      error: null,
      ...fields,
    }) as CaptureItem;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmCaptureRepository(
      db.dataSource.getRepository(CaptureSessionEntity),
      db.dataSource.getRepository(CaptureItemEntity),
    );
  });
  after(async () => db?.drop());

  describe("sessions", () => {
    test("round-trips a session and finds it by project-scoped id and by token hash", async () => {
      const saved = session(tenant.projectId, { decryptHttps: true });
      await repo.saveSession(saved);
      assert.deepEqual(plain(await repo.findSession(tenant.projectId, saved.id)), saved);
      assert.deepEqual(plain(await repo.findSessionByTokenHash(saved.tokenHash)), saved);
      assert.equal(await repo.findSession(tenant.otherProjectId, saved.id), null);
      assert.equal(await repo.findSessionByTokenHash("0".repeat(64)), null);
    });

    test("the token hash is unique", async () => {
      const saved = session(tenant.projectId);
      await repo.saveSession(saved);
      await assert.rejects(
        () => repo.saveSession(session(tenant.otherProjectId, { tokenHash: saved.tokenHash })),
        /duplicate key/,
      );
    });

    test("listSessions is newest first, up to the limit, only of that project", async () => {
      const t = await seedTenant(db.dataSource);
      const s1 = session(t.projectId, { startedAt: at(1) });
      const s2 = session(t.projectId, { startedAt: at(2) });
      const s3 = session(t.projectId, { startedAt: at(3) });
      for (const s of [s2, session(t.otherProjectId, { startedAt: at(9) }), s3, s1]) await repo.saveSession(s);
      assert.deepEqual(
        (await repo.listSessions(t.projectId, 10)).map((s) => s.id),
        [s3.id, s2.id, s1.id],
      );
      assert.deepEqual(
        (await repo.listSessions(t.projectId, 2)).map((s) => s.id),
        [s3.id, s2.id],
      );
    });

    test("removeSession needs the right project and takes the items", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      await repo.appendItem(item(s));
      assert.equal(await repo.removeSession(tenant.otherProjectId, s.id), false);
      assert.equal(await repo.removeSession(tenant.projectId, s.id), true);
      assert.equal(await repo.removeSession(tenant.projectId, s.id), false);
      assert.equal(await countRows(db.dataSource, "capture_items", `"sessionId" = $1`, [s.id]), 0);
    });

    test("stopSession stops an active session once, in its project only", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      assert.equal(await repo.stopSession(tenant.otherProjectId, s.id, "manual", at(5)), false);
      assert.equal(await repo.stopSession(tenant.projectId, s.id, "manual", at(5)), true);
      assert.equal(await repo.stopSession(tenant.projectId, s.id, "expired", at(6)), false);
      const stopped = await repo.findSession(tenant.projectId, s.id);
      assert.equal(stopped?.status, "stopped");
      assert.equal(stopped?.stopReason, "manual");
      assert.equal(stopped?.stoppedAt?.getTime(), at(5).getTime());
    });
  });

  describe("expiry and the active list", () => {
    // Global queries: each test starts from an empty sessions table in this private schema.
    beforeEach(async () => {
      await db.dataSource.query(`DELETE FROM capture_sessions`);
    });

    test("listActive returns only the active sessions of every project", async () => {
      const a = session(tenant.projectId);
      const b = session(tenant.otherProjectId);
      const stopped = session(tenant.projectId, { status: "stopped", stopReason: "manual", stoppedAt: at(1) });
      for (const s of [a, b, stopped]) await repo.saveSession(s);
      assert.deepEqual((await repo.listActive()).map((s) => s.id).sort(), [a.id, b.id].sort());
    });

    test("expireDue stops the active sessions past their expiry, at or before now", async () => {
      const past = session(tenant.projectId, { expiresAt: at(10) });
      const exact = session(tenant.otherProjectId, { expiresAt: at(20) });
      const future = session(tenant.projectId, { expiresAt: at(21) });
      const alreadyStopped = session(tenant.projectId, {
        expiresAt: at(5),
        status: "stopped",
        stopReason: "manual",
        stoppedAt: at(4),
      });
      for (const s of [past, exact, future, alreadyStopped]) await repo.saveSession(s);

      assert.equal(await repo.expireDue(at(20)), 2);
      const expired = await repo.findSession(tenant.projectId, past.id);
      assert.equal(expired?.status, "stopped");
      assert.equal(expired?.stopReason, "expired");
      assert.equal(expired?.stoppedAt?.getTime(), at(20).getTime());
      assert.equal((await repo.findSession(tenant.otherProjectId, exact.id))?.stopReason, "expired");
      assert.equal((await repo.findSession(tenant.projectId, future.id))?.status, "active");
      const untouched = await repo.findSession(tenant.projectId, alreadyStopped.id);
      assert.equal(untouched?.stopReason, "manual");
      assert.equal(untouched?.stoppedAt?.getTime(), at(4).getTime());

      assert.equal(await repo.expireDue(at(20)), 0, "nothing is expired twice");
      assert.deepEqual(
        (await repo.listActive()).map((s) => s.id),
        [future.id],
      );
    });
  });

  describe("items", () => {
    test("appendNext numbers items from the session's counter and stops at the cap", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      const { seq: _seq, ...base } = item(s);
      assert.equal(await repo.appendNext({ ...base, id: randomUUID() }, 2), 1);
      assert.equal(await repo.appendNext({ ...base, id: randomUUID() }, 2), 2);
      assert.equal(await repo.appendNext({ ...base, id: randomUUID() }, 2), null, "the cap is reached");
      assert.equal((await repo.findSession(tenant.projectId, s.id))?.itemCount, 2);
      assert.deepEqual(
        (await repo.listItems(tenant.projectId, s.id, 0, 10)).map((i) => i.seq),
        [1, 2],
      );
    });

    test("appendNext refuses a session of another project and a stopped one", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      const { seq: _seq, ...base } = item(s);
      assert.equal(await repo.appendNext({ ...base, projectId: tenant.otherProjectId }, 10), null);
      await repo.stopSession(tenant.projectId, s.id, "manual", at(1));
      assert.equal(await repo.appendNext(base, 10), null);
      assert.equal(await countRows(db.dataSource, "capture_items", `"sessionId" = $1`, [s.id]), 0);
    });

    test("appendNext rolls the counter back when the item cannot be written", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      const { seq: _seq, ...base } = item(s);
      await repo.appendNext(base, 10);
      await assert.rejects(() => repo.appendNext(base, 10), /duplicate key/);
      assert.equal((await repo.findSession(tenant.projectId, s.id))?.itemCount, 1);
    });

    test("an appended item round-trips, and listItems pages after a sequence number", async () => {
      const s = session(tenant.projectId);
      await repo.saveSession(s);
      const items = [1, 2, 3, 4].map((seq) =>
        item(s, {
          seq,
          status: seq === 4 ? null : 200,
          error: seq === 4 ? "ECONNRESET" : null,
          encrypted: seq === 2,
          requestBodyTruncated: seq === 3,
        }),
      );
      for (const i of [items[2], items[0], items[3], items[1]]) await repo.appendItem(i);
      assert.deepEqual(plain(await repo.listItems(tenant.projectId, s.id, 0, 10)), items);
      assert.deepEqual(
        (await repo.listItems(tenant.projectId, s.id, 2, 10)).map((i) => i.seq),
        [3, 4],
      );
      assert.deepEqual(
        (await repo.listItems(tenant.projectId, s.id, 0, 2)).map((i) => i.seq),
        [1, 2],
      );
      assert.deepEqual(plain(await repo.listItems(tenant.otherProjectId, s.id, 0, 10)), []);
      await assert.rejects(() => repo.appendItem(items[0]), /duplicate key/, "an item is written once");
    });

    test("findItems returns the asked ones in sequence order, scoped, and nothing for no ids", async () => {
      const s = session(tenant.projectId);
      const other = session(tenant.projectId);
      await repo.saveSession(s);
      await repo.saveSession(other);
      const a = item(s, { seq: 1 });
      const b = item(s, { seq: 2 });
      const c = item(s, { seq: 3 });
      const elsewhere = item(other, { seq: 1 });
      for (const i of [c, a, b, elsewhere]) await repo.appendItem(i);

      assert.deepEqual(plain(await repo.findItems(tenant.projectId, s.id, [])), []);
      assert.deepEqual(
        (await repo.findItems(tenant.projectId, s.id, [c.id, a.id, elsewhere.id, randomUUID()])).map((i) => i.seq),
        [1, 3],
      );
      assert.deepEqual(plain(await repo.findItems(tenant.otherProjectId, s.id, [a.id])), []);
    });

    test("deleting the project takes its sessions and items", async () => {
      const t = await seedTenant(db.dataSource);
      const s = session(t.projectId);
      await repo.saveSession(s);
      await repo.appendItem(item(s));
      await deleteProject(db.dataSource, t.projectId);
      assert.equal(await repo.findSessionByTokenHash(s.tokenHash), null);
      assert.equal(await countRows(db.dataSource, "capture_items", `"projectId" = $1`, [t.projectId]), 0);
    });
  });
});

describe("TypeOrmCaptureAuthorityRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let repo: TypeOrmCaptureAuthorityRepository;

  before(async () => {
    db = await openIsolatedDb();
    repo = new TypeOrmCaptureAuthorityRepository(db.dataSource.getRepository(CaptureAuthorityEntity));
  });
  after(async () => db?.drop());

  test("find is null until one is stored, and the first one inserted stays", async () => {
    assert.equal(await repo.find(), null);
    const first = { certificatePem: "FIRST", privateKeyCiphertext: "v1.a.b.c", createdAt: at(0) };
    await repo.insertIfAbsent(first);
    await repo.insertIfAbsent({ certificatePem: "SECOND", privateKeyCiphertext: "v1.d.e.f", createdAt: at(1) });
    assert.deepEqual(plain(await repo.find()), first);
    assert.equal(await countRows(db.dataSource, "capture_authorities"), 1);
  });
});
