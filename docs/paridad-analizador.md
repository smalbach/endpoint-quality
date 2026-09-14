# Paridad con el analizador — qué falta, y en qué orden

Revisión detallada, pantalla por pantalla y ruta por ruta, de `smalbach/security-analyzer` y
`smalbach/security-analyzer-front` contra este repo (12 de septiembre de 2026).

**Lo que cambia respecto a `editor-de-peticiones.md`.** Aquel documento dejó fuera a propósito el
endpoint editable a mano, los scripts, las reglas de seguridad, el rendimiento, el escáner de
GitHub, la IA y el dashboard. La decisión ahora es la contraria: **el producto ofrece las mismas
opciones, configuraciones y menús que el analizador**, y lo único que se conserva de aquí es el
estilo visual (claro, slate, Tailwind 4, `components/ui.tsx`).

Cuatro decisiones tomadas antes de empezar:

| Pregunta                | Decisión                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estilo visual           | El de endpoint-quality. Nada de temas oscuros, glass ni selector de temas.                                                                                                                     |
| Alcance                 | Todo: reglas OWASP, rendimiento, escáner de GitHub + IA, dashboard + historial + ayuda.                                                                                                        |
| Origen de los endpoints | **Los dos.** El contrato OpenAPI sigue entrando y detectando deriva, y además un endpoint se crea, edita, archiva e importa a mano.                                                            |
| Scripts pre/post        | Sí, pero **en un proceso aparte** con límite de tiempo y memoria y sin el entorno del servidor. `node:vm` dentro de la API no es una frontera: un script llega a `process` y lee los secretos. |

Lo que **no** se copia, porque en el analizador es un fallo y no una opción:

- Los sockets sin autenticar (los cuatro _gateways_ aceptan cualquier `runId`). Aquí el progreso
  sigue por SSE detrás del guard.
- `PATCH environments/:envId/variables` que ignora `envId` y escribe en el activo.
- Guardar el formulario de variables con la máscara `••••••••` como valor.
- `window.alert` para errores y el `ForgotPassword` que no distingue red de éxito... este último
  sí se copia: no revelar si la cuenta existe es correcto.

---

## 1. Mapa de menús

### Barra global (analizador `NavHeader`)

| Analizador                       | Aquí hoy         | Destino                                              |
| -------------------------------- | ---------------- | ---------------------------------------------------- |
| Dashboard `/dashboard/ecommerce` | —                | `/dashboard`                                         |
| Projects `/projects`             | `/` (Proyectos)  | `/projects` (y `/` redirige)                         |
| History `/history`               | —                | `/history` — análisis sueltos desde fichero          |
| Icons `/icon-library`            | —                | `/icons`                                             |
| Breadcrumb `/ proyecto`          | —                | sí                                                   |
| Botón de entorno (activo, token) | —                | sí, dentro de un proyecto                            |
| Usuario + logout                 | correo + «Salir» | igual, más selector de organización (propio de aquí) |
| ThemePicker                      | —                | **no** (estilo)                                      |

### Barra lateral del proyecto (analizador `ProjectSidebar`)

Plegable, con «Todos los proyectos», nombre y URL base, ayuda por ítem, y «Ayuda y documentación»
al pie.

| Analizador   | Aquí hoy                               | Destino                                                                                                      |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Endpoints    | Matriz (solo operaciones del contrato) | Endpoints: árbol, estados, bulk, import, editor tipo Postman; la matriz del contrato queda como vista dentro |
| Roles        | sección `access` en Configuración      | Roles: lista con color y aislamiento, permisos por endpoint, matriz R/W/D                                    |
| Test Runs    | Corridas (matriz de contrato)          | Test Runs: corrida de seguridad con reglas + las corridas de contrato                                        |
| Performance  | —                                      | Performance: planes, ejecuciones en vivo, comparativas                                                       |
| Flow Testing | Flujos                                 | Flow Testing: grupos con DnD, lienzo con tipos de nodo, informe                                              |
| Settings     | Configuración + Entornos               | Settings: nombre, descripción, URL base, tags, autenticación; y dentro, contrato, secciones y entornos       |

---

## 2. Brechas por módulo

`✔` presente · `½` parcial · `✗` falta.

### Auth y cuenta

| Capacidad                                                          | Estado                 |
| ------------------------------------------------------------------ | ---------------------- |
| Registro, login, refresh, logout, me                               | ✔                      |
| Olvidé mi contraseña / restablecer (token sha256, 1 h)             | ✗                      |
| Correo (bienvenida, restablecer)                                   | ✗                      |
| Bloqueo tras 5 intentos durante 15 min                             | ✗                      |
| Complejidad de contraseña (mayúscula, minúscula, dígito, especial) | ½ (solo longitud ≥ 12) |
| Página 404                                                         | ✗ (redirige a `/`)     |

