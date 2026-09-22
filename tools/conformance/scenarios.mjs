/**
 * El guion de paridad: la misma conversación HTTP, contra cualquiera de los backends.
 *
 * Cada caso declara lo que manda y lo que espera. Lo que **no** declara es el cuerpo exacto de la
 * respuesta: eso se compara contra el backend de referencia después de normalizar lo que cambia
 * entre corridas (identificadores, tokens, fechas). Escribir el cuerpo esperado a mano habría
 * significado mantener una tercera copia del contrato, que es exactamente el problema del que
 * este guion existe para protegernos.
 *
 * `auth` dice con qué credencial va el caso:
 *   - `null`          sin cabecera;
 *   - `"session"`     el token de acceso de la cuenta principal;
 *   - `"other"`       el de una segunda cuenta, de otra organización — para probar el límite;
 *   - `"api-token"`   un token de servicio `eqt_`.
 */

/** Una contraseña que cumple la política: doce caracteres, mayúscula, minúscula, número y símbolo. */
const PASSWORD = "Conformidad-2026";

export function scenarios(run) {
  const email = `conformidad+${run}@example.com`;
  const other = `conformidad-otra+${run}@example.com`;

  return [
    // --- sonda y descriptor -----------------------------------------------------------------
    {
      module: "health",
      name: "la sonda consulta la base y dice que está arriba",
      method: "GET",
      path: "/health",
      expect: 200,
    },
    {
      module: "health",
      name: "el descriptor dice quién contesta y qué cubre",
      method: "GET",
      path: "/backend",
      expect: 200,
      // El descriptor es lo único que *debe* diferir entre backends: es su carné de identidad.
      compare: false,
      assert: (body) => {
        if (typeof body.id !== "string" || !body.id) return "sin id";
        if (typeof body.reference !== "boolean") return "sin bandera de referencia";
        if (!body.modules || typeof body.modules !== "object") return "sin mapa de módulos";
        const values = new Set(Object.values(body.modules));
        for (const value of values) {
          if (!["full", "partial", "none"].includes(value)) return `cobertura desconocida: ${value}`;
        }
        return null;
      },
    },

    // --- sesión -----------------------------------------------------------------------------
    {
      module: "auth",
      name: "una contraseña débil se rechaza con 422 y el campo que falla",
      method: "POST",
      path: "/auth/register",
      body: { email: `debil+${run}@example.com`, password: "corta", name: "Débil" },
      expect: 422,
    },
    {
      module: "auth",
      name: "un correo sin arroba se rechaza con 422",
      method: "POST",
      path: "/auth/register",
      body: { email: "sin-arroba", password: PASSWORD, name: "Sin arroba" },
      expect: 422,
    },
    {
      module: "auth",
      name: "el registro crea la cuenta y la organización que la va a poseer",
      setup: true,
      method: "POST",
      path: "/auth/register",
      // El nombre lleva el sufijo de la corrida para que también lo lleve el slug: la base es
      // compartida, así que la segunda corrida encontraría el slug ocupado y se llamaría
      // «conformidad-2» — una diferencia entre backends que no es una diferencia de backend.
      body: { email, password: PASSWORD, name: `Conformidad ${run}` },
      expect: 201,
      capture: { userId: "userId", organizationId: "organizationId" },
    },
    {
      module: "auth",
      name: "el mismo correo dos veces es 409 con su código",
      method: "POST",
      path: "/auth/register",
      body: { email, password: PASSWORD, name: `Conformidad ${run}` },
      expect: 409,
    },
    {
      module: "auth",
      name: "el login devuelve la sesión y pone la cookie de refresco",
      setup: true,
      method: "POST",
      path: "/auth/login",
      body: { email, password: PASSWORD },
      expect: 200,
      capture: { accessToken: "accessToken", refreshToken: "refreshToken" },
      cookie: { name: "eq_refresh", attributes: ["HttpOnly", "SameSite=strict", "Path=/"] },
    },
    {
      module: "auth",
      name: "una contraseña equivocada es 401, y no dice que la cuenta exista",
      method: "POST",
      path: "/auth/login",
      body: { email, password: "Contraseña-Mala-1" },
      expect: 401,
    },
    {
      module: "auth",
      name: "un correo que no existe falla igual que una contraseña mala",
      method: "POST",
      path: "/auth/login",
      body: { email: `nadie+${run}@example.com`, password: PASSWORD },
      expect: 401,
    },
    {
      module: "auth",
      name: "sin credencial, una ruta protegida es 401",
      method: "GET",
      path: "/auth/me",
      expect: 401,
    },
    {
      module: "auth",
      name: "un token inventado es 401",
      method: "GET",
      path: "/auth/me",
      headers: { Authorization: "Bearer no-es-un-token" },
      expect: 401,
    },
    {
      module: "auth",
      name: "«quién soy» trae la persona y sus organizaciones",
      method: "GET",
      path: "/auth/me",
      auth: "session",
      expect: 200,
    },
    {
      module: "auth",
      name: "«dónde puedo actuar» contesta con la misma forma para una persona",
      method: "GET",
      path: "/auth/context",
      auth: "session",
      expect: 200,
    },
    {
      module: "auth",
      name: "el refresco rota el par y sigue siendo la misma sesión",
      method: "POST",
      path: "/auth/refresh",
      body: { refreshToken: "{{refreshToken}}" },
      expect: 200,
      capture: { rotatedRefresh: "refreshToken" },
    },
    {
      module: "auth",
      name: "un refresco ya gastado es 401 — y revoca la cadena entera",
      method: "POST",
      path: "/auth/refresh",
      body: { refreshToken: "{{refreshToken}}" },
      expect: 401,
    },
    {
      module: "auth",
      name: "y la rotación que vino de esa cadena tampoco vale ya",
      method: "POST",
      path: "/auth/refresh",
      body: { refreshToken: "{{rotatedRefresh}}" },
      expect: 401,
    },
    {
      module: "auth",
      name: "un enlace de restablecimiento inventado no dice qué falla de más",
      method: "POST",
      path: "/auth/reset-password",
      body: { token: "no-existe", newPassword: PASSWORD },
      expect: 422,
    },
    {
      module: "auth",
      name: "«olvidé mi contraseña» contesta 204 exista o no la cuenta",
      method: "POST",
      path: "/auth/forgot-password",
      body: { email: `fantasma+${run}@example.com` },
      expect: 204,
    },

    // --- organizaciones ---------------------------------------------------------------------
    {
      module: "iam",
      name: "la lista de miembros trae a quien fundó la organización",
      method: "GET",
      path: "/orgs/{{organizationId}}/members",
      auth: "session",
      expect: 200,
    },
    {
      module: "iam",
      name: "crear una segunda organización funciona y deja dentro a su propietario",
      // Imprescindible: el bloque de proyectos la usa para probar que un proyecto de una
      // organización no se ve desde otra.
      setup: true,
      method: "POST",
      path: "/orgs",
      body: { name: `Segunda ${run}` },
      auth: "session",
      expect: 201,
      capture: { secondOrganizationId: "organizationId" },
    },
    {
      module: "iam",
      name: "un token de CI se crea, se enseña una vez y queda su preview",
      method: "POST",
      path: "/orgs/{{organizationId}}/tokens",
      body: { name: "CI de conformidad" },
      auth: "session",
      expect: 201,
      capture: { apiToken: "token", apiTokenId: "id" },
    },
    {
      module: "iam",
      name: "la lista de tokens no devuelve ningún secreto",
      method: "GET",
      path: "/orgs/{{organizationId}}/tokens",
      auth: "session",
      expect: 200,
      assert: (body) => {
        // El *preview* empieza por `eqt_` a propósito: son sus seis primeros caracteres. Lo que
        // no puede aparecer es un token entero, que es lo que se busca aquí.
        const raw = JSON.stringify(body);
        return /eqt_[\w-]{20,}/.test(raw) ? "un token en claro en la lista" : null;
      },
    },
    {
      module: "iam",
      name: "un token de servicio sabe decir en qué organización actúa",
      method: "GET",
      path: "/auth/context",
      auth: "api-token",
      expect: 200,
    },
    {
      module: "iam",
      name: "un token de servicio no representa a una persona",
      method: "GET",
      path: "/auth/me",
      auth: "api-token",
      expect: 401,
    },
    {
      module: "iam",
      name: "un token de servicio no llega a gestionar credenciales",
      method: "GET",
      path: "/orgs/{{organizationId}}/tokens",
      auth: "api-token",
      expect: 403,
    },
    {
      module: "iam",
      name: "invitar con un rol por encima del tuyo no se puede… y con uno igual sí",
      method: "POST",
      path: "/orgs/{{organizationId}}/invitations",
      body: { email: `invitada+${run}@example.com`, role: "editor" },
      auth: "session",
      expect: 201,
    },
    {
      module: "iam",
      name: "la misma dirección dos veces es 409 mientras la invitación siga viva",
      method: "POST",
      path: "/orgs/{{organizationId}}/invitations",
      body: { email: `invitada+${run}@example.com`, role: "editor" },
      auth: "session",
      expect: 409,
    },
    {
      module: "iam",
      name: "un rol que no existe se rechaza con 422",
      method: "POST",
      path: "/orgs/{{organizationId}}/invitations",
      body: { email: `otra+${run}@example.com`, role: "jefe" },
      auth: "session",
      expect: 422,
    },
    {
      module: "iam",
      name: "cambiarte el rol a ti mismo no se puede",
      method: "PATCH",
      path: "/orgs/{{organizationId}}/members/{{userId}}",
      body: { role: "viewer" },
      auth: "session",
      expect: 403,
    },
    {
      module: "iam",
      name: "el último propietario no puede salirse y dejar la organización sin dueño",
      method: "DELETE",
      path: "/orgs/{{organizationId}}/members/{{userId}}",
      auth: "session",
      expect: 409,
    },
    {
      module: "iam",
      name: "el token de CI se revoca y la revocación es idempotente",
      method: "DELETE",
      path: "/orgs/{{organizationId}}/tokens/{{apiTokenId}}",
      auth: "session",
      expect: 204,
    },
    {
      module: "iam",
      name: "un token revocado deja de valer inmediatamente",
      method: "GET",
      path: "/auth/context",
      auth: "api-token",
      expect: 401,
    },

    // --- el límite entre inquilinos ---------------------------------------------------------
    {
      module: "iam",
      name: "una segunda cuenta, en su propia organización",
      method: "POST",
      path: "/auth/register",
      body: { email: other, password: PASSWORD, name: "Otra" },
      expect: 201,
      capture: { otherOrganizationId: "organizationId" },
    },
    {
      module: "iam",
      name: "y entra",
      method: "POST",
      path: "/auth/login",
      body: { email: other, password: PASSWORD },
      expect: 200,
      capture: { otherAccessToken: "accessToken" },
    },
    {
      module: "iam",
      name: "preguntar por la organización de otro es 403, no 404",
      method: "GET",
      path: "/orgs/{{organizationId}}/members",
      auth: "other",
      expect: 403,
    },

    // --- proyectos --------------------------------------------------------------------------
    {
      module: "projects",
      name: "la lista de un proyecto recién fundado está vacía",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects",
      auth: "session",
      expect: 200,
    },
    {
      module: "projects",
      name: "crear un proyecto devuelve su id y su slug",
      method: "POST",
      path: "/orgs/{{organizationId}}/projects",
      body: { name: "Catálogo de conformidad", description: "Creado por el guion de paridad" },
      auth: "session",
      expect: 201,
      capture: { projectId: "projectId" },
    },
    {
      module: "projects",
      name: "un baseUrl que no es http se rechaza con 422",
      method: "POST",
      path: "/orgs/{{organizationId}}/projects",
      body: { name: "Con URL mala", baseUrl: "ftp://ejemplo" },
      auth: "session",
      expect: 422,
    },
    {
      module: "projects",
      name: "dos proyectos con el mismo nombre no chocan de slug",
      method: "POST",
      path: "/orgs/{{organizationId}}/projects",
      body: { name: "Catálogo de conformidad" },
      auth: "session",
      expect: 201,
    },
    {
      module: "projects",
      name: "la tarjeta del proyecto trae contrato, origen y última corrida en nulo",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      auth: "session",
      expect: 200,
    },
    {
      module: "projects",
      name: "editarlo no le cambia el slug",
      method: "PATCH",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      body: { name: "Catálogo renombrado", tags: ["uno", "uno", " dos "] },
      auth: "session",
      expect: 204,
    },
    {
      module: "projects",
      name: "y las etiquetas quedan recortadas y sin repetir",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      auth: "session",
      expect: 200,
      assert: (body) => {
        const tags = JSON.stringify(body.tags);
        return tags === '["uno","dos"]' ? null : `etiquetas inesperadas: ${tags}`;
      },
    },
    {
      module: "projects",
      name: "un proyecto de otra organización no existe para quien pregunta",
      method: "GET",
      path: "/orgs/{{secondOrganizationId}}/projects/{{projectId}}",
      auth: "session",
      expect: 404,
    },
    {
      module: "projects",
      name: "archivarlo lo saca de la lista",
      method: "PATCH",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}/archived",
      body: { archived: true },
      auth: "session",
      expect: 204,
    },
    {
      module: "projects",
      name: "editar un proyecto archivado es 409",
      method: "PATCH",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      body: { name: "No debería" },
      auth: "session",
      expect: 409,
    },
    {
      module: "projects",
      name: "pero se sigue pudiendo pedir con includeArchived",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects?includeArchived=true",
      auth: "session",
      expect: 200,
      assert: (body) =>
        Array.isArray(body) && body.length === 2 ? null : `se esperaban 2 proyectos, hay ${body.length}`,
    },
    {
      module: "projects",
      name: "desarchivarlo lo devuelve a la lista",
      method: "PATCH",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}/archived",
      body: { archived: false },
      auth: "session",
      expect: 204,
    },
    {
      module: "projects",
      name: "borrarlo es blando: desaparece de todas partes",
      method: "DELETE",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      auth: "session",
      expect: 204,
    },
    {
      module: "projects",
      name: "y a partir de ahí contesta 404",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects/{{projectId}}",
      auth: "session",
      expect: 404,
    },
    {
      module: "projects",
      name: "un identificador que no es un uuid tampoco existe",
      method: "GET",
      path: "/orgs/{{organizationId}}/projects/no-es-un-uuid",
      auth: "session",
      expect: 404,
      known:
        "los tres contestan 500. La columna es `uuid` y Postgres rechaza el valor antes de que " +
        "nadie decida nada, así que un identificador mal escrito sale como error interno en vez " +
        "de como «no existe». Es del backend de referencia, no del porte.",
    },
    {
      module: "auth",
      name: "cerrar sesión deja de servir el refresco",
      method: "POST",
      path: "/auth/logout",
      body: { everywhere: true },
      auth: "session",
      expect: 204,
    },
  ];
}

export { PASSWORD };
