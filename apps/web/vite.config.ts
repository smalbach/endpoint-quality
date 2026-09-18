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
  },
});
