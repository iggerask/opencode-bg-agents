import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ProcessSupervisor } from "../src/monitors"

const temporary: string[] = []
const descendantPids: number[] = []

async function eventually(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

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

async function supervisor(options: Partial<ConstructorParameters<typeof ProcessSupervisor>[0]> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-root-"))
  const stateDir = path.join(root, "state")
  temporary.push(root)
  return new ProcessSupervisor({ worktree: root, stateDir, ...options })
}

afterEach(async () => {
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("captures output and sends a readiness event", async () => {
  const events: string[] = []
  const monitors = await supervisor({ notify: (event) => events.push(event.type) })
  const record = await monitors.start({ command: "printf 'ready now\\n'; sleep 1", ownerSessionID: "s", wakePattern: "ready now" })
  const result = await monitors.wait(record.id, 2)
  expect(result.reason).toBe("ready")
  await monitors.wait(record.id, 2)
  expect(await monitors.read(record.id)).toContain("ready now")
  expect(events).toContain("ready")
  await monitors.dispose()
})

test("persists exit state and combined stdout/stderr log", async () => {
  const monitors = await supervisor()
  const started = await monitors.start({ command: "printf out; printf err >&2; exit 7", ownerSessionID: "s" })
  const finished = await monitors.wait(started.id, 2)
  expect(finished.record?.state).toBe("done")
  expect(finished.record?.exitCode).toBe(7)
  expect(await monitors.read(started.id)).toContain("out")
  expect(await monitors.read(started.id)).toContain("err")
  const restarted = new ProcessSupervisor({ worktree: path.dirname(path.dirname(started.logPath)), stateDir: path.dirname(started.logPath) })
  expect((await restarted.get(started.id))?.exitCode).toBe(7)
  await monitors.dispose()
})

test("rejects invalid readiness regexes and cwd escapes", async () => {
  const monitors = await supervisor()
  await expect(monitors.start({ command: "true", ownerSessionID: "s", wakePattern: "[" })).rejects.toThrow("Invalid wake_pattern")
  await expect(monitors.start({ command: "true", ownerSessionID: "s", cwd: "/tmp" })).rejects.toThrow("within worktree")
  await monitors.dispose()

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-symlink-root-"))
  temporary.push(root)
  await fs.symlink("/tmp", path.join(root, "escape"))
  const symlinked = new ProcessSupervisor({ worktree: root, stateDir: path.join(root, "state") })
  await expect(symlinked.start({ command: "true", ownerSessionID: "s", cwd: "escape" })).rejects.toThrow("within worktree")
  await symlinked.dispose()
})

test("stops monitors and applies timeout", async () => {
  const monitors = await supervisor()
  const killed = await monitors.start({ command: "sleep 10", ownerSessionID: "s" })
  await monitors.stop(killed.id)
  expect((await monitors.wait(killed.id, 3)).record?.state).toBe("killed")
  const timed = await monitors.start({ command: "sleep 10", ownerSessionID: "s", timeoutSec: 0.02 })
  expect((await monitors.wait(timed.id, 3)).record?.state).toBe("timeout")
  await monitors.dispose()
})

test("enforces concurrency and disposal prevents late notifications", async () => {
  const events: string[] = []
  const monitors = await supervisor({ maxConcurrent: 1, notify: (event) => events.push(event.type) })
  await monitors.start({ command: "sleep 10", ownerSessionID: "s" })
  await expect(monitors.start({ command: "sleep 10", ownerSessionID: "s" })).rejects.toThrow("Monitor limit")
  await monitors.dispose()
  expect(events).toEqual([])
})

test("cleans a process group when metadata persistence fails after spawn", async () => {
  const monitors = await supervisor()
  const pidPath = path.join((monitors as any).stateDir, "failed-start.pid")
  // This private seam models a disk/rename failure precisely after spawn. The
  // seam waits for the live leader PID first, making the post-spawn failure and
  // the assertion that cleanup actually kills OS work deterministic.
  ;(monitors as any).writeMetadata = async () => {
    await waitForPid(pidPath)
    throw new Error("sidecar unavailable")
  }
  let pid: number | undefined
  try {
    await expect(monitors.start({ command: `echo $$ > ${JSON.stringify(pidPath)}; exec sleep 3`, ownerSessionID: "s" })).rejects.toThrow("sidecar unavailable")
    pid = await waitForPid(pidPath)
    descendantPids.push(pid)
    expect((monitors as any).monitors.size).toBe(0)
    expect(await eventually(() => !processExists(pid!))).toBe(true)
    await Promise.race([
      monitors.dispose(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispose hung")), 2000)),
    ])
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGKILL") } catch {}
    }
    await monitors.dispose()
  }
})

test.if(process.platform === "linux" && Boolean((Bun as any).which?.("setsid")))("escalates after the shell leader exits so redirected descendants do not survive", async () => {
  const monitors = await supervisor()
  const pidPath = path.join((monitors as any).stateDir, "descendant.pid")
  const command = `(trap '' TERM; exec sleep 2) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}; trap 'exit 0' TERM; while :; do sleep 1; done`
  const record = await monitors.start({ command, ownerSessionID: "s" })
  // The shell writes its child PID before entering its loop; read it only once
  // the file is present to keep the test independent of scheduling.
  const pid = await waitForPid(pidPath)
  descendantPids.push(pid)
  await monitors.stop(record.id)
  expect((await monitors.wait(record.id, 3)).record?.state).toBe("killed")
  expect(await eventually(() => !processExists(pid))).toBe(true)
  await monitors.dispose()
})

test.if(process.platform === "linux" && Boolean((Bun as any).which?.("setsid")))("cleans redirected descendants after ordinary shell completion", async () => {
  const monitors = await supervisor()
  const pidPath = path.join((monitors as any).stateDir, "ordinary-descendant.pid")
  const command = `(trap '' TERM; exec sleep 2) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}; exit 0`
  const record = await monitors.start({ command, ownerSessionID: "s" })
  const pid = await waitForPid(pidPath)
  descendantPids.push(pid)

  expect((await monitors.wait(record.id, 3)).record?.state).toBe("done")
  expect(await eventually(() => !processExists(pid))).toBe(true)
  await monitors.dispose()
})

test("recovers an unclean running sidecar as unavailable and derives paths", async () => {
  const monitors = await supervisor()
  const stateDir = (monitors as any).stateDir as string
  await fs.mkdir(stateDir, { recursive: true })
  const id = "mon_recovered"
  await fs.writeFile(path.join(stateDir, `${id}.json`), JSON.stringify({ id, state: "running", title: "old", command: "old", cwd: "/", ownerSessionID: "owner", startedAt: 1, logPath: "/forged", metadataPath: "/forged", exitCodePath: "/forged", patternSeen: false, live: true }))
  const record = await monitors.get(id)
  expect(record).toMatchObject({ state: "unavailable", live: false, logPath: path.join(stateDir, `${id}.log`) })
  await monitors.dispose()
})
