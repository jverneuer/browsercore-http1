import { defineConfig } from "oxlint";
import base from "@browsercore/dev/oxlint";

// Local overrides for pre-existing patterns the shared base flags.
// TODO: migrate these to idiomatic TS and remove the overrides.
export default defineConfig({
    extends: [base],
    rules: {
        // Sequential awaits in network loops (redirect follow, connection setup)
        // are correctness-for-ordering, not accidental.
        "no-await-in-loop": "off",
    },
});
