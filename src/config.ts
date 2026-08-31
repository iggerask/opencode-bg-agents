import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export interface OrchestrationConfig {
  maxConcurrent: number
  maxMonitors: number
  enforceWriteRoots: boolean
  requireCompletion: boolean
  notifications: boolean
  validationTimeoutSec: number
}

type Values = Record<string, unknown>
const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
const boolean = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback

async function readJSON(file: string): Promise<Values> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

/** Plugin tuple options win; legacy project/global bg-agents JSON remains a soft fallback. */
export async function loadConfig(worktree: string, options: Values = {}): Promise<OrchestrationConfig> {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const global = await readJSON(path.join(xdg, "opencode", "bg-agents.json"))
  const project = await readJSON(path.join(worktree, ".opencode", "bg-agents.json"))
  const get = (name: string) => options[name] ?? project[name] ?? global[name]
  return {
    maxConcurrent: positive(get("max_concurrent"), 4),
    maxMonitors: positive(get("max_monitors"), 8),
    enforceWriteRoots: boolean(get("enforce_write_roots"), true),
    requireCompletion: boolean(get("require_completion"), true),
    notifications: boolean(get("notifications"), true),
    validationTimeoutSec: positive(get("validation_timeout_sec"), 600),
  }
}
