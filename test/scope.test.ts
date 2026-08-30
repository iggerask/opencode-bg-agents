import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { canonicalizeWriteRoots, pathWithinWriteRoots, ScopeError, scopesConflict } from "../src/scope"

const directories: string[] = []
async function worktree() {
  const directory = await mkdtemp(join(tmpdir(), "native-orch-scope-"))
  directories.push(directory)
  await mkdir(join(directory, ".git"))
  await mkdir(join(directory, ".opencode", "bg"), { recursive: true })
  await mkdir(join(directory, "src"))
  return directory
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe("write scopes", () => {
  test("normalizes duplicates and roots covered by an ancestor", async () => {
    const root = await worktree()
    expect(await canonicalizeWriteRoots(root, ["src/lib", "./src", "src", "src/lib"])).toEqual(["src"])
    expect(scopesConflict("src", "src/lib")).toBe(true)
    expect(scopesConflict("src", "docs")).toBe(false)
  })

  test("rejects absolute, escaping, protected, and symlink-escaping roots", async () => {
    const root = await worktree()
    const outside = await mkdtemp(join(tmpdir(), "native-orch-outside-"))
    directories.push(outside)
    await symlink(outside, join(root, "escape"))
    for (const value of ["/tmp/nope", "../nope", ".git/config", ".opencode/bg/tasks.sqlite", "escape/output"]) {
      await expect(canonicalizeWriteRoots(root, [value])).rejects.toBeInstanceOf(ScopeError)
    }
  })

  test("uses physical containment for a symlinked candidate", async () => {
    const root = await worktree()
    await mkdir(join(root, "docs"))
    await symlink("../docs", join(root, "src", "link"))
    expect(await pathWithinWriteRoots(root, "src/link/guide.md", ["src"])).toBe(false)
  })
})
