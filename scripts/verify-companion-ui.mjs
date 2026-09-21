/** Compatibility entry point: the companion scenario UI is now DecisionStudio.
 * Keep existing QA invocations valid while running the current isolated suite. */
if (process.env.COMPANION_QA_URL) process.env.DECISION_QA_URL ??= process.env.COMPANION_QA_URL
if (process.env.COMPANION_QA_CDP) process.env.CDP_ENDPOINT ??= process.env.COMPANION_QA_CDP
if (process.env.COMPANION_QA_OUTPUT) process.env.DECISION_QA_OUTPUT ??= process.env.COMPANION_QA_OUTPUT
await import('./verify-decision-ui.mjs')
