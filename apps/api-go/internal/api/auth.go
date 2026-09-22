package api

// La superficie HTTP de una sesión, con las mismas reglas que `auth.controller.ts`.
//
// El token de refresco viaja como cookie `eq_refresh` httpOnly y SameSite=Strict, y además en el
// cuerpo: un navegador no debe poder leerlo desde JavaScript, y una CLI o un trabajo de CI no
// tiene tarro de cookies. El de acceso va solo en el cuerpo y nunca como cookie, que es lo que
// hace estructuralmente imposible un CSRF contra las rutas autenticadas.
//
// Todo lo que se emite aquí lo acepta el backend de Node y al revés: mismo secreto, misma tabla,
// mismo formato de hash.

import (
	"net/http"
	"strings"
	"time"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/crypto"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/domain"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/store"
)

type registerBody struct {
	Email            string `json:"email"`
	Password         string `json:"password"`
	Name             string `json:"name"`
	OrganizationName string `json:"organizationName"`
}

type loginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshBody struct {
	RefreshToken string `json:"refreshToken"`
}

type logoutBody struct {
	RefreshToken string `json:"refreshToken"`
	Everywhere   bool   `json:"everywhere"`
}

type changePasswordBody struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

type forgotPasswordBody struct {
	Email string `json:"email"`
}

type resetPasswordBody struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
}

type sessionResponse struct {
	UserID       string `json:"userId"`
	AccessToken  string `json:"accessToken"`
	ExpiresIn    int    `json:"expiresIn"`
	RefreshToken string `json:"refreshToken"`
}

type registerResponse struct {
	UserID         string `json:"userId"`
	OrganizationID string `json:"organizationId"`
}

type organizationView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	Role string `json:"role"`
}

type currentUser struct {
	ID            string             `json:"id"`
	Email         string             `json:"email"`
	Name          string             `json:"name"`
	Organizations []organizationView `json:"organizations"`
}

type personView struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type authContext struct {
	Principal     string             `json:"principal"`
	User          *personView        `json:"user"`
	Organizations []organizationView `json:"organizations"`
}

func assertStrongPassword(password, field string) error {
	found := domain.PasswordProblems(password)
	if len(found) == 0 {
		return nil
	}
	fields := make([]problems.Field, 0, len(found))
	for _, detail := range found {
		fields = append(fields, problems.Field{Field: field, Detail: detail})
	}
	return problems.Invalid("La contraseña no cumple los requisitos", fields, "weak-password")
}

// --- cookie de refresco ---------------------------------------------------------------------

func (s *Server) sessionCookie(value string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     refreshCookie,
		Value:    value,
		Expires:  expires,
		HttpOnly: true,
		// Strict y no Lax: esta cookie solo la manda nuestro propio front, nunca una navegación.
		SameSite: http.SameSiteStrictMode,
		Secure:   s.settings.Production,
		// `/` y no `/auth`: la API se sirve bajo un prefijo (`/api-go` por el proxy), así que el
		// navegador ve `/api-go/auth/refresh`, que `path=/auth` no casa. Con la ruta estrecha la
		// cookie no se mandaba nunca y la sesión moría en cada recarga.
		Path:   "/",
		Domain: s.settings.CookieDomain,
	}
}

func (s *Server) clearSessionCookie(writer http.ResponseWriter) {
	// Se borra con los mismos atributos con los que se puso, o el navegador se queda con la vieja
	// y el siguiente refresco presenta un token que el servidor ya revocó.
	cookie := s.sessionCookie("", time.Unix(0, 0))
	cookie.MaxAge = -1
	http.SetCookie(writer, cookie)
}

