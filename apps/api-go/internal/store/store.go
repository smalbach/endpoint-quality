// Package store es SQL directo contra el esquema que mantiene `apps/api`.
//
// Sin ORM y a propósito (ver `docs/backends-poliglotas.md` §7): el esquema no es de este backend y
// este backend no puede cambiarlo, así que declarar aquí cuarenta structs para no poder migrar
// ninguna sería duplicar la definición sin ganar nada.
//
// **Este backend no emite DDL.** Las migraciones son de `apps/api` y solo de él.
//
// Los identificadores van entrecomillados en todas las consultas porque TypeORM los creó en
// `camelCase`, y en Postgres un identificador sin comillas se pliega a minúsculas: `"organizationId"`
// existe, `organizationid` no.
package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Healthy(ctx context.Context) error {
	var one int
	return s.pool.QueryRow(ctx, "SELECT 1").Scan(&one)
}

// --- usuarios -------------------------------------------------------------------------------

type User struct {
	ID                  string
	Email               string
	Name                string
	PasswordDigest      string
	Status              string
	CreatedAt           time.Time
	FailedLoginAttempts int
	LockedUntil         *time.Time
}

const userColumns = `"id"::text, "email", "name", "passwordDigest", "status", "createdAt", "failedLoginAttempts", "lockedUntil"`

func scanUser(row pgx.Row) (*User, error) {
	var user User
	err := row.Scan(&user.ID, &user.Email, &user.Name, &user.PasswordDigest, &user.Status,
		&user.CreatedAt, &user.FailedLoginAttempts, &user.LockedUntil)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM "users" WHERE "id" = $1::uuid`, id))
}

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM "users" WHERE "email" = $1`, email))
}

func (s *Store) InsertUser(ctx context.Context, user User) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "users" ("id", "email", "name", "passwordDigest", "status", "createdAt", "failedLoginAttempts", "lockedUntil")
		 VALUES ($1::uuid, $2, $3, $4, $5, $6, 0, NULL)`,
		user.ID, user.Email, user.Name, user.PasswordDigest, user.Status, user.CreatedAt)
	return err
}

func (s *Store) SetPassword(ctx context.Context, userID, digest string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "users" SET "passwordDigest" = $2, "failedLoginAttempts" = 0, "lockedUntil" = NULL WHERE "id" = $1::uuid`,
		userID, digest)
	return err
}

func (s *Store) SetLoginFailures(ctx context.Context, userID string, attempts int, lockedUntil *time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "users" SET "failedLoginAttempts" = $2, "lockedUntil" = $3 WHERE "id" = $1::uuid`,
		userID, attempts, lockedUntil)
	return err
}

// --- sesiones -------------------------------------------------------------------------------

type RefreshToken struct {
	ID        string
	UserID    string
	SessionID string
	ExpiresAt time.Time
	UsedAt    *time.Time
	RevokedAt *time.Time
}

func (s *Store) RefreshTokenByHash(ctx context.Context, hash string) (*RefreshToken, error) {
	var token RefreshToken
	err := s.pool.QueryRow(ctx,
		`SELECT "id"::text, "userId"::text, "sessionId"::text, "expiresAt", "usedAt", "revokedAt"
		 FROM "refresh_tokens" WHERE "tokenHash" = $1`, hash).
		Scan(&token.ID, &token.UserID, &token.SessionID, &token.ExpiresAt, &token.UsedAt, &token.RevokedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &token, nil
}

func (s *Store) InsertRefreshToken(ctx context.Context, id, userID, sessionID, hash string, expiresAt, createdAt time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "refresh_tokens" ("id", "userId", "sessionId", "tokenHash", "expiresAt", "createdAt", "usedAt", "revokedAt", "replacedByHash")
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL, NULL, NULL)`,
		id, userID, sessionID, hash, expiresAt, createdAt)
	return err
}

