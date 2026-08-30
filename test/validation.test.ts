import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createValidationRunner } from "../src/validation"

const temporaryDirectories: string[] = []

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "validation-runner-"))
  temporaryDirectories.push(directory)
  const root = path.join(directory, "worktree")
  await fs.mkdir(root)
  return { directory, root, logs: path.join(directory, "logs") }
}

afterEach(async () => {
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
