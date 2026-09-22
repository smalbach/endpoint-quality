// Package api es la superficie HTTP: el enrutado, la identidad, el freno de peticiones y las
// respuestas, con el mismo contrato que la API de NestJS.
//
// Sin framework, con `net/http` y los patrones de método y ruta de Go 1.22. Meter uno sería añadir
// una dependencia para ahorrar treinta líneas y perder la propiedad más útil de esta
// implementación: que se lee entera.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/config"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/crypto"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/domain"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/store"
)

const refreshCookie = "eq_refresh"

type Server struct {
	settings config.Settings
	store    *store.Store
	// Un digest de una contraseña que no tiene nadie, calculado una vez, para que el camino del
	// correo desconocido gaste el mismo trabajo que el del conocido. Sin él, el login contesta
	// antes cuando la cuenta no existe, que es un oráculo de enumeración gratis.
	decoyDigest string
	limiter     *limiter
}

func New(settings config.Settings, data *store.Store) (*Server, error) {
	decoy, err := crypto.HashPassword("una contraseña que no tiene nadie")
	if err != nil {
		return nil, err
	}
	return &Server{settings: settings, store: data, decoyDigest: decoy, limiter: newLimiter()}, nil
}

// Handler declara cada ruta con su método. El enrutador de la biblioteca estándar distingue
// `PATCH /orgs/{organizationId}/projects/{projectId}` de `PATCH …/{projectId}/archived` por
// especificidad, que es justo lo que hace falta aquí.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.handle(s.health))
	mux.HandleFunc("GET /backend", s.handle(s.backend))

	mux.HandleFunc("POST /auth/register", s.handle(s.register))
	mux.HandleFunc("POST /auth/login", s.handle(s.login))
	mux.HandleFunc("POST /auth/refresh", s.handle(s.refresh))
	mux.HandleFunc("POST /auth/logout", s.handle(s.logout))
	mux.HandleFunc("POST /auth/forgot-password", s.handle(s.forgotPassword))
	mux.HandleFunc("POST /auth/reset-password", s.handle(s.resetPassword))
	mux.HandleFunc("POST /auth/change-password", s.handle(s.changePassword))
	mux.HandleFunc("GET /auth/me", s.handle(s.me))
	mux.HandleFunc("GET /auth/context", s.handle(s.authContext))

	mux.HandleFunc("POST /orgs", s.handle(s.createOrganization))
	mux.HandleFunc("POST /invitations/accept", s.handle(s.acceptInvitation))
	mux.HandleFunc("GET /orgs/{organizationId}/members", s.handle(s.members))
	mux.HandleFunc("POST /orgs/{organizationId}/invitations", s.handle(s.invite))
	mux.HandleFunc("PATCH /orgs/{organizationId}/members/{userId}", s.handle(s.changeRole))
	mux.HandleFunc("DELETE /orgs/{organizationId}/members/{userId}", s.handle(s.removeMember))
	mux.HandleFunc("GET /orgs/{organizationId}/tokens", s.handle(s.listAPITokens))
	mux.HandleFunc("POST /orgs/{organizationId}/tokens", s.handle(s.createAPIToken))
	mux.HandleFunc("DELETE /orgs/{organizationId}/tokens/{tokenId}", s.handle(s.revokeAPIToken))

	mux.HandleFunc("GET /orgs/{organizationId}/projects", s.handle(s.listProjects))
	mux.HandleFunc("POST /orgs/{organizationId}/projects", s.handle(s.createProject))
	mux.HandleFunc("GET /orgs/{organizationId}/projects/{projectId}", s.handle(s.getProject))
	mux.HandleFunc("PATCH /orgs/{organizationId}/projects/{projectId}", s.handle(s.updateProject))
	mux.HandleFunc("PATCH /orgs/{organizationId}/projects/{projectId}/archived", s.handle(s.setProjectArchived))
	mux.HandleFunc("DELETE /orgs/{organizationId}/projects/{projectId}", s.handle(s.deleteProject))

	return s.cors(mux)
}

// handle convierte un manejador que devuelve error en uno de `net/http`: así ningún fallo puede
// salir sin pasar por Problem Details, que es la propiedad que el filtro global da allí.
func (s *Server) handle(next func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if err := next(writer, request); err != nil {
			problems.Write(writer, request, err)
		}
	}
}