func (s *Store) MarkRefreshTokenUsed(ctx context.Context, id string, at time.Time, replacedByHash string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "refresh_tokens" SET "usedAt" = $2, "replacedByHash" = $3 WHERE "id" = $1::uuid`, id, at, replacedByHash)
	return err
}

// RevokeSession cierra la cadena entera en una sentencia: hacerlo fila a fila deja una ventana en
// la que quien robó el token refresca otra vez.
func (s *Store) RevokeSession(ctx context.Context, sessionID string, at time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "refresh_tokens" SET "revokedAt" = $2 WHERE "sessionId" = $1::uuid AND "revokedAt" IS NULL`, sessionID, at)
	return err
}

func (s *Store) RevokeAllSessions(ctx context.Context, userID string, at time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "refresh_tokens" SET "revokedAt" = $2 WHERE "userId" = $1::uuid AND "revokedAt" IS NULL`, userID, at)
	return err
}

type PasswordReset struct {
	ID        string
	UserID    string
	ExpiresAt time.Time
	UsedAt    *time.Time
}

func (s *Store) InsertPasswordReset(ctx context.Context, id, userID, hash string, createdAt, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "password_reset_tokens" ("id", "userId", "tokenHash", "createdAt", "expiresAt", "usedAt")
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL)`, id, userID, hash, createdAt, expiresAt)
	return err
}

func (s *Store) PasswordResetByHash(ctx context.Context, hash string) (*PasswordReset, error) {
	var reset PasswordReset
	err := s.pool.QueryRow(ctx,
		`SELECT "id"::text, "userId"::text, "expiresAt", "usedAt" FROM "password_reset_tokens" WHERE "tokenHash" = $1`, hash).
		Scan(&reset.ID, &reset.UserID, &reset.ExpiresAt, &reset.UsedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &reset, nil
}

func (s *Store) SpendPasswordResets(ctx context.Context, userID string, at time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "password_reset_tokens" SET "usedAt" = $2 WHERE "userId" = $1::uuid AND "usedAt" IS NULL`, userID, at)
	return err
}

// --- tokens de servicio ----------------------------------------------------------------------

type APIToken struct {
	ID             string
	OrganizationID string
	Name           string
	Preview        string
	CreatedAt      time.Time
	LastUsedAt     *time.Time
	RevokedAt      *time.Time
}

const apiTokenColumns = `"id"::text, "organizationId"::text, "name", "preview", "createdAt", "lastUsedAt", "revokedAt"`

func scanAPIToken(row pgx.Row) (*APIToken, error) {
	var token APIToken
	err := row.Scan(&token.ID, &token.OrganizationID, &token.Name, &token.Preview,
		&token.CreatedAt, &token.LastUsedAt, &token.RevokedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &token, nil
}

func (s *Store) APITokenByHash(ctx context.Context, hash string) (*APIToken, error) {
	return scanAPIToken(s.pool.QueryRow(ctx, `SELECT `+apiTokenColumns+` FROM "api_tokens" WHERE "tokenHash" = $1`, hash))
}

func (s *Store) APITokenByID(ctx context.Context, id string) (*APIToken, error) {
	return scanAPIToken(s.pool.QueryRow(ctx, `SELECT `+apiTokenColumns+` FROM "api_tokens" WHERE "id" = $1::uuid`, id))
}

func (s *Store) APITokens(ctx context.Context, organizationID string) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+apiTokenColumns+` FROM "api_tokens" WHERE "organizationId" = $1::uuid ORDER BY "createdAt" DESC`,
		organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tokens := []APIToken{}
	for rows.Next() {
		var token APIToken
		if err := rows.Scan(&token.ID, &token.OrganizationID, &token.Name, &token.Preview,
			&token.CreatedAt, &token.LastUsedAt, &token.RevokedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, token)
	}
	return tokens, rows.Err()
}

func (s *Store) InsertAPIToken(ctx context.Context, token APIToken, hash, createdBy string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "api_tokens" ("id", "organizationId", "name", "tokenHash", "preview", "createdBy", "createdAt", "lastUsedAt", "revokedAt")
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, NULL, NULL)`,
		token.ID, token.OrganizationID, token.Name, hash, token.Preview, createdBy, token.CreatedAt)
	return err
}

func (s *Store) TouchAPIToken(ctx context.Context, id string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE "api_tokens" SET "lastUsedAt" = $2 WHERE "id" = $1::uuid`, id, at)
	return err
}

func (s *Store) RevokeAPIToken(ctx context.Context, id string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE "api_tokens" SET "revokedAt" = $2 WHERE "id" = $1::uuid`, id, at)
	return err
}

