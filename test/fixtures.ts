import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export async function pluginFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-plugin-"))
  await fs.mkdir(path.join(root, "src"))
  const calls = { abort: [] as string[], toast: [] as string[], asks: [] as any[] }
  const client: any = {
    session: {
      get: async () => ({ data: { status: "running" } }),
      messages: async () => ({ data: [] }),
      diff: async () => ({ data: [] }),
      abort: async ({ path }: any) => { calls.abort.push(path.id) },
    },
    tui: { showToast: async ({ body }: any) => { calls.toast.push(body.message) } },
  }
  return { root, client, calls, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

export const context = (sessionID: string, root: string, agent = "orchestrator", calls?: { asks: any[] }) => ({
  sessionID,
  messageID: "msg",
  agent,
  directory: root,
  worktree: root,
  abort: new AbortController().signal,
  metadata() {},
  ask: async (input: any) => {
    const required = ["permission", "patterns", "always", "metadata"]
    if (!input || typeof input !== "object" || Object.keys(input).length !== required.length || required.some((key) => !(key in input))) {
      throw new Error("AskInput must be exactly {permission, patterns, always, metadata}")
    }
    if (typeof input.permission !== "string" || !Array.isArray(input.patterns) || !Array.isArray(input.always) || !input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new Error("AskInput has invalid field types")
    }
    calls?.asks.push(input)
  },
}) as any

export function text(result: any): string { return typeof result === "string" ? result : result.output }
