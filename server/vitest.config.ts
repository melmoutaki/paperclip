import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: serverRoot,
  cacheDir: process.env.VITEST_CACHE_DIR ?? path.join(os.tmpdir(), "paperclip-server-vitest-cache"),
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["src/__tests__/setup-supertest.ts"],
  },
});