### Proyectos

| Capacidad                                                                                                     | Estado                             |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Crear con nombre, descripción, URL base, tags, autenticación                                                  | ½ (solo nombre)                    |
| Autenticación del proyecto: none / bearer (token, login endpoint, método, body, token path) / basic / api_key | ½ (credenciales por entorno y rol) |
| Activos / archivados, archivar y restaurar desde la tarjeta                                                   | ✗ en la UI (la API lo tiene)       |
| Tarjeta con salud: Security %, Flows %, Perf                                                                  | ✗                                  |
| Eliminar proyecto                                                                                             | ✗                                  |
| Pestaña Settings                                                                                              | ✗                                  |
| Importar de otro proyecto eligiendo endpoints, flujos y entornos uno a uno                                    | ½ (copia secciones enteras)        |

### Endpoints

| Capacidad                                                                                                                                                       | Estado                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Endpoint como fila propia (método, path, descripción, parámetros, requiresAuth, tags, scripts)                                                                  | ✗                                                             |
| Estados active / archived / inactive; filtro por estado                                                                                                         | ✗                                                             |
| Árbol por primer segmento y versión, checkbox de grupo indeterminado                                                                                            | ✗                                                             |
| Búsqueda con debounce, paginación                                                                                                                               | ✗                                                             |
| Acciones masivas: archivar, desactivar, activar, borrar                                                                                                         | ✗                                                             |
| Importar fichero (OpenAPI, Postman, Insomnia, markdown con cURL) creando endpoints                                                                              | ½ (solo OpenAPI como contrato; el resto solo como plantillas) |
| Importar un cURL suelto                                                                                                                                         | ½                                                             |
| Panel partido redimensionable lista / editor                                                                                                                    | ✗                                                             |
| Editor: método, path con `{{var}}` resuelto, descripción, Send, cURL, Save                                                                                      | ½ (panel «Enviar» dentro de flujos)                           |
| Pestañas Params (path + query) · Headers · Body (none, form-data con ficheros, urlencoded, raw JSON, binary) · Auth · Scripts · Access Control · Security Rules | ½ (sin ficheros, binary, auth por petición, scripts, reglas)  |
| Respuesta: Body · Headers · Console, copiar                                                                                                                     | ½ (sin consola)                                               |
| Probar con subida de ficheros (10 × 10 MB, extensiones bloqueadas)                                                                                              | ✗                                                             |

### Entornos

| Capacidad                                                   | Estado |
| ----------------------------------------------------------- | ------ |
| CRUD, variables con inicial/actual/secreta/apagada, revelar | ✔      |
| Entorno activo por proyecto y «activar»                     | ✔      |
| Gestor de entornos en modal desde el botón de la barra      | ✔      |
| Scripts que escriben el valor actual                        | ✔      |
| Token de sesión capturado, JWT decodificado, cuenta atrás   | ✔      |

### Roles

| Capacidad                                                                    | Estado |
| ---------------------------------------------------------------------------- | ------ |
| Rol con nombre, descripción, color, aislamiento entre mismo rol              | ✔      |
| Permisos por endpoint: acceso y alcance de datos all / own / none, por grupo | ✔      |
| Reglas entre roles R / W / D                                                 | ✔      |
| Acceso por rol desde el editor del endpoint                                  | ✔      |

### Test Runs de seguridad

| Capacidad                                                                                                                                                                                                                                                          | Estado                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Modal: etiqueta, alcance (todos / seleccionados), credenciales usuario+contraseña+rol, timeout, iteraciones de rate limit, permutaciones entre usuarios, PDF, reglas                                                                                               | ✗                            |
| 17 reglas (BOLA/IDOR, BFLA, JWT, ataques JWT, CORS, inyección, mass assignment, exposición de datos, error disclosure, verbose error, rate limit, cabeceras, method tampering, content-type, cross-user, consistencia entre versiones, tamaño anómalo) con presets | ✗                            |
| Estrategias de ataque y descubrimiento de ids reales                                                                                                                                                                                                               | ✗                            |
| Hallazgos con severidad, remediación, evidencia, pasos para reproducir                                                                                                                                                                                             | ✗                            |
| Score, nivel de riesgo, endpoints sin proteger                                                                                                                                                                                                                     | ✗                            |
| Página de la corrida: filtros (orden, método, endpoint, estado, severidad, categoría, regla, familia HTTP, código, tipo de prueba), paginación, tarjetas HTTP                                                                                                      | ½ (corridas de contrato)     |
| Informes JSON · HTML · **PDF**                                                                                                                                                                                                                                     | ½ (sin PDF; JUnit es propio) |
| Análisis con IA: resumen ejecutivo, top 5, grupos de hallazgos con solución                                                                                                                                                                                        | ✗                            |
| Visibilidad pública con enlace compartido                                                                                                                                                                                                                          | ✗                            |

