import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ProcessSupervisor } from "../src/monitors"

const temporary: string[] = []

async function supervisor(options: Partial<ConstructorParameters<typeof ProcessSupervisor>[0]> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-root-"))
  const stateDir = path.join(root, "state")
  temporary.push(root)
  return new ProcessSupervisor({ worktree: root, stateDir, ...options })
}

afterEach(async () => {
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
