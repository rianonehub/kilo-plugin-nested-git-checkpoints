// nested-git-checkpoints (global plugin — works for any project)
//
// Kilo's built-in checkpoints (snapshot/undo) use a shadow git-dir with
// --work-tree=<project root>. Git never recurses into a directory that
// contains its own `.git` (an embedded repo / submodule), so any file under
// such a nested repo is invisible to the built-in snapshot; those edits are
// not captured by checkpoints and are not reverted on undo. (Example: a repo
// whose `renderer/` is a separate git repo with its own submodules.)
//
// This plugin closes that gap generically. It auto-discovers every nested git
// repo under the worktree and, for each one, keeps its own shadow git-dir (in
// Kilo's data dir, never touching the real nested `.git`) and:
//   - snapshots each nested repo at every user-message boundary (chat.message),
//     keyed by messageID, matching the built-in per-turn undo granularity;
//   - snapshots a post-turn "head" on session.idle (for redo-to-head);
//   - restores the nested repos automatically when the built-in undo/redo
//     fires, by watching session.revert on session.updated.
// Projects with no nested repos are detected as such and the plugin stays inert.
// Manual tools are provided as a fallback.

import type { Plugin, Hooks } from "@kilocode/plugin"
import { tool } from "@kilocode/plugin/tool"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"

type NestedRepo = { rel: string; abs: string; gitdir: string }
type Snap = { seq: number; kind: "pre" | "manual"; messageID?: string; time: number; trees: Record<string, string> }
type SessionState = { snapshots: Snap[]; head?: { time: number; trees: Record<string, string> } }
type PersistState = {
  version: number
  seq: number
  nested: Array<{ rel: string; abs: string; gitdir: string }>
  sessions: Record<string, SessionState>
}

const GIT_FLAGS = [
  "-c", "core.autocrlf=false",
  "-c", "core.longpaths=true",
  "-c", "core.symlinks=true",
  "-c", "core.quotepath=false",
  "-c", "core.fsmonitor=false",
  "-c", "gc.auto=0",
  "-c", "protocol.file.allow=always",
  "-c", "advice.addEmbeddedRepo=false",
]

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "kilo-nested",
  GIT_AUTHOR_EMAIL: "kilo-nested@localhost",
  GIT_COMMITTER_NAME: "kilo-nested",
  GIT_COMMITTER_EMAIL: "kilo-nested@localhost",
}

const PRUNE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  ".cache", "tmp", ".turbo", ".idea", ".vscode", ".yarn",
])

const MAX_SNAPSHOTS_PER_SESSION = 200
const CLEAR_RESTORE_DEBOUNCE_MS = 250

