// Package crypto son las tres primitivas que tienen que coincidir byte a byte con las de la API
// de NestJS: el KDF de las contraseñas, el hash de los tokens opacos y la firma del token de
// acceso.
//
// Aquí no hay margen de estilo. Un digest con otro formato es una cuenta que no puede entrar por
// este backend; un hash en hexadecimal donde el otro escribe base64 es una sesión que se rompe al
// cambiar de backend. Los originales están en `apps/api/src/shared/crypto/`.
//
// El JWT va a mano en vez de con una biblioteca: son cuarenta líneas, HS256 es un HMAC-SHA256
// sobre dos JSON en base64url, y la única parte delicada —no fiarse del `alg` que venga dentro—
// se ve mejor escrita que escondida detrás de una opción de configuración.
package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

// El suelo de OWASP para scrypt, igual que en `password-hasher.ts`.
const (
	scryptCost        = 1 << 17
	scryptBlockSize   = 8
	scryptParallelism = 1
	scryptKeyLength   = 32
)

// HashPassword devuelve `scrypt$N$r$p$salt_b64$hash_b64`, el formato que guarda la API de Nest.
// La sal viaja dentro del digest, que es lo que permite que verificar no necesite nada más que la
// cadena guardada.
func HashPassword(plain string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived, err := scrypt.Key(normalized(plain), salt, scryptCost, scryptBlockSize, scryptParallelism, scryptKeyLength)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"scrypt$%d$%d$%d$%s$%s",
		scryptCost, scryptBlockSize, scryptParallelism,
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(derived),
	), nil
}

// VerifyPassword comprueba con **los parámetros que el propio digest declara**, no con los de
// arriba: así una cuenta creada por los tests de Nest —que usan un scrypt más barato a propósito—
// sigue pudiendo entrar por aquí.
func VerifyPassword(plain, digest string) bool {
	parts := strings.Split(digest, "$")
	if len(parts) != 6 || parts[0] != "scrypt" || parts[4] == "" || parts[5] == "" {
		return false
	}
	cost, err1 := strconv.Atoi(parts[1])
	blockSize, err2 := strconv.Atoi(parts[2])
	parallelism, err3 := strconv.Atoi(parts[3])
	salt, err4 := base64.StdEncoding.DecodeString(parts[4])
	expected, err5 := base64.StdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		// Un digest corrupto es un login que falla, no un 500: la fila puede venir de cualquier
		// sitio y entrar en pánico aquí convertiría un dato malo en una caída.
		return false
	}
	derived, err := scrypt.Key(normalized(plain), salt, cost, blockSize, parallelism, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(derived, expected) == 1
}

// NFKC antes de derivar, como hace `plain.normalize("NFKC")` allí: sin esto, una contraseña con
// acentos escrita desde dos teclados distintos produce dos digests distintos.
func normalized(plain string) []byte {
	return norm.NFKC.Bytes([]byte(plain))
}

// GenerateOpaqueToken devuelve 32 bytes de aleatoriedad en base64url sin relleno.
func GenerateOpaqueToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// HashOpaqueToken es SHA-256 en **base64**, no en hexadecimal: es la forma en que está guardada la
// columna `tokenHash`, y la que decide si un refresco emitido por otro backend se encuentra aquí.
func HashOpaqueToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// TokenPreview son los seis primeros caracteres y los cuatro últimos: lo justo para distinguir dos
// tokens en una lista sin poder reconstruir ninguno.
func TokenPreview(token string) string {
	if len(token) < 10 {
		return token
	}
	return token[:6] + "…" + token[len(token)-4:]
}

type accessClaims struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
}

// SignAccessToken emite el JWT HS256 con los claims que el guard de Nest lee: `sub` y `email`.
func SignAccessToken(secret []byte, userID, email string, ttlSeconds int) (string, error) {
	now := time.Now().UTC()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(accessClaims{
		Sub:   userID,
		Email: email,
		Iat:   now.Unix(),
		Exp:   now.Add(time.Duration(ttlSeconds) * time.Second).Unix(),
	})
	if err != nil {
		return "", err
	}
	signing := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signing + "." + base64.RawURLEncoding.EncodeToString(sign(secret, signing)), nil
}

var ErrInvalidToken = errors.New("la credencial no es válida")

// VerifyAccessToken comprueba la firma antes de mirar nada del contenido, y **exige HS256**.
// Aceptar el algoritmo que declare el propio token es la vulnerabilidad `alg: none` de manual: un
// atacante cambia la cabecera a `{"alg":"none"}`, se queda sin firma, y el token lo escribe él.
func VerifyAccessToken(secret []byte, token string) (string, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", "", ErrInvalidToken
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", ErrInvalidToken
	}
	var algorithm struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(header, &algorithm); err != nil || algorithm.Alg != "HS256" {
		return "", "", ErrInvalidToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(signature, sign(secret, parts[0]+"."+parts[1])) {
		return "", "", ErrInvalidToken
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", ErrInvalidToken
	}
	var claims accessClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", "", ErrInvalidToken
	}
	if claims.Sub == "" {
		return "", "", ErrInvalidToken
	}
	if claims.Exp != 0 && time.Now().UTC().Unix() >= claims.Exp {
		return "", "", ErrInvalidToken
	}
	return claims.Sub, claims.Email, nil
}

func sign(secret []byte, signing string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signing))
	return mac.Sum(nil)
}