// --- organizaciones --------------------------------------------------------------------------

type Organization struct {
	ID        string
	Name      string
	Slug      string
	CreatedAt time.Time
}

func (s *Store) OrganizationByID(ctx context.Context, id string) (*Organization, error) {
	var organization Organization
	err := s.pool.QueryRow(ctx,
		`SELECT "id"::text, "name", "slug", "createdAt" FROM "organizations" WHERE "id" = $1::uuid`, id).
		Scan(&organization.ID, &organization.Name, &organization.Slug, &organization.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &organization, nil
}

func (s *Store) OrganizationSlugTaken(ctx context.Context, slug string) (bool, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM "organizations" WHERE "slug" = $1`, slug).Scan(&count)
	return count > 0, err
}

func (s *Store) InsertOrganization(ctx context.Context, organization Organization) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "organizations" ("id", "name", "slug", "createdAt") VALUES ($1::uuid, $2, $3, $4)`,
		organization.ID, organization.Name, organization.Slug, organization.CreatedAt)
	return err
}

type Membership struct {
	OrganizationID string
	UserID         string
	Role           string
	CreatedAt      time.Time
}

func (s *Store) Membership(ctx context.Context, organizationID, userID string) (*Membership, error) {
	var membership Membership
	err := s.pool.QueryRow(ctx,
		`SELECT "organizationId"::text, "userId"::text, "role", "createdAt" FROM "memberships"
		 WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid`, organizationID, userID).
		Scan(&membership.OrganizationID, &membership.UserID, &membership.Role, &membership.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &membership, nil
}

func (s *Store) membershipsWhere(ctx context.Context, where string, argument string) ([]Membership, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT "organizationId"::text, "userId"::text, "role", "createdAt" FROM "memberships"
		 WHERE `+where+` ORDER BY "createdAt" ASC`, argument)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	memberships := []Membership{}
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(&membership.OrganizationID, &membership.UserID, &membership.Role, &membership.CreatedAt); err != nil {
			return nil, err
		}
		memberships = append(memberships, membership)
	}
	return memberships, rows.Err()
}

func (s *Store) MembershipsOfUser(ctx context.Context, userID string) ([]Membership, error) {
	return s.membershipsWhere(ctx, `"userId" = $1::uuid`, userID)
}

func (s *Store) MembershipsOfOrganization(ctx context.Context, organizationID string) ([]Membership, error) {
	return s.membershipsWhere(ctx, `"organizationId" = $1::uuid`, organizationID)
}

func (s *Store) SaveMembership(ctx context.Context, membership Membership) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "memberships" ("organizationId", "userId", "role", "createdAt") VALUES ($1::uuid, $2::uuid, $3, $4)
		 ON CONFLICT ("organizationId", "userId") DO UPDATE SET "role" = EXCLUDED."role"`,
		membership.OrganizationID, membership.UserID, membership.Role, membership.CreatedAt)
	return err
}

