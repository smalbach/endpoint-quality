/**
 * The channel repositories against a real Postgres: channels, their sessions and messages, and
 * the `.proto` files of a gRPC channel.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { blankConversation, type ChannelMessage } from "@eq/runner-core";

import {
  ChannelEndpointEntity,
  ChannelMessageEntity,
  ChannelProtoFileEntity,
  ChannelSessionEntity,
} from "@/shared/database/entities";
import {
  TypeOrmChannelRepository,
  TypeOrmChannelSessionRepository,
} from "@/modules/channels/infrastructure/persistence/typeorm-channel.repository";
import { TypeOrmChannelProtoRepository } from "@/modules/channels/infrastructure/persistence/typeorm-proto.repository";
import type { Channel } from "@/modules/channels/domain/model";
import type { ChannelSession } from "@/modules/channels/domain/session";
import { DEFAULT_MQTT } from "@/modules/channels/domain/mqtt";
import { DEFAULT_SOCKETIO } from "@/modules/channels/domain/socketio";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

function channel(projectId: string, fields: Record<string, unknown> = {}): Channel {
  return {
    id: randomUUID(),
    projectId,
    protocol: "ws",
    name: "chat",
    url: "wss://example.test/socket",
    subprotocols: [],
    headers: [],
    auth: null,
    limits: { maxMessages: 10 },
    expectations: {},
    messages: [],
    mqtt: null,
    grpc: null,
    socketio: null,
    orderIndex: 0,
    createdAt: at(0),
    updatedAt: at(0),
    updatedBy: null,
    deletedAt: null,
    ...fields,
  } as unknown as Channel;
}

function session(tenant: Tenant, channelId: string, fields: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: randomUUID(),
    channelId,
    projectId: tenant.projectId,
    environmentId: null,
    status: "open",
    conversation: blankConversation(),
    verdict: null,
    stopReason: null,
    ownerInstance: "instance-a",
    heartbeatAt: at(100),
    openedAt: at(0),
    closedAt: null,
    startedBy: tenant.userId,
    ...fields,
  };
}

describe("TypeOrmChannelRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmChannelRepository;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
  });
  after(async () => db?.drop());

  test("a plain WebSocket channel round-trips with its protocol settings null", async () => {
    const saved = channel(tenant.projectId, { limits: { maxMessages: 5 }, headers: [{ name: "x", value: "1" }] });
    await repo.save(saved);
    const found = await repo.findById(tenant.projectId, saved.id);
    assert.ok(found);
    assert.equal(found.name, "chat");
    assert.deepEqual(found.limits, { maxMessages: 5 });
    assert.deepEqual(found.headers, [{ name: "x", value: "1" }]);
    assert.equal(found.mqtt, null);
    assert.equal(found.grpc, null);
    assert.equal(found.socketio, null);
  });

  test("stored MQTT and Socket.IO settings are completed with the defaults an old row lacks", async () => {
    const mqtt = channel(tenant.projectId, { protocol: "mqtt", mqtt: { clientId: "c1", keepaliveSec: 30 } });
    const socketio = channel(tenant.projectId, { protocol: "socketio", socketio: { namespace: "/chat" } });
    const grpc = channel(tenant.projectId, {
      protocol: "grpc",
      grpc: { service: "a.B", method: "C", deadlineMs: 500 },
    });
    await repo.save(mqtt);
    await repo.save(socketio);
    await repo.save(grpc);

    assert.deepEqual((await repo.findById(tenant.projectId, mqtt.id))?.mqtt, {
      ...DEFAULT_MQTT,
      clientId: "c1",
      keepaliveSec: 30,
    });
    assert.deepEqual((await repo.findById(tenant.projectId, socketio.id))?.socketio, {
      ...DEFAULT_SOCKETIO,
      namespace: "/chat",
    });
    assert.deepEqual((await repo.findById(tenant.projectId, grpc.id))?.grpc, {
      service: "a.B",
      method: "C",
      deadlineMs: 500,
    });
  });

  test("a row written without the grpc column value reads back as null, not undefined", async () => {
    const id = randomUUID();
    await db.dataSource.query(
      `INSERT INTO channel_endpoints (id, "projectId", protocol, name, url, limits, "createdAt", "updatedAt")
       VALUES ($1, $2, 'ws', 'old', 'ws://x', '{}'::jsonb, now(), now())`,
      [id, tenant.projectId],
    );
    const found = await repo.findById(tenant.projectId, id);
    assert.ok(found);
    assert.strictEqual(found.grpc, null);
    assert.strictEqual(found.mqtt, null);
    assert.strictEqual(found.socketio, null);
  });

  test("lists by orderIndex then creation, without deleted channels or another project's", async () => {
    const t = await seedTenant(db.dataSource);
    const second = channel(t.projectId, { name: "second", orderIndex: 1, createdAt: at(1) });
    const firstOld = channel(t.projectId, { name: "first-old", orderIndex: 0, createdAt: at(1) });
    const firstNew = channel(t.projectId, { name: "first-new", orderIndex: 0, createdAt: at(5) });
    const deleted = channel(t.projectId, { name: "deleted", deletedAt: at(9) });
    const foreign = channel(t.otherProjectId, { name: "foreign" });
    for (const c of [second, firstNew, deleted, foreign, firstOld]) await repo.save(c);

    assert.deepEqual(
      (await repo.listByProject(t.projectId)).map((c) => c.name),
      ["first-old", "first-new", "second"],
    );
    assert.equal(await repo.countByProject(t.projectId), 3);
    assert.equal(await repo.countByProject(t.otherProjectId), 1);
    assert.equal(await repo.findById(t.projectId, deleted.id), null);
    assert.equal(await repo.findById(t.projectId, foreign.id), null, "another project's channel is not found");
    assert.equal(await repo.findById(t.projectId, randomUUID()), null);
  });

  test("save updates in place, and a soft delete hides the channel", async () => {
    const c = channel(tenant.projectId, { name: "before" });
    await repo.save(c);
    await repo.save({ ...c, name: "after" });
    assert.equal((await repo.findById(tenant.projectId, c.id))?.name, "after");
    assert.equal(await countRows(db.dataSource, "channel_endpoints", "id = $1", [c.id]), 1);
    await repo.save({ ...c, name: "after", deletedAt: at(50) } as Channel);
    assert.equal(await repo.findById(tenant.projectId, c.id), null);
  });
});

describe("TypeOrmChannelSessionRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let channelId: string;
  let repo: TypeOrmChannelSessionRepository;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    const channels = new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
    const c = channel(tenant.projectId);
    await channels.save(c);
    channelId = c.id;
    repo = new TypeOrmChannelSessionRepository(
      db.dataSource.getRepository(ChannelSessionEntity),
      db.dataSource.getRepository(ChannelMessageEntity),
    );
  });
  after(async () => db?.drop());

  test("the conversation's state survives the split into row and counters", async () => {
    const conversation = {
      ...blankConversation(),
      handshake: { status: 101, headers: { upgrade: "websocket" } },
      openedAtMs: 1000,
      closedAtMs: 2500,
      closeCode: 1000,
      closeReason: "bye",
      trailers: { "grpc-status": "0" },
      stopped: "max-messages",
      counters: { sent: 2, received: 3, bytesIn: 40, bytesOut: 20 },
    } as unknown as ChannelSession["conversation"];
    const saved = session(tenant, channelId, {
      status: "closed",
      conversation,
      verdict: { passed: true, results: [] } as unknown as ChannelSession["verdict"],
      stopReason: "max-messages" as ChannelSession["stopReason"],
      closedAt: at(200),
    });
    await repo.save(saved);

    const found = await repo.findById(tenant.projectId, saved.id);
    assert.ok(found);
    assert.equal(found.status, "closed");
    assert.deepEqual(found.conversation.handshake, { status: 101, headers: { upgrade: "websocket" } });
    assert.equal(found.conversation.openedAtMs, 1000);
    assert.equal(found.conversation.closedAtMs, 2500);
    assert.equal(found.conversation.closeCode, 1000);
    assert.equal(found.conversation.closeReason, "bye");
    assert.deepEqual(found.conversation.trailers, { "grpc-status": "0" });
    assert.equal(found.conversation.stopped, "max-messages");
    assert.deepEqual(found.conversation.counters, { sent: 2, received: 3, bytesIn: 40, bytesOut: 20 });
    assert.deepEqual(found.conversation.messages, [], "messages live in their own table");
    assert.deepEqual(found.verdict, { passed: true, results: [] });
    assert.equal(found.stopReason, "max-messages");
    assert.equal(found.closedAt?.getTime(), at(200).getTime());
    assert.equal(found.startedBy, tenant.userId);

    const [row] = await db.dataSource.query(`SELECT "prunedAt" FROM channel_sessions WHERE id = $1`, [saved.id]);
    assert.equal(row.prunedAt, null);
  });

  test("an old row with empty counters and no handshake reads with the blank defaults", async () => {
    const id = randomUUID();
    await db.dataSource.query(
      `INSERT INTO channel_sessions (id, "channelId", "projectId", status, counters, "ownerInstance", "heartbeatAt", "openedAt", "startedBy")
       VALUES ($1, $2, $3, 'error', '{}'::jsonb, 'old', now(), now(), $4)`,
      [id, channelId, tenant.projectId, tenant.userId],
    );
    const found = await repo.findById(tenant.projectId, id);
    assert.ok(found);
    assert.deepEqual(found.conversation, blankConversation());
    assert.equal(found.verdict, null);
    assert.equal(found.stopReason, null);
    assert.equal(found.environmentId, null);
  });

  test("a JSON null in the counters column reads as zero counters", async () => {
    const id = randomUUID();
    await db.dataSource.query(
      `INSERT INTO channel_sessions (id, "channelId", "projectId", status, counters, "ownerInstance", "heartbeatAt", "openedAt", "startedBy")
       VALUES ($1, $2, $3, 'closed', 'null'::jsonb, 'old', now(), now(), $4)`,
      [id, channelId, tenant.projectId, tenant.userId],
    );
    const found = await repo.findById(tenant.projectId, id);
    assert.deepEqual(found?.conversation.counters, { sent: 0, received: 0, bytesIn: 0, bytesOut: 0 });
    assert.equal(found?.conversation.openedAtMs, null);
  });

  test("findById is scoped to the project", async () => {
    const saved = session(tenant, channelId);
    await repo.save(saved);
    assert.ok(await repo.findById(tenant.projectId, saved.id));
    assert.equal(await repo.findById(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.findById(tenant.projectId, randomUUID()), null);
  });

  test("listByChannel returns the newest first, up to the limit, only of that project", async () => {
    const t = await seedTenant(db.dataSource);
    const channels = new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
    const c = channel(t.projectId);
    await channels.save(c);
    const old = session(t, c.id, { openedAt: at(1), status: "closed" });
    const mid = session(t, c.id, { openedAt: at(2), status: "closed" });
    const recent = session(t, c.id, { openedAt: at(3), status: "closed" });
    for (const s of [mid, recent, old]) await repo.save(s);

    assert.deepEqual(
      (await repo.listByChannel(t.projectId, c.id, 10)).map((s) => s.id),
      [recent.id, mid.id, old.id],
    );
    assert.deepEqual(
      (await repo.listByChannel(t.projectId, c.id, 2)).map((s) => s.id),
      [recent.id, mid.id],
    );
    assert.deepEqual(await repo.listByChannel(t.otherProjectId, c.id, 10), []);
  });

  test("messages keep their order and only carry the protocol fields they have", async () => {
    const s = session(tenant, channelId);
    await repo.save(s);
    await repo.appendMessages(s.id, []);
    assert.deepEqual(await repo.listMessages(s.id), []);

    const ws: ChannelMessage = { seq: 1, direction: "out", kind: "text", atMs: 10, bytes: 5, truncated: false, body: "hello" };
    const mqtt = {
      seq: 3,
      direction: "in",
      kind: "text",
      atMs: 30,
      bytes: 2,
      truncated: true,
      body: "{}",
      topic: "a/b",
      qos: 1,
      retain: false,
      properties: { contentType: "application/json" },
    } as ChannelMessage;
    const socketio = {
      seq: 2,
      direction: "in",
      kind: "text",
      atMs: 20,
      bytes: 4,
      truncated: false,
      body: "[1]",
      event: "tick",
      ack: true,
    } as ChannelMessage;
    await repo.appendMessages(s.id, [mqtt, ws]);
    await repo.appendMessages(s.id, [socketio]);

    const listed = await repo.listMessages(s.id);
    assert.deepEqual(listed, [ws, socketio, mqtt]);
    assert.equal("topic" in listed[0], false, "a WebSocket message has no MQTT fields");
    assert.equal("event" in listed[2], false);
  });

  test("a duplicate sequence number is rejected by the primary key", async () => {
    const s = session(tenant, channelId);
    await repo.save(s);
    const m: ChannelMessage = { seq: 1, direction: "in", kind: "text", atMs: 0, bytes: 0, truncated: false, body: "" };
    await repo.appendMessages(s.id, [m]);
    await assert.rejects(() => repo.appendMessages(s.id, [m]), /duplicate key/);
  });

  test("countLive, beat and findStale only touch the live sessions of an instance", async () => {
    const live = session(tenant, channelId, { ownerInstance: "reaper-a", status: "open", heartbeatAt: at(10) });
    const connecting = session(tenant, channelId, {
      ownerInstance: "reaper-a",
      status: "connecting",
      heartbeatAt: at(10),
    });
    const closed = session(tenant, channelId, { ownerInstance: "reaper-a", status: "closed", heartbeatAt: at(10) });
    const other = session(tenant, channelId, { ownerInstance: "reaper-b", status: "open", heartbeatAt: at(10) });
    for (const s of [live, connecting, closed, other]) await repo.save(s);

    assert.equal(await repo.countLive("reaper-a"), 2);
    assert.equal(await repo.countLive("reaper-b"), 1);
    assert.equal(await repo.countLive("nobody"), 0);

    const staleBefore = (await repo.findStale(at(11))).map((s) => s.id);
    for (const id of [live.id, connecting.id, other.id]) assert.ok(staleBefore.includes(id));
    assert.equal(staleBefore.includes(closed.id), false, "a closed session is never stale");

    await repo.beat("reaper-a", at(500));
    assert.equal((await repo.findById(tenant.projectId, live.id))?.heartbeatAt.getTime(), at(500).getTime());
    assert.equal((await repo.findById(tenant.projectId, connecting.id))?.heartbeatAt.getTime(), at(500).getTime());
    assert.equal((await repo.findById(tenant.projectId, closed.id))?.heartbeatAt.getTime(), at(10).getTime());
    assert.equal((await repo.findById(tenant.projectId, other.id))?.heartbeatAt.getTime(), at(10).getTime());

    const staleAfter = (await repo.findStale(at(11))).map((s) => s.id);
    assert.equal(staleAfter.includes(live.id), false);
    assert.equal(staleAfter.includes(connecting.id), false);
    assert.ok(staleAfter.includes(other.id));
  });

  test("deleting the project removes its sessions and their messages", async () => {
    const t = await seedTenant(db.dataSource);
    const channels = new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
    const c = channel(t.projectId);
    await channels.save(c);
    const s = session(t, c.id);
    await repo.save(s);
    await repo.appendMessages(s.id, [{ seq: 1, direction: "in", kind: "text", atMs: 0, bytes: 0, truncated: false, body: "" }]);
    await deleteProject(db.dataSource, t.projectId);
    assert.equal(await repo.findById(t.projectId, s.id), null);
    assert.deepEqual(await repo.listMessages(s.id), []);
  });
});

describe("TypeOrmChannelProtoRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmChannelProtoRepository;
  let channels: TypeOrmChannelRepository;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmChannelProtoRepository(db.dataSource.getRepository(ChannelProtoFileEntity));
    channels = new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
  });
  after(async () => db?.drop());

  test("replace stores the set sorted by path, with its utf-8 size", async () => {
    const c = channel(tenant.projectId, { protocol: "grpc" });
    await channels.save(c);
    assert.deepEqual(await repo.list(c.id), []);

    await repo.replace(c.id, [
      { path: "b/svc.proto", content: "syntax = \"proto3\";" },
      { path: "a/ñ.proto", content: "// ñ" },
    ]);
    assert.deepEqual(await repo.list(c.id), [
      { path: "a/ñ.proto", content: "// ñ" },
      { path: "b/svc.proto", content: "syntax = \"proto3\";" },
    ]);
    const [row] = await db.dataSource.query(`SELECT bytes FROM channel_proto_files WHERE "channelId" = $1 AND path = 'a/ñ.proto'`, [c.id]);
    assert.equal(row.bytes, 5, "bytes are utf-8 bytes (ñ is two), not the 4 characters");
  });

  test("replace swaps the whole set, an empty one clears it, and other channels are untouched", async () => {
    const c = channel(tenant.projectId, { protocol: "grpc" });
    const other = channel(tenant.projectId, { protocol: "grpc" });
    await channels.save(c);
    await channels.save(other);
    await repo.replace(other.id, [{ path: "keep.proto", content: "x" }]);
    await repo.replace(c.id, [{ path: "old.proto", content: "1" }]);
    await repo.replace(c.id, [{ path: "new.proto", content: "2" }]);
    assert.deepEqual(await repo.list(c.id), [{ path: "new.proto", content: "2" }]);
    await repo.replace(c.id, []);
    assert.deepEqual(await repo.list(c.id), []);
    assert.deepEqual(await repo.list(other.id), [{ path: "keep.proto", content: "x" }]);
  });

  test("a failing replace rolls back and leaves the previous set", async () => {
    const c = channel(tenant.projectId, { protocol: "grpc" });
    await channels.save(c);
    await repo.replace(c.id, [{ path: "keep.proto", content: "x" }]);
    await assert.rejects(() =>
      repo.replace(c.id, [
        { path: "dup.proto", content: "1" },
        { path: "dup.proto", content: "2" },
      ]),
    );
    assert.deepEqual(await repo.list(c.id), [{ path: "keep.proto", content: "x" }]);
  });

  test("files of an unknown channel violate the foreign key", async () => {
    await assert.rejects(() => repo.replace(randomUUID(), [{ path: "x.proto", content: "" }]), /foreign key/);
  });
});