// issueSession emite un par acceso/refresco y anota el lado del refresco. Compartida por el login
// y por la rotación para que las dos no puedan divergir.
func (s *Server) issueSession(request *http.Request, userID, email, sessionID string) (sessionResponse, time.Time, error) {
	now := time.Now().UTC()
	refreshToken, err := crypto.GenerateOpaqueToken()
	if err != nil {
		return sessionResponse{}, time.Time{}, err
	}
	expiresAt := now.AddDate(0, 0, s.settings.RefreshTokenTTLDays)

	if err := s.store.InsertRefreshToken(request.Context(), newID(), userID, sessionID,
		crypto.HashOpaqueToken(refreshToken), expiresAt, now); err != nil {
		return sessionResponse{}, time.Time{}, err
	}

	accessToken, err := crypto.SignAccessToken(s.settings.JWTAccessSecret, userID, email, s.settings.AccessTokenTTLSeconds)
	if err != nil {
		return sessionResponse{}, time.Time{}, err
	}
	return sessionResponse{
		UserID:       userID,
		AccessToken:  accessToken,
		ExpiresIn:    s.settings.AccessTokenTTLSeconds,
		RefreshToken: refreshToken,
	}, expiresAt, nil
}

// --- rutas -------------------------------------------------------------------------------------

func (s *Server) register(writer http.ResponseWriter, request *http.Request) error {
	// Con el mismo límite que el login: escribe una fila y corre el KDF, así que es a la vez un
	// vector de spam y una forma de hacer trabajar al servidor gratis.
	if err := s.throttle(request, "register", 5, time.Minute); err != nil {
		return err
	}
	var body registerBody
	if err := decode(request, &body); err != nil {
		return err
	}
	// Las reglas del DTO primero, como el pipe de allí: una contraseña de cinco letras no llega a
	// la política de dominio, y por eso su mensaje es «al menos 12 caracteres» y no la lista entera.
	if err := (rules{}).
		email("email", body.Email).
		maxLength("email", body.Email, 320).
		minLength("password", body.Password, 12).
		maxLength("password", body.Password, 200).
		maxLength("name", body.Name, 200).
		maxLength("organizationName", body.OrganizationName, 200).
		check(); err != nil {
		return err
	}

	email := domain.NormalizeEmail(body.Email)
	if !strings.Contains(email, "@") {
		return problems.Invalid("El correo no es válido",
			[]problems.Field{{Field: "email", Detail: "Debe ser una dirección de correo"}}, "")
	}
	if err := assertStrongPassword(body.Password, "password"); err != nil {
		return err
	}

	ctx := request.Context()
	existing, err := s.store.UserByEmail(ctx, email)
	if err != nil {
		return err
	}
	if existing != nil {
		// Esto sí filtra que la dirección está registrada, y es el intercambio correcto: la
		// alternativa es no crear la cuenta y decir que sí se creó. Donde la enumeración importa
		// —el login— no se filtra nada.
		return problems.Conflict("Ese correo ya tiene una cuenta", "email-taken")
	}

	digest, err := crypto.HashPassword(body.Password)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	user := store.User{ID: newID(), Email: email, Name: name, PasswordDigest: digest,
		Status: "active", CreatedAt: time.Now().UTC()}
	if err := s.store.InsertUser(ctx, user); err != nil {
		return err
	}

	organizationName := strings.TrimSpace(body.OrganizationName)
	if organizationName == "" {
		organizationName = name
	}
	organizationID, _, err := s.foundOrganization(request, organizationName, user.ID)
	if err != nil {
		return err
	}
	return writeJSON(writer, http.StatusCreated, registerResponse{UserID: user.ID, OrganizationID: organizationID})
}

