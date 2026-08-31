/** Durable state used by the native orchestration controller. */
export const TASK_STATES = [
  "queued",
  "ready",
  "starting",
  "running",
  "blocked",
  "checking",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const

export type TaskState = (typeof TASK_STATES)[number]

export const ACTIVE_TASK_STATES: readonly TaskState[] = ["starting", "running", "checking"]
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled", "interrupted"]

export interface Task {
  id: string
  state: TaskState
  /** Session which requested the task. */
  rootSessionId: string
  /** Optional immediate parent, when the requester is itself a child session. */
  parentSessionId?: string
  nativeSessionId?: string
  nativeJobId?: string
  prompt: string
  agent: string
  title: string
  /** Canonical project-relative write roots. */
  writeRoots: string[]
  dependencies: string[]
  validationCommands: string[]
  result?: string
  error?: string
  blockedReason?: string
  createdAt: number
  updatedAt: number
  readyAt?: number
  startedAt?: number
  finishedAt?: number
  /** Random capability issued exactly once while a task is claimed for dispatch. */
  dispatchToken?: string
  dispatchTokenIssuedAt?: number
  dispatchTokenConsumedAt?: number
}

export interface CreateTaskInput {
  id: string
  rootSessionId: string
  parentSessionId?: string
  prompt: string
  agent: string
  title: string
  writeRoots?: string[]
  dependencies?: string[]
  validationCommands?: string[]
  state?: TaskState
}

export interface TaskPatch {
  nativeSessionId?: string | null
  nativeJobId?: string | null
  result?: string | null
  error?: string | null
  blockedReason?: string | null
  title?: string
  agent?: string
  prompt?: string
}

export interface TaskEvent {
  id: number
  taskId: string
  at: number
  fromState?: TaskState
  toState?: TaskState
  kind: string
  detail?: string
}

export interface LeaseConflict {
  taskId: string
  root: string
}

export interface LeaseAcquireResult {
  acquired: boolean
  conflicts: LeaseConflict[]
}

export interface DependencyStatus {
  ready: boolean
  pending: string[]
  blockedReason?: string
}

export interface DispatchClaim {
  task: Task
  token: string
}