// cors con credenciales: el origen se refleja **solo** si está en la lista. Contestar `*` con
// `Allow-Credentials` no lo permite ningún navegador, y reflejar cualquiera es abrir la API a
// cualquier página que la persona visite mientras tiene sesión.
func (s *Server) cors(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, origin := range s.settings.CORSOrigins {
		allowed[origin] = true
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if origin := request.Header.Get("Origin"); origin != "" && allowed[origin] {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Set("Access-Control-Allow-Credentials", "true")
			writer.Header().Set("Vary", "Origin")
			if request.Method == http.MethodOptions {
				writer.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
				writer.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
				writer.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(writer, request)
	})
}

// --- respuestas -------------------------------------------------------------------------------

func writeJSON(writer http.ResponseWriter, status int, body any) error {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	return json.NewEncoder(writer).Encode(body)
}

func noContent(writer http.ResponseWriter) error {
	writer.WriteHeader(http.StatusNoContent)
	return nil
}

// decode rechaza un cuerpo con campos que el DTO no declara, como el `forbidNonWhitelisted` de
// allí: tirar en silencio un `role: "owner"` que alguien intentó mandar esconde el intento.
func decode(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return problems.Invalid("La solicitud no supera la validación",
			[]problems.Field{{Field: "body", Detail: "El cuerpo no tiene la forma esperada"}}, "422")
	}
	return nil
}

// iso escribe una fecha como lo hace `JSON.stringify` sobre un `Date`: UTC, milisegundos y `Z`.
// El `time.RFC3339Nano` de Go daría `+00:00` y nanosegundos, que es válido y distinto — y el front
// ordena y compara estas cadenas.
func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func isoPointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := iso(*value)
	return &formatted
}

// newID es un UUID v4 con la aleatoriedad del sistema. Una dependencia menos por catorce líneas.
func newID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// Sin aleatoriedad no se puede emitir un identificador que no colisione ni un token que no
		// se adivine: seguir sería peor que parar.
		log.Fatalf("no hay fuente de aleatoriedad: %v", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(raw)
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
}

// --- identidad --------------------------------------------------------------------------------

type principal struct {
	kind           string // "user" | "api-token"
	userID         string
	email          string
	organizationID string
	tokenID        string
}

// authenticate establece **quién** llama, y no dice nada de permisos. La credencial es un JWT
// firmado o un token de servicio `eqt_`.
func (s *Server) authenticate(request *http.Request) (principal, error) {
	header := request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return principal{}, problems.Unauthenticated("Falta la credencial", "")
	}
	credential := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	ctx := request.Context()

	if strings.HasPrefix(credential, "eqt_") {
		token, err := s.store.APITokenByHash(ctx, crypto.HashOpaqueToken(credential))
		if err != nil {
			return principal{}, err
		}
		if token == nil || token.RevokedAt != nil {
			return principal{}, problems.Unauthenticated("La credencial no es válida", "")
		}
		// Anotado para que un operador vea qué tokens de CI siguen en uso antes de revocar uno.
		if err := s.store.TouchAPIToken(ctx, token.ID, time.Now().UTC()); err != nil {
			return principal{}, err
		}
		return principal{kind: "api-token", organizationID: token.OrganizationID, tokenID: token.ID}, nil
	}

	userID, _, err := crypto.VerifyAccessToken(s.settings.JWTAccessSecret, credential)
	if err != nil {
		return principal{}, problems.Unauthenticated("La credencial no es válida", "")
	}
	user, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return principal{}, err
	}
	// Una firma que verifica no es lo mismo que una cuenta que sigue existiendo y activa.
	if user == nil || user.Status != "active" {
		return principal{}, problems.Unauthenticated("La credencial no es válida", "")
	}
	return principal{kind: "user", userID: user.ID, email: user.Email}, nil
}

// requireUser: las operaciones que solo hace una persona. Un token de CI que pudiera invitar a un
// propietario convertiría un secreto de build filtrado en una toma de la cuenta.
func requireUser(who principal) (string, error) {
	if who.kind != "user" || who.userID == "" {
		return "", problems.Unauthenticated("Esta operación requiere una sesión de usuario", "user-session-required")
	}
	return who.userID, nil
}

