/**
 * La CA del proxy de captura: lo que hace falta para ver **dentro** de un túnel HTTPS.
 *
 * Descifrar HTTPS es hacer de intermediario: el proxy contesta al dispositivo con un certificado
 * para el nombre que pidió, firmado por una CA de esta instalación que el dispositivo tiene que
 * instalar como raíz de confianza, y abre su propia conexión TLS con el servidor de verdad. Es lo
 * que hacen Postman, Charles o mitmproxy, y tiene un precio que este fichero existe para contener:
 * **una CA así firma certificados para cualquier dominio**. Quien tenga su clave privada puede
 * suplantar cualquier sitio ante los dispositivos que la instalaron.
 *
 * ## Las reglas
 *
 * 1. **Apagado por defecto** (`CAPTURE_MITM=false`), y encendido solo por sesión: aunque el
 *    despliegue lo permita, cada sesión elige si descifra.
 * 2. **Una CA por instalación**, generada la primera vez que hace falta. ECDSA P-256, cinco años. La
 *    genera `@peculiar/x509` sobre WebCrypto de Node: nada de OpenSSL por la línea de órdenes.
 * 3. **La clave privada solo se guarda cifrada** con `SECRETS_KEY` (el mismo cifrado de las
 *    credenciales de destino). Si el cifrado no está disponible —sin `SECRETS_KEY`, o con una que no
 *    es de 32 bytes—, **no se genera nada** y descifrar HTTPS se niega con el motivo: no hay otra
 *    manera de guardarla, ni en disco ni en una columna en claro. Tampoco si la guardada no se puede
 *    descifrar (cambió `SECRETS_KEY`): generar otra en silencio rompería los dispositivos que
 *    instalaron la primera.
 * 4. **En memoria, no exportable.** Descifrada una vez, la clave se importa como una `CryptoKey`
 *    que no se puede volver a exportar: firma certificados y nada más. Ni se registra ni sale por
 *    ninguna ruta; lo único que se descarga es el certificado, que es público.
 * 5. **Certificados de hoja cortos y en memoria.** Uno por nombre, válido dos días, recordado uno,
 *    con un máximo de 500. Todos con la misma clave de hoja, generada al arrancar y que nunca se
 *    guarda: si se filtrara, sirve lo que tarden en caducar.
 *
 * Lo que no se puede arreglar: una app que **fija** el certificado de su servidor (certificate
 * pinning) no acepta el de la CA aunque esté instalada. Su túnel falla y se graba con el motivo; hay
 * que capturarla sin descifrar. Y Android, desde la 7, no confía en las CA que instala el usuario
 * salvo que la app lo permita en su configuración de red.
 */
import { randomBytes, webcrypto, X509Certificate as NodeCertificate } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext, type SecureContext } from "node:tls";
import { Inject, Injectable } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import type { CaptureAuthorityView, CaptureMitmView } from "@eq/contracts";

import { ENV, type Env } from "@/shared/config/env";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { ConflictError } from "@/shared/errors/domain-error";
import { CAPTURE_AUTHORITY_REPOSITORY, type CaptureAuthorityRepositoryPort } from "../domain/ports";

// Sin la biblioteca del DOM en el `tsconfig`: los tipos de WebCrypto son los de Node.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const DAY_MS = 86_400_000;
/** Cuánto vale la CA. Lo bastante para no tener que reinstalarla cada poco. */
const AUTHORITY_DAYS = 5 * 365;
/** Cuánto vale un certificado de hoja. Corto: si se filtra con su clave, sirve poco tiempo. */
const LEAF_DAYS = 2;
/** Cuánto se reutiliza uno antes de firmar otro, para no servir nunca uno a punto de caducar. */
const LEAF_REUSE_MS = DAY_MS;
const MAX_LEAVES = 500;
// Las fechas de los certificados salen del reloj de verdad y no de `CLOCK`: es el que mira TLS al
// validarlos, y un certificado fechado con el reloj de una prueba no lo aceptaría nadie.