const server: Plugin = async (ctx, options) => {
  const { client, worktree, project } = ctx as any
  const $ = (ctx as any).$
  const opts = (options ?? {}) as {
    paths?: string[]
    maxDepth?: number
    dataDir?: string
    autoRestore?: boolean
  }
  const maxDepth = typeof opts.maxDepth === "number" ? opts.maxDepth : 8
  const autoRestore = opts.autoRestore !== false

  const dataRoot =
    opts.dataDir ||
    path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode")
  const base = path.join(dataRoot, "nested-snapshot", String(project?.id ?? "default"), short(worktree))
  const statePath = path.join(base, "state.json")

  let nested: NestedRepo[] = []
  const byRel = new Map<string, NestedRepo>()
  let state: PersistState = { version: 1, seq: 0, nested: [], sessions: {} }

  const appliedRevert = new Map<string, string | null>()
  const seen = new Set<string>()
  const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const locks = new Map<string, Promise<unknown>>()

  async function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
    try {
      await client.app.log({ body: { service: "nested-git-checkpoints", level, message, extra } })
    } catch {
      /* logging must never break the session */
    }
  }

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  function short(s: string): string {
    return createHash("sha1").update(s).digest("hex").slice(0, 16)
  }

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  async function git(
    gitdir: string | null,
    workTree: string | null,
    sub: string[],
    o: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const args = [...GIT_FLAGS]
    if (gitdir) args.push("--git-dir", gitdir)
    if (workTree) args.push("--work-tree", workTree)
    args.push(...sub)
    try {
      const res = await $`git ${args}`
        .cwd(o.cwd ?? workTree ?? worktree)
        .env({ ...process.env, ...(o.env ?? {}) })
        .quiet()
        .nothrow()
      return {
        code: typeof res.exitCode === "number" ? res.exitCode : 0,
        out: res.stdout?.toString() ?? "",
        err: res.stderr?.toString() ?? "",
      }
    } catch (e) {
      return { code: 1, out: "", err: (e as any)?.message ?? String(e) }
    }
  }

  async function ensureRepo(repo: NestedRepo): Promise<boolean> {
    if (await pathExists(path.join(repo.gitdir, "HEAD"))) return true
    try {
      await fs.mkdir(path.dirname(repo.gitdir), { recursive: true })
    } catch {
      /* ignore */
    }
    const init = await git(null, null, ["init", "-q"], {
      cwd: repo.abs,
      env: { GIT_DIR: repo.gitdir, GIT_WORK_TREE: repo.abs },
    })
    if (init.code !== 0) {
      await log("warn", "failed to init shadow repo", { rel: repo.rel, err: init.err })
      return false
    }
    return true
  }

  // Snapshot one nested repo -> tree hash (or null). Pins the tree via a ref so
  // git gc cannot prune it.
  async function snapshotRepo(
    repo: NestedRepo,
    refSuffix: string | number,
    sessionID: string,
    label: string,
  ): Promise<string | null> {
    return withLock(repo.gitdir, async () => {
      if (!(await ensureRepo(repo))) return null
      const add = await git(repo.gitdir, repo.abs, ["add", "-A", "--", "."], { cwd: repo.abs })
      if (add.code !== 0) await log("debug", "add reported non-zero (continuing)", { rel: repo.rel, err: add.err.slice(0, 300) })
      const wt = await git(repo.gitdir, repo.abs, ["write-tree"], { cwd: repo.abs })
      const tree = wt.out.trim()
      if (wt.code !== 0 || !tree) {
        await log("warn", "write-tree failed", { rel: repo.rel, err: wt.err })
        return null
      }
      const commit = await git(repo.gitdir, null, ["commit-tree", tree, "-m", label], { cwd: repo.abs, env: GIT_IDENT })
      const commitHash = commit.out.trim()
      const refTarget = commit.code === 0 && commitHash ? commitHash : tree
      await git(repo.gitdir, null, ["update-ref", `refs/kilo-nested/${sessionID}/${refSuffix}`, refTarget], { cwd: repo.abs })
      return tree
    })
  }

  // Restore one nested repo working tree to a target tree, mirroring the
  // built-in behavior: applies modifications, additions AND deletions, while
  // leaving files ignored by the nested repo's own .gitignore untouched.
  async function restoreRepo(repo: NestedRepo, targetTree: string): Promise<boolean> {
    return withLock(repo.gitdir, async () => {
      if (!(await ensureRepo(repo))) return false
      const objExists = await git(repo.gitdir, null, ["cat-file", "-e", `${targetTree}^{tree}`], { cwd: repo.abs })
      if (objExists.code !== 0) {
        await log("warn", "restore skipped: target tree missing", { rel: repo.rel, targetTree })
        return false
      }
      await git(repo.gitdir, repo.abs, ["add", "-A", "--", "."], { cwd: repo.abs })
      const cur = await git(repo.gitdir, repo.abs, ["write-tree"], { cwd: repo.abs })
      const curTree = cur.out.trim()
      if (cur.code === 0 && curTree) {
        const rt = await git(repo.gitdir, repo.abs, ["read-tree", "-u", "-m", curTree, targetTree], { cwd: repo.abs })
        if (rt.code === 0) return true
        await log("debug", "read-tree merge failed, falling back to checkout-index", { rel: repo.rel, err: rt.err.slice(0, 300) })
      }
      // Fallback: contents-only restore (no deletions of newly added files).
      const read = await git(repo.gitdir, repo.abs, ["read-tree", targetTree], { cwd: repo.abs })
      if (read.code !== 0) {
        await log("warn", "restore read-tree failed", { rel: repo.rel, err: read.err })
        return false
      }
      const co = await git(repo.gitdir, repo.abs, ["checkout-index", "-a", "-f"], { cwd: repo.abs })
      if (co.code !== 0) {
        await log("warn", "restore checkout-index failed", { rel: repo.rel, err: co.err })
        return false
      }
      return true
    })
  }

  async function snapshotAll(refSuffix: string | number, sessionID: string, label: string): Promise<Record<string, string>> {
    const trees: Record<string, string> = {}
    await Promise.all(
      nested.map(async (repo) => {
        try {
          const tree = await snapshotRepo(repo, refSuffix, sessionID, label)
          if (tree) trees[repo.rel] = tree
        } catch (e) {
          await log("warn", "snapshot repo threw", { rel: repo.rel, err: (e as any)?.message ?? String(e) })
        }
      }),
    )
    return trees
  }

  async function restoreAll(trees: Record<string, string>): Promise<string[]> {
    const restored: string[] = []
    for (const rel of Object.keys(trees)) {
      const repo = byRel.get(rel)
      if (!repo) continue
      try {
        if (await restoreRepo(repo, trees[rel])) restored.push(rel)
      } catch (e) {
        await log("warn", "restore repo threw", { rel, err: (e as any)?.message ?? String(e) })
      }
    }
    return restored
  }

  async function fetchMessageIds(sessionID: string): Promise<string[]> {
    try {
      const r: any = await client.session.messages({ path: { id: sessionID } })
      const list = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []
      return list.map((m: any) => m?.info?.id ?? m?.id).filter((x: any): x is string => typeof x === "string")
    } catch {
      return []
    }
  }

  // Map a revert target message to the nested trees that represent the repo
  // state at the start of that message's turn.
  async function resolveTreesForRevert(sessionID: string, targetMessageID: string): Promise<Record<string, string> | null> {
    const sess = state.sessions[sessionID]
    if (!sess || sess.snapshots.length === 0) return null
    const direct = sess.snapshots.filter((s) => s.messageID)
    const exact = [...direct].reverse().find((s) => s.messageID === targetMessageID)
    if (exact) return exact.trees

    const ids = await fetchMessageIds(sessionID)
    const targetIdx = ids.indexOf(targetMessageID)
    if (targetIdx < 0) {
      // Unknown target: best-effort restore to the most recent snapshot.
      return direct[direct.length - 1]?.trees ?? null
    }
    let best: Snap | undefined
    let bestIdx = -1
    for (const s of direct) {
      const idx = s.messageID ? ids.indexOf(s.messageID) : -1
      if (idx >= 0 && idx <= targetIdx && idx > bestIdx) {
        best = s
        bestIdx = idx
      }
    }
    if (best) return best.trees
    // Target precedes our earliest snapshot: restore the earliest we have.
    return direct[0]?.trees ?? null
  }

  async function loadState() {
    try {
      const raw = await fs.readFile(statePath, "utf8")
      const parsed = JSON.parse(raw) as PersistState
      if (parsed && typeof parsed === "object" && parsed.sessions) {
        state = { version: 1, seq: parsed.seq ?? 0, nested: parsed.nested ?? [], sessions: parsed.sessions ?? {} }
      }
    } catch {
      /* first run or unreadable state */
    }
  }

  async function saveState() {
    try {
      state.nested = nested.map((n) => ({ rel: n.rel, abs: n.abs, gitdir: n.gitdir }))
      await fs.mkdir(base, { recursive: true })
      const tmp = `${statePath}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(state), "utf8")
      await fs.rename(tmp, statePath)
    } catch (e) {
      await log("warn", "failed to save state", { err: (e as any)?.message ?? String(e) })
    }
  }

  function ensureSession(sessionID: string): SessionState {
    let s = state.sessions[sessionID]
    if (!s) {
      s = { snapshots: [] }
      state.sessions[sessionID] = s
    }
    return s
  }

  function pushSnapshot(sessionID: string, snap: Snap) {
    const s = ensureSession(sessionID)
    s.snapshots.push(snap)
    if (s.snapshots.length > MAX_SNAPSHOTS_PER_SESSION) {
      const drop = s.snapshots.splice(0, s.snapshots.length - MAX_SNAPSHOTS_PER_SESSION)
      for (const d of drop) {
        for (const repo of nested) {
          git(repo.gitdir, null, ["update-ref", "-d", `refs/kilo-nested/${sessionID}/${d.seq}`], { cwd: repo.abs }).catch(
            () => {},
          )
        }
      }
    }
  }

  async function discoverNested(): Promise<NestedRepo[]> {
    const found = new Map<string, NestedRepo>()
    const addRepo = (abs: string) => {
      const rel = path.relative(worktree, abs)
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
      if (found.has(rel)) return
      found.set(rel, { rel, abs, gitdir: path.join(base, "repos", short(rel)) })
    }

    // Explicit paths from options always win.
    for (const p of opts.paths ?? []) {
      const abs = path.resolve(worktree, p)
      if ((await pathExists(path.join(abs, ".git"))) && abs !== worktree) addRepo(abs)
    }

    let visited = 0
    const queue: Array<{ dir: string; depth: number }> = [{ dir: worktree, depth: 0 }]
    while (queue.length) {
      const { dir, depth } = queue.shift()!
      if (depth > maxDepth || visited > 20000) break
      visited++
      let entries: any[] = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory() || PRUNE_DIRS.has(e.name)) continue
        const abs = path.join(dir, e.name)
        if (abs !== worktree && (await pathExists(path.join(abs, ".git")))) addRepo(abs)
        queue.push({ dir: abs, depth: depth + 1 })
      }
    }
    return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel))
  }

  const ready = (async () => {
    try {
      nested = await discoverNested()
      byRel.clear()
      for (const n of nested) byRel.set(n.rel, n)
      await loadState()
      await saveState()
      await log("info", "initialized", { base, nested: nested.map((n) => n.rel), autoRestore })
    } catch (e) {
      await log("error", "init failed", { err: (e as any)?.message ?? String(e) })
    }
  })()

  function scheduleClearRestore(sessionID: string) {
    cancelClearTimer(sessionID)
    const timer = setTimeout(() => {
      clearTimers.delete(sessionID)
      void (async () => {
        if (appliedRevert.get(sessionID) !== null) return // a new revert target arrived
        const head = state.sessions[sessionID]?.head
        if (!head?.trees) return
        const restored = await restoreAll(head.trees)
        if (restored.length) await log("info", "restored nested repos to head (redo)", { sessionID, restored })
      })()
    }, CLEAR_RESTORE_DEBOUNCE_MS)
    clearTimers.set(sessionID, timer)
  }

  function cancelClearTimer(sessionID: string) {
    const t = clearTimers.get(sessionID)
    if (t) {
      clearTimeout(t)
      clearTimers.delete(sessionID)
    }
  }

  const hooks: Hooks = {
    "chat.message": async (input, output) => {
      await ready
      if (!nested.length) return
      try {
        const sessionID = input.sessionID
        const messageID = input.messageID ?? (output as any)?.message?.id
        if (!sessionID || !messageID) return
        cancelClearTimer(sessionID)
        appliedRevert.set(sessionID, null)
        seen.add(sessionID)
        const seq = ++state.seq
        const trees = await snapshotAll(seq, sessionID, `pre ${sessionID} ${messageID}`)
        if (Object.keys(trees).length) {
          pushSnapshot(sessionID, { seq, kind: "pre", messageID, time: Date.now(), trees })
          await saveState()
          await log("debug", "captured pre-turn snapshot", { sessionID, messageID, repos: Object.keys(trees) })
        }
      } catch (e) {
        await log("warn", "chat.message hook failed", { err: (e as any)?.message ?? String(e) })
      }
    },

    event: async ({ event }) => {
      await ready
      if (!nested.length) return
      const ev = event as any
      try {
        if (ev?.type === "session.idle") {
          const sessionID = ev.properties?.sessionID
          if (!sessionID || !seen.has(sessionID)) return
          const trees = await snapshotAll("head", sessionID, `head ${sessionID}`)
          if (Object.keys(trees).length) {
            ensureSession(sessionID).head = { time: Date.now(), trees }
            await saveState()
          }
          return
        }

        if (ev?.type === "session.updated") {
          if (!autoRestore) return
          const info = ev.properties?.info
          const sessionID = info?.id
          if (!sessionID || !seen.has(sessionID)) return
          const target: string | null = info?.revert?.messageID ?? null
          const prev = appliedRevert.has(sessionID) ? appliedRevert.get(sessionID)! : null
          if (target === prev) return
          appliedRevert.set(sessionID, target)
          if (target) {
            cancelClearTimer(sessionID)
            const trees = await resolveTreesForRevert(sessionID, target)
            if (trees) {
              const restored = await restoreAll(trees)
              if (restored.length) await log("info", "restored nested repos (undo)", { sessionID, target, restored })
            }
          } else {
            // Revert cleared: redo-to-head OR a new message. Defer so a
            // following chat.message can cancel (new message keeps current state).
            scheduleClearRestore(sessionID)
          }
        }
      } catch (e) {
        await log("warn", "event hook failed", { type: ev?.type, err: (e as any)?.message ?? String(e) })
      }
    },

    tool: {
      nested_checkpoint_status: tool({
        description:
          "Show nested-git checkpoint status for this session: auto-detected nested git repos (embedded repos/submodules under the worktree), snapshot counts, and the shadow storage path.",
        args: {},
        async execute(_args, context) {
          await ready
          const s = state.sessions[context.sessionID]
          const lines: string[] = []
          lines.push(`storage: ${base}`)
          lines.push(`auto-restore: ${autoRestore ? "on" : "off"}`)
          lines.push(`nested repos (${nested.length}):`)
          for (const n of nested) lines.push(`  - ${n.rel}`)
          if (!nested.length) lines.push("  (none found under the worktree)")
          lines.push(`snapshots this session: ${s?.snapshots.length ?? 0}`)
          lines.push(`head captured: ${s?.head ? "yes" : "no"}`)
          return lines.join("\n")
        },
      }),

      nested_checkpoint_snapshot: tool({
        description:
          "Manually capture a checkpoint of every auto-detected nested git repo (embedded repos/submodules) under the worktree right now. Use before risky edits.",
        args: {
          label: tool.schema.string().optional().describe("Optional label for the snapshot"),
        },
        async execute(args, context) {
          await ready
          if (!nested.length) return "No nested git repos detected under the worktree; nothing to snapshot."
          const seq = ++state.seq
          const messageID = context.messageID || `manual-${Date.now()}`
          const trees = await snapshotAll(seq, context.sessionID, `manual ${args.label ?? messageID}`)
          if (!Object.keys(trees).length) return "Snapshot produced no trees (see logs)."
          pushSnapshot(context.sessionID, { seq, kind: "manual", messageID, time: Date.now(), trees })
          await saveState()
          return `Captured nested checkpoint #${seq} for: ${Object.keys(trees).join(", ")}`
        },
      }),

      nested_checkpoint_restore: tool({
        description:
          "Restore nested git repos (embedded repos/submodules under the worktree) to a previous checkpoint. Target: 'previous' (start of the last turn, default), 'head' (latest end-of-turn state), a messageID, or a snapshot seq number.",
        args: {
          to: tool.schema
            .string()
            .optional()
            .describe("'previous' | 'head' | <messageID> | <seq>. Defaults to 'previous'."),
        },
        async execute(args, context) {
          await ready
          if (!nested.length) return "No nested git repos detected under the worktree; nothing to restore."
          const sess = state.sessions[context.sessionID]
          if (!sess) return "No checkpoints recorded for this session yet."
          const to = (args.to ?? "previous").trim()

          let trees: Record<string, string> | null = null
          if (to === "head") {
            trees = sess.head?.trees ?? null
          } else if (to === "previous" || to === "latest") {
            const preSnaps = sess.snapshots.filter((s) => s.messageID || s.kind === "manual")
            trees = preSnaps[preSnaps.length - 1]?.trees ?? null
          } else if (/^\d+$/.test(to)) {
            trees = sess.snapshots.find((s) => s.seq === Number(to))?.trees ?? null
          } else {
            trees = await resolveTreesForRevert(context.sessionID, to)
          }

          if (!trees) return `No checkpoint found for target '${to}'.`
          const restored = await restoreAll(trees)
          return restored.length
            ? `Restored nested repos to '${to}': ${restored.join(", ")}`
            : `Nothing restored for '${to}' (see logs).`
        },
      }),
    },

    dispose: async () => {
      for (const t of clearTimers.values()) clearTimeout(t)
      clearTimers.clear()
    },
  }

  return hooks
}

export default { id: "nested-git-checkpoints", server }
