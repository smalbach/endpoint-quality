// Las reglas portadas desde `apps/api/src/modules/*/domain/`, comparadas con lo que hace el
// original. Cada caso de aquí corresponde a una decisión que se toma allí, no a una línea de aquí.
package domain

import (
	"reflect"
	"testing"
)

func TestLaEscaleraDeRoles(t *testing.T) {
	if !AtLeast("admin", "editor") || !AtLeast("owner", "owner") {
		t.Error("un rol no alcanza uno que tiene por debajo")
	}
	if AtLeast("editor", "admin") {
		t.Error("un editor llega a una operación de admin")
	}
	// Un rol que no existe no alcanza nada: la escalera se compara, no se supone.
	if AtLeast("jefe", "viewer") {
		t.Error("un rol inventado alcanzó el más bajo")
	}
	if IsRole("jefe") || !IsRole("viewer") {
		t.Error("IsRole no reconoce los cuatro que hay")
	}
}

func TestLaPoliticaDeContraseñaNombraTodoLoQueFalta(t *testing.T) {
	got := PasswordProblems("corta")
	want := []string{
		"Debe tener al menos 12 caracteres",
		"Debe incluir una mayúscula",
		"Debe incluir un número",
		"Debe incluir un símbolo",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("problemas distintos de los del original:\n  %v\n  %v", got, want)
	}
	if len(PasswordProblems("Conformidad-2026")) != 0 {
		t.Error("rechaza una contraseña que cumple la política")
	}
}

func TestLasClasesSeMidenPorCategoriaUnicode(t *testing.T) {
	// Sin esto, «Ñandú» no tendría mayúscula en cuanto alguien salga del alfabeto inglés.
	for _, problem := range PasswordProblems("Ñandú-corriendo-9") {
		if problem == "Debe incluir una mayúscula" || problem == "Debe incluir una minúscula" {
			t.Errorf("«Ñandú-corriendo-9» no debería tener el problema %q", problem)
		}
	}
	// El espacio cuenta como símbolo, que es lo que dice `[^\p{L}\p{Nd}]` allí.
	for _, problem := range PasswordProblems("Una Contrasena 9") {
		if problem == "Debe incluir un símbolo" {
			t.Error("el espacio debería contar como símbolo")
		}
	}
}

func TestLosSlugsPlieganLosAcentos(t *testing.T) {
	cases := map[string]string{
		// Las marcas se quitan y la letra se queda: tirar el carácter entero daría `can-n`.
		"Cañón":             "canon",
		"  ¡Hola, Mundo!  ": "hola-mundo",
		"!!!":               "org",
	}
	for name, want := range cases {
		if got := SlugifyOrganization(name); got != want {
			t.Errorf("SlugifyOrganization(%q) = %q, se esperaba %q", name, got, want)
		}
	}
	if got := SlugifyProject("!!!"); got != "proyecto" {
		t.Errorf("el respaldo de un proyecto es %q", got)
	}
}

func TestLasEtiquetasSeRecortanUnaVezCadaUnaYEnOrden(t *testing.T) {
	got := NormalizeTags([]string{" dos ", "uno", "dos", "", "  "})
	if !reflect.DeepEqual(got, []string{"dos", "uno"}) {
		t.Errorf("etiquetas inesperadas: %v", got)
	}
}

func TestElBaseURLSoloAceptaHTTP(t *testing.T) {
	texto := func(value string) *string { return &value }

	if problems := BaseURLProblems(nil); problems != nil {
		t.Error("sin baseUrl no hay nada que objetar")
	}
	if problems := BaseURLProblems(texto("  ")); problems != nil {
		t.Error("un baseUrl vacío se trata como ausente")
	}
	if problems := BaseURLProblems(texto("https://api.example.com")); problems != nil {
		t.Errorf("rechazó una URL válida: %v", problems)
	}
	if problems := BaseURLProblems(texto("ftp://example.com")); len(problems) != 1 ||
		problems[0].Detail != "Solo http o https" {
		t.Errorf("no señaló el esquema: %v", problems)
	}
	if problems := BaseURLProblems(texto("esto no es una url")); len(problems) != 1 ||
		problems[0].Detail != "No es una URL válida" {
		t.Errorf("no señaló la URL: %v", problems)
	}
}

func TestElUltimoPropietarioNoSePuedeQuedarFuera(t *testing.T) {
	roles := map[string]string{"u1": "owner", "u2": "admin"}

	if !WouldOrphanOrganization(roles, "u1", "viewer") {
		t.Error("degradar al único propietario dejaría la organización sin dueño")
	}
	if WouldOrphanOrganization(roles, "u1", "owner") {
		t.Error("seguir siendo propietario no deja a nadie fuera")
	}
	if WouldOrphanOrganization(roles, "u2", "") {
		t.Error("expulsar a alguien que no es el propietario no deja la organización huérfana")
	}
	if WouldOrphanOrganization(map[string]string{"u1": "owner", "u2": "owner"}, "u1", "") {
		t.Error("con dos propietarios, quitar uno no deja la organización huérfana")
	}
}
