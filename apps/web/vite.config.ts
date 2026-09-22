import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    // The API is a separate origin in production; proxying in development keeps the refresh
    // cookie same-site, which is what `SameSite=Strict` requires to work at all.
    // Un prefijo por implementación, **todos bajo el mismo origen**. Es lo que permite que el
    // selector cambie de backend sin que la sesión se caiga: la cookie de refresco es
    // `SameSite=Strict` y del origen, no del prefijo, así que los tres la reciben y una sesión
    // abierta contra Node sigue viva contra Go.
    proxy: {
      "/api-py": {
        target: process.env.VITE_API_PY_URL ?? "http://localhost:3002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-py/, ""),
      },
      "/api-go": {
        target: process.env.VITE_API_GO_URL ?? "http://localhost:3003",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-go/, ""),
      },
      // El último, porque `/api` es prefijo de los otros dos en el emparejador de Vite.
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // En las pruebas, Node cargaría `graphql-language-service` por su `main` de CommonJS, que trae el
    // `graphql` de CommonJS; las pruebas usan el ESM, y un esquema de un `graphql` no lo reconoce el
    // otro («from another module or realm»). Su build ESM, pasado por Vite, importa el mismo que ellas.
    // El `vite build` ya elige ese por su `module`.
    alias: {
      "graphql-language-service": fileURLToPath(
        new URL("./node_modules/graphql-language-service/esm/index.js", import.meta.url),
      ),
    },
    // `pnpm test:coverage`. Los umbrales son un trinquete, no una meta: el suelo de lo medido hoy,
    // para que la cobertura no baje sin que nadie lo note. Súbelos cuando suba lo medido.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // `src/lib/types.ts` es solo `export type { … }` desde `@eq/contracts`: no tiene una línea que
      // ejecutar, y v8 la contaría como un fichero al 0 %.
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/**/*.d.ts", "src/lib/types.ts"],
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 100, statements: 100, branches: 100, functions: 100 },
    },
  },
});