// login: cada fallo contesta lo mismo y tarda lo mismo. Un correo desconocido verifica la
// contraseña contra un digest señuelo antes de fallar, así que el tiempo de respuesta no dice si
// la cuenta existe; una cuenta deshabilitada o bloqueada falla con el mismo mensaje.
func (s *Server) login(writer http.ResponseWriter, request *http.Request) error {
	if err := s.throttle(request, "login", 10, time.Minute); err != nil {
		return err
	}
	var body loginBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).email("email", body.Email).maxLength("email", body.Email, 320).
		maxLength("password", body.Password, 200).check(); err != nil {
		return err
	}

	ctx := request.Context()
	now := time.Now().UTC()
	user, err := s.store.UserByEmail(ctx, domain.NormalizeEmail(body.Email))
	if err != nil {
		return err
	}
	digest := s.decoyDigest
	if user != nil {
		digest = user.PasswordDigest
	}
	matches := crypto.VerifyPassword(body.Password, digest)

	if user == nil {
		return problems.Unauthenticated("", "")
	}
	if user.LockedUntil != nil && user.LockedUntil.After(now) {
		return problems.Unauthenticated("", "")
	}
	if !matches {
		attempts := user.FailedLoginAttempts + 1
		if attempts >= domain.MaxFailedLogins {
			until := now.Add(domain.Lockout)
			if err := s.store.SetLoginFailures(ctx, user.ID, 0, &until); err != nil {
				return err
			}
		} else if err := s.store.SetLoginFailures(ctx, user.ID, attempts, nil); err != nil {
			return err
		}
		return problems.Unauthenticated("", "")
	}
	if user.Status != "active" {
		return problems.Unauthenticated("", "")
	}
	if user.FailedLoginAttempts > 0 || user.LockedUntil != nil {
		if err := s.store.SetLoginFailures(ctx, user.ID, 0, nil); err != nil {
			return err
		}
	}

	session, expiresAt, err := s.issueSession(request, user.ID, user.Email, newID())
	if err != nil {
		return err
	}
	http.SetCookie(writer, s.sessionCookie(session.RefreshToken, expiresAt))
	return writeJSON(writer, http.StatusOK, session)
}

func (s *Server) refresh(writer http.ResponseWriter, request *http.Request) error {
	if err := s.throttle(request, "refresh", 30, time.Minute); err != nil {
		return err
	}
	var body refreshBody
	if err := decode(request, &body); err != nil {
		return err
	}
	token := body.RefreshToken
	if token == "" {
		if cookie, err := request.Cookie(refreshCookie); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		return problems.Unauthenticated("Falta el refresh token", "")
	}

	ctx := request.Context()
	now := time.Now().UTC()
	stored, err := s.store.RefreshTokenByHash(ctx, crypto.HashOpaqueToken(token))
	if err != nil {
		return err
	}
	if stored == nil {
		return problems.Unauthenticated("La sesión no es válida", "")
	}

	switch {
	case stored.UsedAt != nil:
		// Un token ya gastado que vuelve a presentarse significa que dos partes tienen la cadena:
		// se revoca la sesión entera, no ese token.
		if err := s.store.RevokeSession(ctx, stored.SessionID, now); err != nil {
			return err
		}
		return problems.Unauthenticated("La sesión no es válida", "")
	case stored.RevokedAt != nil, !stored.ExpiresAt.After(now):
		return problems.Unauthenticated("La sesión no es válida", "")
	}

	user, err := s.store.UserByID(ctx, stored.UserID)
	if err != nil {
		return err
	}
	// Una cuenta deshabilitada conserva un refresco válido hasta que caduca. Comprobarlo aquí es
	// lo que hace que deshabilitar surta efecto en la siguiente rotación y no treinta días después.
	if user == nil || user.Status != "active" {
		if err := s.store.RevokeSession(ctx, stored.SessionID, now); err != nil {
			return err
		}
		return problems.Unauthenticated("La sesión no es válida", "")
	}

	// El token nuevo se une a la misma sesión: esa cadena es la que recorre la detección de reuso.
	session, expiresAt, err := s.issueSession(request, user.ID, user.Email, stored.SessionID)
	if err != nil {
		return err
	}
	if err := s.store.MarkRefreshTokenUsed(ctx, stored.ID, now, crypto.HashOpaqueToken(session.RefreshToken)); err != nil {
		return err
	}
	http.SetCookie(writer, s.sessionCookie(session.RefreshToken, expiresAt))
	return writeJSON(writer, http.StatusOK, session)
}

