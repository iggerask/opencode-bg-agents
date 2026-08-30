import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createValidationRunner } from "../src/validation"

const temporaryDirectories: string[] = []
const descendantPids: number[] = []

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code !== "ESRCH"
  }
}

async function waitForPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    try {
      const pid = Number(await fs.readFile(filePath, "utf8"))
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("descendant PID was not written")
}

async function eventually(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "validation-runner-"))
  temporaryDirectories.push(directory)
  const root = path.join(directory, "worktree")
  await fs.mkdir(root)
  return { directory, root, logs: path.join(directory, "logs") }
}

afterEach(async () => {
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test("runs successful validations and saves their output", async () => {
  const { root, logs } = await workspace()
  const results = await createValidationRunner({ worktree: root, stateDir: logs }).run(["printf success"])

  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ command: "printf success", state: "success", exitCode: 0, output: "success" })
  expect(await fs.readFile(results[0].logPath, "utf8")).toBe("success")
})

test("stops at the first failing validation by default", async () => {
  const { root, logs } = await workspace()
  const marker = path.join(root, "should-not-exist")
  const results = await createValidationRunner(root, logs).run(["exit 7", `touch ${JSON.stringify(marker)}`])

  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ state: "failure", exitCode: 7 })
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
})

test("times out a validation", async () => {
  const { root, logs } = await workspace()
  const [result] = await createValidationRunner({ worktree: root, stateDir: logs, timeoutMs: 30 }).run(["sleep 2"])

  expect(result.state).toBe("timeout")
  expect(result.durationMs).toBeLessThan(1500)
})

test("aborts a validation", async () => {
  const { root, logs } = await workspace()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30)
  const [result] = await createValidationRunner({ worktree: root, stateDir: logs }).run(["sleep 2"], {
    signal: controller.signal,
  })
  clearTimeout(timer)

  expect(result.state).toBe("aborted")
})

test.if(process.platform === "linux" && Boolean((Bun as any).which?.("setsid")))("escalates timeout cleanup after a shell leader exits", async () => {
  const { root, logs } = await workspace()
  const pidPath = path.join(root, "descendant.pid")
  const command = `(trap '' TERM; exec sleep 3) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}; trap 'exit 0' TERM; while :; do sleep 1; done`
  const [result] = await createValidationRunner({ worktree: root, stateDir: logs, timeoutMs: 500 }).run([command])
  const pid = await waitForPid(pidPath)
  descendantPids.push(pid)

  expect(result.state).toBe("timeout")
  expect(await eventually(() => !processExists(pid))).toBe(true)
})

test.if(process.platform === "linux" && Boolean((Bun as any).which?.("setsid")))("escalates abort cleanup after a shell leader exits", async () => {
  const { root, logs } = await workspace()
  const pidPath = path.join(root, "descendant.pid")
  const controller = new AbortController()
  const command = `(trap '' TERM; exec sleep 2) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}; trap 'exit 0' TERM; while :; do sleep 1; done`
  const running = createValidationRunner({ worktree: root, stateDir: logs }).run([command], { signal: controller.signal })
  // If setup fails before the child reports its PID, abort in finally and wait
  // for the runner's bounded cleanup rather than leaving a live test promise.
  void running.catch(() => {})
  try {
    const pid = await waitForPid(pidPath)
    descendantPids.push(pid)
    controller.abort()
    const [result] = await running

    expect(result.state).toBe("aborted")
    expect(await eventually(() => !processExists(pid))).toBe(true)
  } finally {
    if (!controller.signal.aborted) controller.abort()
    await Promise.race([
      running.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ])
  }
})

test("truncates returned output while retaining the complete log", async () => {
  const { root, logs } = await workspace()
  const [result] = await createValidationRunner({ worktree: root, stateDir: logs, maxOutputBytes: 32 }).run([
    "yes validation-output | head -c 1024",
  ])

  expect(new TextEncoder().encode(result.output).byteLength).toBeLessThanOrEqual(32)
  expect((await fs.readFile(result.logPath, "utf8")).length).toBeGreaterThan(32)
})

test("rejects a cwd that escapes the worktree", async () => {
  const { directory, root, logs } = await workspace()
  await fs.mkdir(path.join(directory, "outside"))
  const runner = createValidationRunner({ worktree: root, stateDir: logs })

  await expect(runner.run(["pwd"], { cwd: "../outside" })).rejects.toThrow(/inside the worktree/)
})
