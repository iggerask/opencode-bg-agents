import * as fs from "node:fs/promises"
import * as path from "node:path"

export type MonitorState = "running" | "done" | "killed" | "timeout" | "unavailable"
export type TerminalMonitorState = Exclude<MonitorState, "running" | "unavailable">

export interface MonitorRecord {
  id: string
  title: string
  command: string
  cwd: string
  ownerSessionID: string
  state: MonitorState
  startedAt: number
  endedAt?: number
  exitCode?: number
  logPath: string
  metadataPath: string
  exitCodePath: string
  pid?: number
  processGroup?: number
  patternSeen: boolean
  /** False for records recovered from a prior supervisor instance. */
  live: boolean
}

export interface StartMonitorOptions {
  command: string
  title?: string
  cwd?: string
  ownerSessionID: string
  wakePattern?: string
  timeoutSec?: number
}

export interface MonitorEvent {
  type: "ready" | "completed"
  record: MonitorRecord
  logTail: string
}

export interface MonitorWaitResult {
  reason: "ready" | "completed" | "wait_timeout" | "not_found" | "disposed"
  record?: MonitorRecord
}

export interface ProcessSupervisorOptions {
  /** Commands may only run within this directory (after resolving symlinks). */
  worktree?: string
  /** Alias for worktree, useful to hosts that call this their project root. */
  root?: string
  /** Directory for logs, metadata sidecars, and atomic exit-code files. */
  stateDir: string
  maxConcurrent?: number
  notify?: (event: MonitorEvent) => void | Promise<void>
}

interface LiveMonitor {
  record: MonitorRecord
  proc: ReturnType<typeof Bun.spawn>
  hasProcessGroup: boolean
  wakeRegex?: RegExp
  stopState?: TerminalMonitorState
  stopNotify: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
  /** Completes after a stopped Linux process group has had its kill grace period. */
  stopCleanup?: Promise<void>
  /** Bypasses the grace period during disposal or failed start cleanup. */
  forceEscalate?: () => void
  leaderExited: boolean
  processGroupGone: boolean
  settled: boolean
  pumps: Promise<void>[]
  waiters: Set<Waiter>
  terminal: Promise<void>
  finish: () => void
}

interface Waiter {
  resolve: (value: MonitorWaitResult) => void
  timer?: ReturnType<typeof setTimeout>
}

const safeID = /^mon_[A-Za-z0-9_-]+$/

function sanitizeTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").slice(0, 80)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/**
 * A per-plugin-instance process supervisor. It deliberately owns no global
 * listeners or registries; callers should invoke dispose during plugin teardown.
 */
export class ProcessSupervisor {
  private readonly worktree: string
  private stateDir: string
  private initPromise?: Promise<void>
  private readonly maxConcurrent: number
  private readonly notify?: (event: MonitorEvent) => void | Promise<void>
  private readonly monitors = new Map<string, LiveMonitor>()
  private disposed = false
  private sequence = 0

  constructor(options: ProcessSupervisorOptions) {
    if (!Number.isFinite(options.maxConcurrent ?? 8) || (options.maxConcurrent ?? 8) < 1) {
      throw new Error("maxConcurrent must be a positive number")
    }
    const worktree = options.worktree ?? options.root
    if (!worktree) throw new Error("Process supervisor requires a worktree/root.")
    this.worktree = worktree
    this.stateDir = options.stateDir
    this.maxConcurrent = Math.floor(options.maxConcurrent ?? 8)
    this.notify = options.notify
  }

