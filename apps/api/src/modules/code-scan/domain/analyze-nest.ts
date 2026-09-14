/**
 * Reading a NestJS codebase for the routes it actually declares.
 *
 * The contract is what an API *says* it does; this is what the code *does* — and the gap between the
 * two is exactly what a scan is for. A controller with a route the OpenAPI never mentions, a guard
 * quietly dropped from an endpoint, a role the code checks that the roles table never heard of: none
 * of these show up in a document, and all of them show up here.
 *
 * Pure, and off the request path: it is `ts-morph` over source text held in memory, no filesystem
 * and no network. The API decides where the text came from — the GitHub API behind the SSRF guard,
 * or an upload — and hands it here as `{ path, content }`. That split is what lets the parser be
 * tested against a string and lets the fetching be tested against a stub.
 */
import { Node, Project, type Decorator, type SourceFile } from "ts-morph";

/** One HTTP route the code declares, resolved to what a run would actually call. */
export type ScannedEndpoint = {
  method: string;
  /** Full path: global prefix + controller base + route, with single slashes and a leading one. */
  path: string;
  controller: string;
  handler: string;
  /** Guard class names, class-level and method-level merged — `AuthGuard`, `RolesGuard`, … */
  guards: string[];
  /** Role names the code requires, from `@Roles(...)` / `@RequireRole(...)`. */
  roles: string[];
  /** False when the endpoint (or its controller) is `@Public()`. The rest are protected, because a
   * global `AuthGuard` is the shape this product assumes and the reference uses. */
  requiresAuth: boolean;
  file: string;
};

export type ScanResult = {
  endpoints: ScannedEndpoint[];
  files: number;
  controllers: number;
};

export type SourceInput = { path: string; content: string };

const HTTP_DECORATORS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

/**
 * `a`, `/a`, `a/`, `//a//b` and `` all become one clean `/a/b` (or `/`), and NestJS's `:param` is
 * rewritten to this product's `{param}`.
 *
 * The rewrite matters as much as the joining: a scanned `/orders/:id` and a stored `/orders/{id}`
 * are the same route, and without it every parameterised endpoint would read as «added» on the first
 * scan and «removed» on the next. `:id?` (optional) drops the `?`; a `*` wildcard is left alone.
 */
export function joinPath(...parts: string[]): string {
  const segments = parts
    .flatMap((part) => part.split("/"))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1).replace(/\?$/, "")}}` : segment));
  return `/${segments.join("/")}`;
}

/**
 * Every controller route in the given sources, with the prefix applied.
 *
 * `prefix` is the app's global prefix (`app.setGlobalPrefix('api')`) — the reference lets you set it
 * on the connector because a route read out of the code without it would never match the contract's.
 */
export function analyzeNestSources(sources: SourceInput[], prefix = ""): ScanResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    // Parsing only: no type-checking, no lib resolution, so a file that would not compile on its own
    // is still read for its decorators.
    compilerOptions: { allowJs: true, noResolve: true, noLib: true },
  });

  const endpoints: ScannedEndpoint[] = [];
  let controllers = 0;

  for (const source of sources) {
    let file: SourceFile;
    try {
      file = project.createSourceFile(safeName(source.path), source.content, { overwrite: true });
    } catch {
      // A file ts-morph cannot even parse is skipped, not fatal: a scan of forty files should not
      // die on one with a syntax error the repo already lives with.
      continue;
    }
    for (const cls of file.getClasses()) {
      const controllerDecorator = cls.getDecorator("Controller");
      if (!controllerDecorator) continue;
      controllers += 1;
      const base = firstPathArg(controllerDecorator.getArguments());
      const classGuards = guardsOf(cls.getDecorator("UseGuards"));
      const classRoles = rolesOf(cls);
      const classPublic = Boolean(cls.getDecorator("Public"));
      const controllerName = cls.getName() ?? "(anónimo)";

      for (const methodDecl of cls.getMethods()) {
        for (const decorator of methodDecl.getDecorators()) {
          const httpMethod = HTTP_DECORATORS[decorator.getName()];
          if (!httpMethod) continue;
          const route = firstPathArg(decorator.getArguments());
          const guards = [...new Set([...classGuards, ...guardsOf(methodDecl.getDecorator("UseGuards"))])];
          const roles = [...new Set([...classRoles, ...rolesOf(methodDecl)])];
          const isPublic = classPublic || Boolean(methodDecl.getDecorator("Public"));
          endpoints.push({
            method: httpMethod,
            path: joinPath(prefix, base, route),
            controller: controllerName,
            handler: methodDecl.getName(),
            guards,
            roles,
            requiresAuth: !isPublic,
            file: source.path,
          });
        }
      }
    }
  }

  return { endpoints, files: sources.length, controllers };
}

/** ts-morph keys files by name; a path with an unusual extension can confuse it, so everything is
 * read as `.ts`. The reported `file` keeps the real path. */
function safeName(path: string): string {
  const clean = path.replace(/[^A-Za-z0-9_./-]/g, "_");
  return clean.endsWith(".ts") || clean.endsWith(".tsx") ? clean : `${clean}.ts`;
}

/** The path a `@Controller`/`@Get` decorator declares: a string literal, or `{ path: '...' }`, or
 * nothing (a controller mounted at the root). An array of paths is reduced to the first. */
function firstPathArg(args: Node[]): string {
  const arg = args[0];
  if (!arg) return "";
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
  if (Node.isArrayLiteralExpression(arg)) {
    const first = arg.getElements()[0];
    return first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))
      ? first.getLiteralValue()
      : "";
  }
  if (Node.isObjectLiteralExpression(arg)) {
    const property = arg.getProperty("path");
    if (property && Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();
      if (initializer && (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)))
        return initializer.getLiteralValue();
    }
  }
  return "";
}

/** Guard class names from a `@UseGuards(...)` decorator, kept as written (`AuthGuard`, a call like
 * `RolesGuard(...)` reduced to its name). */
function guardsOf(decorator: Decorator | undefined): string[] {
  if (!decorator) return [];
  return decorator.getArguments().map((arg) => {
    if (Node.isCallExpression(arg)) return arg.getExpression().getText();
    return arg.getText();
  });
}

/** Role names from every `@Roles(...)` / `@RequireRole(...)` on a class or method — the string
 * literals only; a role passed as a variable is not a name this can resolve. */
function rolesOf(node: { getDecorators(): Decorator[] }): string[] {
  const roles: string[] = [];
  for (const decorator of node.getDecorators()) {
    const name = decorator.getName();
    if (name !== "Roles" && name !== "RequireRole" && name !== "RequireRoles") continue;
    for (const arg of decorator.getArguments()) {
      if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) roles.push(arg.getLiteralValue());
      else if (Node.isArrayLiteralExpression(arg))
        for (const element of arg.getElements())
          if (Node.isStringLiteral(element) || Node.isNoSubstitutionTemplateLiteral(element))
            roles.push(element.getLiteralValue());
    }
  }
  return roles;
}