func (s *Store) RemoveMembership(ctx context.Context, organizationID, userID string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM "memberships" WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid`, organizationID, userID)
	return err
}

type Invitation struct {
	ID             string
	OrganizationID string
	Email          string
	Role           string
	CreatedAt      time.Time
	ExpiresAt      time.Time
	AcceptedAt     *time.Time
	RevokedAt      *time.Time
}

const invitationColumns = `"id"::text, "organizationId"::text, "email", "role", "createdAt", "expiresAt", "acceptedAt", "revokedAt"`

func scanInvitation(row pgx.Row) (*Invitation, error) {
	var invitation Invitation
	err := row.Scan(&invitation.ID, &invitation.OrganizationID, &invitation.Email, &invitation.Role,
		&invitation.CreatedAt, &invitation.ExpiresAt, &invitation.AcceptedAt, &invitation.RevokedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &invitation, nil
}

func (s *Store) PendingInvitation(ctx context.Context, organizationID, email string) (*Invitation, error) {
	return scanInvitation(s.pool.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM "invitations"
		 WHERE "organizationId" = $1::uuid AND "email" = $2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
		organizationID, email))
}

func (s *Store) InvitationByHash(ctx context.Context, hash string) (*Invitation, error) {
	return scanInvitation(s.pool.QueryRow(ctx, `SELECT `+invitationColumns+` FROM "invitations" WHERE "tokenHash" = $1`, hash))
}

func (s *Store) Invitations(ctx context.Context, organizationID string) ([]Invitation, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+invitationColumns+` FROM "invitations" WHERE "organizationId" = $1::uuid ORDER BY "createdAt" DESC`,
		organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invitations := []Invitation{}
	for rows.Next() {
		var invitation Invitation
		if err := rows.Scan(&invitation.ID, &invitation.OrganizationID, &invitation.Email, &invitation.Role,
			&invitation.CreatedAt, &invitation.ExpiresAt, &invitation.AcceptedAt, &invitation.RevokedAt); err != nil {
			return nil, err
		}
		invitations = append(invitations, invitation)
	}
	return invitations, rows.Err()
}

func (s *Store) InsertInvitation(ctx context.Context, invitation Invitation, hash, invitedBy string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "invitations" ("id", "organizationId", "email", "role", "tokenHash", "invitedBy", "createdAt", "expiresAt", "acceptedAt", "revokedAt")
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, NULL, NULL)`,
		invitation.ID, invitation.OrganizationID, invitation.Email, invitation.Role, hash, invitedBy,
		invitation.CreatedAt, invitation.ExpiresAt)
	return err
}

func (s *Store) AcceptInvitation(ctx context.Context, id string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE "invitations" SET "acceptedAt" = $2 WHERE "id" = $1::uuid`, id, at)
	return err
}

// --- proyectos -------------------------------------------------------------------------------

type Project struct {
	ID                  string
	OrganizationID      string
	Name                string
	Slug                string
	Description         string
	CreatedAt           time.Time
	ArchivedAt          *time.Time
	ActiveSpecVersionID *string
	ActiveEnvironmentID *string
	BaseURL             string
	Tags                []string
	AuthType            string
	AuthSettings        map[string]any
}

const projectColumns = `"id"::text, "organizationId"::text, "name", "slug", "description", "createdAt", "archivedAt",
	"activeSpecVersionId"::text, "activeEnvironmentId"::text, "baseUrl", "tags", "authType", "authSettings"`

func scanProject(row pgx.Row) (*Project, error) {
	var project Project
	err := row.Scan(&project.ID, &project.OrganizationID, &project.Name, &project.Slug, &project.Description,
		&project.CreatedAt, &project.ArchivedAt, &project.ActiveSpecVersionID, &project.ActiveEnvironmentID,
		&project.BaseURL, &project.Tags, &project.AuthType, &project.AuthSettings)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &project, nil
}

// ProjectByID solo devuelve lo no borrado: el repositorio de TypeORM aplica ese filtro en
// silencio, y una fila borrada que aquí siguiera apareciendo sería una diferencia visible.
func (s *Store) ProjectByID(ctx context.Context, id string) (*Project, error) {
	return scanProject(s.pool.QueryRow(ctx,
		`SELECT `+projectColumns+` FROM "projects" WHERE "id" = $1::uuid AND "deletedAt" IS NULL`, id))
}

func (s *Store) ProjectSlugTaken(ctx context.Context, organizationID, slug string) (bool, error) {
	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM "projects" WHERE "organizationId" = $1::uuid AND "slug" = $2 AND "deletedAt" IS NULL`,
		organizationID, slug).Scan(&count)
	return count > 0, err
}

