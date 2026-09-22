package api

// Proyectos: el CRUD, con la misma tarjeta que pinta la lista del front.
//
// Toda ruta cuelga de `/orgs/{organizationId}/`, así que el límite entre inquilinos lo pone el rol
// sobre un valor que está en la URL. El identificador del proyecto se comprueba **otra vez**
// dentro, contra esa organización: el rol prueba que perteneces a la *organización*, y solo la
// comprobación de dentro prueba que el *proyecto* también es de ella.

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/smalbach/endpoint-quality/apps/api-go/internal/domain"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/problems"
	"github.com/smalbach/endpoint-quality/apps/api-go/internal/store"
)

type createProjectBody struct {
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	BaseURL     *string  `json:"baseUrl"`
	Tags        []string `json:"tags"`
}

type updateProjectBody struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	BaseURL     *string  `json:"baseUrl"`
	Tags        []string `json:"tags"`
}

type archiveProjectBody struct {
	Archived bool `json:"archived"`
}

type projectCreated struct {
	ProjectID string `json:"projectId"`
	Slug      string `json:"slug"`
}

// La mitad no secreta de la autenticación de un proyecto, con una máscara donde hay un secreto
// guardado. El texto cifrado no sale de la base de datos por ninguna ruta.
type projectAuthView struct {
	Type        string `json:"type"`
	LoginURL    string `json:"loginUrl"`
	LoginMethod string `json:"loginMethod"`
	TokenPath   string `json:"tokenPath"`
	Username    string `json:"username"`
	HeaderName  string `json:"headerName"`
	Token       string `json:"token"`
	LoginBody   string `json:"loginBody"`
	Password    string `json:"password"`
	APIKey      string `json:"apiKey"`
}

type lastRunView struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Totals     any     `json:"totals"`
}

type contractView struct {
	VersionID      string `json:"versionId"`
	Title          string `json:"title"`
	Version        string `json:"version"`
	OperationCount int    `json:"operationCount"`
	ImportedAt     string `json:"importedAt"`
}

type sourceView struct {
	Kind          string `json:"kind"`
	Location      string `json:"location"`
	HeadersStored bool   `json:"headersStored"`
}

type forkView struct {
	ParentProjectID string  `json:"parentProjectId"`
	ParentName      *string `json:"parentName"`
	ForkedAt        string  `json:"forkedAt"`
	SyncedAt        string  `json:"syncedAt"`
	Version         int     `json:"version"`
}

type projectSummary struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	Slug                string          `json:"slug"`
	Description         string          `json:"description"`
	ArchivedAt          *string         `json:"archivedAt"`
	BaseURL             string          `json:"baseUrl"`
	ActiveEnvironmentID *string         `json:"activeEnvironmentId"`
	Tags                []string        `json:"tags"`
	Auth                projectAuthView `json:"auth"`
	LastRun             *lastRunView    `json:"lastRun"`
	Contract            *contractView   `json:"contract"`
	Source              *sourceView     `json:"source"`
	Fork                *forkView       `json:"fork"`
}

const mask = "••••••••"

func viewProjectAuth(authType string, settings map[string]any) projectAuthView {
	text := func(key string) string {
		if value, ok := settings[key].(string); ok {
			return value
		}
		return ""
	}
	secrets := map[string]bool{}
	if list, ok := settings["secretFields"].([]any); ok {
		for _, field := range list {
			if name, ok := field.(string); ok {
				secrets[name] = true
			}
		}
	}
	masked := func(field string) string {
		if secrets[field] {
			return mask
		}
		return ""
	}
	return projectAuthView{
		Type:        authType,
		LoginURL:    text("loginUrl"),
		LoginMethod: text("loginMethod"),
		TokenPath:   text("tokenPath"),
		Username:    text("username"),
		HeaderName:  text("headerName"),
		Token:       masked("token"),
		LoginBody:   masked("loginBody"),
		Password:    masked("password"),
		APIKey:      masked("apiKey"),
	}
}

