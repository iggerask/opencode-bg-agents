import * as fs from "node:fs/promises"
import * as path from "node:path"

export class ScopeError extends Error {
  override name = "ScopeError"
}

export interface ScopeOptions {
  /** Project-relative directory owned by this plugin and never writable by tasks. */
  pluginStateDir?: string
}

const asPosix = (value: string) => value.replaceAll("\\", "/")
const protectedDefault = ".opencode/bg"

function relativePath(value: string): string {
  if (!value || value.includes("\0")) throw new ScopeError("write root must be a non-empty relative path")
  const portable = asPosix(value)
  if (path.isAbsolute(value) || path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) {
    throw new ScopeError(`write root must be project-relative: ${value}`)
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "")
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ScopeError(`write root escapes the worktree: ${value}`)
  }
  return normalized === "" ? "." : normalized
}

function isSameOrDescendant(value: string, ancestor: string): boolean {
  return ancestor === "." || value === ancestor || value.startsWith(`${ancestor}/`)
}

async function realPathForCandidate(worktree: string, relative: string): Promise<string> {
  const candidate = path.resolve(worktree, relative)
  try {
    return await fs.realpath(candidate)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }

  // A future output path may not exist yet. Resolve its closest existing parent
  // so an existing symlink in the prefix cannot escape the worktree later.
  let cursor = candidate
  const suffix: string[] = []
  while (true) {
    try {
      const parent = await fs.realpath(cursor)
      return path.resolve(parent, ...suffix.reverse())
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new ScopeError(`cannot resolve write root: ${relative}`)
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/** True when two canonical project-relative roots overlap. */
export function scopesConflict(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left)
}

/** Canonicalize one project-relative write root and reject protected/escaping paths. */
export async function canonicalizeWriteRoot(
  worktree: string,
  value: string,
  options: ScopeOptions = {},
): Promise<string> {
  const root = await fs.realpath(worktree)
  const relative = relativePath(value)
  const protectedRoot = relativePath(options.pluginStateDir ?? protectedDefault)
  if (scopesConflict(relative, ".git") || scopesConflict(relative, protectedRoot)) {
    throw new ScopeError(`write root is protected: ${value}`)
  }

  const resolved = await realPathForCandidate(root, relative)
  const relativeResolved = path.relative(root, resolved)
  if (relativeResolved === ".." || relativeResolved.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResolved)) {
    throw new ScopeError(`write root escapes the worktree through a symlink: ${value}`)
  }
  const protectedPaths = await Promise.all(
    [".git", protectedRoot].map((protectedRelative) => realPathForCandidate(root, protectedRelative)),
  )
  if (protectedPaths.some((protectedPath) => isWithinPhysical(protectedPath, resolved) || isWithinPhysical(resolved, protectedPath))) {
    throw new ScopeError(`write root is protected: ${value}`)
  }
  // Lease identities must use the physical path so symlink aliases conflict.
  return relativeResolved === "" ? "." : asPosix(relativeResolved)
}

/** Canonicalize, sort, de-duplicate, and remove roots covered by another root. */
export async function canonicalizeWriteRoots(
  worktree: string,
  values: readonly string[],
  options: ScopeOptions = {},
): Promise<string[]> {
  const roots = await Promise.all(values.map((value) => canonicalizeWriteRoot(worktree, value, options)))
  const unique = [...new Set(roots)].sort((a, b) => a.length - b.length || a.localeCompare(b))
  return unique.filter((root, index) => !unique.slice(0, index).some((parent) => isSameOrDescendant(root, parent)))
}

/**
 * Advisory physical-path authorization used at write hooks and completion.
 * It resolves existing symlinks (or the nearest existing parent for future
 * output) for both sides before containment comparison. The filesystem can
 * still change after this check, so this is not a sandbox/TOCTOU defense.
 */
export async function pathWithinWriteRoots(worktree: string, value: string, roots: readonly string[]): Promise<boolean> {
  let relative: string
  try {
    const root = await fs.realpath(worktree)
    if (path.isAbsolute(value)) {
      const lexical = path.relative(root, value)
      if (lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) return false
      relative = relativePath(lexical)
    } else relative = relativePath(value)
    const candidate = await realPathForCandidate(root, relative)
    if (!isWithinPhysical(root, candidate)) return false
    for (const allowed of roots) {
      const physicalRoot = await realPathForCandidate(root, relativePath(allowed))
      if (isWithinPhysical(physicalRoot, candidate)) return true
    }
    return false
  } catch { return false }
}

function isWithinPhysical(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export const normalizeWriteRoots = canonicalizeWriteRoots
export const writeScopesConflict = scopesConflict
