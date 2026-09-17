import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El tarro de cookies de cada persona en cada proyecto.
 *
 * Sin esto, una API que autentica con cookie no se podía probar de principio a fin: el login
 * contestaba su `Set-Cookie`, la petición siguiente salía sin él, y todo lo que iba detrás
 * contestaba 401. La única salida era capturar la cookie con un script y volver a pegarla en una
 * cabecera a mano.
 *
 * **Por persona**, como el token de sesión y por lo mismo: la cookie que consigue quien está
 * probando es su sesión, no la del proyecto, y compartirla entre los miembros de una organización
 * sería darles la sesión de otro.
 *
 * El valor va **cifrado**. Una cookie de sesión es exactamente una credencial —es lo que el
 * servidor acepta en lugar de la contraseña— y guardarla en claro sería peor que guardar el token,
 * porque nadie la mira.
 *
 * La clave primaria es la que dice la RFC 6265 que identifica una cookie: dominio, ruta y nombre.
 * Con `name` suelto, renovar el valor de una cookie en `/admin` machacaría la de `/`.
 */
export class CookieJar1700000022000 implements MigrationInterface {
  name = "CookieJar1700000022000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "request_cookies" (
        "actorId" uuid NOT NULL,
        "projectId" uuid NOT NULL,
        "domain" varchar(255) NOT NULL,
        "path" varchar(255) NOT NULL,
        "name" varchar(256) NOT NULL,
        "valueCiphertext" text NOT NULL,
        "expiresAt" timestamptz,
        "secure" boolean NOT NULL DEFAULT false,
        "httpOnly" boolean NOT NULL DEFAULT false,
        "sameSite" varchar(10),
        "hostOnly" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL,
        CONSTRAINT "PK_request_cookies" PRIMARY KEY ("actorId", "projectId", "domain", "path", "name")
      )
    `);
    // Lo que se lee siempre: el tarro entero de una persona en un proyecto, antes de cada envío.
    await queryRunner.query(
      `CREATE INDEX "IDX_request_cookies_actor_project" ON "request_cookies" ("actorId", "projectId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "request_cookies"`);
  }
}