// roleIn resuelve la autorización **contra la base en cada petición**, sobre la organización que
// la ruta nombra. Los roles no viajan en el JWT: meterlos ahorra una consulta y cuesta que una
// membresía revocada siga funcionando hasta que caduque el token.
func (s *Server) roleIn(request *http.Request, who principal, organizationID, required string) (string, error) {
	if who.kind == "api-token" {
		if who.organizationID != organizationID {
			return "", problems.Forbidden("Este token no pertenece a la organización", "")
		}
		// Un token de servicio llega hasta `editor` y no más: lanza corridas y lee, y no gestiona
		// miembros ni credenciales.
		if !domain.AtLeast("editor", required) {
			return "", problems.Forbidden("Un token de servicio no alcanza para esta operación", "api-token-role")
		}
		return "editor", nil
	}

	userID, err := requireUser(who)
	if err != nil {
		return "", err
	}
	membership, err := s.store.Membership(request.Context(), organizationID, userID)
	if err != nil {
		return "", err
	}
	if membership == nil {
		return "", problems.Forbidden("No perteneces a esta organización", "")
	}
	if !domain.AtLeast(membership.Role, required) {
		return "", problems.Forbidden("Esta operación requiere el rol "+required, "insufficient-role")
	}
	return membership.Role, nil
}

// --- freno de peticiones -----------------------------------------------------------------------

// El freno de las rutas que no piden credencial. En memoria del proceso: con una sola instancia es
// exacto, y este backend se despliega en un proceso. La API de Nest puede compartir contadores por
// Redis; decirlo aquí es mejor que fingir que cuenta lo mismo detrás de un balanceador.
type limiter struct {
	mutex sync.Mutex
	hits  map[string][]time.Time
}

func newLimiter() *limiter { return &limiter{hits: map[string][]time.Time{}} }

func (l *limiter) check(key string, limit int, window time.Duration) error {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	now := time.Now()
	kept := l.hits[key][:0]
	for _, hit := range l.hits[key] {
		if now.Sub(hit) < window {
			kept = append(kept, hit)
		}
	}
	if len(kept) >= limit {
		l.hits[key] = kept
		return problems.RateLimited()
	}
	l.hits[key] = append(kept, now)
	return nil
}

func (s *Server) throttle(request *http.Request, operation string, limit int, window time.Duration) error {
	// Detrás del proxy del front, la IP del socket es la del proxy: `X-Forwarded-For` es lo que
	// distingue a dos personas. Solo el primer salto, que es el que escribe el proxy propio.
	client := request.RemoteAddr
	if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
		client = strings.TrimSpace(strings.Split(forwarded, ",")[0])
	} else if host, _, found := strings.Cut(client, ":"); found {
		client = host
	}
	return s.limiter.check(operation+"|"+client, limit, window)
}

// --- sonda y descriptor -------------------------------------------------------------------------

type databaseCheck struct {
	Status    string `json:"status"`
	LatencyMs *int   `json:"latencyMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

type healthDocument struct {
	Status string `json:"status"`
	Checks struct {
		Database databaseCheck `json:"database"`
	} `json:"checks"`
}

// health consulta de verdad la base en vez de informar de que el proceso está vivo: una sonda que
// solo sabe decir «ok» es el `pass: true` a mano que este producto existe para cazar.
//
// El código es 200 también cuando la base no contesta, y el veredicto va en `status`. No es lo que
// uno elegiría de cero —503 es lo que entiende un balanceador— sino lo que hace el backend de
// referencia, y aquí manda la paridad.
func (s *Server) health(writer http.ResponseWriter, request *http.Request) error {
	started := time.Now()
	document := healthDocument{Status: "ok"}
	if err := s.store.Healthy(request.Context()); err != nil {
		document.Status = "down"
		document.Checks.Database = databaseCheck{Status: "down", Error: err.Error()}
	} else {
		latency := int(time.Since(started).Milliseconds())
		document.Checks.Database = databaseCheck{Status: "up", LatencyMs: &latency}
	}
	return writeJSON(writer, http.StatusOK, document)
}

func (s *Server) backend(writer http.ResponseWriter, _ *http.Request) error {
	return writeJSON(writer, http.StatusOK, descriptor)
}

// logInfo es la única traza de este backend: un registro que nombra el hecho y nunca la
// credencial que lo provocó.
func logInfo(format string, args ...any) {
	log.Printf(format, args...)
}
