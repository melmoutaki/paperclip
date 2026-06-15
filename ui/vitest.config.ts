import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: process.env.VITEST_CACHE_DIR ?? path.join(os.tmpdir(), "paperclip-ui-vitest-cache"),
  resolve: {
    alias: {
      "@": path.resolve(uiRoot, "./src"),
      lexical: path.resolve(uiRoot, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
