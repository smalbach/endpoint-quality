/**
 * The environment repositories against a real Postgres: environments and their credentials, the
 * encrypted cookie jar, and the per-person session token.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Cookie } from "@eq/runner-core";

import {
  EnvironmentCredentialEntity,
  EnvironmentEntity,
  RequestCookieEntity,
  SessionTokenEntity,
} from "@/shared/database/entities";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { TypeOrmEnvironmentRepository } from "@/modules/environments/infrastructure/persistence/typeorm-environment.repository";
import { TypeOrmCookieJarRepository } from "@/modules/environments/infrastructure/persistence/typeorm-cookie-jar.repository";
import { TypeOrmSessionTokenRepository } from "@/modules/environments/infrastructure/persistence/typeorm-session-token.repository";
import type { Credential, Environment } from "@/modules/environments/domain/model";
import type { SessionToken } from "@/modules/environments/domain/session-token";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

const newKey = () => randomBytes(32).toString("base64");

describe("TypeOrmEnvironmentRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmEnvironmentRepository;

  const environment = (projectId: string, fields: Partial<Environment> = {}): Environment => ({
    id: randomUUID(),
    projectId,
    name: `env-${randomUUID().slice(0, 6)}`,
    baseUrl: "https://api.example.test",
    specUrl: null,
    variables: {},
    disabledVariables: {},
    writesAllowed: false,
    authEnforced: false,
    createdAt: at(0),
    ...fields,
  });

  const credential = (environmentId: string, fields: Partial<Credential> = {}): Credential => ({
    id: randomUUID(),
    environmentId,
    name: "main",
    role: "primary",
    kind: "bearer",
    headerName: null,
    secretCiphertext: "v1.a.b.c",
    scopes: [],
    createdAt: at(0),
    updatedAt: at(0),
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmEnvironmentRepository(
      db.dataSource.getRepository(EnvironmentEntity),
      db.dataSource.getRepository(EnvironmentCredentialEntity),
    );
  });
  after(async () => db?.drop());

  test("round-trips an environment and finds it by id and by name within the project", async () => {
    const saved = environment(tenant.projectId, {
      name: "staging",
      specUrl: "https://api.example.test/spec.json",
      variables: { host: { initial: "a", current: "b", sensitive: false } },
      disabledVariables: { old: { initial: "x", current: "x", sensitive: true } },
      writesAllowed: true,
      authEnforced: true,
    });
    await repo.save(saved);
    assert.deepEqual(await repo.findById(saved.id), saved);
    assert.deepEqual(await repo.findByName(tenant.projectId, "staging"), saved);
    assert.equal(await repo.findByName(tenant.otherProjectId, "staging"), null);
    assert.equal(await repo.findByName(tenant.projectId, "nope"), null);
    assert.equal(await repo.findById(randomUUID()), null);
  });

  test("a name is unique per project, not globally", async () => {
    const t = await seedTenant(db.dataSource);
    await repo.save(environment(t.projectId, { name: "prod" }));
    await repo.save(environment(t.otherProjectId, { name: "prod" }));
    await assert.rejects(() => repo.save(environment(t.projectId, { name: "prod" })), /duplicate key/);
  });

  test("listForProject is oldest first and scoped", async () => {
    const t = await seedTenant(db.dataSource);
    const late = environment(t.projectId, { name: "late", createdAt: at(9) });
    const early = environment(t.projectId, { name: "early", createdAt: at(1) });
    for (const e of [late, environment(t.otherProjectId), early]) await repo.save(e);
    assert.deepEqual(
      (await repo.listForProject(t.projectId)).map((e) => e.name),
      ["early", "late"],
    );
  });

  test("credentials: ordered by role, found by role, one per role, removed by role", async () => {
    const env = environment(tenant.projectId);
    await repo.save(env);
    assert.deepEqual(await repo.listCredentials(env.id), []);
    assert.equal(await repo.findCredential(env.id, "primary"), null);

    const primary = credential(env.id, { role: "primary", scopes: ["read", "write"] });
    const insufficient = credential(env.id, { role: "insufficient", kind: "api_key", headerName: "X-Key" });
    await repo.saveCredential(primary);
    await repo.saveCredential(insufficient);
    assert.deepEqual(
      (await repo.listCredentials(env.id)).map((c) => c.role),
      ["insufficient", "primary"],
    );
    assert.deepEqual(await repo.findCredential(env.id, "insufficient"), insufficient);
    assert.deepEqual((await repo.findCredential(env.id, "primary"))?.scopes, ["read", "write"]);

    await assert.rejects(() => repo.saveCredential(credential(env.id, { role: "primary" })), /duplicate key/);

    await repo.saveCredential({ ...primary, secretCiphertext: "v1.new", updatedAt: at(5) });
    assert.equal((await repo.findCredential(env.id, "primary"))?.secretCiphertext, "v1.new");

    await repo.removeCredential(env.id, "insufficient");
    assert.deepEqual(
      (await repo.listCredentials(env.id)).map((c) => c.role),
      ["primary"],
    );
  });

  test("removing an environment takes its credentials with it", async () => {
    const env = environment(tenant.projectId);
    const keep = environment(tenant.projectId);
    await repo.save(env);
    await repo.save(keep);
    await repo.saveCredential(credential(env.id));
    await repo.saveCredential(credential(keep.id));
    await repo.remove(env.id);
    assert.equal(await repo.findById(env.id), null);
    assert.equal(await countRows(db.dataSource, "environment_credentials", `"environmentId" = $1`, [env.id]), 0);
    assert.equal((await repo.listCredentials(keep.id)).length, 1);
  });

  test("a credential for an unknown environment violates the foreign key", async () => {
    await assert.rejects(() => repo.saveCredential(credential(randomUUID())), /foreign key/);
  });
});

describe("TypeOrmCookieJarRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let cipher: AesGcmSecretCipher;
  let repo: TypeOrmCookieJarRepository;

  const cookie = (fields: Partial<Cookie> = {}): Cookie => ({
    name: "sid",
    value: "secret-session",
    domain: "api.example.test",
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: at(0).getTime(),
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    cipher = new AesGcmSecretCipher(newKey());
    repo = new TypeOrmCookieJarRepository(db.dataSource.getRepository(RequestCookieEntity), cipher);
  });
  after(async () => db?.drop());

  test("stores the value encrypted and lists it decrypted, every field intact", async () => {
    const actor = randomUUID();
    const session = cookie();
    const persistent = cookie({
      name: "pref",
      value: "dark",
      path: "/admin",
      expiresAt: at(3600).getTime(),
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      hostOnly: false,
      createdAt: at(10).getTime(),
    });
    await repo.save(actor, tenant.projectId, [session, persistent]);

    const rows: { valueCiphertext: string }[] = await db.dataSource.query(
      `SELECT "valueCiphertext" FROM request_cookies WHERE "actorId" = $1`,
      [actor],
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.valueCiphertext, /^v1\./);
      assert.equal(row.valueCiphertext.includes("secret-session"), false, "never in clear");
    }

    const jar = (await repo.list(actor, tenant.projectId)).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(jar, [persistent, session]);
  });

  test("the jar belongs to one person in one project", async () => {
    const actor = randomUUID();
    await repo.save(actor, tenant.projectId, [cookie()]);
    assert.deepEqual(await repo.list(randomUUID(), tenant.projectId), []);
    assert.deepEqual(await repo.list(actor, tenant.otherProjectId), []);
  });

  test("saving an empty jar writes nothing; saving the same key replaces the value", async () => {
    const actor = randomUUID();
    await repo.save(actor, tenant.projectId, []);
    assert.equal(await countRows(db.dataSource, "request_cookies", `"actorId" = $1`, [actor]), 0);
    await repo.save(actor, tenant.projectId, [cookie({ value: "one" })]);
    await repo.save(actor, tenant.projectId, [cookie({ value: "two" })]);
    const jar = await repo.list(actor, tenant.projectId);
    assert.deepEqual(
      jar.map((c) => c.value),
      ["two"],
    );
  });

  test("the key is domain, path and name: the same name on another path is another cookie", async () => {
    const actor = randomUUID();
    await repo.save(actor, tenant.projectId, [cookie({ path: "/" }), cookie({ path: "/admin", value: "admin" })]);
    assert.equal((await repo.list(actor, tenant.projectId)).length, 2);

    await repo.remove(actor, tenant.projectId, [{ domain: "api.example.test", path: "/admin", name: "sid" }]);
    assert.deepEqual(
      (await repo.list(actor, tenant.projectId)).map((c) => c.path),
      ["/"],
    );
    await repo.remove(actor, tenant.projectId, []);
    assert.equal((await repo.list(actor, tenant.projectId)).length, 1);
  });

  test("a cookie encrypted under another key is skipped, not an error", async () => {
    const actor = randomUUID();
    const oldKey = new TypeOrmCookieJarRepository(
      db.dataSource.getRepository(RequestCookieEntity),
      new AesGcmSecretCipher(newKey()),
    );
    await oldKey.save(actor, tenant.projectId, [cookie({ name: "stale" })]);
    await repo.save(actor, tenant.projectId, [cookie({ name: "fresh", value: "ok" })]);
    await db.dataSource.query(
      `INSERT INTO request_cookies ("actorId", "projectId", domain, path, name, "valueCiphertext", "createdAt")
       VALUES ($1, $2, 'x.test', '/', 'garbage', 'not-a-payload', now())`,
      [actor, tenant.projectId],
    );
    const jar = await repo.list(actor, tenant.projectId);
    assert.deepEqual(
      jar.map((c) => [c.name, c.value]),
      [["fresh", "ok"]],
    );
  });

  test("clear empties one person's jar in one project only", async () => {
    const actor = randomUUID();
    const other = randomUUID();
    await repo.save(actor, tenant.projectId, [cookie()]);
    await repo.save(actor, tenant.otherProjectId, [cookie()]);
    await repo.save(other, tenant.projectId, [cookie()]);
    await repo.clear(actor, tenant.projectId);
    assert.deepEqual(await repo.list(actor, tenant.projectId), []);
    assert.equal((await repo.list(actor, tenant.otherProjectId)).length, 1);
    assert.equal((await repo.list(other, tenant.projectId)).length, 1);
  });

  test("purgeExpired deletes what expired at or before now and keeps session cookies", async () => {
    const actor = randomUUID();
    const now = at(1000);
    await repo.save(actor, tenant.projectId, [
      cookie({ name: "past", expiresAt: at(999).getTime() }),
      cookie({ name: "exact", expiresAt: now.getTime() }),
      cookie({ name: "future", expiresAt: at(1001).getTime() }),
      cookie({ name: "session", expiresAt: null }),
    ]);
    const otherActor = randomUUID();
    await repo.save(otherActor, tenant.projectId, [cookie({ name: "past", expiresAt: at(1).getTime() })]);

    await repo.purgeExpired(actor, tenant.projectId, now);
    assert.deepEqual(
      (await repo.list(actor, tenant.projectId)).map((c) => c.name).sort(),
      ["future", "session"],
    );
    assert.equal((await repo.list(otherActor, tenant.projectId)).length, 1, "only that person's jar is purged");
  });
});

describe("TypeOrmSessionTokenRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmSessionTokenRepository;

  const token = (actorId: string, projectId: string, fields: Partial<SessionToken> = {}): SessionToken => ({
    actorId,
    projectId,
    tokenCiphertext: "v1.x.y.z",
    claims: null,
    expiresAt: null,
    capturedAt: at(0),
    source: "login",
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmSessionTokenRepository(db.dataSource.getRepository(SessionTokenEntity));
  });
  after(async () => db?.drop());

  test("round-trips a token, with and without claims and expiry", async () => {
    const actor = randomUUID();
    assert.equal(await repo.find(actor, tenant.projectId), null);
    const bare = token(actor, tenant.projectId);
    await repo.save(bare);
    assert.deepEqual(await repo.find(actor, tenant.projectId), bare);

    const full = token(actor, tenant.projectId, {
      claims: { sub: "u1", roles: ["admin"] },
      expiresAt: at(3600),
      capturedAt: at(10),
      source: "script",
    });
    await repo.save(full);
    assert.deepEqual(await repo.find(actor, tenant.projectId), full, "one token per person and project");
    assert.equal(await countRows(db.dataSource, "session_tokens", `"actorId" = $1`, [actor]), 1);
  });

  test("tokens are per person and per project, and remove takes only that one", async () => {
    const actor = randomUUID();
    const other = randomUUID();
    await repo.save(token(actor, tenant.projectId));
    await repo.save(token(actor, tenant.otherProjectId, { source: "script" }));
    await repo.save(token(other, tenant.projectId));
    await repo.remove(actor, tenant.projectId);
    assert.equal(await repo.find(actor, tenant.projectId), null);
    assert.equal((await repo.find(actor, tenant.otherProjectId))?.source, "script");
    assert.ok(await repo.find(other, tenant.projectId));
  });

  test("deleting the project takes its tokens", async () => {
    const t = await seedTenant(db.dataSource);
    const actor = randomUUID();
    await repo.save(token(actor, t.projectId));
    await deleteProject(db.dataSource, t.projectId);
    assert.equal(await repo.find(actor, t.projectId), null);
    await assert.rejects(() => repo.save(token(actor, t.projectId)), /foreign key/);
  });
});
