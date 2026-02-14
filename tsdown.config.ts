import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

export default defineConfig([
  {
    entry: "gateway/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "gateway/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "gateway/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "gateway/extensibility/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "gateway/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: [
      "gateway/extensibility/hooks/bundled/*/handler.ts",
      "gateway/extensibility/hooks/llm-slug-generator.ts",
    ],
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
