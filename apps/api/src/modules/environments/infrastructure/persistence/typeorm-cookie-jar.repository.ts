import { Injectable, Inject } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, Repository } from "typeorm";

import type { Cookie } from "@eq/runner-core";

import { RequestCookieEntity } from "@/shared/database/entities";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import type { CookieJarRepositoryPort } from "../../domain/ports";

/**
 * El tarro de una persona en un proyecto, cifrado en la fila y descifrado aquí.
 *
 * El cifrado vive en el repositorio y no en el dominio porque el dominio de las cookies es puro y
 * se comprueba contra la RFC sin una clave a mano. Lo que no puede pasar es que una cookie salga de
 * aquí sin descifrar o entre sin cifrar, y por eso las dos conversiones están en el mismo fichero,
 * una al lado de la otra.
 *
 * Una cookie que no se puede descifrar se **salta**. Pasa si cambió la clave, y el resultado de
 * tratarlo como un error sería que nadie pudiera enviar nada en ese proyecto hasta borrar la tabla
 * a mano; saltándola, la petición sale sin esa cookie y el servidor pedirá login otra vez, que es
 * lo que de verdad hay que hacer.
 */
@Injectable()
export class TypeOrmCookieJarRepository implements CookieJarRepositoryPort {
  constructor(
    @InjectRepository(RequestCookieEntity) private readonly cookies: Repository<RequestCookieEntity>,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async list(actorId: string, projectId: string): Promise<Cookie[]> {
    const rows = await this.cookies.find({ where: { actorId, projectId } });
    const jar: Cookie[] = [];
    for (const row of rows) {
      let value: string;
      try {
        value = this.cipher.decrypt(row.valueCiphertext);
      } catch {
        continue;
      }
      jar.push({
        name: row.name,
        value,
        domain: row.domain,
        path: row.path,
        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
        secure: row.secure,
        httpOnly: row.httpOnly,
        sameSite: (row.sameSite as Cookie["sameSite"]) ?? null,
        hostOnly: row.hostOnly,
        createdAt: row.createdAt.getTime(),
      });
    }
    return jar;
  }

  async save(actorId: string, projectId: string, jar: Cookie[]): Promise<void> {
    if (!jar.length) return;
    await this.cookies.save(
      jar.map((cookie) => ({
        actorId,
        projectId,
        domain: cookie.domain,
        path: cookie.path,
        name: cookie.name,
        valueCiphertext: this.cipher.encrypt(cookie.value),
        expiresAt: cookie.expiresAt === null ? null : new Date(cookie.expiresAt),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        hostOnly: cookie.hostOnly,
        createdAt: new Date(cookie.createdAt),
      })),
    );
  }

  async remove(actorId: string, projectId: string, keys: Pick<Cookie, "domain" | "path" | "name">[]): Promise<void> {
    for (const key of keys) {
      await this.cookies.delete({ actorId, projectId, domain: key.domain, path: key.path, name: key.name });
    }
  }

  async clear(actorId: string, projectId: string): Promise<void> {
    await this.cookies.delete({ actorId, projectId });
  }

  /** Lo caducado se borra de verdad y no solo se deja de mandar: es una credencial que ya no sirve. */
  async purgeExpired(actorId: string, projectId: string, now: Date): Promise<void> {
    await this.cookies.delete({ actorId, projectId, expiresAt: LessThanOrEqual(now) });
  }
}
