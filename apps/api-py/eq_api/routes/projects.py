"""
Proyectos: el CRUD, con la misma tarjeta que pinta la lista del front.

Toda ruta cuelga de `/orgs/{organizationId}/`, así que el límite entre inquilinos lo pone el mismo
rol de siempre sobre un valor que está en la URL. El identificador del proyecto se comprueba
**otra vez** dentro, contra esa organización: el rol prueba que perteneces a la *organización*, y
solo la comprobación de dentro prueba que el *proyecto* también es de ella.

Roles, como en el original: `viewer` lee, `editor` crea y edita, `admin` archiva y borra.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from ..db import iso
from ..domain import base_url_problems, normalize_tags, slugify_project, utc_now, view_project_auth
from ..identity import Principal, authenticate, role_in_organization
from ..problems import ConflictError, InvalidInputError, NotFoundError
from ..repositories import new_id
from ..validation import Rules
from .auth import StrictModel

router = APIRouter(prefix="/orgs/{organization_id}/projects", tags=["projects"])


class CreateProjectBody(StrictModel):
    name: str
    description: str | None = None
    baseUrl: str | None = None
    tags: list[str] | None = Field(default=None, max_length=30)


class UpdateProjectBody(StrictModel):
    name: str | None = None
    description: str | None = None
    baseUrl: str | None = None
    tags: list[str] | None = Field(default=None, max_length=30)


class ArchiveProjectBody(StrictModel):
    archived: bool


def actor_id(principal: Principal) -> str:
    """Quien actúa. Un token de CI es un importador legítimo —así es como una tubería mantiene
    fresco el contrato— y por eso esto no exige una sesión de persona."""
    return principal.user_id or principal.token_id or ""


async def summarize(request: Request, project: dict) -> dict:
    """La tarjeta de un proyecto: lo suyo, más lo que solo se sabe mirando alrededor.

    `contract: null` es un estado real y la interfaz lo pinta: un proyecto existe antes de su
    primera importación, porque importar puede fallar y perder el proyecto con ello no ayuda."""
    read = request.app.state.eq.repositories.project_read
    projects = request.app.state.eq.repositories.projects

    last_run = await read.last_run(str(project["id"]))
    active = await read.active_spec_version(str(project["activeSpecVersionId"]) if project["activeSpecVersionId"] else None)
    source = await read.latest_source(str(project["id"]))
    fork = await read.fork(str(project["id"]))
    parent = await projects.find_by_id(str(fork["parentProjectId"])) if fork else None

    return {
        "id": str(project["id"]),
        "name": project["name"],
        "slug": project["slug"],
        "description": project["description"],
        "archivedAt": iso(project["archivedAt"]),
        "baseUrl": project["baseUrl"],
        "activeEnvironmentId": str(project["activeEnvironmentId"]) if project["activeEnvironmentId"] else None,
        "tags": project["tags"],
        "auth": view_project_auth(project["authType"], project["authSettings"] or {}),
        "lastRun": (
            {
                "id": str(last_run["id"]),
                "status": last_run["status"],
                "startedAt": iso(last_run["startedAt"]),
                "finishedAt": iso(last_run["finishedAt"]),
                "totals": last_run["totals"],
            }
            if last_run
            else None
        ),
        "contract": (
            {
                "versionId": str(active["id"]),
                "title": active["title"],
                "version": active["contractVersion"],
                "operationCount": active["operationCount"],
                "importedAt": iso(active["importedAt"]),
            }
            if active
            else None
        ),
        "source": (
            {
                "kind": source["kind"],
                "location": source["location"],
                "headersStored": source["headersCiphertext"] is not None,
            }
            if source
            else None
        ),
        "fork": (
            {
                "parentProjectId": str(fork["parentProjectId"]),
                # El nombre del original solo si sigue estando y es de esta organización: uno
                # borrado no se nombra.
                "parentName": (
                    parent["name"]
                    if parent and str(parent["organizationId"]) == str(project["organizationId"])
                    else None
                ),
                "forkedAt": iso(fork["createdAt"]),
                "syncedAt": iso(fork["syncedAt"]),
                "version": fork["version"],
            }
            if fork
            else None
        ),
    }


async def owned_project(request: Request, organization_id: str, project_id: str) -> dict:
    project = await request.app.state.eq.repositories.projects.find_by_id(project_id)
    if not project or str(project["organizationId"]) != organization_id:
        raise NotFoundError("El proyecto no existe", "project-not-found")
    return project


@router.get("")
async def list_projects(
    request: Request,
    organization_id: str,
    includeArchived: str | None = None,  # noqa: N803 — el nombre del parámetro es parte del contrato
    principal: Principal = Depends(authenticate),
) -> list:
    await role_in_organization(request, principal, organization_id, "viewer")
    projects = await request.app.state.eq.repositories.projects.list_for_organization(
        organization_id, includeArchived == "true"
    )
    return [await summarize(request, project) for project in projects]


@router.post("", status_code=201)
async def create_project(
    request: Request,
    organization_id: str,
    body: CreateProjectBody,
    principal: Principal = Depends(authenticate),
) -> dict:
    await role_in_organization(request, principal, organization_id, "editor")
    Rules().max_length("name", body.name, 200).max_length("description", body.description, 2000).max_length(
        "baseUrl", body.baseUrl, 2000
    ).check()
    state = request.app.state.eq

    problems = base_url_problems(body.baseUrl)
    if problems:
        raise InvalidInputError("La configuración del proyecto no es válida", problems)

    base = slugify_project(body.name)
    slug = base
    suffix = 2
    while await state.repositories.projects.find_by_slug(organization_id, slug):
        slug = f"{base}-{suffix}"
        suffix += 1
        if suffix >= 1000:
            slug = f"{base}-{new_id()[:8]}"
            break

    project_id = new_id()
    await state.repositories.projects.insert(
        {
            "id": project_id,
            "organizationId": organization_id,
            "name": body.name.strip(),
            "slug": slug,
            "description": (body.description or "").strip(),
            "createdBy": actor_id(principal),
            "createdAt": utc_now(),
            "baseUrl": (body.baseUrl or "").strip(),
            "tags": normalize_tags(body.tags or []),
        }
    )
    return {"projectId": project_id, "slug": slug}


@router.get("/{project_id}")
async def get_project(
    request: Request,
    organization_id: str,
    project_id: str,
    principal: Principal = Depends(authenticate),
) -> dict:
    await role_in_organization(request, principal, organization_id, "viewer")
    return await summarize(request, await owned_project(request, organization_id, project_id))


@router.patch("/{project_id}", status_code=204)
async def update_project(
    request: Request,
    organization_id: str,
    project_id: str,
    body: UpdateProjectBody,
    principal: Principal = Depends(authenticate),
) -> None:
    await role_in_organization(request, principal, organization_id, "editor")
    Rules().max_length("name", body.name, 200).max_length("description", body.description, 2000).max_length(
        "baseUrl", body.baseUrl, 2000
    ).check()
    project = await owned_project(request, organization_id, project_id)
    if project["archivedAt"] is not None:
        raise ConflictError("El proyecto está archivado", "project-archived")

    problems = base_url_problems(body.baseUrl)
    if problems:
        raise InvalidInputError("La configuración del proyecto no es válida", problems)

    # El slug **no** se recalcula desde un nombre nuevo: está en URLs que el equipo tiene
    # guardadas y en el trabajo de CI que lanza sus corridas. Renombrar no rompe ninguna de las dos.
    await request.app.state.eq.repositories.projects.update_fields(
        project_id,
        name=(body.name or "").strip() or project["name"],
        description=(body.description.strip() if body.description is not None else project["description"]),
        base_url=(body.baseUrl.strip() if body.baseUrl is not None else project["baseUrl"]),
        tags=(normalize_tags(body.tags) if body.tags is not None else project["tags"]),
    )


@router.patch("/{project_id}/archived", status_code=204)
async def set_archived(
    request: Request,
    organization_id: str,
    project_id: str,
    body: ArchiveProjectBody,
    principal: Principal = Depends(authenticate),
) -> None:
    # Archivar saca el proyecto de la lista de todo el mundo, así que sube un escalón sobre editarlo.
    await role_in_organization(request, principal, organization_id, "admin")
    await owned_project(request, organization_id, project_id)
    await request.app.state.eq.repositories.projects.set_archived(
        project_id, utc_now() if body.archived else None
    )


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    request: Request,
    organization_id: str,
    project_id: str,
    principal: Principal = Depends(authenticate),
) -> None:
    # Borrar es definitivo para toda la organización, así que es el mismo escalón que archivar.
    await role_in_organization(request, principal, organization_id, "admin")
    await owned_project(request, organization_id, project_id)
    await request.app.state.eq.repositories.projects.soft_delete(project_id, utc_now())
