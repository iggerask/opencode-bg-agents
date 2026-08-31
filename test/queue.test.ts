import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskQueue } from "../src/queue"
import { TaskStore } from "../src/store"

const directories: string[] = []
async function storeForTest() {
  const directory = await mkdtemp(join(tmpdir(), "native-orch-queue-"))
  directories.push(directory)
  return new TaskStore(join(directory, "tasks.sqlite"))
}
function create(store: TaskStore, id: string, writeRoots: string[], dependencies: string[] = []) {
  return store.createTask({ id, rootSessionId: "root", prompt: id, agent: "agent", title: id, writeRoots, dependencies })
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe("TaskQueue", () => {
  test("claims FIFO work, enforces capacity, and issues one-time tokens", async () => {
    const store = await storeForTest()
    create(store, "first", ["a"]); create(store, "second", ["b"])
    const queue = new TaskQueue(store, { capacity: 1 })
    const first = queue.next()!
    expect(first.task.id).toBe("first")
    expect(queue.next()).toBeUndefined()
    expect(store.consumeDispatchToken("first", first.token)).toBe(true)
    expect(store.consumeDispatchToken("first", first.token)).toBe(false)
    store.transitionTask("first", "running")
    store.transitionTask("first", "done")
    queue.release("first")
    expect(queue.next()!.task.id).toBe("second")
    store.close()
  })

  test("claiming by id never claims older work", async () => {
    const store = await storeForTest()
    create(store, "older", ["a"]); create(store, "requested", ["b"])
    const queue = new TaskQueue(store, { capacity: 2 })
    expect(queue.claim("requested")?.task.id).toBe("requested")
    expect(store.getTask("older")?.state).toBe("queued")
    store.close()
  })

  test("waits for dependencies, blocks failed dependencies, and skips conflicting leases", async () => {
    const store = await storeForTest()
    create(store, "dependency", ["dep"])
    create(store, "dependent", ["child"], ["dependency"])
    create(store, "conflicting", ["dep/file"])
    const queue = new TaskQueue(store, { capacity: 2 })
    expect(queue.next()!.task.id).toBe("dependency")
    // The independent task is eligible but its root overlaps the live dependency lease.
    expect(queue.next()).toBeUndefined()
    store.transitionTask("dependency", "running")
    store.transitionTask("dependency", "done")
    queue.release("dependency")
    expect(queue.next()!.task.id).toBe("dependent")
    store.close()

    const failed = await storeForTest()
    create(failed, "bad", ["bad"]); create(failed, "blocked", ["good"], ["bad"])
    failed.transitionTask("bad", "failed")
    const failedQueue = new TaskQueue(failed, { capacity: 1 })
    expect(failedQueue.next()).toBeUndefined()
    expect(failed.getTask("blocked")).toMatchObject({ state: "blocked", blockedReason: "dependency bad is failed" })
    failed.close()
  })

  test("reconsiders a dependency-blocked task after its prerequisite recovers", async () => {
    const store = await storeForTest()
    create(store, "dependency", ["dep"])
    create(store, "dependent", ["child"], ["dependency"])
    store.transitionTask("dependency", "failed")
    const queue = new TaskQueue(store, { capacity: 1 })
    expect(queue.claim("dependent")).toBeUndefined()
    expect(store.getTask("dependent")).toMatchObject({ state: "blocked", blockedReason: "dependency dependency is failed" })
    // A continuation/retry may recover a failed prerequisite.
    store.transitionTask("dependency", "starting")
    store.transitionTask("dependency", "running")
    store.transitionTask("dependency", "done")
    expect(queue.claim("dependent")?.task.id).toBe("dependent")
    store.close()
  })
})
