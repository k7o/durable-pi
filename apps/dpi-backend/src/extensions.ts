// Re-export shim, kept for one slice: assembly moved to playground.ts and the symbols below moved to the feature
// that owns them. Callers keep their import path until slice 6 deletes this file and names the new paths directly.
export { createPlayground } from "./playground.js";
export { Workspace } from "./features/app-state/doc.js";
export { TodoTool } from "./features/todos/tools.js";
export type { SpawnSession } from "./features/sessions/types.js";
