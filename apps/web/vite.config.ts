import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, target: "es2022" },
  server: { port: 5174, strictPort: true },
  // css.include: os testes de contraste leem tokens.css (?raw); sem isso o Vitest entrega CSS vazio.
  test: { environment: "jsdom", css: { include: [/tokens\.css/] } },
});
