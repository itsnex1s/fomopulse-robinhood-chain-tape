import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** `bun run web` talks to the indexer on 8080; in production the same process serves dist/. */
const server = { proxy: { "/api": "http://localhost:8080", "/ws": { target: "ws://localhost:8080", ws: true } } };

export default defineConfig({ plugins: [react(), tailwind()], server, build: { target: "es2022" } });
