import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskStore } from "../src/store"

const paths: string[] = []
async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "native-orch-store-"))
  paths.push(directory)
  return join(directory, "tasks.sqlite")
}
function task(id: string, dependencies: string[] = []) {
  return { id, rootSessionId: "root", prompt: `prompt ${id}`, agent: "implement", title: id, writeRoots: [id], dependencies }
}
afterEach(async () => { await Promise.all(paths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe("TaskStore", () => {
  test("migrates once and reopens current task state", async () => {
    const path = await databasePath()
    const first = new TaskStore(path)
    first.createTask(task("a"))
    first.transitionTask("a", "ready")
    first.updateTask("a", { nativeSessionId: "ses_a" })
    first.close()

    const reopened = new TaskStore(path)
    expect(reopened.getTask("a")).toMatchObject({ id: "a", state: "ready", nativeSessionId: "ses_a", dependencies: [] })
    expect(reopened.listEvents("a").map((event) => event.kind)).toEqual(["created", "transition", "updated"])
    reopened.close()
  })

  test("rejects dependency cycles", async () => {
    const store = new TaskStore(await databasePath())
    store.createTask(task("a"))
    store.createTask(task("b", ["a"]))
    expect(() => store.addDependency("a", "b")).toThrow("dependency cycle")
    store.close()
  })

  test("persists dependencies, reports failed prerequisites, and leases overlap exactly", async () => {
    const store = new TaskStore(await databasePath())
    store.createTask(task("base"))
    store.createTask(task("child", ["base"]))
    expect(store.dependencyStatus("child")).toEqual({ ready: false, pending: ["base"] })
    store.transitionTask("base", "failed", "broken")
    expect(store.dependencyStatus("child").blockedReason).toBe("dependency base is failed")

    expect(store.acquireLeases("base", ["src"])).toEqual({ acquired: true, conflicts: [] })
    expect(store.acquireLeases("base", ["src"])).toEqual({ acquired: true, conflicts: [] })
    expect(store.acquireLeases("child", ["src/lib"])).toEqual({ acquired: false, conflicts: [{ taskId: "base", root: "src" }] })
    expect(store.acquireLeases("child", ["docs"])).toEqual({ acquired: true, conflicts: [] })
    expect(store.releaseLeases("base")).toBe(1)
    expect(store.acquireLeases("child", ["src/lib"])).toEqual({ acquired: true, conflicts: [] })
    store.close()
  })

  test("consumes dispatch once and links a child only from consumed starting state", async () => {
    const store = new TaskStore(await databasePath())
    store.createTask(task("a"))
    const claim = store.claimTaskIfEligible("a", 1)!
    expect(store.linkNativeChild("a", "child")).toBeUndefined()
    expect(store.consumeDispatchToken("a", claim.token)).toBe(true)
    expect(store.consumeDispatchToken("a", claim.token)).toBe(false)
    expect(store.linkNativeChild("a", "child")?.state).toBe("running")
    expect(store.linkNativeChild("a", "other")).toBeUndefined()
    store.close()
  })
})
