/**
 * The IAM adapters against a real Postgres (an isolated schema): organizations by slug, memberships
 * scoped by both halves of their key, and which invitation counts as pending.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { InvitationEntity, MembershipEntity, OrganizationEntity } from "@/shared/database/entities";
import {
  TypeOrmInvitationRepository,
  TypeOrmMembershipRepository,
  TypeOrmOrganizationRepository,
} from "@/modules/iam/infrastructure/persistence/typeorm-repositories";
import type { Invitation, Organization } from "@/modules/iam/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { insertOrganization, insertUser } from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);
const hash = () => randomUUID().replace(/-/g, "");

describe("iam persistence adapters", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  describe("TypeOrmOrganizationRepository", () => {
    const repo = () => new TypeOrmOrganizationRepository(db.dataSource.getRepository(OrganizationEntity));

    test("save, then findById and findBySlug return the same organization", async () => {
      const org: Organization = {
        id: randomUUID(),
        name: "Acme",
        slug: `acme-${randomUUID().slice(0, 6)}`,
        createdAt: at("2026-01-01T00:00:00Z"),
      };
      await repo().save(org);
      assert.deepEqual(await repo().findById(org.id), org);
      assert.deepEqual(await repo().findBySlug(org.slug), org);
    });

    test("unknown id or slug is null", async () => {
      assert.equal(await repo().findById(randomUUID()), null);
      assert.equal(await repo().findBySlug("no-such-slug"), null);
    });

    test("a taken slug is rejected by the unique index", async () => {
      const slug = `dup-${randomUUID().slice(0, 6)}`;
      await repo().save({ id: randomUUID(), name: "A", slug, createdAt: new Date() });
      await assert.rejects(repo().save({ id: randomUUID(), name: "B", slug, createdAt: new Date() }), /duplicate|unique/i);
    });
  });

  describe("TypeOrmMembershipRepository", () => {
    const repo = () => new TypeOrmMembershipRepository(db.dataSource.getRepository(MembershipEntity));

    test("find is by organization AND user; either one alone does not match", async () => {
      const org = await insertOrganization(db.dataSource);
      const otherOrg = await insertOrganization(db.dataSource);
      const user = await insertUser(db.dataSource);
      const membership = { organizationId: org, userId: user, role: "admin" as const, createdAt: at("2026-01-01T00:00:00Z") };
      await repo().save(membership);
      assert.deepEqual(await repo().find(org, user), membership);
      assert.equal(await repo().find(otherOrg, user), null);
      assert.equal(await repo().find(org, randomUUID()), null);
    });

    test("listForUser and listForOrganization are oldest first and scoped", async () => {
      const orgA = await insertOrganization(db.dataSource);
      const orgB = await insertOrganization(db.dataSource);
      const user = await insertUser(db.dataSource);
      const colleague = await insertUser(db.dataSource);
      await repo().save({ organizationId: orgB, userId: user, role: "viewer", createdAt: at("2026-03-01T00:00:00Z") });
      await repo().save({ organizationId: orgA, userId: user, role: "owner", createdAt: at("2026-01-01T00:00:00Z") });
      await repo().save({ organizationId: orgA, userId: colleague, role: "editor", createdAt: at("2026-02-01T00:00:00Z") });

      assert.deepEqual(
        (await repo().listForUser(user)).map((m) => [m.organizationId, m.role]),
        [
          [orgA, "owner"],
          [orgB, "viewer"],
        ],
      );
      assert.deepEqual(
        (await repo().listForOrganization(orgA)).map((m) => [m.userId, m.role]),
        [
          [user, "owner"],
          [colleague, "editor"],
        ],
      );
      assert.deepEqual(await repo().listForUser(randomUUID()), []);
    });

    test("save of the same pair changes the role; remove deletes only that pair", async () => {
      const org = await insertOrganization(db.dataSource);
      const user = await insertUser(db.dataSource);
      const other = await insertUser(db.dataSource);
      await repo().save({ organizationId: org, userId: user, role: "viewer", createdAt: new Date() });
      await repo().save({ organizationId: org, userId: other, role: "viewer", createdAt: new Date() });
      await repo().save({ organizationId: org, userId: user, role: "admin", createdAt: new Date() });
      assert.equal((await repo().find(org, user))?.role, "admin");

      await repo().remove(org, user);
      assert.equal(await repo().find(org, user), null);
      assert.notEqual(await repo().find(org, other), null);
    });

    test("memberships go with their organization (cascade)", async () => {
      const org = await insertOrganization(db.dataSource);
      const user = await insertUser(db.dataSource);
      await repo().save({ organizationId: org, userId: user, role: "viewer", createdAt: new Date() });
      await db.dataSource.query(`DELETE FROM "organizations" WHERE "id" = $1`, [org]);
      assert.deepEqual(await repo().listForUser(user), []);
    });
  });

  describe("TypeOrmInvitationRepository", () => {
    const repo = () => new TypeOrmInvitationRepository(db.dataSource.getRepository(InvitationEntity));
    const invitation = (organizationId: string, overrides: Partial<Invitation> = {}): Invitation => ({
      id: randomUUID(),
      organizationId,
      email: "new.person@example.test",
      role: "editor",
      tokenHash: hash(),
      invitedBy: randomUUID(),
      createdAt: at("2026-01-01T00:00:00Z"),
      expiresAt: at("2026-01-08T00:00:00Z"),
      acceptedAt: null,
      revokedAt: null,
      ...overrides,
    });

    test("save lower-cases the email; findByHash round-trips; unknown is null", async () => {
      const org = await insertOrganization(db.dataSource);
      const inv = invitation(org, { email: "Someone@Example.TEST" });
      await repo().save(inv);
      assert.deepEqual(await repo().findByHash(inv.tokenHash), { ...inv, email: "someone@example.test" });
      assert.equal(await repo().findByHash(hash()), null);
    });

    test("findPending skips accepted and revoked ones and matches the email in any case", async () => {
      const org = await insertOrganization(db.dataSource);
      const email = `p-${randomUUID().slice(0, 6)}@example.test`;
      await repo().save(invitation(org, { email, acceptedAt: at("2026-01-02T00:00:00Z") }));
      await repo().save(invitation(org, { email, revokedAt: at("2026-01-03T00:00:00Z") }));
      assert.equal(await repo().findPending(org, email), null);

      const live = invitation(org, { email });
      await repo().save(live);
      assert.equal((await repo().findPending(org, email.toUpperCase()))?.id, live.id);
      assert.equal(await repo().findPending(await insertOrganization(db.dataSource), email), null);
    });

    test("listForOrganization is newest first and scoped to the organization", async () => {
      const org = await insertOrganization(db.dataSource);
      const other = await insertOrganization(db.dataSource);
      const old = invitation(org, { createdAt: at("2026-01-01T00:00:00Z") });
      const recent = invitation(org, { createdAt: at("2026-02-01T00:00:00Z") });
      await repo().save(old);
      await repo().save(recent);
      await repo().save(invitation(other));
      assert.deepEqual(
        (await repo().listForOrganization(org)).map((i) => i.id),
        [recent.id, old.id],
      );
    });
  });
});
