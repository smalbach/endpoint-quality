package api

// La validación del cuerpo, con los mensajes exactos del `ValidationPipe` de la API de NestJS.
//
// El front pinta `errors[].detail` debajo del campo que lo causó, así que ese texto es parte del
// contrato: dos backends que lo escriben distinto son dos productos que hablan distinto según
// quién conteste, y el guion de conformidad lo señala como divergencia.
//
// Las reglas se comprueban en el orden en que están declaradas en el DTO de allí, que es el orden
// en que `class-validator` devuelve sus mensajes.

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
)

// La de `class-validator`, simplificada a lo que este producto necesita distinguir: una dirección
// con arroba, algo antes, algo después y un punto en el dominio.
var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// rules acumula los problemas y los levanta todos juntos, no el primero: un formulario que corrige
// un campo por petición es un formulario que se envía cinco veces.
type rules struct {
	found []problems.Field
}

func (r rules) email(field, value string) rules {
	if !emailPattern.MatchString(value) {
		r.found = append(r.found, problems.Field{Field: field, Detail: field + " debe ser una dirección válida"})
	}
	return r
}

func (r rules) minLength(field, value string, length int) rules {
	if len([]rune(value)) < length {
		r.found = append(r.found, problems.Field{
			Field: field, Detail: fmt.Sprintf("%s debe tener al menos %d caracteres", field, length),
		})
	}
	return r
}

func (r rules) maxLength(field, value string, length int) rules {
	if len([]rune(value)) > length {
		r.found = append(r.found, problems.Field{
			Field: field, Detail: fmt.Sprintf("%s no puede superar los %d caracteres", field, length),
		})
	}
	return r
}

func (r rules) oneOf(field, value string, options []string) rules {
	for _, option := range options {
		if value == option {
			return r
		}
	}
	r.found = append(r.found, problems.Field{
		Field: field, Detail: fmt.Sprintf("%s debe ser uno de: %s", field, strings.Join(options, ", ")),
	})
	return r
}

func (r rules) check() error {
	if len(r.found) == 0 {
		return nil
	}
	// El `type` termina en `422` y no en un código de dominio: es el fallo genérico de validación,
	// igual que el que produce el pipe allí.
	return problems.Invalid("La solicitud no supera la validación", r.found, "422")
}
