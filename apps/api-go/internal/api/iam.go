package api

// Organizaciones, miembros, invitaciones y tokens de CI.
//
// Toda ruta bajo `{organizationId}` resuelve el rol contra la base, en esa organización. No hay
// ninguna que lea un identificador de organización y se fíe: el de la URL es una pregunta, y la
// membresía es la respuesta.

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/crypto"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/domain"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/store"
)

type createOrganizationBody struct {
	Name string `json:"name"`
}

type inviteMemberBody struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

type changeRoleBody struct {
	Role string `json:"role"`
}

type acceptInvitationBody struct {
	Token string `json:"token"`
}

type createAPITokenBody struct {
	Name string `json:"name"`
}

type organizationCreated struct {
	OrganizationID string `json:"organizationId"`
	Slug           string `json:"slug"`
}

type memberView struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Since  string `json:"since"`
}

type pendingInvitation struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	ExpiresAt string `json:"expiresAt"`
}

type membersView struct {
	Members     []memberView        `json:"members"`
	Invitations []pendingInvitation `json:"invitations"`
}

type invitationCreated struct {
	InvitationID string `json:"invitationId"`
	Token        string `json:"token"`
	ExpiresAt    string `json:"expiresAt"`
}

type apiTokenView struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Preview    string  `json:"preview"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
}

type apiTokenCreated struct {
	ID      string `json:"id"`
	Token   string `json:"token"`
	Preview string `json:"preview"`
}

// foundOrganization funda una organización y mete dentro a su propietario. La llama también el
// registro: una cuenta sin organización no puede hacer nada, así que crearla es parte de crear la
// cuenta y no un paso que el cliente tenga que acordarse de dar.
func (s *Server) foundOrganization(request *http.Request, name, ownerID string) (string, string, error) {
	ctx := request.Context()
	base := domain.SlugifyOrganization(name)
	slug := base
	for suffix := 2; suffix < 1000; suffix++ {
		taken, err := s.store.OrganizationSlugTaken(ctx, slug)
		if err != nil {
			return "", "", err
		}
		if !taken {
			break
		}
		slug = fmt.Sprintf("%s-%d", base, suffix)
	}

	now := time.Now().UTC()
	organization := store.Organization{ID: newID(), Name: strings.TrimSpace(name), Slug: slug, CreatedAt: now}
	if err := s.store.InsertOrganization(ctx, organization); err != nil {
		return "", "", err
	}
	if err := s.store.SaveMembership(ctx, store.Membership{
		OrganizationID: organization.ID, UserID: ownerID, Role: "owner", CreatedAt: now,
	}); err != nil {
		return "", "", err
	}
	return organization.ID, slug, nil
}

func (s *Server) createOrganization(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	userID, err := requireUser(who)
	if err != nil {
		return err
	}
	var body createOrganizationBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).maxLength("name", body.Name, 200).check(); err != nil {
		return err
	}
	organizationID, slug, err := s.foundOrganization(request, body.Name, userID)
	if err != nil {
		return err
	}
	return writeJSON(writer, http.StatusCreated, organizationCreated{OrganizationID: organizationID, Slug: slug})
}

func (s *Server) acceptInvitation(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	userID, err := requireUser(who)
	if err != nil {
		return err
	}
	var body acceptInvitationBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).maxLength("token", body.Token, 200).check(); err != nil {
		return err
	}

	ctx := request.Context()
	now := time.Now().UTC()
	invitation, err := s.store.InvitationByHash(ctx, crypto.HashOpaqueToken(body.Token))
	if err != nil {
		return err
	}
	if invitation == nil || invitation.RevokedAt != nil || invitation.AcceptedAt != nil {
		return problems.NotFound("La invitación no es válida", "invitation-invalid")
	}
	if !invitation.ExpiresAt.After(now) {
		return problems.NotFound("La invitación ha caducado", "invitation-expired")
	}
	user, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return err
	}
	if user == nil {
		return problems.NotFound("El usuario no existe", "user-not-found")
	}
	if domain.NormalizeEmail(user.Email) != invitation.Email {
		return problems.Forbidden("Esta invitación es para otra dirección de correo", "invitation-wrong-recipient")
	}

	existing, err := s.store.Membership(ctx, invitation.OrganizationID, userID)
	if err != nil {
		return err
	}
	if existing == nil {
		if err := s.store.SaveMembership(ctx, store.Membership{
			OrganizationID: invitation.OrganizationID, UserID: userID, Role: invitation.Role, CreatedAt: now,
		}); err != nil {
			return err
		}
	}
	if err := s.store.AcceptInvitation(ctx, invitation.ID, now); err != nil {
		return err
	}
	return writeJSON(writer, http.StatusOK, map[string]string{"organizationId": invitation.OrganizationID})
}

func (s *Server) members(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "viewer"); err != nil {
		return err
	}

	ctx := request.Context()
	memberships, err := s.store.MembershipsOfOrganization(ctx, organizationID)
	if err != nil {
		return err
	}
	people := []memberView{}
	for _, membership := range memberships {
		user, err := s.store.UserByID(ctx, membership.UserID)
		if err != nil {
			return err
		}
		if user != nil {
			people = append(people, memberView{
				UserID: user.ID, Email: user.Email, Name: user.Name,
				Role: membership.Role, Since: iso(membership.CreatedAt),
			})
		}
	}

	invitations, err := s.store.Invitations(ctx, organizationID)
	if err != nil {
		return err
	}
	// El hash del token no sale del repositorio: una invitación pendiente es una credencial viva
	// hasta que se acepta, y esta vista es lo que pinta la pantalla de miembros.
	pending := []pendingInvitation{}
	for _, invitation := range invitations {
		if invitation.AcceptedAt == nil && invitation.RevokedAt == nil {
			pending = append(pending, pendingInvitation{
				ID: invitation.ID, Email: invitation.Email, Role: invitation.Role,
				ExpiresAt: iso(invitation.ExpiresAt),
			})
		}
	}
	return writeJSON(writer, http.StatusOK, membersView{Members: people, Invitations: pending})
}

func (s *Server) invite(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	userID, err := requireUser(who)
	if err != nil {
		return err
	}
	var body inviteMemberBody
	if err := decode(request, &body); err != nil {
		return err
	}
	// Después del rol y no antes: los guards corren antes que el pipe en el original, así que
	// quien no es admin recibe 403 aunque además mande un cuerpo inválido.
	if err := (rules{}).email("email", body.Email).maxLength("email", body.Email, 320).
		oneOf("role", body.Role, domain.Roles).check(); err != nil {
		return err
	}

	ctx := request.Context()
	inviter, err := s.store.Membership(ctx, organizationID, userID)
	if err != nil {
		return err
	}
	if inviter == nil || !domain.AtLeast(inviter.Role, "admin") {
		return problems.Forbidden("No puedes invitar a esta organización", "")
	}
	if !domain.AtLeast(inviter.Role, body.Role) {
		return problems.Forbidden("No puedes invitar con un rol superior al tuyo", "role-escalation")
	}

	email := domain.NormalizeEmail(body.Email)
	existing, err := s.store.PendingInvitation(ctx, organizationID, email)
	if err != nil {
		return err
	}
	if existing != nil {
		return problems.Conflict("Esa dirección ya tiene una invitación pendiente", "invitation-pending")
	}

	token, err := crypto.GenerateOpaqueToken()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	invitation := store.Invitation{
		ID: newID(), OrganizationID: organizationID, Email: email, Role: body.Role,
		CreatedAt: now, ExpiresAt: now.Add(domain.InvitationTTL),
	}
	if err := s.store.InsertInvitation(ctx, invitation, crypto.HashOpaqueToken(token), userID); err != nil {
		return err
	}
	// El token se devuelve una vez: es lo que permite a la pantalla enseñar el enlace cuando no hay
	// correo saliente configurado.
	return writeJSON(writer, http.StatusCreated, invitationCreated{
		InvitationID: invitation.ID, Token: token, ExpiresAt: iso(invitation.ExpiresAt),
	})
}

func (s *Server) changeRole(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	targetID := request.PathValue("userId")
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	actorID, err := requireUser(who)
	if err != nil {
		return err
	}
	var body changeRoleBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).oneOf("role", body.Role, domain.Roles).check(); err != nil {
		return err
	}

	ctx := request.Context()
	actor, err := s.store.Membership(ctx, organizationID, actorID)
	if err != nil {
		return err
	}
	if actor == nil || !domain.AtLeast(actor.Role, "admin") {
		return problems.Forbidden("No puedes gestionar miembros de esta organización", "")
	}
	if actorID == targetID {
		return problems.Forbidden("No puedes cambiar tu propio rol", "self-role-change")
	}
	if !domain.AtLeast(actor.Role, body.Role) {
		return problems.Forbidden("No puedes otorgar un rol superior al tuyo", "role-escalation")
	}
	target, err := s.store.Membership(ctx, organizationID, targetID)
	if err != nil {
		return err
	}
	if target == nil {
		return problems.NotFound("Esa persona no es miembro de la organización", "membership-not-found")
	}
	// Un admin tampoco degrada a un propietario: la escalera tiene que valer en los dos sentidos o
	// el rango de encima del tuyo es solo una etiqueta.
	if !domain.AtLeast(actor.Role, target.Role) {
		return problems.Forbidden("No puedes modificar a alguien con un rol superior al tuyo", "role-escalation")
	}
	roles, err := s.rolesOf(request, organizationID)
	if err != nil {
		return err
	}
	if domain.WouldOrphanOrganization(roles, targetID, body.Role) {
		return problems.Conflict("La organización quedaría sin propietario", "last-owner")
	}

	if err := s.store.SaveMembership(ctx, store.Membership{
		OrganizationID: organizationID, UserID: targetID, Role: body.Role, CreatedAt: target.CreatedAt,
	}); err != nil {
		return err
	}
	return noContent(writer)
}

func (s *Server) removeMember(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	targetID := request.PathValue("userId")
	// `viewer` y no `admin`: salir de una organización a la que te invitaron no puede exigir el
	// permiso de gestionar a la gente que hay dentro.
	if _, err := s.roleIn(request, who, organizationID, "viewer"); err != nil {
		return err
	}
	actorID, err := requireUser(who)
	if err != nil {
		return err
	}

	ctx := request.Context()
	actor, err := s.store.Membership(ctx, organizationID, actorID)
	if err != nil {
		return err
	}
	if actor == nil {
		return problems.Forbidden("No perteneces a esta organización", "")
	}
	target, err := s.store.Membership(ctx, organizationID, targetID)
	if err != nil {
		return err
	}
	if target == nil {
		return problems.NotFound("Esa persona no es miembro de la organización", "membership-not-found")
	}
	if actorID != targetID {
		if !domain.AtLeast(actor.Role, "admin") {
			return problems.Forbidden("No puedes gestionar miembros de esta organización", "")
		}
		if !domain.AtLeast(actor.Role, target.Role) {
			return problems.Forbidden("No puedes expulsar a alguien con un rol superior al tuyo", "role-escalation")
		}
	}
	roles, err := s.rolesOf(request, organizationID)
	if err != nil {
		return err
	}
	if domain.WouldOrphanOrganization(roles, targetID, "") {
		return problems.Conflict("La organización quedaría sin propietario", "last-owner")
	}

	if err := s.store.RemoveMembership(ctx, organizationID, targetID); err != nil {
		return err
	}
	return noContent(writer)
}

func (s *Server) rolesOf(request *http.Request, organizationID string) (map[string]string, error) {
	memberships, err := s.store.MembershipsOfOrganization(request.Context(), organizationID)
	if err != nil {
		return nil, err
	}
	roles := map[string]string{}
	for _, membership := range memberships {
		roles[membership.UserID] = membership.Role
	}
	return roles, nil
}

func (s *Server) listAPITokens(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	tokens, err := s.store.APITokens(request.Context(), organizationID)
	if err != nil {
		return err
	}
	views := []apiTokenView{}
	for _, token := range tokens {
		views = append(views, apiTokenView{
			ID: token.ID, Name: token.Name, Preview: token.Preview, CreatedAt: iso(token.CreatedAt),
			LastUsedAt: isoPointer(token.LastUsedAt), RevokedAt: isoPointer(token.RevokedAt),
		})
	}
	return writeJSON(writer, http.StatusOK, views)
}

func (s *Server) createAPIToken(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	userID, err := requireUser(who)
	if err != nil {
		return err
	}
	var body createAPITokenBody
	if err := decode(request, &body); err != nil {
		return err
	}
	if err := (rules{}).maxLength("name", body.Name, 120).check(); err != nil {
		return err
	}

	// Con prefijo para que un token filtrado sea reconocible en un registro o en un repositorio
	// público, por un escáner de secretos y por quien se lo encuentre.
	opaque, err := crypto.GenerateOpaqueToken()
	if err != nil {
		return err
	}
	token := "eqt_" + opaque
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "Token de CI"
	}
	stored := store.APIToken{
		ID: newID(), OrganizationID: organizationID, Name: name,
		Preview: crypto.TokenPreview(token), CreatedAt: time.Now().UTC(),
	}
	if err := s.store.InsertAPIToken(request.Context(), stored, crypto.HashOpaqueToken(token), userID); err != nil {
		return err
	}
	return writeJSON(writer, http.StatusCreated, apiTokenCreated{
		ID: stored.ID, Token: token, Preview: stored.Preview,
	})
}

func (s *Server) revokeAPIToken(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	token, err := s.store.APITokenByID(request.Context(), request.PathValue("tokenId"))
	if err != nil {
		return err
	}
	// La comprobación de la organización va dentro del 404 y no al lado: contestar 403 por un
	// token que es de otro confirma que ese identificador existe, que es un oráculo de pertenencia
	// entre inquilinos. Para quien llama, no existe.
	if token == nil || token.OrganizationID != organizationID {
		return problems.NotFound("El token no existe", "api-token-not-found")
	}
	if token.RevokedAt != nil {
		return noContent(writer)
	}
	if err := s.store.RevokeAPIToken(request.Context(), token.ID, time.Now().UTC()); err != nil {
		return err
	}
	return noContent(writer)
}