// summarize arma la tarjeta: lo del proyecto, más lo que solo se sabe mirando alrededor.
// `contract: null` es un estado real y la interfaz lo pinta — un proyecto existe antes de su
// primera importación, porque importar puede fallar y perder el proyecto con ello no ayuda.
func (s *Server) summarize(request *http.Request, project store.Project) (projectSummary, error) {
	ctx := request.Context()
	summary := projectSummary{
		ID:                  project.ID,
		Name:                project.Name,
		Slug:                project.Slug,
		Description:         project.Description,
		ArchivedAt:          isoPointer(project.ArchivedAt),
		BaseURL:             project.BaseURL,
		ActiveEnvironmentID: project.ActiveEnvironmentID,
		Tags:                project.Tags,
		Auth:                viewProjectAuth(project.AuthType, project.AuthSettings),
	}
	if summary.Tags == nil {
		summary.Tags = []string{}
	}

	run, err := s.store.LastRun(ctx, project.ID)
	if err != nil {
		return summary, err
	}
	if run != nil {
		summary.LastRun = &lastRunView{
			ID: run.ID, Status: run.Status, StartedAt: iso(run.StartedAt),
			FinishedAt: isoPointer(run.FinishedAt), Totals: run.Totals,
		}
	}

	if project.ActiveSpecVersionID != nil {
		version, err := s.store.SpecVersion(ctx, *project.ActiveSpecVersionID)
		if err != nil {
			return summary, err
		}
		if version != nil {
			summary.Contract = &contractView{
				VersionID: version.ID, Title: version.Title, Version: version.ContractVersion,
				OperationCount: version.OperationCount, ImportedAt: iso(version.ImportedAt),
			}
		}
	}

	source, err := s.store.LatestSpecSource(ctx, project.ID)
	if err != nil {
		return summary, err
	}
	if source != nil {
		summary.Source = &sourceView{Kind: source.Kind, Location: source.Location, HeadersStored: source.HeadersStored}
	}

	fork, err := s.store.Fork(ctx, project.ID)
	if err != nil {
		return summary, err
	}
	if fork != nil {
		view := &forkView{
			ParentProjectID: fork.ParentProjectID, ForkedAt: iso(fork.CreatedAt),
			SyncedAt: iso(fork.SyncedAt), Version: fork.Version,
		}
		parent, err := s.store.ProjectByID(ctx, fork.ParentProjectID)
		if err != nil {
			return summary, err
		}
		// El nombre del original solo si sigue estando y es de esta organización: uno borrado no
		// se nombra.
		if parent != nil && parent.OrganizationID == project.OrganizationID {
			name := parent.Name
			view.ParentName = &name
		}
		summary.Fork = view
	}
	return summary, nil
}

func (s *Server) ownedProject(request *http.Request, organizationID, projectID string) (*store.Project, error) {
	project, err := s.store.ProjectByID(request.Context(), projectID)
	if err != nil {
		return nil, err
	}
	if project == nil || project.OrganizationID != organizationID {
		return nil, problems.NotFound("El proyecto no existe", "project-not-found")
	}
	return project, nil
}

func (s *Server) listProjects(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "viewer"); err != nil {
		return err
	}
	projects, err := s.store.Projects(request.Context(), organizationID,
		request.URL.Query().Get("includeArchived") == "true")
	if err != nil {
		return err
	}
	summaries := []projectSummary{}
	for _, project := range projects {
		summary, err := s.summarize(request, project)
		if err != nil {
			return err
		}
		summaries = append(summaries, summary)
	}
	return writeJSON(writer, http.StatusOK, summaries)
}