  async start(options: StartMonitorOptions): Promise<MonitorRecord> {
    if (this.disposed) throw new Error("Process supervisor has been disposed.")
    if (!options.command) throw new Error("Monitor command is required.")
    if (!options.ownerSessionID) throw new Error("Monitor ownerSessionID is required.")
    // Resolve state before counting so recovered records have their documented
    // unavailable state before a new process is admitted.
    await this.initialize()
    if ([...this.monitors.values()].filter((m) => m.record.state === "running").length >= this.maxConcurrent) {
      throw new Error(`Monitor limit (${this.maxConcurrent}) reached.`)
    }

    let wakeRegex: RegExp | undefined
    if (options.wakePattern) {
      try {
        wakeRegex = new RegExp(options.wakePattern, "m")
      } catch (error) {
        throw new Error(`Invalid wake_pattern regex: ${String(error)}`)
      }
    }

    const cwd = await this.validateCwd(options.cwd)
    const id = this.nextID()
    const logPath = path.join(this.stateDir, `${id}.log`)
    const metadataPath = path.join(this.stateDir, `${id}.json`)
    const exitCodePath = path.join(this.stateDir, `${id}.exit.json`)
    await fs.writeFile(logPath, "")

    // setsid makes the spawned bash a process-group leader on Linux. Direct
    // child killing remains the fallback when setsid is unavailable.
    const setsid = process.platform === "linux" ? (Bun as any).which?.("setsid") : undefined
    const argv = setsid ? [setsid, "bash", "-lc", options.command] : ["bash", "-lc", options.command]
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    })
    const record: MonitorRecord = {
      id,
      title: sanitizeTitle(options.title ?? options.command.slice(0, 60)),
      command: options.command,
      cwd,
      ownerSessionID: options.ownerSessionID,
      state: "running",
      startedAt: Date.now(),
      logPath,
      metadataPath,
      exitCodePath,
      pid: proc.pid,
      processGroup: setsid ? proc.pid : undefined,
      patternSeen: false,
      live: true,
    }
    let finish!: () => void
    const terminal = new Promise<void>((resolve) => (finish = resolve))
    const monitor: LiveMonitor = {
      record,
      proc,
      hasProcessGroup: Boolean(setsid),
      wakeRegex,
      stopNotify: true,
      leaderExited: false,
      processGroupGone: !setsid,
      settled: false,
      pumps: [],
      waiters: new Set(),
      terminal,
      finish,
    }
    this.monitors.set(id, monitor)
    monitor.pumps = [this.pump(proc.stdout as ReadableStream<Uint8Array> | null, monitor), this.pump(proc.stderr as ReadableStream<Uint8Array> | null, monitor)]
    // Keep a rejection observed immediately; observeExit still waits for both
    // pumps with allSettled to preserve as much log output as possible.
    for (const pump of monitor.pumps) void pump.catch(() => {})
    // Attach process ownership before any fallible persistence. In particular,
    // an unwritable sidecar must not leave an unobserved child behind.
    void proc.exited.then(
      (code) => this.observeExit(monitor, code),
      () => this.observeExit(monitor, -1),
    ).catch(() => {
      // complete() is deliberately defensive, but never let lifecycle work
      // become an unhandled rejection if a runtime stream behaves unexpectedly.
    })
    if (options.timeoutSec && options.timeoutSec > 0) {
      monitor.timeoutTimer = setTimeout(() => this.requestStop(monitor, "timeout", true), options.timeoutSec * 1000)
      ;(monitor.timeoutTimer as any).unref?.()
    }
    try {
      await this.writeMetadata(record)
    } catch (error) {
      // Lifecycle observation is already installed. Escalate immediately and
      // bound the wait so a failed start can never make dispose hang.
      // The leader can win the race and complete before this failed write is
      // observed, while a redirected descendant is still in its group. Do not
      // gate this cleanup on record.state for that reason.
      monitor.stopState ??= "killed"
      monitor.stopNotify = false
      this.killProcess(monitor, "SIGTERM")
      if (monitor.hasProcessGroup) this.beginGroupCleanup(monitor)
      else if (!monitor.killTimer) {
        monitor.killTimer = setTimeout(() => this.killProcess(monitor, "SIGKILL"), 1000)
        ;(monitor.killTimer as any).unref?.()
      }
      this.forceStop(monitor)
      await Promise.race([monitor.terminal, this.delay(1500)])
      if (!monitor.settled) await this.complete(monitor, "killed", -1)
      this.monitors.delete(id)
      throw error
    }
    return this.copy(record)
  }

  /** Alias for integrations whose tool is named monitor_run. */
  async run(options: StartMonitorOptions): Promise<MonitorRecord> {
    return this.start(options)
  }

  async status(id?: string): Promise<MonitorRecord[]> {
    await this.initialize()
    if (id) {
      const record = await this.get(id)
      return record ? [record] : []
    }
    const live = [...this.monitors.values()].map((monitor) => this.copy(monitor.record))
    try {
      const names = await fs.readdir(this.stateDir)
      const recovered = await Promise.all(
        names
          .filter((name) => /^mon_[A-Za-z0-9_-]+\.json$/.test(name))
          .map((name) => this.get(name.slice(0, -".json".length))),
      )
      const known = new Set(live.map((record) => record.id))
      return [...live, ...recovered.filter((record): record is MonitorRecord => record !== undefined && !known.has(record.id))]
    } catch {
      return live
    }
  }

  /** Read a live record, or a terminal record persisted by an older instance. */
  async get(id: string): Promise<MonitorRecord | undefined> {
    await this.initialize()
    const live = this.monitors.get(id)
    if (live) return this.copy(live.record)
    if (!safeID.test(id)) return undefined
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathsFor(id).metadataPath, "utf8")) as MonitorRecord
      if (!parsed || parsed.id !== id) return undefined
      // We cannot safely reattach after an unclean restart. Keep ownership
      // metadata visible but never expose it as controllable/running.
      const state: MonitorState = parsed.state === "running" ? "unavailable" : parsed.state
      return { ...parsed, ...this.pathsFor(id), state, live: false }
    } catch {
      return undefined
    }
  }

  async getStatus(id: string): Promise<MonitorRecord | undefined> {
    return this.get(id)
  }

  async read(id: string, tail = 50): Promise<string> {
    const record = await this.get(id)
    if (!record) throw new Error(`No monitor ${id}.`)
    try {
      const text = await fs.readFile(this.pathsFor(record.id).logPath, "utf8")
      return text.split("\n").slice(-Math.max(1, Math.floor(tail))).join("\n")
    } catch {
      return "(no output yet)"
    }
  }

  async stop(id: string, notify = false): Promise<MonitorRecord | undefined> {
    const monitor = this.monitors.get(id)
    if (!monitor) return this.get(id)
    if (monitor.record.state === "running") this.requestStop(monitor, "killed", notify)
    return this.copy(monitor.record)
  }

  stopOwnedBy(ownerSessionID: string): void {
    for (const monitor of this.monitors.values()) {
      if (monitor.record.ownerSessionID === ownerSessionID && monitor.record.state === "running") {
        this.requestStop(monitor, "killed", false)
      }
    }
  }

  stopOwnedBySession(ownerSessionID: string): void {
    this.stopOwnedBy(ownerSessionID)
  }

  async wait(id: string, timeoutSec = 600): Promise<MonitorWaitResult> {
    const monitor = this.monitors.get(id)
    if (!monitor) {
      const persisted = await this.get(id)
      return persisted ? { reason: "completed", record: persisted } : { reason: "not_found" }
    }
    if (monitor.record.state !== "running") return { reason: "completed", record: this.copy(monitor.record) }
    if (monitor.record.patternSeen) return { reason: "ready", record: this.copy(monitor.record) }
    if (this.disposed) return { reason: "disposed", record: this.copy(monitor.record) }
    return new Promise<MonitorWaitResult>((resolve) => {
      const waiter: Waiter = { resolve }
      if (timeoutSec > 0 && Number.isFinite(timeoutSec)) {
        waiter.timer = setTimeout(() => {
          monitor.waiters.delete(waiter)
          resolve({ reason: "wait_timeout", record: this.copy(monitor.record) })
        }, timeoutSec * 1000)
        ;(waiter.timer as any).unref?.()
      }
      monitor.waiters.add(waiter)
    })
  }

  /** Kill all live processes and resolve all outstanding waits without notifications. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const live = [...this.monitors.values()]
    for (const monitor of live) {
      this.clearTimer(monitor.timeoutTimer)
      if (monitor.record.state === "running") {
        this.requestStop(monitor, "killed", false)
        this.forceStop(monitor)
      }
      this.settleWaiters(monitor, "disposed")
    }
    await Promise.allSettled(live.map((monitor) => monitor.terminal))
  }

  private async validateCwd(requested: string | undefined): Promise<string> {
    const root = await fs.realpath(this.worktree).catch(() => {
      throw new Error(`Worktree does not exist: ${this.worktree}`)
    })
    const supplied = requested ?? root
    const candidate = path.resolve(root, supplied)
    const resolved = await fs.realpath(candidate).catch(() => {
      throw new Error(`Invalid monitor cwd: ${supplied}`)
    })
    if (!isWithin(root, resolved)) throw new Error(`Monitor cwd must be within worktree: ${supplied}`)
    return resolved
  }

  private async initialize(): Promise<void> {
    this.initPromise ??= (async () => {
      const root = await fs.realpath(this.worktree).catch(() => { throw new Error(`Worktree does not exist: ${this.worktree}`) })
      const requested = path.resolve(root, this.stateDir)
      if (!isWithin(root, requested)) throw new Error("Monitor stateDir must remain inside the worktree")
      // Validate the nearest existing parent before mkdir so a symlink prefix
      // cannot cause us to create files outside the worktree.
      let parent = requested
      while (true) {
        try {
          const resolvedParent = await fs.realpath(parent)
          if (!isWithin(root, resolvedParent)) throw new Error("Monitor stateDir must remain inside the worktree")
          break
        } catch (error: any) {
          if (error?.message === "Monitor stateDir must remain inside the worktree") throw error
          if (error?.code !== "ENOENT") throw error
          const next = path.dirname(parent)
          if (next === parent) throw new Error("Monitor stateDir cannot be resolved")
          parent = next
        }
      }
      await fs.mkdir(requested, { recursive: true })
      const resolved = await fs.realpath(requested)
      if (!isWithin(root, resolved)) throw new Error("Monitor stateDir must remain inside the worktree")
      this.stateDir = resolved
    })()
    return this.initPromise
  }

  private pathsFor(id: string): Pick<MonitorRecord, "logPath" | "metadataPath" | "exitCodePath"> {
    if (!safeID.test(id)) throw new Error("Invalid monitor id.")
    return { logPath: path.join(this.stateDir, `${id}.log`), metadataPath: path.join(this.stateDir, `${id}.json`), exitCodePath: path.join(this.stateDir, `${id}.exit.json`) }
  }

  private nextID(): string {
    this.sequence += 1
    return `mon_${Date.now().toString(36)}_${this.sequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  private async pump(stream: ReadableStream<Uint8Array> | null, monitor: LiveMonitor): Promise<void> {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let window = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (text) await fs.appendFile(monitor.record.logPath, text)
        if (!this.disposed && monitor.wakeRegex && !monitor.record.patternSeen) {
          window = (window + text).slice(-8192)
          if (monitor.wakeRegex.test(window)) {
            monitor.record.patternSeen = true
            await this.writeMetadata(monitor.record)
            await this.emit("ready", monitor)
            // Notify before resolving waiters so a completed wait observes its
            // corresponding readiness event deterministically.
            this.settleWaiters(monitor, "ready")
          }
        }
      }
      const finalText = decoder.decode()
      if (finalText) await fs.appendFile(monitor.record.logPath, finalText)
    } finally {
      reader.releaseLock()
    }
  }

  private requestStop(monitor: LiveMonitor, state: TerminalMonitorState, notify: boolean): void {
    if (monitor.record.state !== "running") return
    monitor.stopState ??= state
    monitor.stopNotify &&= notify
    this.killProcess(monitor, "SIGTERM")
    if (monitor.hasProcessGroup) {
      this.beginGroupCleanup(monitor)
    } else if (!monitor.killTimer) {
      monitor.killTimer = setTimeout(() => this.killProcess(monitor, "SIGKILL"), 1000)
      ;(monitor.killTimer as any).unref?.()
    }
  }

  private killProcess(monitor: LiveMonitor, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = monitor.proc.pid
    // Negative PIDs address the group only when Linux setsid created it.
    if (process.platform === "linux" && monitor.hasProcessGroup && !monitor.processGroupGone) {
      try {
        process.kill(-pid, signal)
        return
      } catch (error: any) {
        if (error?.code === "ESRCH") monitor.processGroupGone = true
      }
    }
    // Once the leader has exited, signaling its numeric PID can target an
    // unrelated process. Group signaling above remains safe until ESRCH.
    if (monitor.leaderExited) return
    try {
      monitor.proc.kill(signal)
    } catch {}
  }

  private async complete(monitor: LiveMonitor, state: TerminalMonitorState, exitCode: number): Promise<void> {
    if (monitor.settled) return
    monitor.settled = true
    this.clearTimer(monitor.timeoutTimer)
    this.clearTimer(monitor.killTimer)
    monitor.killTimer = undefined
    monitor.record.state = state
    monitor.record.exitCode = exitCode
    monitor.record.endedAt = Date.now()
    try {
      await this.writeExitCode(monitor.record)
      await this.writeMetadata(monitor.record)
    } catch {
      // A state-dir failure must not strand a process waiter or disposal.
    } finally {
      this.settleWaiters(monitor, "completed")
      if (!this.disposed && monitor.stopNotify) await this.emit("completed", monitor)
      monitor.finish()
    }
  }

  private async observeExit(monitor: LiveMonitor, exitCode: number): Promise<void> {
    monitor.leaderExited = true
    // A shell can legitimately exit while leaving a background job in the
    // setsid group. Treat that as a group cleanup event even without an
    // explicit stop request; otherwise a redirected child is invisible to the
    // output pumps and outlives a seemingly completed monitor.
    if (!monitor.stopCleanup && monitor.hasProcessGroup && !monitor.processGroupGone) {
      // Signal directly instead of probing first. A probe followed by a signal
      // leaves an avoidable window in which a vacated PGID can be reused.
      this.killProcess(monitor, "SIGTERM")
      if (!monitor.processGroupGone) this.beginGroupCleanup(monitor)
    }
    const pumps = Promise.allSettled(monitor.pumps)
    // Do not mistake a shell exiting after SIGTERM for its setsid group being
    // gone: background descendants may have redirected both output pipes.
    await monitor.stopCleanup
    // SIGKILL normally closes the pipes immediately. Bound this last log drain
    // after a forced group stop so an abnormal stream cannot hold dispose
    // forever; the pumps remain observed and may still preserve late output.
    if (monitor.stopCleanup) await Promise.race([pumps, this.delay(250)])
    else await pumps
    await this.complete(monitor, monitor.stopState ?? "done", exitCode)
  }

  private beginGroupCleanup(monitor: LiveMonitor): void {
    if (monitor.stopCleanup) return
    let escalate!: () => void
    const escalation = new Promise<void>((resolve) => {
      escalate = resolve
    })
    const trigger = () => {
      this.clearTimer(monitor.killTimer)
      monitor.killTimer = undefined
      monitor.forceEscalate = undefined
      escalate()
    }
    monitor.forceEscalate = trigger
    monitor.killTimer = setTimeout(trigger, 1000)
    ;(monitor.killTimer as any).unref?.()
    monitor.stopCleanup = (async () => {
      // Most SIGTERM-responsive groups disappear immediately. Poll during the
      // grace period so ordinary completion does not pay the full escalation
      // delay, while forceEscalate can still bypass it during disposal.
      const goneBeforeEscalation = await Promise.race([
        this.waitForGroupGone(monitor, 1000),
        escalation.then(() => false),
      ])
      if (goneBeforeEscalation) {
        this.clearTimer(monitor.killTimer)
        monitor.killTimer = undefined
        monitor.forceEscalate = undefined
        return
      }
      this.killProcess(monitor, "SIGKILL")
      // SIGKILL is asynchronous. Wait briefly so callers returning from a
      // stop/dispose do not leave runnable descendants behind, but never hang
      // forever on an unkillable process or a platform anomaly.
      await this.waitForGroupGone(monitor, 250)
    })()
  }

  private forceStop(monitor: LiveMonitor): void {
    if (monitor.hasProcessGroup) {
      monitor.forceEscalate?.()
      this.killProcess(monitor, "SIGKILL")
    } else {
      this.clearTimer(monitor.killTimer)
      monitor.killTimer = undefined
      this.killProcess(monitor, "SIGKILL")
    }
  }

  private processGroupExists(monitor: LiveMonitor): boolean {
    if (!monitor.hasProcessGroup || monitor.processGroupGone) return false
    try {
      process.kill(-monitor.proc.pid, 0)
      return true
    } catch (error: any) {
      if (error?.code === "ESRCH") monitor.processGroupGone = true
      // Only ESRCH proves the old group is gone. Preserve cleanup for EPERM
      // and other transient/host-specific failures.
      return true
    }
  }

  private async waitForGroupGone(monitor: LiveMonitor, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.processGroupExists(monitor) && Date.now() < deadline) {
      await this.delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
    return !this.processGroupExists(monitor)
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  private settleWaiters(monitor: LiveMonitor, reason: "ready" | "completed" | "disposed"): void {
    for (const waiter of monitor.waiters) {
      this.clearTimer(waiter.timer)
      waiter.resolve({ reason, record: this.copy(monitor.record) })
    }
    monitor.waiters.clear()
  }

  private async emit(type: MonitorEvent["type"], monitor: LiveMonitor): Promise<void> {
    if (!this.notify || this.disposed) return
    try {
      await this.notify({ type, record: this.copy(monitor.record), logTail: await this.read(monitor.record.id, type === "ready" ? 15 : 30) })
    } catch {
      // Notification failures must never affect process cleanup.
    }
  }

  private async writeMetadata(record: MonitorRecord): Promise<void> {
    await this.atomicWrite(record.metadataPath, JSON.stringify(record))
  }

  private async writeExitCode(record: MonitorRecord): Promise<void> {
    await this.atomicWrite(record.exitCodePath, JSON.stringify({ id: record.id, exitCode: record.exitCode, endedAt: record.endedAt }))
  }

  private async atomicWrite(destination: string, contents: string): Promise<void> {
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(temporary, contents)
    await fs.rename(temporary, destination)
  }

  private copy(record: MonitorRecord): MonitorRecord {
    return { ...record }
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer) clearTimeout(timer)
  }
}

export function createProcessSupervisor(options: ProcessSupervisorOptions): ProcessSupervisor {
  return new ProcessSupervisor(options)
}
