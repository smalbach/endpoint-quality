// Package problems es la única forma en que sale un error de esta API: RFC 9457, con el mismo
// cuerpo que el filtro de NestJS (`shared/errors/problem-details.filter.ts`).
//
// No es cosmética compartida: el front ramifica sobre `problem.type` —`project-not-found`,
// `email-taken`, `weak-password`— y pinta `errors[].detail` debajo del campo que lo causó. Un
// backend que conteste el mismo código con otro cuerpo rompe formularios enteros sin que ningún
// código de estado lo delate.
package problems

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/tracing"
)

type Kind string

const (
	KindNotFound        Kind = "not-found"
	KindConflict        Kind = "conflict"
	KindInvalid         Kind = "invalid"
	KindUnauthenticated Kind = "unauthenticated"
	KindForbidden       Kind = "forbidden"
	KindRateLimited     Kind = "rate-limited"
)

var statusByKind = map[Kind]int{
	KindNotFound:        http.StatusNotFound,
	KindConflict:        http.StatusConflict,
	KindInvalid:         http.StatusUnprocessableEntity,
	KindUnauthenticated: http.StatusUnauthorized,
	KindForbidden:       http.StatusForbidden,
	KindRateLimited:     http.StatusTooManyRequests,
}

var titleByStatus = map[int]string{
	400: "Solicitud inválida",
	401: "No autenticado",
	403: "Sin permiso",
	404: "Recurso no encontrado",
	409: "Conflicto",
	413: "Cuerpo demasiado grande",
	415: "Tipo de contenido no soportado",
	422: "Entidad no procesable",
	429: "Demasiadas solicitudes",
	500: "Error interno",
}

const base = "https://endpoint-quality.dev/problems"

// Field es un problema con nombre, para que el formulario sepa bajo qué input ponerlo.
type Field struct {
	Field  string `json:"field"`
	Detail string `json:"detail"`
}

// Error es un fallo del dominio, sin HTTP dentro. El `code` se convierte en el último segmento
// del `type`, que es lo que un cliente lee para ramificar sin interpretar prosa.
type Error struct {
	Kind    Kind
	Message string
	Fields  []Field
	Code    string
}

func (e *Error) Error() string { return e.Message }

func NotFound(message, code string) *Error {
	return &Error{Kind: KindNotFound, Message: message, Code: code}
}
func Conflict(message, code string) *Error {
	return &Error{Kind: KindConflict, Message: message, Code: code}
}
func Invalid(message string, fields []Field, code string) *Error {
	return &Error{Kind: KindInvalid, Message: message, Fields: fields, Code: code}
}
func Unauthenticated(message, code string) *Error {
	if message == "" {
		message = "Credenciales inválidas"
	}
	return &Error{Kind: KindUnauthenticated, Message: message, Code: code}
}
func Forbidden(message, code string) *Error {
	if message == "" {
		message = "No tienes permiso sobre este recurso"
	}
	return &Error{Kind: KindForbidden, Message: message, Code: code}
}

// RateLimited lleva el texto exacto que contesta la referencia. «ThrottlerException: Too Many
// Requests» es el mensaje que `@nestjs/throttler` pone en su excepción y que el filtro de allí
// deja pasar tal cual. Copiarlo no es admirarlo: el cuerpo de un 429 es tan parte del contrato
// como el de un 422.
func RateLimited() *Error {
	return &Error{Kind: KindRateLimited, Message: "ThrottlerException: Too Many Requests", Code: "429"}
}

type document struct {
	Type     string  `json:"type"`
	Title    string  `json:"title"`
	Status   int     `json:"status"`
	Detail   string  `json:"detail"`
	Instance string  `json:"instance"`
	Errors   []Field `json:"errors,omitempty"`
	// El último, como en el original: el orden de las claves es parte de la forma que compara el
	// guion de conformidad. Va en la respuesta a propósito — es lo que cierra el bucle entre quien
	// informa de un fallo y el registro, y no filtra nada: un número aleatorio por petición.
	TraceID string `json:"traceId,omitempty"`
}

func instanceOf(request *http.Request) string {
	if request.URL.RawQuery != "" {
		return request.URL.Path + "?" + request.URL.RawQuery
	}
	return request.URL.Path
}

// Write manda el error como Problem Details. Un `*Error` se traduce por su género; cualquier otra
// cosa es un 500 que **no cuenta nada de dentro**: una traza en el cuerpo de una respuesta es un
// mapa del sistema de ficheros del servidor y de las versiones que corre.
func Write(writer http.ResponseWriter, request *http.Request, err error) {
	document := toDocument(err, instanceOf(request))
	document.TraceID = tracing.FromContext(request.Context())
	if document.Status >= 500 {
		// Lo que se registra y lo que se contesta son cosas distintas a propósito: el operador
		// necesita la causa y quien llama no debe recibirla.
		log.Printf("%s %s → 500 [%s]: %v", request.Method, document.Instance, document.TraceID, err)
	}
	writer.Header().Set("Content-Type", "application/problem+json")
	writer.WriteHeader(document.Status)
	_ = json.NewEncoder(writer).Encode(document)
}

func toDocument(err error, instance string) document {
	if domain, ok := err.(*Error); ok {
		status := statusByKind[domain.Kind]
		code := domain.Code
		if code == "" {
			code = string(domain.Kind)
		}
		return document{
			Type:     base + "/" + code,
			Title:    titleByStatus[status],
			Status:   status,
			Detail:   domain.Message,
			Instance: instance,
			Errors:   domain.Fields,
		}
	}
	return document{
		Type:     base + "/internal",
		Title:    titleByStatus[500],
		Status:   500,
		Detail:   "La solicitud no pudo completarse",
		Instance: instance,
	}
}
