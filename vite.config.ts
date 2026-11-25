// Builds the static pages into dist/, which the Worker serves as assets.
import path from "node:path";
import { defineConfig } from "vite";

const web = path.join(import.meta.dirname, "src/web");

export default defineConfig({
  root: web,
  publicDir: path.join(web, "public"),
  build: {
    outDir: path.join(import.meta.dirname, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: path.join(web, "index.html"),
        start: path.join(web, "start.html"),
        join: path.join(web, "join.html"),
        vote: path.join(web, "vote.html"),
        board: path.join(web, "board.html"),
        admin: path.join(web, "admin.html"),
      },
    },
  },
});
