import { Database } from "bun:sqlite"
import {
  ACTIVE_TASK_STATES,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  type CreateTaskInput,
  type DependencyStatus,
  type DispatchClaim,
  type LeaseAcquireResult,
  type Task,
  type TaskEvent,
  type TaskPatch,
  type TaskState,
} from "./types"

type Row = Record<string, any>
const now = () => Date.now()
const DISPATCH_TOKEN_TTL_MS = 5 * 60 * 1000
const json = (value: unknown) => JSON.stringify(value)
const parseArray = (value: string | null): string[] => (value ? JSON.parse(value) : [])
const optional = (value: unknown): string | undefined => (value == null ? undefined : String(value))
const optionalNumber = (value: unknown): number | undefined => (value == null ? undefined : Number(value))

const transitionTargets: Record<TaskState, readonly TaskState[]> = {
  queued: ["ready", "blocked", "cancelled", "failed", "interrupted"],
  ready: ["starting", "blocked", "queued", "cancelled", "failed", "interrupted"],
  starting: ["running", "queued", "failed", "cancelled", "interrupted"],
  running: ["blocked", "checking", "done", "failed", "cancelled", "interrupted"],
  blocked: ["queued", "ready", "starting", "running", "cancelled", "failed", "interrupted"],
  checking: ["done", "failed", "running", "blocked", "cancelled", "interrupted"],
  done: [],
  failed: ["starting", "cancelled"],
  cancelled: [],
  interrupted: ["queued", "starting", "cancelled"],
}