### Flow Testing

| Capacidad                                                                               | Estado                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Grupos con arrastrar y soltar, reordenar, ejecutar grupo, estado por flujo              | ½ (suites sin DnD)                                            |
| Duplicar flujo, renombrar en línea, estado draft/ready/archived                         | ✗                                                             |
| Paleta de nodos: Auth, Request, Condition, Loop, Merge, Delay, Script                   | ½ (condición, bucle, espera y login son propiedades del paso) |
| Menú contextual del nodo, duplicar, diálogo al borrar                                   | ✗                                                             |
| Velocidad de ejecución, Ctrl+S, Ctrl+Enter                                              | ✗                                                             |
| Panel de validación con «ir al nodo»                                                    | ½                                                             |
| Timeline en vivo e informe con diagnóstico del error                                    | ½                                                             |
| Editor de esquema de respuesta (visual, JSON, desde respuesta), extractores automáticos | ✗                                                             |
| Mapeo de variables entre nodos, variables disponibles                                   | ½                                                             |

### Performance

Todo falta: planes (escenarios con peso, pasos, think time, extractores, aserciones), perfil de
carga constant / ramp / spike con VUs y duración, umbrales p50…p99, errorRate, rps; ejecución con
ventanas de 5 s, resumen, desglose por endpoint, historial por plan y comparativas.

### Escáner de GitHub

Todo falta: conectar repo (token cifrado, rama, base path, prefijo), escanear NestJS con ts-morph,
importar, sincronizar con diff, historial, análisis de impacto sobre flujos y permisos.

### Dashboard, historial, ayuda

Todo falta: dashboard con proyectos, endpoints, corridas, score medio, flujos, tasa de paso,
tiempo medio de rendimiento, gráficas (score, vulnerabilidades, historial, estados), corridas y
proyectos recientes; historial de análisis sueltos con búsqueda y paginación; análisis desde
fichero markdown con progreso; panel «Ayuda y documentación» con ocho temas; biblioteca de iconos.

---

## 3. Fases

Cada fase deja el producto funcionando y se prueba en el navegador antes de pasar a la siguiente.

1. **Shell y menús** · _hecha_. Barra global (Dashboard, Proyectos, Historial, Iconos, breadcrumb, botón de
   entorno), barra lateral plegable del proyecto con las seis secciones y su ayuda, panel de
   ayuda, modal y toasts propios, 404. Las pantallas que ya existen se reubican bajo su sección.
2. **Proyectos y Settings** · _hecha_. Descripción, URL base, tags y autenticación del proyecto; activos y
   archivados; salud en la tarjeta; eliminar; pestaña Settings; olvidé/restablecer contraseña con
   correo; bloqueo; complejidad.
3. **Endpoints** · _hecha_. Entidad propia que convive con las operaciones del contrato (importar un
   contrato crea o actualiza endpoints con origen `contract`), estados, árbol, bulk, importación de
   ficheros y cURL, editor tipo Postman con subida de ficheros.
4. **Entornos activos y scripts** · _hecha_. Entorno activo en el servidor (el primero se activa solo y
   borrar el activo promueve el siguiente), gestor modal, token de sesión por persona cifrado en el
   servidor (del login o de un script, con claims y cuenta atrás); scripts previo y posterior en un
   proceso aparte por script —sin variables de entorno, con el modelo de permisos de Node, sin generar
   código desde texto, 3 s y 64 MB— con la API `pm`/`env`, `pm.test`/`pm.expect` y consola con los
   secretos ocultos.
5. **Roles** · _hecha_. Tablas propias (rol con color y aislamiento, permiso por endpoint con tres
   estados —permitido, denegado, sin decidir— y alcance de datos, reglas R/W/D entre roles); la sección
   `access` se deriva de ellas en cada cambio. Guardar permisos es un parche, no un reemplazo;
   renombrar un rol renombra sus credenciales y borrarlo se las lleva. Acceso por rol en el editor.
6. **Test Runs de seguridad.** Paquete `security-rules` con las 17 reglas y estrategias, hallazgos,
   score, modal, página con filtros, PDF, visibilidad, IA opcional.
7. **Flow Testing.** Grupos con DnD, tipos de nodo, informe con diagnóstico, esquema.
8. **Performance.**
9. **Escáner de GitHub.**
10. **Dashboard, historial, análisis desde fichero, importar de otro proyecto por elementos.**
