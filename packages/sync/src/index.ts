import { fileURLToPath } from "node:url";

export * from "./schema.js";

/**
 * Absolute path to the sync-rules YAML, for the deploy checklist (docs/deploy.md) and any
 * tooling that verifies the hosted PowerSync instance's rules against this repo's source
 * of record. Resolved relative to this module rather than hardcoded so it is correct
 * regardless of where the workspace checkout lives. Source-relative by design: the YAML is
 * data pasted into the PowerSync dashboard, not a runtime asset this package ships in
 * dist/, so this path is only meaningful when @cortex/sync is consumed from source (as
 * deploy/CI tooling does), not from a built dist/ copy.
 */
export const SYNC_RULES_PATH = fileURLToPath(new URL("./sync-rules.yaml", import.meta.url));
