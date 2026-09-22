// Endpoint Quality — la API en Go, sobre el mismo esquema y los mismos secretos que la de NestJS.
//
// Arranca en su propio puerto (`PORT_GO`, 3003 por defecto) para poder convivir con los otros dos
// backends, que es lo que hace que el selector del front pueda cambiar de uno a otro sin apagar
// nada. Ver `docs/backends-poliglotas.md`.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/api"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/config"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/store"
)

func main() {
	settings, err := config.Load()
	if err != nil {
		// Un valor por defecto en el código firma las sesiones de todo el mundo con la misma
		// clave: mejor no arrancar.
		log.Fatalf("configuración: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	data, err := store.Open(ctx, settings.DatabaseURL)
	if err != nil {
		log.Fatalf("no se pudo conectar a la base de datos: %v", err)
	}
	defer data.Close()

	server, err := api.New(settings, data)
	if err != nil {
		log.Fatalf("no se pudo preparar la API: %v", err)
	}

	httpServer := &http.Server{
		Addr:              ":" + settings.Port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("API (Go) escuchando en http://localhost:%s · descriptor en /backend", settings.Port)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("el servidor se cayó: %v", err)
		}
	}()

	<-ctx.Done()
	// Un apagado que corta las peticiones en curso deja escrituras a medias en la base compartida.
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdown); err != nil {
		log.Printf("apagado con peticiones en curso: %v", err)
	}
}
