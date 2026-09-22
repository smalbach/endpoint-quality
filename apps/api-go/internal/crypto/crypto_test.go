// Las piezas que tienen que coincidir con las de la API de NestJS, contra valores fijos.
//
// El guion de `tools/conformance` prueba la paridad de verdad, con los tres backends levantados.
// Esto es la mitad que se puede correr sin nada delante y que falla en el sitio exacto: un digest
// con otro formato, un hash en hexadecimal donde el otro escribe base64, un JWT sin firma que
// alguien acepta. Los valores esperados están calculados **con el otro backend**: un test que
// compara la implementación consigo misma pasa aunque las dos mitades estén mal.
package crypto

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestDigestConElFormatoQueGuardaNode(t *testing.T) {
	digest, err := HashPassword("Una-contraseña-1")
	if err != nil {
		t.Fatalf("no se pudo derivar: %v", err)
	}
	parts := strings.Split(digest, "$")
	if len(parts) != 6 {
		t.Fatalf("el digest tiene %d campos, no 6: %s", len(parts), digest)
	}
	if parts[0] != "scrypt" || parts[1] != "131072" || parts[2] != "8" || parts[3] != "1" {
		t.Errorf("parámetros distintos de los de OWASP que usa el original: %v", parts[:4])
	}
	salt, err := base64.StdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) != 16 {
		t.Errorf("la sal no son 16 bytes en base64 estándar: %v", err)
	}
	derived, err := base64.StdEncoding.DecodeString(parts[5])
	if err != nil || len(derived) != 32 {
		t.Errorf("la clave derivada no son 32 bytes en base64 estándar: %v", err)
	}
	if !VerifyPassword("Una-contraseña-1", digest) {
		t.Error("no verifica su propio digest")
	}
	if VerifyPassword("otra-contraseña", digest) {
		t.Error("verifica una contraseña que no es")
	}
}

func TestVerificaUnDigestHechoConOtrosParametros(t *testing.T) {
	// Los tests de Nest usan un scrypt más barato a propósito, y esas cuentas viven en la misma
	// base. Leer los parámetros del propio digest es lo que las deja entrar por aquí.
	barato := "scrypt$4096$8$1$" +
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef")) + "$" +
		base64.StdEncoding.EncodeToString(make([]byte, 32))
	if VerifyPassword("cualquiera", barato) {
		t.Error("aceptó una contraseña que no corresponde a ese digest")
	}
}

func TestUnDigestCorruptoEsUnLoginQueFallaYNoUnPanico(t *testing.T) {
	for _, digest := range []string{
		"",
		"no-es-un-digest",
		"scrypt$1$2$3$$",
		"scrypt$no-es-un-numero$8$1$c2FsdA==$aGFzaA==",
		"bcrypt$1$2$3$c2FsdA==$aGFzaA==",
	} {
		if VerifyPassword("x", digest) {
			t.Errorf("aceptó el digest corrupto %q", digest)
		}
	}
}

func TestLaNormalizacionUnicodeNoParteLaContraseña(t *testing.T) {
	// «ñ» compuesta y descompuesta son la misma contraseña para quien la teclea.
	digest, err := HashPassword("Contraseña-larga-1")
	if err != nil {
		t.Fatalf("no se pudo derivar: %v", err)
	}
	if !VerifyPassword("Contraseña-larga-1", digest) {
		t.Error("la forma descompuesta no verifica: falta la normalización NFKC")
	}
}

func TestElHashOpacoEsSha256EnBase64(t *testing.T) {
	// Calculado con el otro backend: createHash("sha256").update("hola").digest("base64").
	if got := HashOpaqueToken("hola"); got != "siHZ27CDp/M0KNfCo8MZiuklYU1wIQ4ocWzKp81N23k=" {
		t.Errorf("hash distinto del de Node: %s", got)
	}
}

func TestUnTokenOpacoSon32BytesEnBase64URL(t *testing.T) {
	token, err := GenerateOpaqueToken()
	if err != nil {
		t.Fatalf("no se pudo generar: %v", err)
	}
	if strings.ContainsAny(token, "=+/") {
		t.Errorf("no es base64url sin relleno: %s", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		t.Errorf("no son 32 bytes: %v", err)
	}
}

func TestElPreviewNoPermiteReconstruirElToken(t *testing.T) {
	if got := TokenPreview("eqt_abcdefghijklmnop"); got != "eqt_ab…mnop" {
		t.Errorf("preview distinto del de Node: %s", got)
	}
	// Uno demasiado corto no se recorta a algo sin sentido.
	if got := TokenPreview("corto"); got != "corto" {
		t.Errorf("preview inesperado: %s", got)
	}
}

func TestElTokenDeAccesoLlevaLosClaimsQueLeeElGuard(t *testing.T) {
	secret := []byte("un-secreto-de-pruebas")
	token, err := SignAccessToken(secret, "u-1", "ada@example.com", 900)
	if err != nil {
		t.Fatalf("no se pudo firmar: %v", err)
	}
	subject, email, err := VerifyAccessToken(secret, token)
	if err != nil || subject != "u-1" || email != "ada@example.com" {
		t.Errorf("claims inesperados: %q %q %v", subject, email, err)
	}
	if _, _, err := VerifyAccessToken([]byte("otro-secreto"), token); err == nil {
		t.Error("aceptó un token firmado con otra clave")
	}
}

func TestUnTokenSinFirmaNoPasa(t *testing.T) {
	// `alg: none` de manual: la cabecera dice que no hay firma y el contenido lo escribe quien
	// quiera. Se rechaza porque el algoritmo lo exige quien verifica, no el token.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"u-1","email":"nadie@example.com"}`))
	if _, _, err := VerifyAccessToken([]byte("un-secreto"), header+"."+payload+"."); err == nil {
		t.Error("aceptó un token sin firma")
	}
}

func TestUnTokenCaducadoNoPasa(t *testing.T) {
	secret := []byte("un-secreto-de-pruebas")
	token, err := SignAccessToken(secret, "u-1", "ada@example.com", -1)
	if err != nil {
		t.Fatalf("no se pudo firmar: %v", err)
	}
	if _, _, err := VerifyAccessToken(secret, token); err == nil {
		t.Error("aceptó un token caducado")
	}
}

func TestUnTokenMalFormadoNoPasa(t *testing.T) {
	secret := []byte("un-secreto-de-pruebas")
	for _, token := range []string{"", "a.b", "no-es-un-token", "!!!.!!!.!!!"} {
		if _, _, err := VerifyAccessToken(secret, token); err == nil {
			t.Errorf("aceptó %q", token)
		}
	}
}