func (s *Server) createProject(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "editor"); err != nil {
		return err
	}
	var body createProjectBody
	if err := decode(request, &body); err != nil {
		return err
	}
	check := (rules{}).maxLength("name", body.Name, 200)
	if body.Description != nil {
		check = check.maxLength("description", *body.Description, 2000)
	}
	if body.BaseURL != nil {
		check = check.maxLength("baseUrl", *body.BaseURL, 2000)
	}
	if err := check.check(); err != nil {
		return err
	}
	if found := domain.BaseURLProblems(body.BaseURL); len(found) > 0 {
		return problems.Invalid("La configuración del proyecto no es válida", found, "")
	}

	ctx := request.Context()
	base := domain.SlugifyProject(body.Name)
	slug := base
	for suffix := 2; suffix < 1000; suffix++ {
		taken, err := s.store.ProjectSlugTaken(ctx, organizationID, slug)
		if err != nil {
			return err
		}
		if !taken {
			break
		}
		slug = fmt.Sprintf("%s-%d", base, suffix)
	}

	project := store.Project{
		ID: newID(), OrganizationID: organizationID, Name: strings.TrimSpace(body.Name), Slug: slug,
		Description: strings.TrimSpace(valueOr(body.Description, "")), CreatedAt: time.Now().UTC(),
		BaseURL: strings.TrimSpace(valueOr(body.BaseURL, "")), Tags: domain.NormalizeTags(body.Tags),
	}
	// Quien actúa: un token de CI es un importador legítimo, así que esto no exige una persona.
	actor := who.userID
	if actor == "" {
		actor = who.tokenID
	}
	if err := s.store.InsertProject(ctx, project, actor); err != nil {
		return err
	}
	return writeJSON(writer, http.StatusCreated, projectCreated{ProjectID: project.ID, Slug: slug})
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "viewer"); err != nil {
		return err
	}
	project, err := s.ownedProject(request, organizationID, request.PathValue("projectId"))
	if err != nil {
		return err
	}
	summary, err := s.summarize(request, *project)
	if err != nil {
		return err
	}
	return writeJSON(writer, http.StatusOK, summary)
}

func (s *Server) updateProject(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	if _, err := s.roleIn(request, who, organizationID, "editor"); err != nil {
		return err
	}
	var body updateProjectBody
	if err := decode(request, &body); err != nil {
		return err
	}
	check := rules{}
	if body.Name != nil {
		check = check.maxLength("name", *body.Name, 200)
	}
	if body.Description != nil {
		check = check.maxLength("description", *body.Description, 2000)
	}
	if body.BaseURL != nil {
		check = check.maxLength("baseUrl", *body.BaseURL, 2000)
	}
	if err := check.check(); err != nil {
		return err
	}

	project, err := s.ownedProject(request, organizationID, request.PathValue("projectId"))
	if err != nil {
		return err
	}
	if project.ArchivedAt != nil {
		return problems.Conflict("El proyecto está archivado", "project-archived")
	}
	if found := domain.BaseURLProblems(body.BaseURL); len(found) > 0 {
		return problems.Invalid("La configuración del proyecto no es válida", found, "")
	}

	name := project.Name
	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		name = strings.TrimSpace(*body.Name)
	}
	description := project.Description
	if body.Description != nil {
		description = strings.TrimSpace(*body.Description)
	}
	baseURL := project.BaseURL
	if body.BaseURL != nil {
		baseURL = strings.TrimSpace(*body.BaseURL)
	}
	tags := project.Tags
	if body.Tags != nil {
		tags = domain.NormalizeTags(body.Tags)
	}

	// El slug **no** se recalcula desde un nombre nuevo: está en URLs que el equipo tiene guardadas
	// y en el trabajo de CI que lanza sus corridas. Renombrar no rompe ninguna de las dos.
	if err := s.store.UpdateProject(request.Context(), project.ID, name, description, baseURL, tags); err != nil {
		return err
	}
	return noContent(writer)
}

func (s *Server) setProjectArchived(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	// Archivar saca el proyecto de la lista de todo el mundo, así que sube un escalón sobre editarlo.
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	var body archiveProjectBody
	if err := decode(request, &body); err != nil {
		return err
	}
	project, err := s.ownedProject(request, organizationID, request.PathValue("projectId"))
	if err != nil {
		return err
	}
	var at *time.Time
	if body.Archived {
		now := time.Now().UTC()
		at = &now
	}
	if err := s.store.SetProjectArchived(request.Context(), project.ID, at); err != nil {
		return err
	}
	return noContent(writer)
}

func (s *Server) deleteProject(writer http.ResponseWriter, request *http.Request) error {
	who, err := s.authenticate(request)
	if err != nil {
		return err
	}
	organizationID := request.PathValue("organizationId")
	// Borrar es definitivo para toda la organización, así que es el mismo escalón que archivar.
	if _, err := s.roleIn(request, who, organizationID, "admin"); err != nil {
		return err
	}
	project, err := s.ownedProject(request, organizationID, request.PathValue("projectId"))
	if err != nil {
		return err
	}
	if err := s.store.SoftDeleteProject(request.Context(), project.ID, time.Now().UTC()); err != nil {
		return err
	}
	return noContent(writer)
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}