/** La CA lista para firmar. La clave, no exportable. */
type LoadedAuthority = { certificate: x509.X509Certificate; pem: string; signingKey: CryptoKey };

@Injectable()
export class CaptureAuthority {
  private loading: Promise<LoadedAuthority> | null = null;
  private failure: string | null = null;
  private leafKeys: Promise<{ keys: CryptoKeyPair; pem: string }> | null = null;
  private readonly leaves = new Map<string, { context: Promise<SecureContext>; madeAt: number }>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CAPTURE_AUTHORITY_REPOSITORY) private readonly authorities: CaptureAuthorityRepositoryPort,
  ) {}

  /** Si el despliegue permite descifrar HTTPS. Que pueda de verdad lo dice `status`. */
  get enabled(): boolean {
    return this.env.CAPTURE_MITM;
  }

  /**
   * La CA lista para firmar: la carga de la tabla o, si no hay, la genera y la guarda cifrada.
   * Falla con el motivo, para quien administra el servidor, cuando no puede hacerlo sin guardar la
   * clave en claro.
   */
  ensure(): Promise<LoadedAuthority> {
    if (!this.enabled) return Promise.reject(disabled());
    this.loading ??= this.load().then(
      (loaded) => {
        this.failure = null;
        return loaded;
      },
      (error: unknown) => {
        // Se olvida el intento para que el siguiente vuelva a probar; el motivo queda para la vista.
        this.loading = null;
        this.failure = error instanceof Error ? error.message : "No se pudo preparar la CA de captura";
        throw new ConflictError(this.failure, "capture-mitm-unavailable");
      },
    );
    return this.loading;
  }

  /** Para la pantalla: `null` si está apagado; si no, si está lista y, si no, por qué. */
  async status(): Promise<CaptureMitmView | null> {
    if (!this.enabled) return null;
    try {
      await this.ensure();
      return { ready: true, problem: null };
    } catch {
      return { ready: false, problem: this.failure };
    }
  }

  /** El certificado de la CA para instalarlo en el dispositivo. **Solo la parte pública.** */
  async view(): Promise<CaptureAuthorityView> {
    const { pem } = await this.ensure();
    const certificate = new NodeCertificate(pem);
    return {
      pem,
      fileName: "endpoint-quality-captura-ca.pem",
      fingerprint: certificate.fingerprint256,
      notAfter: new Date(certificate.validTo).toISOString(),
    };
  }

  /**
   * El contexto TLS con el que el proxy contesta a un dispositivo que pidió `hostname`: un
   * certificado para ese nombre firmado por la CA. Se recuerda un día, y como mucho 500 nombres.
   */
  contextFor(hostname: string): Promise<SecureContext> {
    const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const now = Date.now();
    const cached = this.leaves.get(name);
    if (cached && now - cached.madeAt < LEAF_REUSE_MS) return cached.context;
    if (this.leaves.size >= MAX_LEAVES) this.leaves.delete(this.leaves.keys().next().value!);
    const context = this.sign(name);
    // Un fallo no se queda en la caché: el siguiente intento vuelve a firmar.
    context.catch(() => this.leaves.delete(name));
    this.leaves.set(name, { context, madeAt: now });
    return context;
  }

  private async load(): Promise<LoadedAuthority> {
    this.assertCipher();
    let stored = await this.authorities.find();
    if (!stored) {
      await this.authorities.insertIfAbsent(await this.generate());
      // Otra instancia pudo ganar la carrera: se usa la que quedó en la tabla, no la de aquí.
      stored = await this.authorities.find();
      if (!stored) throw new Error("La CA de captura no quedó guardada");
    }
    let pkcs8: string;
    try {
      pkcs8 = this.cipher.decrypt(stored.privateKeyCiphertext);
    } catch {
      throw new Error(
        "La clave de la CA de captura no se puede descifrar con la SECRETS_KEY actual. Si la clave cambió, hay que " +
          "restaurar la anterior; no se genera otra CA en silencio porque los dispositivos que instalaron esta dejarían " +
          "de confiar en el proxy.",
      );
    }
    const signingKey = await webcrypto.subtle.importKey(
      "pkcs8",
      x509.PemConverter.decode(pkcs8)[0]!,
      { name: ALGORITHM.name, namedCurve: ALGORITHM.namedCurve },
      // No exportable: una vez en memoria, solo sirve para firmar.
      false,
      ["sign"],
    );
    const certificate = new x509.X509Certificate(stored.certificatePem);
    if (certificate.notAfter.getTime() <= Date.now()) {
      throw new Error("La CA de captura caducó: hay que borrar la fila de capture_authorities y reinstalar la nueva.");
    }
    return { certificate, pem: stored.certificatePem, signingKey };
  }

  /**
   * Comprueba que se puede cifrar **antes** de generar nada. Sin esto, un `SECRETS_KEY` que falta
   * se descubriría con la clave ya generada en memoria, y la tentación sería guardarla igual.
   */
  private assertCipher(): void {
    const probe = randomBytes(16).toString("hex");
    let roundTrip: string;
    try {
      roundTrip = this.cipher.decrypt(this.cipher.encrypt(probe));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "el cifrado no está disponible";
      throw new Error(
        `Descifrar HTTPS no puede arrancar: la clave privada de la CA solo se guarda cifrada, y el cifrado no está ` +
          `disponible (${reason}). Define una SECRETS_KEY válida (32 bytes en base64).`,
      );
    }
    if (roundTrip !== probe) throw new Error("Descifrar HTTPS no puede arrancar: el cifrado no devuelve lo cifrado.");
  }

  /** Una CA nueva, con la clave ya cifrada. El PKCS#8 en claro no sale de esta función. */
  private async generate() {
    const keys = (await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
    const now = new Date();
    const marker = randomBytes(3).toString("hex");
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: `CN=endpoint-quality captura ${marker}, O=endpoint-quality`,
      notBefore: new Date(now.getTime() - DAY_MS),
      notAfter: new Date(now.getTime() + AUTHORITY_DAYS * DAY_MS),
      keys,
      signingAlgorithm: ALGORITHM,
      extensions: [
        // CA, y sin CA intermedias por debajo: solo firma hojas.
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const pkcs8 = x509.PemConverter.encode(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
    return {
      certificatePem: certificate.toString("pem"),
      privateKeyCiphertext: this.cipher.encrypt(pkcs8),
      createdAt: now,
    };
  }

  private async sign(name: string): Promise<SecureContext> {
    const authority = await this.ensure();
    const leaf = await this.leafKey();
    const now = new Date();
    const certificate = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${isIP(name) ? name : name.replace(/[,+="<>#;\\]/g, "")}`,
      issuer: authority.certificate.subject,
      notBefore: new Date(now.getTime() - 60 * 60_000),
      notAfter: new Date(now.getTime() + LEAF_DAYS * DAY_MS),
      signingKey: authority.signingKey,
      publicKey: leaf.keys.publicKey,
      signingAlgorithm: ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: isIP(name) ? "ip" : "dns", value: name }]),
        await x509.AuthorityKeyIdentifierExtension.create(authority.certificate),
      ],
    });
    return createSecureContext({ key: leaf.pem, cert: certificate.toString("pem") });
  }

  /** La clave de las hojas: una por proceso, solo en memoria. */
  private leafKey(): Promise<{ keys: CryptoKeyPair; pem: string }> {
    this.leafKeys ??= (async () => {
      const keys = (await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
      const pem = x509.PemConverter.encode(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
      return { keys, pem };
    })();
    return this.leafKeys;
  }
}

/** Un número de serie aleatorio y positivo: el primer bit a cero, como pide DER. */
function serial(): string {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f;
  return bytes.toString("hex");
}

function disabled(): ConflictError {
  return new ConflictError(
    "Descifrar HTTPS no está activado en este despliegue: hace falta CAPTURE_MITM=true",
    "capture-mitm-disabled",
  );
}
