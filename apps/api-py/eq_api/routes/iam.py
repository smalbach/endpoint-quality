"""
Organizaciones, miembros, invitaciones y tokens de CI.

Toda ruta bajo `:organizationId` resuelve el rol contra la base, en esa organización. No hay
ninguna que lea un identificador de organización y se fíe: el de la URL es una pregunta, y la
membresía es la respuesta.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..crypto import generate_opaque_token, hash_opaque_token, token_preview
from ..db import iso
from ..domain import (
    INVITATION_TTL,
    normalize_email,
    slugify_organization,
    utc_now,
    would_orphan_organization,
)
from ..identity import Principal, authenticate, require_user, role_in_organization
from ..problems import ConflictError, ForbiddenError, NotFoundError
from ..repositories import at_least, new_id
from ..validation import ROLES, Rules
from .auth import StrictModel

router = APIRouter(tags=["iam"])

# El rol llega como `str` y no como `Literal` a propósito: un `Literal` lo rechazaría Pydantic con
# su propio mensaje («Input should be 'viewer', ...») y el front pinta ese texto bajo el campo. La
# comprobación va en `Rules`, con la frase del original.
class CreateOrganizationBody(StrictModel):
    name: str


class InviteMemberBody(StrictModel):
    email: str
    role: str


class ChangeRoleBody(StrictModel):
    role: str


class AcceptInvitationBody(StrictModel):
    token: str


async def create_organization(request: Request, name: str, owner_id: str) -> str:
    """Funda una organización y mete dentro a su propietario.

    La llama también el registro, y por eso es una función y no solo una ruta: una cuenta sin
    organización no puede hacer nada, así que crearla es parte de crear la cuenta y no un paso
    que el cliente tenga que acordarse de dar."""
    state = request.app.state.eq
    now = utc_now()
    base = slugify_organization(name)
    slug = base
    suffix = 2
    while await state.repositories.organizations.find_by_slug(slug):
        slug = f"{base}-{suffix}"
        suffix += 1
        if suffix >= 1000:
            slug = f"{base}-{new_id()[:8]}"
            break

    organization_id = new_id()
    await state.repositories.organizations.insert(
        {"id": organization_id, "name": name.strip(), "slug": slug, "createdAt": now}
    )
    await state.repositories.memberships.save(
        {"organizationId": organization_id, "userId": owner_id, "role": "owner", "createdAt": now}
    )
    return organization_id


@router.post("/orgs", status_code=201)
async def create(request: Request, body: CreateOrganizationBody, principal: Principal = Depends(authenticate)) -> dict:
    Rules().max_length("name", body.name, 200).check()
    organization_id = await create_organization(request, body.name, require_user(principal))
    state = request.app.state.eq
    organization = await state.repositories.organizations.find_by_id(organization_id)
    return {"organizationId": organization_id, "slug": organization["slug"] if organization else ""}


@router.post("/invitations/accept", status_code=200)
async def accept(request: Request, body: AcceptInvitationBody, principal: Principal = Depends(authenticate)) -> dict:
    Rules().max_length("token", body.token, 200).check()
    state = request.app.state.eq
    user_id = require_user(principal)
    now = utc_now()

    invitation = await state.repositories.invitations.find_by_hash(hash_opaque_token(body.token))
    if not invitation or invitation["revokedAt"] is not None or invitation["acceptedAt"] is not None:
        raise NotFoundError("La invitación no es válida", "invitation-invalid")
    if invitation["expiresAt"] <= now:
        raise NotFoundError("La invitación ha caducado", "invitation-expired")

    user = await state.repositories.users.find_by_id(user_id)
    if not user:
        raise NotFoundError("El usuario no existe", "user-not-found")
    if normalize_email(user["email"]) != invitation["email"]:
        raise ForbiddenError("Esta invitación es para otra dirección de correo", "invitation-wrong-recipient")

    organization_id = str(invitation["organizationId"])
    if not await state.repositories.memberships.find(organization_id, user_id):
        await state.repositories.memberships.save(
            {
                "organizationId": organization_id,
                "userId": user_id,
                "role": invitation["role"],
                "createdAt": now,
            }
        )
    await state.repositories.invitations.mark_accepted(str(invitation["id"]), now)
    return {"organizationId": organization_id}


@router.get("/orgs/{organization_id}/members")
async def members(request: Request, organization_id: str, principal: Principal = Depends(authenticate)) -> dict:
    await role_in_organization(request, principal, organization_id, "viewer")
    state = request.app.state.eq

    rows = await state.repositories.memberships.list_for_organization(organization_id)
    people = []
    for membership in rows:
        user = await state.repositories.users.find_by_id(str(membership["userId"]))
        if user:
            people.append(
                {
                    "userId": str(user["id"]),
                    "email": user["email"],
                    "name": user["name"],
                    "role": membership["role"],
                    "since": iso(membership["createdAt"]),
                }
            )

    # El hash del token no sale del repositorio: una invitación pendiente es una credencial viva
    # hasta que se acepta, y esta vista es lo que pinta la pantalla de miembros.
    pending = [
        {
            "id": str(invitation["id"]),
            "email": invitation["email"],
            "role": invitation["role"],
            "expiresAt": iso(invitation["expiresAt"]),
        }
        for invitation in await state.repositories.invitations.list_for_organization(organization_id)
        if invitation["acceptedAt"] is None and invitation["revokedAt"] is None
    ]
    return {"members": people, "invitations": pending}


@router.post("/orgs/{organization_id}/invitations", status_code=201)
async def invite(
    request: Request,
    organization_id: str,
    body: InviteMemberBody,
    principal: Principal = Depends(authenticate),
) -> dict:
    await role_in_organization(request, principal, organization_id, "admin")
    # Después del rol y no antes: los guards corren antes que el pipe en el original, así que
    # quien no es admin recibe 403 aunque además mande un cuerpo inválido.
    Rules().email("email", body.email).max_length("email", body.email, 320).one_of(
        "role", body.role, ROLES
    ).check()
    state = request.app.state.eq
    actor_id = require_user(principal)

    inviter = await state.repositories.memberships.find(organization_id, actor_id)
    if not inviter or not at_least(str(inviter["role"]), "admin"):
        raise ForbiddenError("No puedes invitar a esta organización")
    if not at_least(str(inviter["role"]), body.role):
        raise ForbiddenError("No puedes invitar con un rol superior al tuyo", "role-escalation")

    email = normalize_email(body.email)
    if await state.repositories.invitations.find_pending(organization_id, email):
        raise ConflictError("Esa dirección ya tiene una invitación pendiente", "invitation-pending")

    now = utc_now()
    token = generate_opaque_token()
    invitation_id = new_id()
    expires_at = now + INVITATION_TTL
    await state.repositories.invitations.insert(
        {
            "id": invitation_id,
            "organizationId": organization_id,
            "email": email,
            "role": body.role,
            "tokenHash": hash_opaque_token(token),
            "invitedBy": actor_id,
            "createdAt": now,
            "expiresAt": expires_at,
        }
    )
    # El token se devuelve una vez, como allí: es lo que permite a la pantalla enseñar el enlace
    # cuando no hay correo saliente configurado.
    return {"invitationId": invitation_id, "token": token, "expiresAt": iso(expires_at)}


@router.patch("/orgs/{organization_id}/members/{user_id}", status_code=204)
async def change_role(
    request: Request,
    organization_id: str,
    user_id: str,
    body: ChangeRoleBody,
    principal: Principal = Depends(authenticate),
) -> None:
    await role_in_organization(request, principal, organization_id, "admin")
    Rules().one_of("role", body.role, ROLES).check()
    state = request.app.state.eq
    actor_id = require_user(principal)

    actor = await state.repositories.memberships.find(organization_id, actor_id)
    if not actor or not at_least(str(actor["role"]), "admin"):
        raise ForbiddenError("No puedes gestionar miembros de esta organización")
    if actor_id == user_id:
        raise ForbiddenError("No puedes cambiar tu propio rol", "self-role-change")
    if not at_least(str(actor["role"]), body.role):
        raise ForbiddenError("No puedes otorgar un rol superior al tuyo", "role-escalation")

    target = await state.repositories.memberships.find(organization_id, user_id)
    if not target:
        raise NotFoundError("Esa persona no es miembro de la organización", "membership-not-found")
    # Un admin tampoco degrada a un propietario: la escalera tiene que valer en los dos sentidos o
    # el rango de encima del tuyo es solo una etiqueta.
    if not at_least(str(actor["role"]), str(target["role"])):
        raise ForbiddenError("No puedes modificar a alguien con un rol superior al tuyo", "role-escalation")

    everyone = await state.repositories.memberships.list_for_organization(organization_id)
    if would_orphan_organization(everyone, user_id, body.role):
        raise ConflictError("La organización quedaría sin propietario", "last-owner")

    await state.repositories.memberships.save(
        {
            "organizationId": organization_id,
            "userId": user_id,
            "role": body.role,
            "createdAt": target["createdAt"],
        }
    )


@router.delete("/orgs/{organization_id}/members/{user_id}", status_code=204)
async def remove_member(
    request: Request,
    organization_id: str,
    user_id: str,
    principal: Principal = Depends(authenticate),
) -> None:
    # `viewer` y no `admin`: salir de una organización a la que te invitaron no puede exigir el
    # permiso de gestionar a la gente que hay dentro.
    await role_in_organization(request, principal, organization_id, "viewer")
    state = request.app.state.eq
    actor_id = require_user(principal)

    actor = await state.repositories.memberships.find(organization_id, actor_id)
    if not actor:
        raise ForbiddenError("No perteneces a esta organización")
    target = await state.repositories.memberships.find(organization_id, user_id)
    if not target:
        raise NotFoundError("Esa persona no es miembro de la organización", "membership-not-found")

    leaving = actor_id == user_id
    if not leaving:
        if not at_least(str(actor["role"]), "admin"):
            raise ForbiddenError("No puedes gestionar miembros de esta organización")
        if not at_least(str(actor["role"]), str(target["role"])):
            raise ForbiddenError("No puedes expulsar a alguien con un rol superior al tuyo", "role-escalation")

    everyone = await state.repositories.memberships.list_for_organization(organization_id)
    if would_orphan_organization(everyone, user_id, None):
        raise ConflictError("La organización quedaría sin propietario", "last-owner")

    await state.repositories.memberships.remove(organization_id, user_id)


class CreateApiTokenBody(StrictModel):
    name: str


@router.get("/orgs/{organization_id}/tokens")
async def list_tokens(request: Request, organization_id: str, principal: Principal = Depends(authenticate)) -> list:
    await role_in_organization(request, principal, organization_id, "admin")
    state = request.app.state.eq
    return [
        {
            "id": str(token["id"]),
            "name": token["name"],
            "preview": token["preview"],
            "createdAt": iso(token["createdAt"]),
            "lastUsedAt": iso(token["lastUsedAt"]),
            "revokedAt": iso(token["revokedAt"]),
        }
        for token in await state.repositories.api_tokens.list_for_organization(organization_id)
    ]


@router.post("/orgs/{organization_id}/tokens", status_code=201)
async def create_token(
    request: Request,
    organization_id: str,
    body: CreateApiTokenBody,
    principal: Principal = Depends(authenticate),
) -> dict:
    await role_in_organization(request, principal, organization_id, "admin")
    Rules().max_length("name", body.name, 120).check()
    state = request.app.state.eq
    # Con prefijo para que un token filtrado sea reconocible en un registro o en un repositorio
    # público, por un escáner de secretos y por quien se lo encuentre.
    token = f"eqt_{generate_opaque_token()}"
    token_id = new_id()
    await state.repositories.api_tokens.insert(
        {
            "id": token_id,
            "organizationId": organization_id,
            "name": body.name.strip() or "Token de CI",
            "tokenHash": hash_opaque_token(token),
            "preview": token_preview(token),
            "createdBy": require_user(principal),
            "createdAt": utc_now(),
        }
    )
    return {"id": token_id, "token": token, "preview": token_preview(token)}


@router.delete("/orgs/{organization_id}/tokens/{token_id}", status_code=204)
async def revoke_token(
    request: Request,
    organization_id: str,
    token_id: str,
    principal: Principal = Depends(authenticate),
) -> None:
    await role_in_organization(request, principal, organization_id, "admin")
    state = request.app.state.eq
    token = await state.repositories.api_tokens.find_by_id(token_id)
    # La comprobación de la organización va dentro del 404 y no al lado: contestar 403 por un token
    # que es de otro confirma que ese identificador existe, que es un oráculo de pertenencia entre
    # inquilinos. Para quien llama, no existe.
    if not token or str(token["organizationId"]) != organization_id:
        raise NotFoundError("El token no existe", "api-token-not-found")
    if token["revokedAt"] is not None:
        return
    await state.repositories.api_tokens.revoke(token_id, utc_now())