func (s *Store) Projects(ctx context.Context, organizationID string, includeArchived bool) ([]Project, error) {
	query := `SELECT ` + projectColumns + ` FROM "projects" WHERE "organizationId" = $1::uuid AND "deletedAt" IS NULL`
	if !includeArchived {
		query += ` AND "archivedAt" IS NULL`
	}
	rows, err := s.pool.Query(ctx, query+` ORDER BY "createdAt" DESC`, organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := []Project{}
	for rows.Next() {
		var project Project
		if err := rows.Scan(&project.ID, &project.OrganizationID, &project.Name, &project.Slug, &project.Description,
			&project.CreatedAt, &project.ArchivedAt, &project.ActiveSpecVersionID, &project.ActiveEnvironmentID,
			&project.BaseURL, &project.Tags, &project.AuthType, &project.AuthSettings); err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	return projects, rows.Err()
}

func (s *Store) InsertProject(ctx context.Context, project Project, createdBy string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "projects" ("id", "organizationId", "name", "slug", "description", "createdBy", "createdAt",
			"archivedAt", "activeSpecVersionId", "activeEnvironmentId", "baseUrl", "tags", "authType", "authSettings",
			"authSecretCiphertext", "deletedAt")
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, NULL, NULL, NULL, $8, $9, 'none', '{}'::jsonb, NULL, NULL)`,
		project.ID, project.OrganizationID, project.Name, project.Slug, project.Description, createdBy,
		project.CreatedAt, project.BaseURL, project.Tags)
	return err
}

func (s *Store) UpdateProject(ctx context.Context, id, name, description, baseURL string, tags []string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "projects" SET "name" = $2, "description" = $3, "baseUrl" = $4, "tags" = $5 WHERE "id" = $1::uuid`,
		id, name, description, baseURL, tags)
	return err
}

func (s *Store) SetProjectArchived(ctx context.Context, id string, at *time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE "projects" SET "archivedAt" = $2 WHERE "id" = $1::uuid`, id, at)
	return err
}

// SoftDeleteProject marca la fila: un proyecto es dueño de corridas, y una corrida es la prueba de
// algo que alguien midió un día.
func (s *Store) SoftDeleteProject(ctx context.Context, id string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE "projects" SET "deletedAt" = $2 WHERE "id" = $1::uuid`, id, at)
	return err
}

// --- lo que la tarjeta de un proyecto necesita y no está en su fila ---------------------------

type SpecVersion struct {
	ID              string
	Title           string
	ContractVersion string
	OperationCount  int
	ImportedAt      time.Time
}

func (s *Store) SpecVersion(ctx context.Context, id string) (*SpecVersion, error) {
	var version SpecVersion
	err := s.pool.QueryRow(ctx,
		`SELECT "id"::text, "title", "contractVersion", "operationCount", "importedAt" FROM "spec_versions" WHERE "id" = $1::uuid`, id).
		Scan(&version.ID, &version.Title, &version.ContractVersion, &version.OperationCount, &version.ImportedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &version, nil
}

type SpecSource struct {
	Kind          string
	Location      string
	HeadersStored bool
}

func (s *Store) LatestSpecSource(ctx context.Context, projectID string) (*SpecSource, error) {
	var source SpecSource
	var ciphertext *string
	err := s.pool.QueryRow(ctx,
		`SELECT "kind", "location", "headersCiphertext" FROM "spec_sources" WHERE "projectId" = $1::uuid
		 ORDER BY "createdAt" DESC LIMIT 1`, projectID).Scan(&source.Kind, &source.Location, &ciphertext)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	source.HeadersStored = ciphertext != nil
	return &source, nil
}

type Run struct {
	ID         string
	Status     string
	StartedAt  time.Time
	FinishedAt *time.Time
	Totals     any
}

func (s *Store) LastRun(ctx context.Context, projectID string) (*Run, error) {
	var run Run
	err := s.pool.QueryRow(ctx,
		`SELECT "id"::text, "status", "startedAt", "finishedAt", "totals" FROM "runs" WHERE "projectId" = $1::uuid
		 ORDER BY "startedAt" DESC LIMIT 1`, projectID).
		Scan(&run.ID, &run.Status, &run.StartedAt, &run.FinishedAt, &run.Totals)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

type Fork struct {
	ParentProjectID string
	CreatedAt       time.Time
	SyncedAt        time.Time
	Version         int
}

func (s *Store) Fork(ctx context.Context, projectID string) (*Fork, error) {
	var fork Fork
	err := s.pool.QueryRow(ctx,
		`SELECT "parentProjectId"::text, "createdAt", "syncedAt", "version" FROM "project_forks" WHERE "forkProjectId" = $1::uuid`,
		projectID).Scan(&fork.ParentProjectID, &fork.CreatedAt, &fork.SyncedAt, &fork.Version)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &fork, nil
}
