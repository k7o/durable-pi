// Write policy travels with the tool: read-only mode removes exactly the tools whose definitions say
// they create, update or delete. A package that cannot be edited declares its policy at install time.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

export type MarkedTool<T extends ToolRegistration = ToolRegistration> = T & { readonly writes: true };

/** Mark a tool that creates, updates or deletes state. */
export function writing<T extends ToolRegistration>(tool: T): MarkedTool<T> {
  return { ...tool, writes: true };
}

export function writes(tool: ToolRegistration): boolean {
  return (tool as { writes?: unknown }).writes === true;
}

/** Apply a declared policy to an installed extension; every declared name must exist. */
export function withWrites<T extends ToolRegistration>(extension: Extension<T>, names: readonly string[]): Extension<T> {
  const tools = extension.tools ?? [];
  const missing = names.filter((name) => !tools.some((tool) => tool.name === name));
  if (missing.length) throw Error(`Extension ${extension.name} has no tool ${missing.join(", ")}`);
  return {
    ...extension,
    tools: tools.map((tool) => (names.includes(tool.name) ? (writing(tool) as T) : tool)),
  };
}

/** The coding tools package ships no policy metadata; its writing tools are declared here. */
export const CODING_WRITES = ["bash", "write", "edit"] as const;