func (s *Server) logout(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	if who.kind != "user" {
		return problems.Unauthenticated("Un token de servicio no tiene sesión que cerrar", "")
	}
	var body logoutBody
	if err := decode(request, &body); err != nil {
		return err
	}

	ctx := request.Context()
	now := time.Now().UTC()
	if body.Everywhere {
		if err := s.store.RevokeAllSessions(ctx, who.userID, now); err != nil {
			return err
		}
	} else {
		token := body.RefreshToken
		if token == "" {
			if cookie, err := request.Cookie(refreshCookie); err == nil {
				token = cookie.Value
			}
		}
		if token != "" {
			stored, err := s.store.RefreshTokenByHash(ctx, crypto.HashOpaqueToken(token))
			if err != nil {
				return err
			}
			if stored != nil && stored.UserID == who.userID {
				if err := s.store.RevokeSession(ctx, stored.SessionID, now); err != nil {
					return err
				}
			}
		}
	}
	s.clearSessionCookie(writer)
	return noContent(writer)
}

// forgotPassword contesta 204 exista o no la cuenta, y con más freno que el login: cada llamada
// puede poner un correo en la bandeja de alguien, lo que la convierte tanto en una forma de acosar
// una dirección como de averiguar si existe.
func (s *Server) forgotPassword(writer http.ResponseWriter, request *http.Request) error {
	if err := s.throttle(request, "forgot-password", 5, 15*time.Minute); err != nil {
		return err
	}
	var body forgotPasswordBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).email("email", body.Email).maxLength("email", body.Email, 320).check(); err != nil {
		return err
	}

	ctx := request.Context()
	user, err := s.store.UserByEmail(ctx, domain.NormalizeEmail(body.Email))
	if err != nil {
		return err
	}
	if user != nil && user.Status == "active" {
		token, err := crypto.GenerateOpaqueToken()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		if err := s.store.InsertPasswordReset(ctx, newID(), user.ID, crypto.HashOpaqueToken(token),
			now, now.Add(domain.PasswordResetTTL)); err != nil {
			return err
		}
		// El correo lo manda el backend de Node, que es donde vive el `MailerPort`. Aquí se anota
		// el destinatario y nunca el token, que es la credencial.
		logInfo("restablecimiento solicitado para el usuario %s", user.ID)
	}
	return noContent(writer)
}

func (s *Server) resetPassword(writer http.ResponseWriter, request *http.Request) error {
	if err := s.throttle(request, "reset-password", 10, time.Minute); err != nil {
		return err
	}
	var body resetPasswordBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).maxLength("token", body.Token, 200).
		minLength("newPassword", body.NewPassword, 12).
		maxLength("newPassword", body.NewPassword, 200).check(); err != nil {
		return err
	}

	ctx := request.Context()
	now := time.Now().UTC()
	stored, err := s.store.PasswordResetByHash(ctx, crypto.HashOpaqueToken(body.Token))
	if err != nil {
		return err
	}
	var user *store.User
	if stored != nil && stored.UsedAt == nil && stored.ExpiresAt.After(now) {
		if user, err = s.store.UserByID(ctx, stored.UserID); err != nil {
			return err
		}
	}
	if stored == nil || user == nil {
		return problems.Invalid("El enlace no es válido o ha caducado",
			[]problems.Field{{Field: "token", Detail: "Pide un enlace nuevo desde «¿Olvidaste tu contraseña?»"}},
			"reset-token-invalid")
	}
	// Después del token: así una contraseña débil no quema un enlace bueno, y un enlace malo no
	// llega a contar cuáles son las reglas de la contraseña.
	if err := assertStrongPassword(body.NewPassword, "newPassword"); err != nil {
		return err
	}

	digest, err := crypto.HashPassword(body.NewPassword)
	if err != nil {
		return err
	}
	if err := s.store.SetPassword(ctx, user.ID, digest); err != nil {
		return err
	}
	if err := s.store.SpendPasswordResets(ctx, user.ID, now); err != nil {
		return err
	}
	if err := s.store.RevokeAllSessions(ctx, user.ID, now); err != nil {
		return err
	}
	s.clearSessionCookie(writer)
	return noContent(writer)
}