function taskFromRow(row: Row, dependencies: string[] = []): Task {
  return {
    id: row.id,
    state: row.state as TaskState,
    rootSessionId: row.root_session_id,
    parentSessionId: optional(row.parent_session_id),
    nativeSessionId: optional(row.native_session_id),
    nativeJobId: optional(row.native_job_id),
    prompt: row.prompt,
    agent: row.agent,
    title: row.title,
    writeRoots: parseArray(row.write_roots),
    dependencies,
    validationCommands: parseArray(row.validation_commands),
    result: optional(row.result),
    error: optional(row.error),
    blockedReason: optional(row.blocked_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    readyAt: optionalNumber(row.ready_at),
    startedAt: optionalNumber(row.started_at),
    finishedAt: optionalNumber(row.finished_at),
    dispatchToken: optional(row.dispatch_token),
    dispatchTokenIssuedAt: optionalNumber(row.dispatch_token_issued_at),
    dispatchTokenConsumedAt: optionalNumber(row.dispatch_token_consumed_at),
  }
}

/** SQLite-backed durable task state. Instances are safe to reopen at the same path. */
export class TaskStore {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    // DDL is transactional in SQLite.  Taking the write lock before looking at
    // the version prevents two freshly-created plugin instances from both
    // observing an empty migration table and racing their CREATE statements.
    this.immediate(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
      const version = this.db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as Row
      if ((version?.version ?? 0) >= 2) return
      if ((version?.version ?? 0) === 1) {
        this.db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(now())
        return
      }
      this.db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN (${TASK_STATES.map((s) => `'${s}'`).join(",")})),
        root_session_id TEXT NOT NULL, parent_session_id TEXT, native_session_id TEXT, native_job_id TEXT,
        prompt TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL,
        write_roots TEXT NOT NULL, validation_commands TEXT NOT NULL,
        result TEXT, error TEXT, blocked_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ready_at INTEGER, started_at INTEGER, finished_at INTEGER,
        dispatch_token TEXT UNIQUE, dispatch_token_issued_at INTEGER, dispatch_token_consumed_at INTEGER
      );
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        PRIMARY KEY (task_id, depends_on_task_id), CHECK (task_id <> depends_on_task_id)
      );
      CREATE TABLE write_leases (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        root TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, root)
      );
      CREATE INDEX write_leases_root ON write_leases(root);
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, from_state TEXT, to_state TEXT, kind TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX task_events_task_at ON task_events(task_id, at);
      CREATE INDEX tasks_state_created ON tasks(state, created_at);
    `)
      this.db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?), (2, ?)").run(now(), now())
    })
  }

  /** SQLite writes use BEGIN IMMEDIATE so independent plugin instances serialize claims. */
  private immediate<T>(fn: () => T): T {
    const transaction: any = this.db.transaction(fn)
    return typeof transaction.immediate === "function" ? transaction.immediate() : transaction()
  }

  private deps(id: string): string[] {
    return (this.db.query("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id").all(id) as Row[]).map((r) => r.depends_on_task_id)
  }

  private event(taskId: string, kind: string, fromState?: TaskState, toState?: TaskState, detail?: string): void {
    this.db.query("INSERT INTO task_events(task_id, at, from_state, to_state, kind, detail) VALUES(?,?,?,?,?,?)").run(taskId, now(), fromState ?? null, toState ?? null, kind, detail ?? null)
  }

  createTask(input: CreateTaskInput): Task {
    if (!input.id || !input.rootSessionId || !input.prompt || !input.agent || !input.title) throw new Error("task id, rootSessionId, prompt, agent, and title are required")
    const state = input.state ?? "queued"
    const dependencies = [...new Set(input.dependencies ?? [])]
    const tx = () => this.immediate(() => {
      const existing = this.getTask(input.id)
      if (existing) return existing
      const at = now()
      this.db.query(`INSERT INTO tasks(id,state,root_session_id,parent_session_id,prompt,agent,title,write_roots,validation_commands,created_at,updated_at,ready_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, state, input.rootSessionId, input.parentSessionId ?? null, input.prompt, input.agent, input.title, json(input.writeRoots ?? []), json(input.validationCommands ?? []), at, at, state === "ready" ? at : null)
      for (const dependency of dependencies) this.db.query("INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?,?)").run(input.id, dependency)
      this.event(input.id, "created", undefined, state)
      return this.getTask(input.id)!
    })
    return tx()
  }

  getTask(id: string): Task | undefined {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null
    return row ? taskFromRow(row, this.deps(id)) : undefined
  }

  listTasks(states?: readonly TaskState[]): Task[] {
    const rows = states?.length
      ? (this.db.query(`SELECT * FROM tasks WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at, rowid`).all(...states) as Row[])
      : (this.db.query("SELECT * FROM tasks ORDER BY created_at, rowid").all() as Row[])
    return rows.map((row) => taskFromRow(row, this.deps(row.id)))
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const fields = [
      ["native_session_id", patch.nativeSessionId], ["native_job_id", patch.nativeJobId], ["result", patch.result], ["error", patch.error],
      ["blocked_reason", patch.blockedReason], ["title", patch.title], ["agent", patch.agent], ["prompt", patch.prompt],
    ].filter((entry): entry is [string, string | null] => entry[1] !== undefined)
    if (!fields.length) return this.requireTask(id)
    const tx = () => this.immediate(() => {
      this.requireTask(id)
      const at = now()
      const bindings: any[] = [...fields.map(([, value]) => value), at, id]
      ;(this.db.query(`UPDATE tasks SET ${fields.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ?`) as any).run(...bindings)
      this.event(id, "updated")
      return this.getTask(id)!
    })
    return tx()
  }

  transitionTask(id: string, next: TaskState, detail?: string): Task {
    const tx = () => this.immediate(() => this.transitionUnchecked(id, next, detail))
    return tx()
  }

  private transitionUnchecked(id: string, next: TaskState, detail?: string): Task {
    const task = this.requireTask(id)
    if (task.state === next) return task
    if (!transitionTargets[task.state].includes(next)) throw new Error(`invalid task transition ${task.state} -> ${next}`)
    const at = now()
    const columns: string[] = ["state = ?", "updated_at = ?"]
    const values: any[] = [next, at]
    if (next === "ready") { columns.push("ready_at = ?", "blocked_reason = NULL"); values.push(at) }
    if (next === "starting") { columns.push("started_at = ?", "blocked_reason = NULL", "finished_at = NULL", "error = NULL"); values.push(at) }
    if ((TERMINAL_TASK_STATES as readonly TaskState[]).includes(next) && !(task.state === "starting" && task.dispatchTokenConsumedAt && !task.nativeSessionId)) {
      columns.push("finished_at = ?", "dispatch_token = NULL", "dispatch_token_issued_at = NULL", "dispatch_token_consumed_at = NULL")
      values.push(at)
    }
    ;(this.db.query(`UPDATE tasks SET ${columns.join(", ")} WHERE id = ?`) as any).run(...values, id)
    this.event(id, "transition", task.state, next, detail)
    return this.getTask(id)!
  }

  /** Compare-and-swap state transition. Returns undefined when another path won. */
  transitionIf(id: string, expected: TaskState | readonly TaskState[], next: TaskState, detail?: string): Task | undefined {
    return this.transitionWithPatchIf(id, expected, next, detail)
  }

  /** Compare-and-swap a state transition and its outcome fields in one write. */
  transitionWithPatchIf(id: string, expected: TaskState | readonly TaskState[], next: TaskState, detail?: string, patch: TaskPatch = {}): Task | undefined {
    const expectedStates = Array.isArray(expected) ? expected : [expected]
    return this.immediate(() => {
      const task = this.requireTask(id)
      if (!expectedStates.includes(task.state)) return undefined
      if (!transitionTargets[task.state].includes(next)) throw new Error(`invalid task transition ${task.state} -> ${next}`)
      const at = now()
      const fields = new Map<string, unknown>([["state", next], ["updated_at", at]])
      if (next === "ready") { fields.set("ready_at", at); fields.set("blocked_reason", null) }
      if (next === "starting") { fields.set("started_at", at); fields.set("blocked_reason", null); fields.set("finished_at", null); fields.set("error", null) }
      if ((TERMINAL_TASK_STATES as readonly TaskState[]).includes(next) && !(task.state === "starting" && task.dispatchTokenConsumedAt && !task.nativeSessionId)) {
        fields.set("finished_at", at); fields.set("dispatch_token", null); fields.set("dispatch_token_issued_at", null); fields.set("dispatch_token_consumed_at", null)
      }
      const patchFields: [string, unknown][] = [
        ["native_session_id", patch.nativeSessionId], ["native_job_id", patch.nativeJobId], ["result", patch.result], ["error", patch.error],
        ["blocked_reason", patch.blockedReason], ["title", patch.title], ["agent", patch.agent], ["prompt", patch.prompt],
      ]
      for (const [field, value] of patchFields) if (value !== undefined) fields.set(field, value)
      const columns = [...fields.keys()].map((field) => `${field} = ?`)
      const values = [...fields.values()]
      const result = (this.db.query(`UPDATE tasks SET ${columns.join(", ")} WHERE id = ? AND state IN (${expectedStates.map(() => "?").join(",")})`) as any).run(...values, id, ...expectedStates)
      if (result.changes !== 1) return undefined
      this.event(id, "transition", task.state, next, detail)
      return this.getTask(id)!
    })
  }

  addDependency(taskId: string, dependsOnTaskId: string): void {
    if (taskId === dependsOnTaskId) throw new Error("a task cannot depend on itself")
    const tx = () => this.immediate(() => {
      this.requireTask(taskId); this.requireTask(dependsOnTaskId)
      const reachable = this.db.query(`WITH RECURSIVE descendants(id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
        UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN descendants x ON d.task_id = x.id
      ) SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1`).get(dependsOnTaskId, taskId) as Row | null
      if (reachable) throw new Error(`dependency cycle: ${taskId} -> ${dependsOnTaskId}`)
      this.db.query("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_task_id) VALUES(?,?)").run(taskId, dependsOnTaskId)
      this.event(taskId, "dependency_added", undefined, undefined, dependsOnTaskId)
    })
    tx()
  }

  dependencyStatus(taskId: string): DependencyStatus {
    this.requireTask(taskId)
    const rows = this.db.query(`SELECT t.id, t.state FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ? ORDER BY t.id`).all(taskId) as Row[]
    const failed = rows.filter((r) => ["failed", "cancelled", "interrupted"].includes(r.state))
    if (failed.length) return { ready: false, pending: [], blockedReason: `dependency ${failed[0].id} is ${failed[0].state}` }
    const pending = rows.filter((r) => r.state !== "done").map((r) => r.id)
    return { ready: pending.length === 0, pending }
  }

  activeCount(): number {
    return Number((this.db.query(`SELECT COUNT(*) AS count FROM tasks WHERE state IN (${ACTIVE_TASK_STATES.map(() => "?").join(",")})`).get(...ACTIVE_TASK_STATES) as Row).count)
  }

  acquireLeases(taskId: string, roots: readonly string[]): LeaseAcquireResult {
    const tx = () => this.immediate(() => this.acquireLeasesUnchecked(taskId, roots))
    return tx()
  }

  private acquireLeasesUnchecked(taskId: string, roots: readonly string[]): LeaseAcquireResult {
    const wanted = [...new Set(roots)].sort()
    this.requireTask(taskId)
    const leases = this.db.query("SELECT task_id, root FROM write_leases WHERE task_id <> ?").all(taskId) as Row[]
    const conflicts = leases.filter((lease) => wanted.some((root) => overlaps(root, lease.root))).map((lease) => ({ taskId: lease.task_id, root: lease.root }))
    if (conflicts.length) return { acquired: false, conflicts }
    const at = now()
    for (const root of wanted) this.db.query("INSERT OR IGNORE INTO write_leases(task_id, root, acquired_at) VALUES(?,?,?)").run(taskId, root, at)
    if (wanted.length) this.event(taskId, "leases_acquired", undefined, undefined, json(wanted))
    return { acquired: true, conflicts: [] }
  }

  releaseLeases(taskId: string): number {
    const tx = () => this.immediate(() => {
      const task = this.requireTask(taskId)
      // A token was accepted but the task hook has not supplied the child ID.
      // Keep the lease until that hook either links/aborts the child or rolls
      // back; otherwise a cancelled child could overlap a new writer.
      if (task.dispatchTokenConsumedAt && !task.nativeSessionId) return 0
      return this.releaseLeasesUnchecked(taskId)
    })
    return tx()
  }

  /**
   * Release only a cancellation that was first made indeterminate, then
   * explicitly resolved by the root.  A direct cancellation while a consumed
   * task after-hook is still pending retains its token and is intentionally
   * ineligible for this escape hatch.
   */
  releaseResolvedUnlinkedCancellation(taskId: string): number {
    return this.immediate(() => {
      const task = this.requireTask(taskId)
      if (task.state !== "cancelled" || task.nativeSessionId || task.dispatchToken || task.dispatchTokenIssuedAt || task.dispatchTokenConsumedAt) return 0
      return this.releaseLeasesUnchecked(taskId)
    })
  }

  /** Mark that an after-hook completed without yielding an authenticated child. */
  markUnlinkedDispatchResolved(taskId: string): boolean {
    return this.immediate(() => {
      const task = this.requireTask(taskId)
      if (!(["interrupted", "cancelled"] as TaskState[]).includes(task.state) || task.nativeSessionId || !task.dispatchTokenConsumedAt) return false
      const result = this.db.query("UPDATE tasks SET dispatch_token = NULL, dispatch_token_issued_at = NULL, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ? AND native_session_id IS NULL AND dispatch_token_consumed_at IS NOT NULL").run(now(), taskId)
      if (result.changes) this.event(taskId, "unlinked_dispatch_resolved")
      return result.changes === 1
    })
  }

  private releaseLeasesUnchecked(taskId: string): number {
    const result = this.db.query("DELETE FROM write_leases WHERE task_id = ?").run(taskId)
    if (result.changes) this.event(taskId, "leases_released")
    return result.changes
  }

  listLeases(taskId?: string): { taskId: string; root: string; acquiredAt: number }[] {
    const rows = (taskId ? this.db.query("SELECT * FROM write_leases WHERE task_id = ? ORDER BY root").all(taskId) : this.db.query("SELECT * FROM write_leases ORDER BY root, task_id").all()) as Row[]
    return rows.map((row) => ({ taskId: row.task_id, root: row.root, acquiredAt: Number(row.acquired_at) }))
  }

  consumeDispatchToken(taskId: string, token: string): boolean {
    const tx = () => this.immediate(() => {
      this.recoverExpiredDispatchesUnchecked()
      const at = now()
      const result = this.db.query("UPDATE tasks SET dispatch_token_consumed_at = ?, updated_at = ? WHERE id = ? AND state = 'starting' AND dispatch_token = ? AND dispatch_token_consumed_at IS NULL AND dispatch_token_issued_at >= ?").run(at, at, taskId, token, at - DISPATCH_TOKEN_TTL_MS)
      if (result.changes) this.event(taskId, "dispatch_token_consumed")
      return result.changes === 1
  })
    return tx()
  }

  /** Atomically associate the child only after the native task call consumed its token. */
  linkNativeChild(id: string, nativeSessionId: string, nativeJobId?: string): Task | undefined {
    return this.immediate(() => {
      const task = this.requireTask(id)
      if (!task.dispatchTokenConsumedAt) return undefined
      const at = now()
      // Continuations deliberately resume the same native session.  Do not
      // overwrite that durable identity, but do complete the starting ->
      // running handshake for the fresh dispatch.
      if (task.nativeSessionId) {
        if (task.nativeSessionId !== nativeSessionId || task.state !== "starting") return undefined
        const resumed = this.db.query("UPDATE tasks SET native_job_id = ?, state = 'running', updated_at = ? WHERE id = ? AND state = 'starting' AND dispatch_token_consumed_at IS NOT NULL").run(nativeJobId ?? task.nativeJobId ?? null, at, id)
        if (resumed.changes !== 1) return undefined
        this.event(id, "native_child_resumed", "starting", "running", nativeSessionId)
        return this.getTask(id)!
      }
      // Cancellation can win after the native task endpoint accepted its
      // token but before this after-hook receives the child metadata.  Record
      // that child even in a terminal state so write hooks can deny it and the
      // caller can abort it.  A still-starting task becomes normally running.
      const terminal = (TERMINAL_TASK_STATES as readonly TaskState[]).includes(task.state)
      const linked = this.db.query(`UPDATE tasks SET native_session_id = ?, native_job_id = ?, state = ?,
        dispatch_token = ${terminal ? "NULL" : "dispatch_token"}, dispatch_token_issued_at = ${terminal ? "NULL" : "dispatch_token_issued_at"}, dispatch_token_consumed_at = ${terminal ? "NULL" : "dispatch_token_consumed_at"}, updated_at = ?
        WHERE id = ? AND native_session_id IS NULL AND dispatch_token_consumed_at IS NOT NULL`).run(nativeSessionId, nativeJobId ?? null, task.state === "starting" ? "running" : task.state, at, id)
      if (linked.changes !== 1) return undefined
      this.event(id, "native_child_linked", task.state, task.state === "starting" ? "running" : task.state, nativeSessionId)
      return this.getTask(id)!
    })
  }

  /** Claims completion validation exactly once. */
  claimCompletion(id: string): Task | undefined { return this.transitionIf(id, "running", "checking", "completion submitted") }

  /** Tasks whose native execution must be reconciled after a process restart. */
  listStartupTasks(): Task[] { return this.listTasks(["starting", "running", "checking"]) }
  listInFlightTasks(): Task[] { return this.listStartupTasks() }

  /** Mark in-flight work interrupted. An unlinked dispatch remains indeterminate and keeps its lease. */
  interruptInFlight(reason = "controller restarted"): Task[] {
    const tx = () => this.immediate(() => {
      const tasks = this.listStartupTasks()
      for (const task of tasks) {
        this.transitionUnchecked(task.id, "interrupted", reason)
        if (task.nativeSessionId) this.releaseLeasesUnchecked(task.id)
      }
      return tasks.map((task) => this.getTask(task.id)!)
    })
    return tx()
  }

  listEvents(taskId: string): TaskEvent[] {
    return (this.db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map((row) => ({ id: Number(row.id), taskId: row.task_id, at: Number(row.at), fromState: optional(row.from_state) as TaskState | undefined, toState: optional(row.to_state) as TaskState | undefined, kind: row.kind, detail: optional(row.detail) }))
  }

  /** Atomically select the oldest dispatchable task, lock its roots, and issue a single-use token. */
  claimOldestDispatchable(capacity: number): DispatchClaim | undefined {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer")
    const tx = () => this.immediate(() => {
      this.recoverExpiredDispatchesUnchecked()
      if (this.activeCount() >= capacity) return undefined
      const candidates = this.listTasks(["queued", "ready", "blocked"])
      for (const task of candidates) {
        const dependencies = this.dependencyStatus(task.id)
        if (dependencies.blockedReason) {
          if (task.state !== "blocked") this.transitionUnchecked(task.id, "blocked", dependencies.blockedReason)
          this.db.query("UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE id = ?").run(dependencies.blockedReason, now(), task.id)
          this.event(task.id, "updated")
          continue
        }
        if (!dependencies.ready) continue
        if (task.state === "blocked") {
          if (!task.blockedReason?.startsWith("dependency ")) continue
          this.transitionUnchecked(task.id, "queued", "dependency recovered")
        }
        if (this.requireTask(task.id).state === "queued") this.transitionUnchecked(task.id, "ready", "dependencies complete")
        const lease = this.acquireLeasesUnchecked(task.id, task.writeRoots)
        if (!lease.acquired) continue
        const token = crypto.randomUUID()
        const at = now()
        this.db.query("UPDATE tasks SET dispatch_token = ?, dispatch_token_issued_at = ?, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ?").run(token, at, at, task.id)
        const starting = this.transitionUnchecked(task.id, "starting", "dispatch claimed")
        this.event(task.id, "dispatch_token_issued")
        return { task: starting, token }
      }
      return undefined
    })
    return tx()
  }

  /** Atomically claim one named task; unlike FIFO dispatch it never steals another task. */
  claimTaskIfEligible(id: string, capacity: number): DispatchClaim | undefined {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer")
    const tx = () => this.immediate(() => {
      this.recoverExpiredDispatchesUnchecked()
      const task = this.requireTask(id)
      const dependencyBlocked = task.state === "blocked" && task.blockedReason?.startsWith("dependency ")
      if (!(dependencyBlocked || (["queued", "ready"] as TaskState[]).includes(task.state)) || this.activeCount() >= capacity) return undefined
      const dependencies = this.dependencyStatus(id)
      if (dependencies.blockedReason) {
        if (task.state !== "blocked") this.transitionUnchecked(id, "blocked", dependencies.blockedReason)
        this.updateTask(id, { blockedReason: dependencies.blockedReason })
        return undefined
      }
      if (!dependencies.ready) return undefined
      if (task.state === "blocked") this.transitionUnchecked(id, "queued", "dependency recovered")
      if (this.requireTask(id).state === "queued") this.transitionUnchecked(id, "ready", "dependencies complete")
      const current = this.requireTask(id)
      const lease = this.acquireLeasesUnchecked(id, current.writeRoots)
      if (!lease.acquired) return undefined
      const token = crypto.randomUUID()
      const at = now()
      this.db.query("UPDATE tasks SET dispatch_token = ?, dispatch_token_issued_at = ?, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ?").run(token, at, at, id)
      const starting = this.transitionUnchecked(id, "starting", "dispatch claimed")
      this.event(id, "dispatch_token_issued")
      return { task: starting, token }
    })
    return tx()
  }

  /** Reserve a retry against the same native session, with fresh leases and token. */
  claimContinuation(id: string, capacity: number, prompt?: string): DispatchClaim | undefined {
    const tx = () => this.immediate(() => {
      this.recoverExpiredDispatchesUnchecked()
      const task = this.requireTask(id)
      if (!task.nativeSessionId || !(["blocked", "failed", "interrupted"] as TaskState[]).includes(task.state) || this.activeCount() >= capacity) return undefined
      const lease = this.acquireLeasesUnchecked(id, task.writeRoots)
      if (!lease.acquired) return undefined
      const token = crypto.randomUUID()
      const at = now()
      this.db.query("UPDATE tasks SET prompt = ?, dispatch_token = ?, dispatch_token_issued_at = ?, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ?").run(prompt ?? task.prompt, token, at, at, id)
      const starting = this.transitionUnchecked(id, "starting", "continuation claimed")
      this.event(id, "dispatch_token_issued")
      return { task: starting, token }
    })
    return tx()
  }

  rollbackDispatch(id: string, reason = "native task was not started"): Task {
    const tx = () => this.immediate(() => {
      const task = this.requireTask(id)
      if (task.state === "starting") this.transitionUnchecked(id, task.nativeSessionId ? "interrupted" : "queued", reason)
      this.db.query("UPDATE tasks SET dispatch_token = NULL, dispatch_token_issued_at = NULL, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ?").run(now(), id)
      // A task that never linked has no execution to protect; linked tasks are interrupted above.
      if (!task.nativeSessionId) this.releaseLeasesUnchecked(id)
      return this.requireTask(id)
    })
    return tx()
  }

  /** Recover claims whose one-use capability was never consumed. */
  recoverExpiredDispatches(): number {
    return this.immediate(() => this.recoverExpiredDispatchesUnchecked())
  }

  private recoverExpiredDispatchesUnchecked(): number {
    const expired = this.db.query("SELECT id FROM tasks WHERE state = 'starting' AND dispatch_token_consumed_at IS NULL AND dispatch_token_issued_at IS NOT NULL AND dispatch_token_issued_at < ?").all(now() - DISPATCH_TOKEN_TTL_MS) as Row[]
    for (const row of expired) {
      this.transitionUnchecked(row.id, "queued", "dispatch token expired before native task start")
      this.db.query("UPDATE tasks SET dispatch_token = NULL, dispatch_token_issued_at = NULL, dispatch_token_consumed_at = NULL, updated_at = ? WHERE id = ?").run(now(), row.id)
      this.releaseLeasesUnchecked(row.id)
      this.event(row.id, "dispatch_expired")
    }
    return expired.length
  }

  findByNativeSession(sessionId: string): Task | undefined {
    const row = this.db.query("SELECT * FROM tasks WHERE native_session_id = ?").get(sessionId) as Row | null
    return row ? taskFromRow(row, this.deps(row.id)) : undefined
  }

  private requireTask(id: string): Task {
    const task = this.getTask(id)
    if (!task) throw new Error(`unknown task: ${id}`)
    return task
  }
}

function overlaps(left: string, right: string): boolean {
  return left === "." || right === "." || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export const openTaskStore = (path: string) => new TaskStore(path)
export const createTaskStore = openTaskStore
export { TaskStore as Store }
