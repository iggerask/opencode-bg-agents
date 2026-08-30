/** Native-first background orchestration. Task execution is delegated to OpenCode's task tool. */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config"
import { ProcessSupervisor } from "./monitors"
import { TaskQueue } from "./queue"
import { canonicalizeWriteRoots, pathWithinWriteRoots } from "./scope"
import { TaskStore } from "./store"
import type { DispatchClaim, Task } from "./types"
import { ValidationRunner } from "./validation"

type Any = Record<string, any>
const taskID = () => `orch_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
const terminal = new Set(["done", "failed", "cancelled", "interrupted"])
const writeTools = new Set(["write", "edit", "apply_patch", "delete", "remove"])

function output(message: string, metadata?: Any) {
  return metadata ? { output: message, metadata } : message
}
function commandFor(id: string, token: string) { return `orch:${id}:${token}` }
function invocation(claim: DispatchClaim, continuation = false): Any {
  return {
    description: claim.task.title,
    prompt: claim.task.prompt,
    subagent_type: claim.task.agent,
    background: true,
    command: commandFor(claim.task.id, claim.token),
    ...(continuation && claim.task.nativeSessionId ? { task_id: claim.task.nativeSessionId } : {}),
  }
}
function pathsFromPatch(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split("\n")) {
    const match = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s+(.+?)\s*$/.exec(line)
    if (match) paths.push(match[1])
  }
  return paths
}
function writePaths(name: string, args: Any): string[] {
  if (name === "apply_patch") return pathsFromPatch(String(args.patchText ?? args.patch ?? ""))
  const value = args.filePath ?? args.path ?? args.file ?? args.filename
  return typeof value === "string" ? [value] : []
}
function compact(task: Task, activity?: string, leases: string[] = []): string {
  const deps = task.dependencies.length ? ` deps=${task.dependencies.join(",")}` : ""
  const native = task.nativeSessionId ? ` native=${task.nativeSessionId}` : ""
  return `${task.id} [${task.state}] ${JSON.stringify(task.title)}${deps}${native} roots=${task.writeRoots.join(",") || "-"} leases=${leases.join(",") || "-"}${activity ? `\n  ↳ ${activity}` : ""}${task.result ? `\n  result=${task.result.slice(0, 400)}` : ""}${task.error ? `\n  error=${task.error.slice(0, 400)}` : ""}`
}

const capabilityInstructions = "Native background subagents are unavailable. Start OpenCode with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true."
const runtimeFlagEnabled = (value: string | undefined) => value !== undefined && ["true", "yes", "on", "1", "y"].includes(value)

export const BackgroundAgents: Plugin = async ({ client, directory, worktree, serverUrl }: any, tupleOptions: Any = {}) => {
  const root = worktree || directory
  const config = await loadConfig(root, tupleOptions)
  const stateDir = path.join(root, ".opencode", "bg")
  await fs.mkdir(stateDir, { recursive: true })
  const store = new TaskStore(path.join(stateDir, "tasks.sqlite"))
  const queue = new TaskQueue(store, { capacity: config.maxConcurrent })
  const envCapability = runtimeFlagEnabled(process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
  let backgroundSubagents = tupleOptions.__backgroundSubagents === true || envCapability
  if (tupleOptions.__backgroundSubagents !== false && serverUrl) {
    try {
      const response = await fetch(new URL("/experimental/capabilities", serverUrl))
      const value: any = await response.json()
      backgroundSubagents ||= value?.backgroundSubagents === true
    } catch { /* capability endpoint is best effort; explicit env fallback remains supported */ }
  }
  const requireCapability = () => backgroundSubagents ? undefined : capabilityInstructions
  const toast = async (message: string, variant: "info" | "success" | "error" | "warning" = "info") => {
    if (!config.notifications) return
    try { await (client as any).tui?.showToast?.({ body: { message, variant, title: "bg agents" } }) } catch {}
  }
  const supervisor = new ProcessSupervisor({
    worktree: root,
    stateDir,
    maxConcurrent: config.maxMonitors,
    notify: async (event) => { await toast(`[monitor ${event.type}] ${event.record.id}`, "info") },
  })

  async function activity(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return undefined
    try {
      const value: any = await (client.session as any).messages({ path: { id: sessionId } })
      const messages = value?.data ?? value ?? []
      for (const message of [...messages].reverse()) for (const part of [...(message.parts ?? [])].reverse()) {
        if (part?.type === "tool" && part.state?.status) return `${part.tool}${part.state.title ? `: ${part.state.title}` : ""} (${part.state.status})`
      }
    } catch {}
    return undefined
  }
  async function release(task: Task) {
    store.releaseLeases(task.id)
    if (task.nativeSessionId) supervisor.stopOwnedBy(task.nativeSessionId)
  }
  async function finish(task: Task, state: "done" | "failed" | "blocked", detail?: string, result?: string) {
    const current = store.getTask(task.id)
    if (!current || terminal.has(current.state)) return current
    const patch = state === "blocked"
      ? { blockedReason: detail ?? "blocked", result: result ?? detail ?? "blocked" }
      : state === "failed"
        ? { error: detail ?? "failed", ...(result === undefined ? {} : { result }) }
        : { ...(result === undefined ? {} : { result }) }
    const finished = store.transitionWithPatchIf(task.id, ["starting", "running", "checking"], state, detail, patch)
    if (!finished) return store.getTask(task.id)
    await release(finished)
    return finished
  }
  async function pathAllowed(value: string, roots: string[]): Promise<boolean> {
    return pathWithinWriteRoots(root, value, roots)
  }
  async function changesWithin(task: Task, claimed: readonly string[]): Promise<string | undefined> {
    if (!task.nativeSessionId) return "tracked task has no native session"
    try {
      const api: any = (client.session as any).diff
      if (typeof api !== "function") return "authoritative client.session.diff is unavailable"
      const response = await api({ path: { id: task.nativeSessionId } })
      if (response?.error) return "authoritative session diff returned an error"
      const data = response?.data ?? response
      if (!Array.isArray(data)) return "authoritative session diff was malformed"
      const files: unknown[] = data
      const actual: string[] = []
      for (const file of files) {
        const name = (file as Any)?.file
        if (typeof name !== "string") return "authoritative session diff contained a malformed file entry"
        actual.push(name)
        if (!(await pathAllowed(name, task.writeRoots))) return `native session changed out-of-scope file: ${name}`
      }
      const normalize = (items: readonly string[]) => [...new Set(items.map((item) => item.replaceAll("\\", "/")))].sort()
      if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(claimed))) return "files_changed does not match authoritative session diff"
    } catch (error) { return `authoritative session diff failed: ${String(error)}` }
    return undefined
  }
  function contract(task: Task): string {
    return [
      `You are specialist task ${task.id}. You were started by OpenCode's native task tool.`,
      `You may write only: ${task.writeRoots.join(", ") || "(no write roots)"}.`,
      "Do not create or dispatch child sessions. Use orch_complete exactly once when finished.",
      "orch_complete status must be done, blocked, or failed and include a concise summary.",
    ].join("\n")
  }
  function authorizeRoot(task: Task, ctx: Any): string | undefined {
    return task.rootSessionId === ctx.sessionID ? undefined : "This task belongs to another root session."
  }
  async function prepare(args: Any, ctx: Any) {
    const unavailable = requireCapability(); if (unavailable) return unavailable
    let roots: string[]
    try { roots = await canonicalizeWriteRoots(root, args.write_roots ?? []) } catch (error) { return `Invalid write_roots: ${String(error)}` }
    const dependencies: string[] = [...new Set<string>((args.depends_on ?? []) as string[])]
    for (const id of dependencies) {
      const dependency = store.getTask(id)
      if (!dependency) return `Unknown dependency ${id}.`
      if (dependency.rootSessionId !== ctx.sessionID) return `Dependency ${id} belongs to another root session.`
    }
    try {
      if ((args.validations ?? []).length) await ctx.ask?.({
        permission: "bash", patterns: args.validations, always: [], metadata: { operation: "orch_prepare", title: args.title },
      })
    } catch (error) { return `Validation permission was not granted: ${String(error)}` }
    let created: Task
    try {
      created = store.createTask({ id: taskID(), rootSessionId: ctx.sessionID, parentSessionId: ctx.sessionID, title: args.title, prompt: args.prompt, agent: args.agent, writeRoots: roots, dependencies, validationCommands: args.validations ?? [] })
    } catch (error) { return `Could not persist task: ${String(error)}` }
    const claim = queue.claim(created.id)
    if (!claim) return output(JSON.stringify({ id: created.id, state: store.getTask(created.id)?.state, queued: true, reason: "waiting for dependencies, write lease, or capacity" }))
    return output(JSON.stringify(invocation(claim)), { taskId: claim.task.id })
  }
  async function start(args: Any, ctx: Any) {
    const unavailable = requireCapability(); if (unavailable) return unavailable
    let candidate: Task | undefined
    if (args.id) candidate = store.getTask(args.id)
    else candidate = store.listTasks(["queued", "ready"]).find((item) => item.rootSessionId === ctx.sessionID)
    if (!candidate) return "No eligible task."
    const denied = authorizeRoot(candidate, ctx)
    if (denied) return denied
    const claim = queue.claim(candidate.id)
    if (!claim) return "Task is queued: waiting for dependencies, write lease, or capacity."
    return output(JSON.stringify(invocation(claim)), { taskId: claim.task.id })
  }

  // Reconcile durable tasks without relying on internal job registries.
  void (async () => {
    for (const pending of store.listStartupTasks()) {
      // A consumed/issued dispatch can be between native invocation and the
      // after-hook. It is indeterminate: never requeue it or release its lock.
      if (pending.state === "starting" && !pending.nativeSessionId) {
        store.transitionIf(pending.id, "starting", "interrupted", "restart while native child linkage was indeterminate")
        continue
      }
      try {
        const statuses: any = await (client.session as any).status?.()
        const map = statuses?.data ?? statuses
        const item = pending.nativeSessionId && (map?.[pending.nativeSessionId] ?? map?.sessions?.[pending.nativeSessionId])
        const status = item?.type ?? item?.status?.type ?? item?.status ?? item
        if (!status || !["running", "busy", "active"].includes(String(status).toLowerCase())) {
          const transitioned = store.transitionIf(pending.id, ["running", "checking"], "interrupted", "native session inactive or unknown after restart")
          if (transitioned) await release(transitioned)
        }
      } catch {
        const transitioned = store.transitionIf(pending.id, ["running", "checking"], "interrupted", "native session status unavailable after restart")
        if (transitioned) await release(transitioned)
      }
    }
    if (!backgroundSubagents) await toast(capabilityInstructions, "warning")
  })()

  return {
    dispose: async () => { await supervisor.dispose(); store.close() },
    event: async ({ event }: Any) => {
      const type = event?.type
      const sid = event?.properties?.sessionID ?? event?.properties?.info?.id ?? event?.session_id
      if (!sid) return
      if (type === "session.deleted") supervisor.stopOwnedBy(sid)
      const task = store.findByNativeSession(sid)
      if (!task) return
      const status = event?.properties?.status?.type ?? event?.properties?.status ?? event?.properties?.info?.status
      const becameIdle = type === "session.idle" || (type === "session.status" && status === "idle")
      if (becameIdle && ["starting", "running", "checking"].includes(task.state)) {
        await finish(task, config.requireCompletion ? "failed" : "done", config.requireCompletion ? "native task ended without orch_complete" : "native task ended")
      }
      if (type === "session.error" && ["starting", "running", "checking"].includes(task.state)) await finish(task, "failed", String(event?.properties?.error ?? "native session error"))
      if (type === "session.deleted" && ["starting", "running", "checking"].includes(task.state)) {
        const interrupted = store.transitionIf(task.id, ["starting", "running", "checking"], "interrupted", "native session deleted")
        if (interrupted) await release(interrupted)
      }
    },
    "tool.execute.before": async (input: Any, hook: Any) => {
      const args = hook.args ?? input.args ?? {}
      if (input.tool === "task") {
        const match = /^orch:([A-Za-z0-9_-]+):([A-Za-z0-9-]+)$/.exec(String(args.command ?? ""))
        if (!match) return
        const task = store.getTask(match[1])
        if (!task || task.rootSessionId !== input.sessionID) throw new Error("Invalid orchestration task command for this session.")
        if (task.agent !== args.subagent_type || task.title !== args.description || args.background !== true || args.prompt !== task.prompt) throw new Error("Native task arguments do not match the prepared orchestration task.")
        if (!store.consumeDispatchToken(task.id, match[2])) throw new Error("Orchestration task command has expired or was already used.")
        hook.args = { ...args, prompt: `${task.prompt}\n\n---\n${contract(task)}` }
        return
      }
      const task = store.findByNativeSession(input.sessionID)
      if (!task || !writeTools.has(input.tool)) return
      if (["blocked", "done", "cancelled"].includes(task.state)) throw new Error(`Task ${task.id} is ${task.state}; further writes are blocked.`)
      if (!config.enforceWriteRoots) return
      const files = writePaths(input.tool, args)
      if (!files.length) throw new Error(`Cannot verify write path for ${input.tool}; use an explicit file path.`)
      for (const file of files) if (!(await pathAllowed(file, task.writeRoots))) throw new Error(`Write outside task ${task.id} roots: ${file}. Allowed: ${task.writeRoots.join(", ")}`)
    },
    "tool.execute.after": async (input: Any, hook: Any) => {
      if (input.tool !== "task") return
      const args = input.args ?? hook.args ?? {}
      const match = /^orch:([A-Za-z0-9_-]+):/.exec(String(args.command ?? ""))
      if (!match) return
      const task = store.getTask(match[1])
      if (!task || task.rootSessionId !== input.sessionID) return
      const metadata = hook.metadata ?? {}
      if (metadata.error) { store.rollbackDispatch(task.id, `native task error: ${String(metadata.error)}`); return }
      if (typeof metadata.sessionId !== "string" || metadata.parentSessionId !== input.sessionID || typeof metadata.jobId !== "string" || metadata.background !== true) {
        store.rollbackDispatch(task.id, "native task returned malformed background metadata"); return
      }
      store.linkNativeChild(task.id, metadata.sessionId, metadata.jobId)
    },
    tool: {
      orch_prepare: tool({ description: "Persist and claim this native specialist task when eligible; returns native task arguments or queue reason.", args: {
        title: tool.schema.string(), prompt: tool.schema.string(), agent: tool.schema.string(), write_roots: tool.schema.array(tool.schema.string()).optional(), depends_on: tool.schema.array(tool.schema.string()).optional(), validations: tool.schema.array(tool.schema.string()).optional(),
      }, execute: prepare }),
      orch_start: tool({ description: "Claim a specified eligible task or your oldest eligible queued task and return native task arguments.", args: { id: tool.schema.string().optional() }, execute: async (args, ctx) => start(args, ctx) }),
      orch_status: tool({ description: "Show durable orchestration task state, dependencies, leases, native session, result/error, and activity.", args: { id: tool.schema.string().optional() }, execute: async (args, ctx) => {
        const selected = args.id ? store.getTask(args.id) : undefined
        if (selected && selected.rootSessionId !== ctx.sessionID) return `No task ${args.id}.`
        const tasks = args.id ? (selected ? [selected] : []) : store.listTasks().filter((task) => task.rootSessionId === ctx.sessionID)
        if (!tasks.length) return args.id ? `No task ${args.id}.` : "No orchestration tasks."
        return (await Promise.all(tasks.map(async (task) => compact(task, await activity(task.nativeSessionId), store.listLeases(task.id).map((lease) => lease.root))))).join("\n")
      } }),
      orch_cancel: tool({ description: "Root-session only: cancel a task, abort its native child, and release leases/monitors.", args: { id: tool.schema.string(), reason: tool.schema.string().optional() }, execute: async (args, ctx) => {
        const task = store.getTask(args.id); if (!task) return `No task ${args.id}.`
        const denied = authorizeRoot(task, ctx); if (denied) return denied
        if (["done", "cancelled"].includes(task.state)) return `Task ${task.id} already ${task.state}.`
        if (task.nativeSessionId) try { await (client.session as any).abort({ path: { id: task.nativeSessionId } }) } catch {}
        const reason = args.reason ?? "cancelled by root session"
        const cancelled = store.transitionWithPatchIf(task.id, ["queued", "ready", "starting", "running", "blocked", "checking", "failed", "interrupted"], "cancelled", reason, { error: reason })
        if (cancelled) { await release(cancelled); return `Cancelled ${task.id}.` }
        return `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; cancellation did not win.`
      } }),
      orch_continue: tool({ description: "Resume a blocked, failed, or interrupted native task with one-use native task arguments.", args: { id: tool.schema.string(), message: tool.schema.string() }, execute: async (args, ctx) => {
        const unavailable = requireCapability(); if (unavailable) return unavailable
        const task = store.getTask(args.id); if (!task) return `No task ${args.id}.`
        const denied = authorizeRoot(task, ctx); if (denied) return denied
        if (!task.nativeSessionId) return `Task ${task.id} has no native session to continue.`
        const prompt = `${task.prompt}\n\nContinuation request: ${args.message}`
        const claim = store.claimContinuation(task.id, queue.capacity, prompt); if (!claim) return "Task cannot continue yet: waiting for capacity or write lease."
        return output(JSON.stringify(invocation(claim, true)), { taskId: task.id })
      } }),
      orch_complete: tool({ description: "Specialist-only completion gate. Call exactly once with done, blocked, or failed.", args: {
        status: tool.schema.enum(["done", "blocked", "failed"]), summary: tool.schema.string(), files_changed: tool.schema.array(tool.schema.string()).optional(), assumptions: tool.schema.array(tool.schema.string()).optional(), question: tool.schema.string().optional(), recommendation: tool.schema.string().optional(),
      }, execute: async (args, ctx) => {
        const task = store.findByNativeSession(ctx.sessionID)
        if (!task) return "orch_complete is only available to a tracked native specialist session."
        if (!["running", "checking"].includes(task.state)) return `Task ${task.id} is ${task.state}; completion is already closed.`
        const structured = JSON.stringify({ summary: args.summary, files_changed: args.files_changed ?? [], assumptions: args.assumptions ?? [], question: args.question, recommendation: args.recommendation })
        if (args.status === "blocked") {
          const finished = await finish(task, "blocked", structured, structured)
          return finished?.state === "blocked" ? `Task ${task.id} recorded as blocked.` : `Task ${task.id} is ${finished?.state ?? "unavailable"}; completion did not win.`
        }
        if (args.status === "failed") {
          const finished = await finish(task, "failed", structured, structured)
          return finished?.state === "failed" ? `Task ${task.id} recorded as failed.` : `Task ${task.id} is ${finished?.state ?? "unavailable"}; completion did not win.`
        }
        if (config.enforceWriteRoots) for (const file of args.files_changed ?? []) if (!(await pathAllowed(file, task.writeRoots))) return `Completion rejected: ${file} is outside ${task.writeRoots.join(", ")}.`
        const checking = store.claimCompletion(task.id)
        if (!checking) return `Task ${task.id} is ${store.getTask(task.id)?.state}; completion is already being processed.`
        const diffError = config.enforceWriteRoots ? await changesWithin(checking, args.files_changed ?? []) : undefined
        if (diffError) {
          const restored = store.transitionIf(task.id, "checking", "running", diffError)
          return restored ? `Completion rejected: ${diffError}. Fix it, then call orch_complete again.` : `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; completion did not win.`
        }
        const current = store.getTask(task.id)!
        const validations = new ValidationRunner({ worktree: root, stateDir: path.join(stateDir, "validation"), timeoutMs: config.validationTimeoutSec * 1000 })
        try {
          if (current.validationCommands.length) await (ctx as Any).ask?.({
            permission: "bash", patterns: current.validationCommands, always: [], metadata: { operation: "orch_complete_validation", taskId: task.id },
          })
        } catch (error) {
          const restored = store.transitionIf(task.id, "checking", "running", "validation permission denied")
          return restored ? `Validation permission was not granted: ${String(error)}` : `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; completion did not win.`
        }
        let results
        try { results = await validations.run(current.validationCommands) } catch (error) {
          const restored = store.transitionIf(task.id, "checking", "running", "validation runner error")
          return restored ? `Validation could not run: ${String(error)}. Fix it, then call orch_complete again.` : `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; completion did not win.`
        }
        const failure = results.find((item) => item.state !== "success")
        if (failure) {
          const restored = store.transitionIf(task.id, "checking", "running", "validation failed")
          return restored
            ? `Validation failed (${failure.command}, ${failure.state}). Log: ${failure.logPath}\n${failure.output.slice(-2000)}\nFix and call orch_complete again.`
            : `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; completion did not win.`
        }
        const completed = store.transitionWithPatchIf(task.id, "checking", "done", args.summary, { result: structured })
        if (!completed) return `Task ${task.id} is ${store.getTask(task.id)?.state ?? "unavailable"}; completion did not win.`
        await release(completed)
        return `Task ${task.id} completed.`
      } }),
      // Migration aliases intentionally never create/prompts manual child sessions.
      bg_dispatch: tool({ description: "Deprecated: use orch_prepare then invoke the returned native task arguments.", args: { title: tool.schema.string(), prompt: tool.schema.string(), agent: tool.schema.string() }, execute: async () => "bg_dispatch is retired. Use orch_prepare and invoke OpenCode's task tool with its returned arguments." }),
      bg_send: tool({ description: "Deprecated: use orch_continue for a native child.", args: { id: tool.schema.string(), message: tool.schema.string() }, execute: async () => "bg_send is retired. Use orch_continue for blocked/failed/interrupted work." }),
      bg_ask: tool({ description: "Deprecated: use orch_complete({status:'blocked', question,...}).", args: { question: tool.schema.string() }, execute: async () => "bg_ask is retired. Record questions with orch_complete status=blocked." }),
      bg_answer: tool({ description: "Deprecated orchestration migration helper.", args: { id: tool.schema.string(), answer: tool.schema.string() }, execute: async () => "bg_answer is retired. Resume work with orch_continue." }),
      bg_status: tool({ description: "Compatibility alias for orch_status.", args: { id: tool.schema.string().optional() }, execute: async (args, ctx) => {
        const selected = args.id ? store.getTask(args.id) : undefined
        if (selected && selected.rootSessionId !== ctx.sessionID) return `No task ${args.id}.`
        const tasks = args.id ? (selected ? [selected] : []) : store.listTasks().filter((task) => task.rootSessionId === ctx.sessionID)
        return tasks.length ? (await Promise.all(tasks.map(async (task) => compact(task, await activity(task.nativeSessionId), store.listLeases(task.id).map((lease) => lease.root))))).join("\n") : args.id ? `No task ${args.id}.` : "No orchestration tasks."
      } }),
      bg_read: tool({ description: "Compatibility alias for orch_status.", args: { id: tool.schema.string() }, execute: async (args, ctx) => { const task = store.getTask(args.id); return task && task.rootSessionId === ctx.sessionID ? compact(task, await activity(task.nativeSessionId), store.listLeases(task.id).map((lease) => lease.root)) : `No task ${args.id}.` } }),
      bg_cancel: tool({ description: "Compatibility alias; use orch_cancel.", args: { id: tool.schema.string(), reason: tool.schema.string().optional() }, execute: async () => "Use orch_cancel; it authorizes the root session and aborts native work." }),
      bg_setup: tool({ description: "Install current templates, /bg command, and .opencode/bg/ gitignore entry without overwriting foreign files.", args: {}, execute: async (_args, ctx) => {
        const templates = fileURLToPath(new URL("../templates/", import.meta.url)); const actions: string[] = []
        const destinations = [path.join(root, ".opencode", "agent", "orchestrator.md"), path.join(root, ".opencode", "command", "bg.md"), path.join(root, ".gitignore")]
        try { await (ctx as Any).ask?.({ permission: "edit", patterns: destinations, always: [], metadata: { operation: "bg_setup" } }) } catch (error) { return `Edit permission was not granted: ${String(error)}` }
        for (const [source, destination] of [["orchestrator.md", path.join(root, ".opencode", "agent", "orchestrator.md")], ["bg-command.md", path.join(root, ".opencode", "command", "bg.md")]] as const) {
          try { await fs.access(destination) } catch { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(templates, source), destination); actions.push(`Installed ${destination}.`) }
        }
        const ignore = path.join(root, ".gitignore"); const text = await fs.readFile(ignore, "utf8").catch(() => ""); if (!text.split("\n").includes(".opencode/bg/")) { await fs.appendFile(ignore, `${text && !text.endsWith("\n") ? "\n" : ""}.opencode/bg/\n`); actions.push("Added .opencode/bg/ to .gitignore.") }
        return actions.join("\n") || "Current bg setup is already installed."
      } }),
      monitor_run: tool({ description: "Run a command under the durable process supervisor.", args: { command: tool.schema.string(), title: tool.schema.string().optional(), cwd: tool.schema.string().optional(), wake_pattern: tool.schema.string().optional(), timeout_sec: tool.schema.number().optional() }, execute: async (args, ctx) => { try { await (ctx as Any).ask?.({ permission: "bash", patterns: [args.command], always: [], metadata: { operation: "monitor_run", title: args.title ?? args.command } }) } catch (error) { return `Bash permission was not granted: ${String(error)}` }; const mon = await supervisor.start({ command: args.command, title: args.title, cwd: args.cwd, ownerSessionID: ctx.sessionID, wakePattern: args.wake_pattern, timeoutSec: args.timeout_sec }); return `Started ${mon.id}.` } }),
      monitor_status: tool({ description: "Status of supervised monitors.", args: { id: tool.schema.string().optional() }, execute: async (args, ctx) => { const records = await supervisor.status(args.id); const owned = records.filter((record) => record.ownerSessionID === ctx.sessionID); return owned.length ? owned.map((r) => `${r.id} [${r.state}] ${r.title}`).join("\n") : args.id ? `No monitor ${args.id}.` : "No monitors." } }),
      monitor_read: tool({ description: "Read monitor output.", args: { id: tool.schema.string(), tail: tool.schema.number().optional() }, execute: async (args, ctx) => { const record = await supervisor.get(args.id); if (!record || record.ownerSessionID !== ctx.sessionID) return `No monitor ${args.id}.`; try { return await supervisor.read(args.id, args.tail) } catch (error) { return String(error) } } }),
      monitor_wait: tool({ description: "Wait for monitor readiness or completion.", args: { id: tool.schema.string(), timeout_sec: tool.schema.number().optional() }, execute: async (args, ctx) => { const record = await supervisor.get(args.id); if (!record || record.ownerSessionID !== ctx.sessionID) return `No monitor ${args.id}.`; const result = await supervisor.wait(args.id, args.timeout_sec); return `${result.reason}${result.record ? `: ${result.record.id} [${result.record.state}]` : ""}` } }),
      monitor_kill: tool({ description: "Kill a monitor.", args: { id: tool.schema.string() }, execute: async (args, ctx) => { const record = await supervisor.get(args.id); if (!record || record.ownerSessionID !== ctx.sessionID) return `No monitor ${args.id}.`; if (record.state === "unavailable") return `Monitor ${record.id} is unavailable after recovery and cannot be controlled.`; if (record.state !== "running") return `Monitor ${record.id} is ${record.state}; it cannot be killed.`; const mon = await supervisor.stop(args.id); return mon ? `Killed ${mon.id}.` : `No monitor ${args.id}.` } }),
    },
  }
}
