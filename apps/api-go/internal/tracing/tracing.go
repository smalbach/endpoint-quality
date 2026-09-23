// Package tracing es el identificador que une todo lo que pasa por una misma petición.
//
// Portado de `apps/api/src/shared/logging/trace-context.ts` y su middleware. No es una comodidad
// de registro: **sale al cliente**, en la cabecera `X-Trace-Id` de toda respuesta y dentro del
// cuerpo RFC 9457 de un error. Quien informa de un fallo trae el número, y buscarlo devuelve la
// petición entera en vez de «hacia las cuatro».
//
// Está aquí porque dos backends que contestan el mismo error, uno con `traceId` y otro sin él, son
// dos contratos distintos — y así es exactamente como el guion de conformidad descubrió que
// faltaba, al traer el trabajo de logging de la rama principal.
//
// El identificador va en el `context.Context` de la petición y no en una variable global: en Go la
// petición ya lleva su contexto a todas partes, y un almacén paralelo sería una segunda fuente de
// verdad para el mismo dato.
package tracing

import (
	"context"
	"net/http"
	"regexp"
)

const (
	// En minúscula al leer, porque así normaliza Go las cabeceras entrantes; la respuesta se
	// escribe con mayúsculas, como la de Express.
	HeaderIn  = "X-Trace-Id"
	HeaderOut = "X-Trace-Id"
)

// La misma forma cerrada que allí: se acepta el identificador que trae el cliente —es lo que
// permite seguir una operación que empezó en otro sitio— pero validado, porque una cabecera sin
// filtrar acabaría en una línea del registro, y un salto de línea ahí inventa entradas enteras.
var safeTraceID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

type contextKey struct{}

// NewID devuelve el identificador que trae el cliente si tiene forma de tal, y uno nuevo si no.
// Nunca falla: una cabecera rara da una traza nueva, no un error.
func NewID(header string, generate func() string) string {
	if safeTraceID.MatchString(header) {
		return header
	}
	return generate()
}

// FromContext es lo que lleva esta petición, o "" fuera de una.
func FromContext(ctx context.Context) string {
	id, _ := ctx.Value(contextKey{}).(string)
	return id
}

// Middleware es lo primero que toca una petición: darle su identificador y devolverlo.
//
// La cabecera va en **toda** respuesta, no solo en los errores, igual que allí: es lo que permite
// citar una petición que salió bien pero tardó, o que devolvió algo raro. Y se pone antes de
// seguir, para que la lleve también lo que conteste sin llegar al manejador.
func Middleware(generate func() string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		id := NewID(request.Header.Get(HeaderIn), generate)
		writer.Header().Set(HeaderOut, id)
		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), contextKey{}, id)))
	})
}
