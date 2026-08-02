import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "http1",
        root: ".",
        include: ["tests/**/*.test.ts"],
        environment: "node",
        globals: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            // types.ts is type-declaration-only — it has no executable statements,
            // functions, or branches to cover. Excluding it keeps the report
            // meaningful; a pure-types file can never meaningfully hit 100%.
            exclude: ["src/types.ts"],
            all: true,
            reporter: ["text", "html", "json-summary"],
        },
    },
});
