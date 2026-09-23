// El identificador de traza, que **sale al cliente** y por tanto es contrato.
//
// Apareció al traer el trabajo de logging de la rama principal: el backend de referencia empezó a
// devolver `traceId` en el cuerpo de los errores y `X-Trace-Id` en toda respuesta, y hasta que no
// se replicó aquí los tres contestaban tres cosas distintas al mismo error.
package tracing

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const generado = "uno-nuevo-generado"

func nuevo() string { return generado }

func TestUnIdentificadorConFormaSeRespeta(t *testing.T) {
	// Es lo que permite seguir una operación que empezó en el navegador o en otro servicio.
	for _, valido := range []string{"abc12345", "con-guiones_y_8", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if got := NewID(valido, nuevo); got != valido {
			t.Errorf("NewID(%q) = %q, debería respetarlo", valido, got)
		}
	}
}

func TestUnoSinFormaSeSustituyeEnVezDeRechazarse(t *testing.T) {
	// Una cabecera rara da una traza nueva, no un error: el cliente no puede tumbar la petición
	// escribiendo cualquier cosa. Y no se propaga: un salto de línea ahí inventaría entradas
	// enteras en el registro.
	for _, raro := range []string{"", "corto", "con espacio", "salto\nde línea", "punto.y.coma",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if got := NewID(raro, nuevo); got != generado {
			t.Errorf("NewID(%q) = %q, debería haberlo sustituido", raro, got)
		}
	}
}

func TestLaCabeceraVaEnTodaRespuestaYElContextoLaLleva(t *testing.T) {
	var visto string
	handler := Middleware(nuevo, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		visto = FromContext(request.Context())
		writer.WriteHeader(http.StatusOK)
	}))

	grabadora := httptest.NewRecorder()
	handler.ServeHTTP(grabadora, httptest.NewRequest(http.MethodGet, "/health", nil))

	// En una respuesta que salió bien, no solo en los errores: es lo que permite citar una
	// petición que tardó o devolvió algo raro.
	if got := grabadora.Header().Get(HeaderOut); got != generado {
		t.Errorf("la respuesta no trae la traza: %q", got)
	}
	if visto != generado {
		t.Errorf("el manejador no vio la traza en su contexto: %q", visto)
	}
}

func TestElIdentificadorQueTraeElClienteLlegaHastaElManejador(t *testing.T) {
	var visto string
	handler := Middleware(nuevo, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		visto = FromContext(request.Context())
	}))

	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	request.Header.Set(HeaderIn, "traza-de-otro-servicio")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if visto != "traza-de-otro-servicio" {
		t.Errorf("se perdió la traza del cliente: %q", visto)
	}
}

func TestFueraDeUnaPeticionNoHayTraza(t *testing.T) {
	// Y está bien que no la haya: un barrido, un monitor o el arranque no pertenecen a ninguna.
	if got := FromContext(t.Context()); got != "" {
		t.Errorf("se inventó una traza fuera de una petición: %q", got)
	}
}