func (s *Server) changePassword(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	if who.kind != "user" {
		return problems.Unauthenticated("Un token de servicio no tiene contraseña", "")
	}
	var body changePasswordBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).maxLength("currentPassword", body.CurrentPassword, 200).
		minLength("newPassword", body.NewPassword, 12).
		maxLength("newPassword", body.NewPassword, 200).check(); err != nil {
		return err
	}

	ctx := request.Context()
	user, err := s.store.UserByID(ctx, who.userID)
	if err != nil {
		return err
	}
	if user == nil {
		return problems.Unauthenticated("", "")
	}
	if !crypto.VerifyPassword(body.CurrentPassword, user.PasswordDigest) {
		return problems.Unauthenticated("La contraseña actual no es correcta", "")
	}
	if err := assertStrongPassword(body.NewPassword, "newPassword"); err != nil {
		return err
	}

	digest, err := crypto.HashPassword(body.NewPassword)
	if err != nil {
		return err
	}
	if err := s.store.SetPassword(ctx, user.ID, digest); err != nil {
		return err
	}
	// Cambiar la contraseña cierra todas las sesiones, esta incluida: dejar la cookie sería dejar
	// al navegador con una credencial que el servidor acaba de revocar.
	if err := s.store.RevokeAllSessions(ctx, user.ID, time.Now().UTC()); err != nil {
		return err
	}
	s.clearSessionCookie(writer)
	return noContent(writer)
}

func (s *Server) organizationsOf(request *http.Request, userID string) ([]organizationView, error) {
	memberships, err := s.store.MembershipsOfUser(request.Context(), userID)
	if err != nil {
		return nil, err
	}
	views := []organizationView{}
	for _, membership := range memberships {
		organization, err := s.store.OrganizationByID(request.Context(), membership.OrganizationID)
		if err != nil {
			return nil, err
		}
		if organization != nil {
			views = append(views, organizationView{
				ID: organization.ID, Name: organization.Name, Slug: organization.Slug, Role: membership.Role,
			})
		}
	}
	return views, nil
}

func (s *Server) me(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	if who.kind != "user" {
		return problems.Unauthenticated("Un token de servicio no representa a una persona", "")
	}
	user, err := s.store.UserByID(request.Context(), who.userID)
	if err != nil {
		return err
	}
	if user == nil {
		return problems.NotFound("El usuario no existe", "user-not-found")
	}
	organizations, err := s.organizationsOf(request, user.ID)
	if err != nil {
		return err
	}
	return writeJSON(writer, http.StatusOK, currentUser{
		ID: user.ID, Email: user.Email, Name: user.Name, Organizations: organizations,
	})
}

// authContext es la misma pregunta que `/auth/me`, hecha de forma que un token de servicio pueda
// contestarla: un token pertenece a exactamente una organización, así que aquí no hay nada que
// elegir — y un token que no puede averiguar la suya es una credencial que funciona y no se usa.
func (s *Server) authContext(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	if who.kind == "api-token" {
		organization, err := s.store.OrganizationByID(request.Context(), who.organizationID)
		if err != nil {
			return err
		}
		if organization == nil {
			return problems.NotFound("La organización del token no existe", "organization-not-found")
		}
		return writeJSON(writer, http.StatusOK, authContext{
			Principal: "api-token",
			User:      nil,
			// `editor` porque es lo que el guard concede a un token de servicio: dicho en vez de
			// supuesto, para que un cliente sepa antes de intentarlo que con esto no invita a nadie.
			Organizations: []organizationView{{
				ID: organization.ID, Name: organization.Name, Slug: organization.Slug, Role: "editor",
			}},
		})
	}

	user, err := s.store.UserByID(request.Context(), who.userID)
	if err != nil {
		return err
	}
	if user == nil {
		return problems.NotFound("El usuario no existe", "user-not-found")
	}
	organizations, err := s.organizationsOf(request, user.ID)
	if err != nil {
		return err
	}
	return writeJSON(writer, http.StatusOK, authContext{
		Principal:     "user",
		User:          &personView{ID: user.ID, Email: user.Email, Name: user.Name},
		Organizations: organizations,
	})
}
