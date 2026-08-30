import { createWriteStream } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export type ValidationState = "success" | "failure" | "timeout" | "aborted"

export interface ValidationResult {
  command: string
  state: ValidationState
  exitCode: number | null
  durationMs: number
  logPath: string
  output: string
}

export interface ValidationRunnerOptions {
  /** Absolute or relative worktree root. `root` is accepted as an alias. */
  worktree?: string
  root?: string
  /** Directory where one full-output log is written for each command. */
  stateDir?: string
  /** Alias for stateDir when validation logs have their own directory. */
  logDir?: string
  /** Per-command timeout. Zero disables the timeout. */
  timeoutMs?: number
  /** Maximum number of UTF-8 bytes returned in each result's output. */
  maxOutputBytes?: number
  /** Alias for maxOutputBytes. */
  maxBytes?: number
  /** Stop after the first non-success result. Defaults to true. */
  stopOnFailure?: boolean
  /** Directory, relative to the worktree unless absolute, for the commands. */
  cwd?: string
  signal?: AbortSignal
}

export interface ValidationRunOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  maxBytes?: number
  stopOnFailure?: boolean
  cwd?: string
  signal?: AbortSignal
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function validNonNegativeNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number.`)
  return Math.floor(value)
}

class OutputTail {
  private chunks: Uint8Array[] = []
  private length = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array) {
    if (this.maxBytes === 0 || chunk.byteLength === 0) return
    const copy = new Uint8Array(chunk)
    this.chunks.push(copy)
    this.length += copy.byteLength

    while (this.length > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]
      const excess = this.length - this.maxBytes
      if (first.byteLength <= excess) {
        this.chunks.shift()
        this.length -= first.byteLength
      } else {
        this.chunks[0] = first.slice(excess)
        this.length -= excess
      }
    }
  }

  text(): string {
    const combined = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(combined)
  }
}

/**
 * Runs validation commands serially. The runner deliberately uses `bash -lc`
 * so configured commands have shell semantics, but never accepts a cwd outside
 * the worktree (including via a symlink).
 */
export class ValidationRunner {
  private runNumber = 0
  private readonly rootInput: string
  private readonly logDirInput: string

  constructor(private readonly options: ValidationRunnerOptions) {
    this.rootInput = options.worktree ?? options.root ?? ""
    this.logDirInput = options.logDir ?? options.stateDir ?? ""
    if (!this.rootInput) throw new Error("ValidationRunner requires a worktree or root.")
    if (!this.logDirInput) throw new Error("ValidationRunner requires a stateDir or logDir.")
    validNonNegativeNumber(options.timeoutMs, "timeoutMs")
    validNonNegativeNumber(options.maxOutputBytes ?? options.maxBytes, "maxOutputBytes")
  }

  async run(commands: readonly string[], runOptions: ValidationRunOptions = {}): Promise<ValidationResult[]> {
    if (commands.length === 0) return []
    for (const command of commands) {
      if (typeof command !== "string") throw new Error("Validation commands must be strings.")
    }

    const root = await fs.realpath(path.resolve(this.rootInput))
    const cwd = await this.resolveCwd(root, runOptions.cwd ?? this.options.cwd)
    const logDir = path.resolve(root, this.logDirInput)
    await fs.mkdir(logDir, { recursive: true })

    const timeoutMs = validNonNegativeNumber(runOptions.timeoutMs ?? this.options.timeoutMs, "timeoutMs") ?? 0
    const maxOutputBytes =
      validNonNegativeNumber(
        runOptions.maxOutputBytes ?? runOptions.maxBytes ?? this.options.maxOutputBytes ?? this.options.maxBytes,
        "maxOutputBytes",
      ) ?? DEFAULT_MAX_OUTPUT_BYTES
    const stopOnFailure = runOptions.stopOnFailure ?? this.options.stopOnFailure ?? true
    const signal = runOptions.signal ?? this.options.signal
    const runId = ++this.runNumber
    const results: ValidationResult[] = []

    for (let index = 0; index < commands.length; index++) {
      const logPath = path.join(logDir, `validation-${runId}-${index + 1}.log`)
      const result = await this.runCommand(commands[index], cwd, logPath, timeoutMs, maxOutputBytes, signal)
      results.push(result)
      if (result.state === "aborted" || (stopOnFailure && result.state !== "success")) break
    }
    return results
  }

  private async resolveCwd(root: string, requested: string | undefined): Promise<string> {
    const candidate = path.resolve(root, requested ?? ".")
    let resolved: string
    try {
      resolved = await fs.realpath(candidate)
    } catch (error) {
      throw new Error(`Validation cwd cannot be resolved: ${candidate} (${String(error)})`)
    }
    if (!inside(root, resolved)) {
      throw new Error(`Validation cwd must remain inside the worktree: ${requested ?? "."}`)
    }
    return resolved
  }

  private async runCommand(
    command: string,
    cwd: string,
    logPath: string,
    timeoutMs: number,
    maxOutputBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ValidationResult> {
    const startedAt = performance.now()
    const output = new OutputTail(maxOutputBytes)
    const log = createWriteStream(logPath, { flags: "w" })
    let logError: Error | undefined
    log.on("error", (error: Error) => {
      logError = error
    })
    let writing = Promise.resolve()
    const append = (chunk: Uint8Array) => {
      output.append(chunk)
      writing = writing.then(
        () =>
          new Promise<void>((resolve, reject) => {
            log.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()))
          }),
      )
      return writing
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      const setsid = process.platform === "linux" ? (Bun as any).which?.("setsid") : undefined
      proc = Bun.spawn(setsid ? [setsid, "bash", "-lc", command] : ["bash", "-lc", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      })
    } catch (error) {
      const message = `Could not start validation command: ${String(error)}\n`
      await append(new TextEncoder().encode(message)).catch(() => {})
      await this.closeLog(log, writing).catch(() => {})
      return {
        command,
        state: "failure",
        exitCode: null,
        durationMs: Math.round(performance.now() - startedAt),
        logPath,
        output: output.text(),
      }
    }

    const pump = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await append(value)
        }
      } finally {
        reader.releaseLock()
      }
    }

    let exited = false
    const exitedPromise = proc.exited.then((exitCode: number) => {
      exited = true
      return exitCode
    })
    let stopState: "timeout" | "aborted" | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (state: "timeout" | "aborted") => {
      if (exited || stopState) return
      stopState = state
      // With setsid, the child is a process-group leader. Kill the group first
      // so shell grandchildren cannot keep the output pipes open.
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {}
      try {
        proc.kill()
      } catch {}
      killTimer = setTimeout(() => {
        if (exited) return
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {}
        try {
          proc.kill("SIGKILL")
        } catch {}
      }, 500)
    }
    const onAbort = () => stop("aborted")
    if (signal?.aborted) stop("aborted")
    else signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = timeoutMs > 0 ? setTimeout(() => stop("timeout"), timeoutMs) : undefined

    let logClosed = false
    try {
      const results: [number, void, void] = await Promise.all([exitedPromise, pump(proc.stdout as ReadableStream<Uint8Array> | null), pump(proc.stderr as ReadableStream<Uint8Array> | null)])
      const exitCode = results[0]
      await this.closeLog(log, writing)
      logClosed = true
      if (logError) throw logError
      return {
        command,
        state: stopState ?? (exitCode === 0 ? "success" : "failure"),
        exitCode: stopState ? null : typeof exitCode === "number" ? exitCode : null,
        durationMs: Math.round(performance.now() - startedAt),
        logPath,
        output: output.text(),
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      if (!exited) {
        try { process.kill(-proc.pid, "SIGKILL") } catch {}
        try { proc.kill("SIGKILL") } catch {}
        await exitedPromise.catch(() => {})
      }
      if (!logClosed) await this.closeLog(log, writing).catch(() => {})
    }
  }

  private async closeLog(log: ReturnType<typeof createWriteStream>, writing: Promise<void>): Promise<void> {
    await writing
    await new Promise<void>((resolve, reject) => {
      log.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
  }
}

export function createValidationRunner(options: ValidationRunnerOptions): ValidationRunner
export function createValidationRunner(
  worktree: string,
  stateDir: string,
  options?: Omit<ValidationRunnerOptions, "worktree" | "root" | "stateDir" | "logDir">,
): ValidationRunner
export function createValidationRunner(
  optionsOrWorktree: ValidationRunnerOptions | string,
  stateDir?: string,
  options: Omit<ValidationRunnerOptions, "worktree" | "root" | "stateDir" | "logDir"> = {},
): ValidationRunner {
  return new ValidationRunner(
    typeof optionsOrWorktree === "string"
      ? { ...options, worktree: optionsOrWorktree, stateDir }
      : optionsOrWorktree,
  )
}
