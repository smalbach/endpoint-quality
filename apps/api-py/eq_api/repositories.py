"""
SQL directo contra el esquema que mantiene `apps/api`.

Sin ORM y a propósito (ver `docs/backends-poliglotas.md` §7): el esquema no es de este backend y
este backend no puede cambiarlo, así que declarar aquí cuarenta entidades para no poder migrar
ninguna sería duplicar la definición y quedarse sin la ventaja. Lo que sí hace falta es que las
consultas digan exactamente lo que el original dice —incluidos los `deletedAt IS NULL` que el
repositorio de TypeORM aplica en silencio— porque una fila borrada que aquí sigue apareciendo es
una diferencia visible entre backends.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from .db import Database

ROLES = ("viewer", "editor", "admin", "owner")
_RANK = {role: index for index, role in enumerate(ROLES)}


def at_least(role: str, required: str) -> bool:
    """La escalera de roles, como en `iam/domain/model.ts`: una comparación y no una tabla de
    excepciones."""
    return _RANK.get(role, -1) >= _RANK[required]


def new_id() -> str:
    return str(uuid.uuid4())


# --- usuarios -------------------------------------------------------------------------------


class Users:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find_by_id(self, user_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "users" WHERE "id" = $1::uuid', user_id)
        return dict(row) if row else None

    async def find_by_email(self, email: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "users" WHERE "email" = $1', email)
        return dict(row) if row else None

    async def insert(self, user: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "users" ("id", "email", "name", "passwordDigest", "status", "createdAt",'
            ' "failedLoginAttempts", "lockedUntil") VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)',
            user["id"],
            user["email"],
            user["name"],
            user["passwordDigest"],
            user["status"],
            user["createdAt"],
            user["failedLoginAttempts"],
            user["lockedUntil"],
        )

    async def set_password(self, user_id: str, digest: str) -> None:
        await self.db.execute(
            'UPDATE "users" SET "passwordDigest" = $2, "failedLoginAttempts" = 0, "lockedUntil" = NULL'
            ' WHERE "id" = $1::uuid',
            user_id,
            digest,
        )

    async def set_login_failures(self, user_id: str, attempts: int, locked_until: datetime | None) -> None:
        await self.db.execute(
            'UPDATE "users" SET "failedLoginAttempts" = $2, "lockedUntil" = $3 WHERE "id" = $1::uuid',
            user_id,
            attempts,
            locked_until,
        )


# --- sesiones -------------------------------------------------------------------------------


class RefreshTokens:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "refresh_tokens" WHERE "tokenHash" = $1', token_hash)
        return dict(row) if row else None

    async def insert(self, token: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "refresh_tokens" ("id", "userId", "sessionId", "tokenHash", "expiresAt", "createdAt",'
            ' "usedAt", "revokedAt", "replacedByHash")'
            " VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL, NULL, NULL)",
            token["id"],
            token["userId"],
            token["sessionId"],
            token["tokenHash"],
            token["expiresAt"],
            token["createdAt"],
        )

    async def mark_used(self, token_id: str, at: datetime, replaced_by_hash: str) -> None:
        await self.db.execute(
            'UPDATE "refresh_tokens" SET "usedAt" = $2, "replacedByHash" = $3 WHERE "id" = $1::uuid',
            token_id,
            at,
            replaced_by_hash,
        )

    async def revoke_session(self, session_id: str, at: datetime) -> None:
        """Toda la cadena en una sola sentencia: cerrarla fila a fila deja una ventana en la que
        quien robó el token refresca otra vez."""
        await self.db.execute(
            'UPDATE "refresh_tokens" SET "revokedAt" = $2 WHERE "sessionId" = $1::uuid AND "revokedAt" IS NULL',
            session_id,
            at,
        )

    async def revoke_all_for_user(self, user_id: str, at: datetime) -> None:
        await self.db.execute(
            'UPDATE "refresh_tokens" SET "revokedAt" = $2 WHERE "userId" = $1::uuid AND "revokedAt" IS NULL',
            user_id,
            at,
        )


class PasswordResets:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def insert(self, token: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "password_reset_tokens" ("id", "userId", "tokenHash", "createdAt", "expiresAt", "usedAt")'
            " VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL)",
            token["id"],
            token["userId"],
            token["tokenHash"],
            token["createdAt"],
            token["expiresAt"],
        )

    async def find_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "password_reset_tokens" WHERE "tokenHash" = $1', token_hash)
        return dict(row) if row else None

    async def spend_all_for_user(self, user_id: str, at: datetime) -> None:
        await self.db.execute(
            'UPDATE "password_reset_tokens" SET "usedAt" = $2 WHERE "userId" = $1::uuid AND "usedAt" IS NULL',
            user_id,
            at,
        )


class ApiTokens:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "api_tokens" WHERE "tokenHash" = $1', token_hash)
        return dict(row) if row else None

    async def find_by_id(self, token_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "api_tokens" WHERE "id" = $1::uuid', token_id)
        return dict(row) if row else None

    async def list_for_organization(self, organization_id: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            'SELECT * FROM "api_tokens" WHERE "organizationId" = $1::uuid ORDER BY "createdAt" DESC',
            organization_id,
        )
        return [dict(row) for row in rows]

    async def insert(self, token: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "api_tokens" ("id", "organizationId", "name", "tokenHash", "preview", "createdBy",'
            ' "createdAt", "lastUsedAt", "revokedAt")'
            " VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, NULL, NULL)",
            token["id"],
            token["organizationId"],
            token["name"],
            token["tokenHash"],
            token["preview"],
            token["createdBy"],
            token["createdAt"],
        )

    async def touch(self, token_id: str, at: datetime) -> None:
        await self.db.execute('UPDATE "api_tokens" SET "lastUsedAt" = $2 WHERE "id" = $1::uuid', token_id, at)

    async def revoke(self, token_id: str, at: datetime) -> None:
        await self.db.execute('UPDATE "api_tokens" SET "revokedAt" = $2 WHERE "id" = $1::uuid', token_id, at)


# --- organizaciones -------------------------------------------------------------------------


class Organizations:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find_by_id(self, organization_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "organizations" WHERE "id" = $1::uuid', organization_id)
        return dict(row) if row else None

    async def find_by_slug(self, slug: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "organizations" WHERE "slug" = $1', slug)
        return dict(row) if row else None

    async def insert(self, organization: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "organizations" ("id", "name", "slug", "createdAt") VALUES ($1::uuid, $2, $3, $4)',
            organization["id"],
            organization["name"],
            organization["slug"],
            organization["createdAt"],
        )


class Memberships:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find(self, organization_id: str, user_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "memberships" WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid',
            organization_id,
            user_id,
        )
        return dict(row) if row else None

    async def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            'SELECT * FROM "memberships" WHERE "userId" = $1::uuid ORDER BY "createdAt" ASC', user_id
        )
        return [dict(row) for row in rows]

    async def list_for_organization(self, organization_id: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            'SELECT * FROM "memberships" WHERE "organizationId" = $1::uuid ORDER BY "createdAt" ASC',
            organization_id,
        )
        return [dict(row) for row in rows]

    async def save(self, membership: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "memberships" ("organizationId", "userId", "role", "createdAt")'
            " VALUES ($1::uuid, $2::uuid, $3, $4)"
            ' ON CONFLICT ("organizationId", "userId") DO UPDATE SET "role" = EXCLUDED."role"',
            membership["organizationId"],
            membership["userId"],
            membership["role"],
            membership["createdAt"],
        )

    async def remove(self, organization_id: str, user_id: str) -> None:
        await self.db.execute(
            'DELETE FROM "memberships" WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid',
            organization_id,
            user_id,
        )


class Invitations:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def insert(self, invitation: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "invitations" ("id", "organizationId", "email", "role", "tokenHash", "invitedBy",'
            ' "createdAt", "expiresAt", "acceptedAt", "revokedAt")'
            " VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, NULL, NULL)",
            invitation["id"],
            invitation["organizationId"],
            invitation["email"],
            invitation["role"],
            invitation["tokenHash"],
            invitation["invitedBy"],
            invitation["createdAt"],
            invitation["expiresAt"],
        )

    async def find_pending(self, organization_id: str, email: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "invitations" WHERE "organizationId" = $1::uuid AND "email" = $2'
            ' AND "acceptedAt" IS NULL AND "revokedAt" IS NULL',
            organization_id,
            email,
        )
        return dict(row) if row else None

    async def find_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "invitations" WHERE "tokenHash" = $1', token_hash)
        return dict(row) if row else None

    async def list_for_organization(self, organization_id: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            'SELECT * FROM "invitations" WHERE "organizationId" = $1::uuid ORDER BY "createdAt" DESC',
            organization_id,
        )
        return [dict(row) for row in rows]

    async def mark_accepted(self, invitation_id: str, at: datetime) -> None:
        await self.db.execute('UPDATE "invitations" SET "acceptedAt" = $2 WHERE "id" = $1::uuid', invitation_id, at)


# --- proyectos ------------------------------------------------------------------------------


class Projects:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def find_by_id(self, project_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "projects" WHERE "id" = $1::uuid AND "deletedAt" IS NULL', project_id
        )
        return dict(row) if row else None

    async def find_by_slug(self, organization_id: str, slug: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "projects" WHERE "organizationId" = $1::uuid AND "slug" = $2 AND "deletedAt" IS NULL',
            organization_id,
            slug,
        )
        return dict(row) if row else None

    async def list_for_organization(self, organization_id: str, include_archived: bool) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            'SELECT * FROM "projects" WHERE "organizationId" = $1::uuid AND "deletedAt" IS NULL'
            + ("" if include_archived else ' AND "archivedAt" IS NULL')
            + ' ORDER BY "createdAt" DESC',
            organization_id,
        )
        return [dict(row) for row in rows]

    async def insert(self, project: dict[str, Any]) -> None:
        await self.db.execute(
            'INSERT INTO "projects" ("id", "organizationId", "name", "slug", "description", "createdBy", "createdAt",'
            ' "archivedAt", "activeSpecVersionId", "activeEnvironmentId", "baseUrl", "tags", "authType",'
            ' "authSettings", "authSecretCiphertext", "deletedAt")'
            " VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, NULL, NULL, NULL, $8, $9::jsonb, 'none',"
            " '{}'::jsonb, NULL, NULL)",
            project["id"],
            project["organizationId"],
            project["name"],
            project["slug"],
            project["description"],
            project["createdBy"],
            project["createdAt"],
            project["baseUrl"],
            project["tags"],
        )

    async def update_fields(
        self,
        project_id: str,
        *,
        name: str,
        description: str,
        base_url: str,
        tags: list[str],
    ) -> None:
        await self.db.execute(
            'UPDATE "projects" SET "name" = $2, "description" = $3, "baseUrl" = $4, "tags" = $5::jsonb'
            ' WHERE "id" = $1::uuid',
            project_id,
            name,
            description,
            base_url,
            tags,
        )

    async def set_archived(self, project_id: str, at: datetime | None) -> None:
        await self.db.execute('UPDATE "projects" SET "archivedAt" = $2 WHERE "id" = $1::uuid', project_id, at)

    async def soft_delete(self, project_id: str, at: datetime) -> None:
        """Borrado blando: un proyecto es dueño de corridas, y una corrida es la prueba de algo que
        alguien midió un día. La fila se marca y las corridas se quedan."""
        await self.db.execute('UPDATE "projects" SET "deletedAt" = $2 WHERE "id" = $1::uuid', project_id, at)


class ProjectReadModel:
    """Lo que la tarjeta de un proyecto necesita y no está en su fila: contrato activo, origen,
    última corrida y bifurcación."""

    def __init__(self, db: Database) -> None:
        self.db = db

    async def active_spec_version(self, spec_version_id: str | None) -> dict[str, Any] | None:
        if not spec_version_id:
            return None
        row = await self.db.fetchrow('SELECT * FROM "spec_versions" WHERE "id" = $1::uuid', spec_version_id)
        return dict(row) if row else None

    async def latest_source(self, project_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "spec_sources" WHERE "projectId" = $1::uuid ORDER BY "createdAt" DESC LIMIT 1',
            project_id,
        )
        return dict(row) if row else None

    async def last_run(self, project_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow(
            'SELECT * FROM "runs" WHERE "projectId" = $1::uuid ORDER BY "startedAt" DESC LIMIT 1',
            project_id,
        )
        return dict(row) if row else None

    async def fork(self, project_id: str) -> dict[str, Any] | None:
        row = await self.db.fetchrow('SELECT * FROM "project_forks" WHERE "forkProjectId" = $1::uuid', project_id)
        return dict(row) if row else None


class Repositories:
    """Todo junto, para colgarlo del estado de la aplicación y no ir pasándolo pieza a pieza."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.users = Users(db)
        self.refresh_tokens = RefreshTokens(db)
        self.password_resets = PasswordResets(db)
        self.api_tokens = ApiTokens(db)
        self.organizations = Organizations(db)
        self.memberships = Memberships(db)
        self.invitations = Invitations(db)
        self.projects = Projects(db)
        self.project_read = ProjectReadModel(db)
