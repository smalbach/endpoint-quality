import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los roles como filas: el rol, su permiso por endpoint y las reglas R/W/D entre roles.
 *
 * - **La sección `access` sigue siendo lo que lee la matriz**, y a partir de ahora se deriva de estas
 *   tablas. Por eso los proyectos que ya tenían roles no empiezan vacíos: cada nombre de
 *   `access.roles` pasa a ser un rol, con un color de la paleta en orden, y cada regla `allow`/`deny`
 *   de una operación pasa a ser el permiso de ese rol sobre los endpoints enlazados a esa operación.
 * - **Un permiso ausente es «sin decidir»**, no «permitido»: no hay fila por defecto.
 * - Las restricciones que el analizador solo tenía en la migración —un nombre por proyecto, un
 *   permiso por rol y endpoint, un par de roles por regla— están aquí, y además un rol no puede ser
 *   regla sobre sí mismo.
 */
export class Roles1700000016000 implements MigrationInterface {
  name = "Roles1700000016000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "project_roles" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(20) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "color" varchar(7) NOT NULL,
        "sameRoleDataIsolation" boolean NOT NULL DEFAULT false,
        "position" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_project_roles_name" ON "project_roles" ("projectId", "name")`);

    await queryRunner.query(`
      CREATE TABLE "role_endpoint_permissions" (
        "roleId" uuid NOT NULL REFERENCES "project_roles"("id") ON DELETE CASCADE,
        "endpointId" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
        "access" varchar(10) NOT NULL CHECK ("access" IN ('allow', 'deny')),
        "dataScope" varchar(10) NOT NULL DEFAULT 'all' CHECK ("dataScope" IN ('all', 'own', 'none')),
        PRIMARY KEY ("roleId", "endpointId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_role_endpoint_permissions_endpoint" ON "role_endpoint_permissions" ("endpointId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "role_rules" (
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "sourceRoleId" uuid NOT NULL REFERENCES "project_roles"("id") ON DELETE CASCADE,
        "targetRoleId" uuid NOT NULL REFERENCES "project_roles"("id") ON DELETE CASCADE,
        "canRead" boolean NOT NULL DEFAULT false,
        "canWrite" boolean NOT NULL DEFAULT false,
        "canDelete" boolean NOT NULL DEFAULT false,
        PRIMARY KEY ("sourceRoleId", "targetRoleId"),
        CHECK ("sourceRoleId" <> "targetRoleId")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_role_rules_project" ON "role_rules" ("projectId")`);

    await queryRunner.query(`
      INSERT INTO "project_roles" ("id", "projectId", "name", "color", "position", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), c."projectId", r.name,
             (ARRAY['#6366f1','#8b5cf6','#ec4899','#ef4444','#f59e0b','#10b981','#06b6d4','#3b82f6'])[((r.ord - 1) % 8) + 1],
             r.ord - 1, now(), now()
      FROM "project_config" c
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c."data"->'access'->'roles', '[]'::jsonb)) WITH ORDINALITY AS r(name, ord)
      WHERE c."section" = 'access' AND length(r.name) BETWEEN 1 AND 20
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "role_endpoint_permissions" ("roleId", "endpointId", "access", "dataScope")
      SELECT DISTINCT ON (pr."id", e."id") pr."id", e."id", decided.access, 'all'
      FROM "project_config" c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."data"->'access'->'rules', '[]'::jsonb)) AS rule
      CROSS JOIN LATERAL (
        SELECT value AS role, 'allow' AS access FROM jsonb_array_elements_text(COALESCE(rule->'allow', '[]'::jsonb))
        UNION ALL
        SELECT value AS role, 'deny' AS access FROM jsonb_array_elements_text(COALESCE(rule->'deny', '[]'::jsonb))
      ) AS decided
      JOIN "project_roles" pr ON pr."projectId" = c."projectId" AND pr."name" = decided.role
      JOIN "endpoints" e ON e."projectId" = c."projectId" AND e."operationId" = rule->>'operationId' AND e."deletedAt" IS NULL
      WHERE c."section" = 'access'
      ORDER BY pr."id", e."id", decided.access
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "role_rules"`);
    await queryRunner.query(`DROP TABLE "role_endpoint_permissions"`);
    await queryRunner.query(`DROP TABLE "project_roles"`);
  }
}
