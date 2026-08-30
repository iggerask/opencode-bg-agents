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

  test("keeps a consumed cancelled dispatch leased until late child metadata is linked", async () => {
    const store = new TaskStore(await databasePath())
    store.createTask(task("race"))
    const claim = store.claimTaskIfEligible("race", 1)!
    expect(store.consumeDispatchToken("race", claim.token)).toBe(true)
    store.transitionTask("race", "cancelled", "cancel won")
    expect(store.releaseLeases("race")).toBe(0)
    const linked = store.linkNativeChild("race", "late-child")
    expect(linked).toMatchObject({ state: "cancelled", nativeSessionId: "late-child" })
    expect(store.releaseLeases("race")).toBe(1)
    store.close()
  })

  test("recovers an unconsumed expired dispatch atomically before a new claim", async () => {
    const store = new TaskStore(await databasePath())
    store.createTask(task("expired"))
    store.createTask(task("next"))
    const expired = store.claimTaskIfEligible("expired", 1)!
    store.db.query("UPDATE tasks SET dispatch_token_issued_at = ? WHERE id = ?").run(Date.now() - 6 * 60 * 1000, "expired")
    const next = store.claimTaskIfEligible("next", 1)
    expect(next?.task.id).toBe("next")
    expect(store.getTask("expired")).toMatchObject({ state: "queued", dispatchToken: undefined })
    expect(store.listLeases("expired")).toEqual([])
    // The expired capability cannot be consumed after recovery.
    expect(store.consumeDispatchToken("expired", expired.token)).toBe(false)
    store.close()
  })

  test("serializes fresh-schema migration across two open stores", async () => {
    const path = await databasePath()
    const first = new TaskStore(path)
    const second = new TaskStore(path)
    first.createTask(task("first"))
    expect(second.getTask("first")?.id).toBe("first")
    second.close()
    first.close()
  })
})
