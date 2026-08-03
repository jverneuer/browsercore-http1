import { definePackageConfig } from "@browsercore/dev/vitest";

export default definePackageConfig({
    name: "http1",
    // types.ts is type-declaration-only — it has no executable statements,
    // functions, or branches to cover. Excluding it keeps the report
    // meaningful; a pure-types file can never meaningfully hit 100%.
    coverage: { exclude: ["src/types.ts"] },
});
