import type { DispatchClaim, Task } from "./types"
import { TaskStore } from "./store"

export interface QueueOptions { capacity: number }

/** Thin scheduling facade: durable selection and locking remain in TaskStore's transaction. */
export class TaskQueue {
  constructor(readonly store: TaskStore, readonly options: QueueOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new Error("capacity must be a positive integer")
  }

  get capacity(): number { return this.options.capacity }
  get activeCount(): number { return this.store.activeCount() }
  get availableCapacity(): number { return Math.max(0, this.capacity - this.activeCount) }

  /** Claims the oldest task with complete dependencies and non-overlapping write leases. */
  next(): DispatchClaim | undefined { return this.store.claimOldestDispatchable(this.capacity) }
  claimNext(): DispatchClaim | undefined { return this.next() }
  claim(id: string): DispatchClaim | undefined { return this.store.claimTaskIfEligible(id, this.capacity) }
  continue(id: string): DispatchClaim | undefined { return this.store.claimContinuation(id, this.capacity) }

  /** Releases a completed/cancelled task's roots; repeated calls are harmless. */
  release(task: Task | string): number { return this.store.releaseLeases(typeof task === "string" ? task : task.id) }
}

export { TaskQueue as Queue }
