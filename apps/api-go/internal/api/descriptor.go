package api

// El descriptor que el front lee **antes** de elegir a qué backend conectarse.
//
// `modules` es un resumen de lo que ya pasa `tools/conformance`, no una intención. Un módulo sube
// a `full` después de que el guion de paridad lo dé por bueno: el front apaga lo que dice `none` y
// confía en lo que dice `full`, así que un descriptor optimista es peor que ninguno.

type backendDescriptor struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Runtime   string            `json:"runtime"`
	Version   string            `json:"version"`
	Reference bool              `json:"reference"`
	Modules   map[string]string `json:"modules"`
}

var apiModules = []string{
	"auth", "iam", "projects", "specs", "environments", "config", "endpoints", "collections",
	"workflows", "runs", "security-runs", "performance", "mocks", "docs", "monitors", "channels",
	"captures", "roles", "code-scan", "dashboard",
}

var implemented = map[string]string{
	"auth": "full",
	"iam":  "full",
	// `partial` y no `full`: están las seis rutas del CRUD —listar, crear, ver, editar, archivar y
	// borrar— y no las de contrato, bifurcación, solicitudes de fusión, importación ni exportación.
	"projects": "partial",
}

var descriptor = func() backendDescriptor {
	modules := map[string]string{}
	for _, module := range apiModules {
		if coverage, ok := implemented[module]; ok {
			modules[module] = coverage
		} else {
			modules[module] = "none"
		}
	}
	return backendDescriptor{
		ID:        "go",
		Name:      "Go",
		Runtime:   "go 1.24 · net/http · pgx",
		Version:   "0.1.0",
		Reference: false,
		Modules:   modules,
	}
}()
