// Package domain son las reglas que no son ni HTTP ni SQL, portadas una a una desde
// `apps/api/src/modules/*/domain/`.
//
// Cada función tiene un original con nombre en el otro backend, y esa correspondencia es lo que
// permite revisar la paridad leyendo en vez de probando: si `Slugify` pliega los acentos allí y
// los tira aquí, dos organizaciones con el mismo nombre acaban con URLs distintas según quién las
// creó.
package domain

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// --- roles ---------------------------------------------------------------------------------

var Roles = []string{"viewer", "editor", "admin", "owner"}

var rank = map[string]int{"viewer": 0, "editor": 1, "admin": 2, "owner": 3}

// AtLeast es la escalera de roles: una comparación, no una tabla de excepciones.
func AtLeast(role, required string) bool {
	have, ok := rank[role]
	if !ok {
		return false
	}
	return have >= rank[required]
}

func IsRole(value string) bool {
	_, ok := rank[value]
	return ok
}

// --- contraseñas ---------------------------------------------------------------------------

const PasswordMinLength = 12

// Cinco intentos fallidos bloquean quince minutos: los números del analizador.
const (
	MaxFailedLogins = 5
	Lockout         = 15 * time.Minute
)

const (
	PasswordResetTTL = time.Hour
	InvitationTTL    = 7 * 24 * time.Hour
)

// PasswordProblems mide las clases por categoría Unicode y no con `[a-z]`, que es lo que
// significan `\p{Ll}`, `\p{Lu}`, `\p{Nd}` y `[^\p{L}\p{Nd}]` en el original. Un `[a-z]` rechazaría
// «Contraseña» como si no tuviera minúsculas en cuanto alguien use un alfabeto que no es el inglés.
func PasswordProblems(password string) []string {
	found := []string{}
	if len([]rune(password)) < PasswordMinLength {
		found = append(found, fmt.Sprintf("Debe tener al menos %d caracteres", PasswordMinLength))
	}
	lower, upper, digit, symbol := false, false, false, false
	for _, character := range password {
		switch {
		case unicode.IsLower(character):
			lower = true
		case unicode.IsUpper(character):
			upper = true
		}
		if unicode.IsDigit(character) {
			digit = true
		}
		// Símbolo es «ni letra ni dígito», que es lo que dice `[^\p{L}\p{Nd}]`: el espacio cuenta.
		if !unicode.IsLetter(character) && !unicode.IsDigit(character) {
			symbol = true
		}
	}
	if !lower {
		found = append(found, "Debe incluir una minúscula")
	}
	if !upper {
		found = append(found, "Debe incluir una mayúscula")
	}
	if !digit {
		found = append(found, "Debe incluir un número")
	}
	if !symbol {
		found = append(found, "Debe incluir un símbolo")
	}
	return found
}

// NormalizeEmail: se comparan sin distinguir mayúsculas y se guardan recortados. Dos cuentas que
// solo difieren en la capitalización son una sola cuenta para cualquiera que teclee una de ellas.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// --- slugs ---------------------------------------------------------------------------------

var notSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name, fallback string) string {
	folded, _, err := transform.String(
		transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC),
		name,
	)
	if err != nil {
		folded = name
	}
	slug := strings.Trim(notSlug.ReplaceAllString(strings.ToLower(folded), "-"), "-")
	if runes := []rune(slug); len(runes) > 60 {
		slug = string(runes[:60])
	}
	if slug == "" {
		return fallback
	}
	return slug
}

func SlugifyOrganization(name string) string { return slugify(name, "org") }
func SlugifyProject(name string) string      { return slugify(name, "proyecto") }

// --- proyectos -----------------------------------------------------------------------------

// NormalizeTags: recortadas, una vez cada una, en el orden en que llegaron.
func NormalizeTags(tags []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed != "" && !seen[trimmed] {
			seen[trimmed] = true
			result = append(result, trimmed)
		}
	}
	return result
}

var schemePattern = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*):`)

// BaseURLProblems: el mismo juicio que `projectSettingsProblems` allí — una URL que no se entiende
// o un esquema que no es http(s) se rechazan con el campo señalado.
func BaseURLProblems(baseURL *string) []problems.Field {
	if baseURL == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*baseURL)
	if trimmed == "" {
		return nil
	}
	match := schemePattern.FindStringSubmatch(trimmed)
	if match == nil {
		return []problems.Field{{Field: "baseUrl", Detail: "No es una URL válida"}}
	}
	if scheme := strings.ToLower(match[1]); scheme != "http" && scheme != "https" {
		return []problems.Field{{Field: "baseUrl", Detail: "Solo http o https"}}
	}
	return nil
}

// --- sesiones ------------------------------------------------------------------------------

// WouldOrphanOrganization: el último propietario no se puede degradar ni expulsar. Una
// organización sin propietario no tiene a nadie que pueda añadir uno, y todo lo que hay dentro se
// queda sin dueño.
func WouldOrphanOrganization(roles map[string]string, userID, nextRole string) bool {
	owners := []string{}
	for id, role := range roles {
		if role == "owner" {
			owners = append(owners, id)
		}
	}
	onlyOwner := len(owners) == 1 && owners[0] == userID
	return onlyOwner && nextRole != "owner"
}
