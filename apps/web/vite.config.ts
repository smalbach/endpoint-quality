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
    proxy: {
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
      thresholds: { lines: 46, statements: 46, branches: 81, functions: 64 },
    },
  },
});
