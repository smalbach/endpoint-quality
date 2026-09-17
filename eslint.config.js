/**
 * One flat config for the whole workspace, not one per package.
 *
 * Five configs would be five places for the same rule to disagree, and the rules that matter here
 * are about **layering**, which is a property of the repository and not of any package inside it.
 *
 * The typed rules are deliberately few. `no-unsafe-*` against TypeORM entities and Nest decorators
 * produces hundreds of findings on day one, and a lint that lands red is a lint everybody turns
 * off. What stays on is the family that catches real defects: a promise nobody awaited.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      ".parity-cut/**",
      "tools/parity-cut/legacy/**",
      "**/node_modules/**",
      // Clones enteros de este repo, creados por los agentes en segundo plano. Linterlos es
      // linter el proyecto otra vez, con un `tsconfig` que se resuelve desde otra raíz.
      ".claude/worktrees/**",
      ".kilo/worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // `_item`/`_index` for the arguments a callback must declare and does not read, and
      // `ignoreRestSiblings` for `const { secret, ...rest }` — naming a key in order to drop it is
      // the point of that line, not an oversight.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // A warning and not an error: the `any`s that exist are at the edges — an optional dependency
      // imported by variable specifier — and turning them red would only teach people to disable
      // the rule that guards the code where it would matter.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // The promise rules need type information, so they run only where a tsconfig covers the file.
    files: ["apps/api/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
  {
    /**
     * The layering the architecture plan promised, enforced instead of trusted.
     *
     * `domain/` is where the rules live and it must stay reachable from a test with no database and
     * no framework; the moment it imports TypeORM, «substitute the port» stops being possible.
     */
    files: ["apps/api/src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "typeorm",
              message: "domain/ no conoce la persistencia: el puerto va aquí, el adaptador en infrastructure/.",
            },
            { name: "@nestjs/typeorm", message: "domain/ no conoce la persistencia." },
            { name: "express", message: "domain/ no conoce el transporte." },
          ],
          patterns: [
            {
              group: ["@/modules/*/infrastructure/*", "**/infrastructure/*"],
              message: "domain/ no depende de infrastructure/.",
            },
          ],
        },
      ],
    },
  },
  {
    /** The engine is consumed by the API and by the browser. A framework import here breaks one of them. */
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@nestjs/*", "react", "react-*", "typeorm", "express"],
              message: "packages/ es dominio puro: sin framework.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["tools/**/*.{ts,mjs}", "scripts/**/*.mjs", "examples/**/*.mjs", "**/*.config.{ts,js}"],
    rules: { "no-console": "off" },
  },
  prettier,
);
