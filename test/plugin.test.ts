import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { BackgroundAgents } from "../src/index"
import { TaskStore } from "../src/store"
import { context, pluginFixture, text } from "./fixtures"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(options: any = {}) {
  const fixture = await pluginFixture(); cleanups.push(fixture.cleanup)
  // 1.18.25 exposes the ID and role under message.info.  Every normal native
  // child has at least its initial user turn.
  fixture.client.session.messages = async () => ({ data: [{ info: { id: "initial-turn", role: "user" }, parts: [] }] })
  const hooks: any = await BackgroundAgents({ client: fixture.client, directory: fixture.root, worktree: fixture.root } as any, { notifications: false, __backgroundSubagents: true, ...options })
  cleanups.push(async () => hooks.dispose())
  return { ...fixture, hooks, ctx: context("root", fixture.root, "orchestrator", fixture.calls) }
}

function argsFrom(result: any) { return JSON.parse(text(result)) }
const nativeMetadata = (sessionId: string) => ({ sessionId, parentSessionId: "root", jobId: `job-${sessionId}`, background: true })

describe("native orchestration plugin", () => {
  test("prepare returns native task args and hooks consume/inject/link", async () => {
    const { hooks, ctx } = await setup()
    const prepared = await hooks.tool.orch_prepare.execute({ title: "Implement thing", prompt: "Do it", agent: "implement", write_roots: ["src"] }, ctx)
    const native = argsFrom(prepared)
    expect(native).toMatchObject({ description: "Implement thing", prompt: "Do it", subagent_type: "implement", background: true })
    expect(native.command).toMatch(/^orch:orch_/)
    const before = { args: { ...native } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "call" }, before)
    expect(before.args.prompt).toContain("Use orch_complete exactly once")
    await expect(hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "again" }, { args: native })).rejects.toThrow("already used")
    const after = { output: "started", metadata: nativeMetadata("child") }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "call", args: native }, after)
    expect(text(await hooks.tool.orch_status.execute({}, ctx))).toContain("native=child")
    expect(after.metadata).toEqual(nativeMetadata("child"))
  })

  test("overlapping roots queue and completion validation unlocks next", async () => {
    const { hooks, ctx, calls } = await setup()
    const first = argsFrom(await hooks.tool.orch_prepare.execute({ title: "one", prompt: "one", agent: "implement", write_roots: ["src"], validations: ["true"] }, ctx))
    const secondResult = await hooks.tool.orch_prepare.execute({ title: "two", prompt: "two", agent: "implement", write_roots: ["src/sub"] }, ctx)
    expect(argsFrom(secondResult).queued).toBe(true)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "a" }, { args: first })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "a", args: first }, { output: "", metadata: nativeMetadata("child") })
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "ok", files_changed: [] }, context("child", ctx.worktree, "implement", calls))).toContain("completed")
    expect(calls.asks).toEqual([
      { permission: "bash", patterns: ["true"], always: [], metadata: { operation: "orch_prepare", title: "one" } },
      { permission: "bash", patterns: ["true"], always: [], metadata: { operation: "orch_complete_validation", taskId: first.command.split(":")[1] } },
    ])
    const next = argsFrom(await hooks.tool.orch_start.execute({}, ctx))
    expect(next.description).toBe("two")
  })

  test("validation failures restore running and blocked work returns continuation args", async () => {
    const { hooks, ctx } = await setup()
    const failing = argsFrom(await hooks.tool.orch_prepare.execute({ title: "validate", prompt: "validate", agent: "implement", write_roots: ["src"], validations: ["printf nope; exit 2"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "v" }, { args: failing })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "v", args: failing }, { output: "", metadata: nativeMetadata("validation-child") })
    const failed = await hooks.tool.orch_complete.execute({ status: "done", summary: "done", files_changed: [] }, context("validation-child", ctx.worktree, "implement"))
    expect(failed).toContain("Validation failed")
    expect(text(await hooks.tool.orch_status.execute({}, ctx))).toContain("[running]")
    const id = failing.command.split(":")[1]
    expect(await hooks.tool.orch_complete.execute({ status: "blocked", summary: "need input", question: "which?" }, context("validation-child", ctx.worktree, "implement"))).toContain("blocked")
    const continued = argsFrom(await hooks.tool.orch_continue.execute({ id, message: "use A" }, ctx))
    expect(continued).toMatchObject({ task_id: "validation-child", background: true })
    expect(continued.prompt).toBe("validate\n\nContinuation request: use A")
    expect(continued.command).toMatch(new RegExp(`^orch:${id}:`))
    expect(await hooks.tool.orch_continue.execute({ id, message: "use B" }, ctx)).toContain("cannot continue yet")
    const continuationBefore = { args: { ...continued } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "continued" }, continuationBefore)
    expect(continuationBefore.args.prompt).toContain("Continuation request: use A")
    await expect(hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "continued-again" }, { args: continued })).rejects.toThrow("already used")
  })

  test("write enforcement parses apply_patch and terminal child events fail missing completion", async () => {
    const { hooks, ctx } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "scope", prompt: "scope", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "a" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "a", args: native }, { output: "", metadata: nativeMetadata("child") })
    await hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "child", callID: "ok" }, { args: { patchText: "*** Add File: src/a.ts" } })
    await expect(hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "child", callID: "bad" }, { args: { patchText: "*** Update File: README.md" } })).rejects.toThrow("outside")
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } } })
    expect(text(await hooks.tool.orch_status.execute({}, ctx))).toContain("without orch_complete")
  })

  test("cancel aborts native child and monitor tools are wired", async () => {
    const { hooks, ctx, calls } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "cancel", prompt: "cancel", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "a" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "a", args: native }, { output: "", metadata: nativeMetadata("child") })
    const id = native.command.split(":")[1]
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(calls.abort).toEqual(["child"])
    const started = await hooks.tool.monitor_run.execute({ command: "printf hi" }, ctx)
    expect(calls.asks).toEqual([{ permission: "bash", patterns: ["printf hi"], always: [], metadata: { operation: "monitor_run", title: "printf hi" } }])
    const monitor = /mon_[A-Za-z0-9_-]+/.exec(text(started))![0]
    expect(text(await hooks.tool.monitor_status.execute({ id: monitor }, ctx))).toContain(monitor)
    expect(text(await hooks.tool.monitor_wait.execute({ id: monitor, timeout_sec: 2 }, ctx))).toContain("completed")
    expect(text(await hooks.tool.monitor_read.execute({ id: monitor }, ctx))).toContain("hi")
  })

  test("setup requests the complete native edit AskInput and unavailable monitors stay honest", async () => {
    const { hooks, ctx, calls } = await setup()
    await hooks.tool.bg_setup.execute({}, ctx)
    expect(calls.asks).toEqual([{
      permission: "edit",
      patterns: [path.join(ctx.worktree, ".opencode", "agent", "orchestrator.md"), path.join(ctx.worktree, ".opencode", "command", "bg.md"), path.join(ctx.worktree, ".gitignore")],
      always: [],
      metadata: { operation: "bg_setup" },
    }])
    const id = "mon_recovered"
    await fs.writeFile(path.join(ctx.worktree, ".opencode", "bg", `${id}.json`), JSON.stringify({ id, state: "running", title: "old", command: "old", cwd: ctx.worktree, ownerSessionID: "root", startedAt: 1, patternSeen: false, live: true }))
    expect(await hooks.tool.monitor_kill.execute({ id }, ctx)).toBe(`Monitor ${id} is unavailable after recovery and cannot be controlled.`)
  })

  test("uses SDK FileDiff records and safely rejects authoritative diff errors", async () => {
    const { hooks, ctx, client } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "diff", prompt: "diff", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "diff" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "diff", args: native }, { output: "", metadata: nativeMetadata("diff-child") })
    const diffQueries: any[] = []
    client.session.messages = async () => ({ data: [
      { info: { id: "initial-turn", role: "user" }, parts: [] },
      { info: { id: "continuation-turn", role: "user" }, parts: [] },
      { info: { id: "assistant-turn", role: "assistant" }, parts: [] },
    ] })
    client.session.diff = async (input: any) => {
      diffQueries.push(input)
      return { data: input.query.messageID === "initial-turn" ? [{ file: "src/a.ts", before: "", after: "x", additions: 1, deletions: 0 }] : [] }
    }
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "ok", files_changed: ["src/a.ts"] }, context("diff-child", ctx.worktree, "implement"))).toContain("completed")
    expect(diffQueries.map((item) => item.query.messageID)).toEqual(["initial-turn", "continuation-turn"])

    const malformed = argsFrom(await hooks.tool.orch_prepare.execute({ title: "bad diff", prompt: "bad diff", agent: "implement", write_roots: ["src/b"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "bad-diff" }, { args: malformed })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "bad-diff", args: malformed }, { output: "", metadata: nativeMetadata("bad-diff-child") })
    client.session.diff = async () => ({ error: { message: "no diff" } })
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "no", files_changed: [] }, context("bad-diff-child", ctx.worktree, "implement"))).toContain("returned an error")
    client.session.diff = async () => ({ data: [{ file: 42 }] })
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "bad", files_changed: [] }, context("bad-diff-child", ctx.worktree, "implement"))).toContain("malformed file entry")
  })

  test("rejects an empty changed-file claim when a message-scoped authoritative diff exists", async () => {
    const { hooks, ctx, client } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "honest diff", prompt: "diff", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "diff" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "diff", args: native }, { output: "", metadata: nativeMetadata("honest-child") })
    client.session.diff = async (input: any) => {
      expect(input).toEqual({ path: { id: "honest-child" }, query: { messageID: "initial-turn" } })
      return { data: [{ file: "src/a.ts" }] }
    }
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "nothing", files_changed: [] }, context("honest-child", ctx.worktree, "implement"))).toContain("does not match")
  })

  test("cancellation before child linkage records and aborts the returned child", async () => {
    const { hooks, ctx, calls } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "link race", prompt: "race", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "race" }, { args: native })
    expect(await hooks.tool.orch_cancel.execute({ id: native.command.split(":")[1] }, ctx)).toContain("Cancelled")
    expect(text(await hooks.tool.orch_status.execute({ id: native.command.split(":")[1] }, ctx))).toContain("leases=src")
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "race", args: native }, { output: "", metadata: nativeMetadata("late-child") })
    expect(calls.abort).toEqual(["late-child"])
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "late-child", callID: "late" }, { args: { filePath: "src/a.ts" } })).rejects.toThrow("cancelled")
  })

  test("root cancellation releases an after-hook-resolved indeterminate dispatch", async () => {
    const { hooks, ctx } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "indeterminate", prompt: "indeterminate", agent: "implement", write_roots: ["src"] }, ctx))
    const id = native.command.split(":")[1]
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "indeterminate" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "indeterminate", args: native }, { output: "", metadata: { error: "native endpoint failed after accepting dispatch" } })
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("[interrupted]")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=src")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=-")
  })

  test("error metadata links and aborts a parent-authenticated child, retrying resolved abort errors", async () => {
    const { hooks, ctx, client, calls } = await setup()
    let attempts = 0
    client.session.abort = async ({ path }: any) => {
      calls.abort.push(path.id)
      attempts += 1
      return attempts === 1 ? { error: { message: "abort unavailable" } } : undefined
    }
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "error child", prompt: "error", agent: "implement", write_roots: ["src"] }, ctx))
    const id = native.command.split(":")[1]
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "error-child" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "error-child", args: native }, { output: "", metadata: { ...nativeMetadata("error-child"), error: "native failed after child creation" } })
    expect(calls.abort).toEqual(["error-child"])
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("native=error-child")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=src")
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "error-child", callID: "late-write" }, { args: { filePath: "src/a.ts" } })).rejects.toThrow("interrupted")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(calls.abort).toEqual(["error-child", "error-child"])
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=-")
  })

  test("error metadata never trusts a child whose parent session does not match", async () => {
    const { hooks, ctx, calls } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "foreign error child", prompt: "error", agent: "implement", write_roots: ["src"] }, ctx))
    const id = native.command.split(":")[1]
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "foreign-error" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "foreign-error", args: native }, { output: "", metadata: { ...nativeMetadata("foreign-child"), parentSessionId: "other-root", error: "failed" } })
    expect(calls.abort).toEqual([])
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).not.toContain("native=foreign-child")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=-")
  })

  test("malformed metadata never aborts a session from another parent", async () => {
    const { hooks, ctx, calls } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "foreign malformed child", prompt: "malformed", agent: "implement", write_roots: ["src"] }, ctx))
    const id = native.command.split(":")[1]
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "foreign-malformed" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "foreign-malformed", args: native }, { output: "", metadata: { ...nativeMetadata("foreign-malformed-child"), parentSessionId: "other-root" } })
    expect(calls.abort).toEqual([])
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).not.toContain("native=foreign-malformed-child")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=-")
  })

  test("a cancelled linked child retries a failed abort and releases its retained lease", async () => {
    const { hooks, ctx, client, calls } = await setup()
    let attempts = 0
    client.session.abort = async ({ path }: any) => {
      calls.abort.push(path.id)
      attempts += 1
      if (attempts === 1) return { error: { message: "transient abort failure" } }
    }
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "retry cancel", prompt: "cancel", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "retry-cancel" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "retry-cancel", args: native }, { output: "", metadata: nativeMetadata("retry-child") })
    const id = native.command.split(":")[1]
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("Cancelled")
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=src")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("retry succeeded")
    expect(calls.abort).toEqual(["retry-child", "retry-child"])
    expect(text(await hooks.tool.orch_status.execute({ id }, ctx))).toContain("leases=-")
    expect(await hooks.tool.orch_cancel.execute({ id }, ctx)).toContain("already cancelled")
  })

  test("blocks writes from blocked, failed, and interrupted native children", async () => {
    const { hooks, ctx } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "terminal writes", prompt: "terminal", agent: "implement", write_roots: ["src"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "terminal" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "terminal", args: native }, { output: "", metadata: nativeMetadata("terminal-child") })
    expect(await hooks.tool.orch_complete.execute({ status: "failed", summary: "failed" }, context("terminal-child", ctx.worktree, "implement"))).toContain("failed")
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "terminal-child", callID: "failed" }, { args: { filePath: "src/a.ts" } })).rejects.toThrow("failed")
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "terminal-child" } } })
    // Failed is already terminal; use an independently interrupted child too.
    const second = argsFrom(await hooks.tool.orch_prepare.execute({ title: "interrupted writes", prompt: "interrupt", agent: "implement", write_roots: ["lib"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "interrupt" }, { args: second })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "interrupt", args: second }, { output: "", metadata: nativeMetadata("interrupted-child") })
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "interrupted-child" } } })
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "interrupted-child", callID: "interrupted" }, { args: { filePath: "lib/a.ts" } })).rejects.toThrow("interrupted")
    const blocked = argsFrom(await hooks.tool.orch_prepare.execute({ title: "blocked writes", prompt: "blocked", agent: "implement", write_roots: ["docs"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "blocked" }, { args: blocked })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "blocked", args: blocked }, { output: "", metadata: nativeMetadata("blocked-child") })
    expect(await hooks.tool.orch_complete.execute({ status: "blocked", summary: "need input" }, context("blocked-child", ctx.worktree, "implement"))).toContain("blocked")
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "blocked-child", callID: "blocked" }, { args: { filePath: "docs/a.ts" } })).rejects.toThrow("blocked")
  })

  test("no-ID orch_start revisits a dependency-blocked task after a continuation recovers its dependency", async () => {
    const { hooks, ctx } = await setup()
    const prerequisite = argsFrom(await hooks.tool.orch_prepare.execute({ title: "prerequisite", prompt: "base", agent: "implement", write_roots: ["base"] }, ctx))
    const dependent = await hooks.tool.orch_prepare.execute({ title: "dependent", prompt: "child", agent: "implement", write_roots: ["child"], depends_on: [prerequisite.command.split(":")[1]] }, ctx)
    expect(argsFrom(dependent).queued).toBe(true)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "base" }, { args: prerequisite })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "base", args: prerequisite }, { output: "", metadata: nativeMetadata("base-child") })
    expect(await hooks.tool.orch_complete.execute({ status: "failed", summary: "retry me" }, context("base-child", ctx.worktree, "implement"))).toContain("failed")
    expect(await hooks.tool.orch_start.execute({}, ctx)).toContain("waiting")
    const resumed = argsFrom(await hooks.tool.orch_continue.execute({ id: prerequisite.command.split(":")[1], message: "retry" }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "resume" }, { args: resumed })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "resume", args: resumed }, { output: "", metadata: nativeMetadata("base-child") })
    expect(await hooks.tool.orch_complete.execute({ status: "done", summary: "recovered", files_changed: [] }, context("base-child", ctx.worktree, "implement"))).toContain("completed")
    expect(argsFrom(await hooks.tool.orch_start.execute({}, ctx)).description).toBe("dependent")
  })

  test("monitor events inject an untrusted-data wake-up into their owner session", async () => {
    const { hooks, ctx, client } = await setup()
    const prompts: any[] = []
    client.session.prompt = async (input: any) => { prompts.push(input) }
    const started = await hooks.tool.monitor_run.execute({ command: "printf ready", wake_pattern: "ready" }, ctx)
    const id = /mon_[A-Za-z0-9_-]+/.exec(text(started))![0]
    await hooks.tool.monitor_wait.execute({ id, timeout_sec: 2 }, ctx)
    await Promise.resolve()
    expect(prompts[0]).toMatchObject({ path: { id: "root" }, body: { parts: [{ type: "text" }] } })
    expect(prompts[0].body.noReply).toBeUndefined()
    expect(prompts[0].body.parts[0].text).toContain("untrusted data")
  })

  test("completion is idempotent and reports cancellation that wins delayed validation", async () => {
    const { hooks, ctx } = await setup()
    const native = argsFrom(await hooks.tool.orch_prepare.execute({ title: "race", prompt: "race", agent: "implement", write_roots: ["src"], validations: ["sleep 0.1; true"] }, ctx))
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "race" }, { args: native })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", callID: "race", args: native }, { output: "", metadata: nativeMetadata("race-child") })
    const specialist = context("race-child", ctx.worktree, "implement")
    const first = hooks.tool.orch_complete.execute({ status: "done", summary: "first", files_changed: [] }, specialist)
    const second = hooks.tool.orch_complete.execute({ status: "done", summary: "second", files_changed: [] }, specialist)
    const secondResult = await second
    expect(secondResult).toContain("already being processed")
    const cancelled = await hooks.tool.orch_cancel.execute({ id: native.command.split(":")[1] }, ctx)
    expect(cancelled).toContain("Cancelled")
    expect(await first).toContain("is cancelled")
    expect(text(await hooks.tool.orch_status.execute({}, ctx))).toContain("[cancelled]")
  })

  test("capability fallback uses only the upstream boolean runtime flag semantics", async () => {
    const name = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
    const previous = process.env[name]
    const previousBroad = process.env.OPENCODE_EXPERIMENTAL
    try {
      process.env.OPENCODE_EXPERIMENTAL = "true"
      process.env[name] = "false"
      const disabled = await setup({ __backgroundSubagents: false })
      expect(text(await disabled.hooks.tool.orch_prepare.execute({ title: "off", prompt: "off", agent: "implement" }, disabled.ctx))).toContain("unavailable")

      process.env[name] = "y"
      const enabled = await setup({ __backgroundSubagents: false })
      expect(argsFrom(await enabled.hooks.tool.orch_prepare.execute({ title: "on", prompt: "on", agent: "implement" }, enabled.ctx))).toMatchObject({ description: "on", background: true })
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
      if (previousBroad === undefined) delete process.env.OPENCODE_EXPERIMENTAL
      else process.env.OPENCODE_EXPERIMENTAL = previousBroad
    }
  })

  test("startup reconciliation accepts the SDK session.status map", async () => {
    const fixture = await pluginFixture(); cleanups.push(fixture.cleanup)
    const stateDir = path.join(fixture.root, ".opencode", "bg")
    await fs.mkdir(stateDir, { recursive: true })
    const store = new TaskStore(path.join(stateDir, "tasks.sqlite"))
    store.createTask({ id: "recovered", state: "running", rootSessionId: "root", prompt: "recover", agent: "implement", title: "recover", writeRoots: [] })
    store.updateTask("recovered", { nativeSessionId: "child" })
    store.close()
    fixture.client.session.status = async () => ({ data: { child: { type: "busy" } } })
    const hooks: any = await BackgroundAgents({ client: fixture.client, directory: fixture.root, worktree: fixture.root } as any, { notifications: false, __backgroundSubagents: true })
    cleanups.push(async () => hooks.dispose())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(text(await hooks.tool.orch_status.execute({}, context("root", fixture.root, "orchestrator", fixture.calls)))).toContain("recovered [running]")
  })
})
