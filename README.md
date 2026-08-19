# NOTE
This project may not be maintainable. Currently, just for personal use.

# kilo-plugin-nested-git-checkpoints

[![npm version](https://img.shields.io/npm/v/kilo-plugin-nested-git-checkpoints.svg)](https://www.npmjs.com/package/kilo-plugin-nested-git-checkpoints)
[![license](https://img.shields.io/npm/l/kilo-plugin-nested-git-checkpoints.svg)](./LICENSE)

A [Kilo](https://kilo.ai) / [OpenCode](https://opencode.ai) plugin that makes **checkpoints (snapshot / undo / redo) work for nested git repositories** — embedded repos and submodules that the built-in checkpoint system silently skips.

## The problem

Kilo's built-in checkpoints take a snapshot with a shadow git-dir whose work-tree is the project root:

```
git --git-dir=<shadow> --work-tree=<project root> add -A
```

Git never recurses into a directory that contains its own `.git`. Such a directory is treated as an **embedded repository / submodule boundary** and is recorded only as a gitlink (a commit pointer), never as individual files.

So if your project contains a nested git repo — for example a front-end checked out into `renderer/` that is its own repository, or any submodule — then:

- edits the agent makes inside that nested repo are **not captured** by checkpoints, and
- **undo / redo does not revert them.**

You lose the safety net exactly where you edit the most.

## What this plugin does

It closes that gap generically, without touching your real repositories. For every nested git repo it finds under the worktree it keeps a **separate shadow git-dir** in Kilo's data directory and:

- **Snapshots** each nested repo at every user-message boundary (`chat.message`), keyed by message id — the same per-turn granularity as built-in undo.
- Captures a **post-turn "head"** on `session.idle` so redo-to-head works.
- **Auto-restores** the nested repos when you use the built-in undo/redo, by watching `session.revert` on `session.updated`.
- Restores with `git read-tree -u -m`, so a revert reverts modifications, **re-adds deleted files, and removes files the agent added** — while leaving files ignored by the nested repo's own `.gitignore` untouched.

It never touches the nested repo's real `.git`; all snapshot state lives in an isolated shadow git-dir per repo.

Projects with no nested repos are detected as such and the plugin stays inert (every hook early-returns), so there is negligible overhead elsewhere.

## Requirements

- Kilo `>= 7` (or a compatible OpenCode build). Declared via `engines.opencode`.
- `git` available on `PATH`.

## Install

### Option 1 — `kilo plugin` command (recommended)

```bash
# Global (all projects on this machine)
kilo plugin kilo-plugin-nested-git-checkpoints --global

# Or just the current project
kilo plugin kilo-plugin-nested-git-checkpoints
```

### Option 2 — config file

Add it to your `kilo.json` (project) or `~/.config/kilo/kilo.json` (global):

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [
    "kilo-plugin-nested-git-checkpoints"
    // or with options:
    // ["kilo-plugin-nested-git-checkpoints", { "autoRestore": true }]
  ]
}
```

After changing config, reload the VS Code window / restart the CLI so the plugin loads at startup.

## Configuration

All options are optional. Pass them as the second element of the plugin tuple, e.g. `["kilo-plugin-nested-git-checkpoints", { ... }]`.

| Option        | Type       | Default | Description |
|---------------|------------|---------|-------------|
| `autoRestore` | `boolean`  | `true`  | Automatically restore nested repos when the built-in undo/redo fires. Set `false` to snapshot only and restore manually via tools. |
| `paths`       | `string[]` | `[]`    | Extra nested-repo paths (relative to the worktree) to always include, in addition to auto-discovery. |
| `maxDepth`    | `number`   | `8`     | Maximum directory depth scanned when auto-discovering nested repos. |
| `dataDir`     | `string`   | see below | Override the base directory used to store shadow snapshots. |

Default storage location: `$XDG_DATA_HOME/opencode/nested-snapshot/<project-id>/<worktree-hash>/` (falling back to `~/.local/share/opencode/...`). Each project/worktree is isolated.

## Tools

The plugin also registers tools you can call directly (useful as a fallback or for scripted flows):

- `nested_checkpoint_status` — show detected nested repos, snapshot counts for the session, and the storage path.
- `nested_checkpoint_snapshot` — capture a checkpoint of every nested repo right now (optional `label`).
- `nested_checkpoint_restore` — restore nested repos to `previous` (default), `head`, a message id, or a snapshot `seq` number.

## How restore maps to undo / redo

- On **undo**, Kilo sets `session.revert.messageID`. The plugin resolves the nested snapshot taken at the start of that turn (matching by message order) and restores it.
- On **redo to a specific turn**, the revert pointer moves and the plugin restores the matching snapshot.
- On **redo to head** (revert cleared with no new message), the plugin restores the last post-turn "head" snapshot. This is debounced so that sending a *new* message after an undo keeps the reverted state instead of jumping forward.

## Caveats

- It relies on the built-in checkpoint/undo signal (`session.revert`). If you disable `snapshot` entirely in your config, undo itself is unavailable and there is nothing to mirror.
- Files ignored by a nested repo's own `.gitignore` (e.g. `node_modules`, build output) are intentionally not tracked or restored.
- Do not run two copies of this plugin at once (e.g. a global install **and** a project install) — they would run duplicate hooks and race on the same shadow storage. Pick one scope.

## Development

```bash
npm install        # installs deps and builds via "prepare"
npm run build      # compile src -> dist
npm run typecheck  # type-check only
```

Project layout:

```
src/server.ts   # the plugin (single module, default-exports { id, server })
dist/           # compiled output shipped to npm (gitignored, published)
```

Publishing:

```bash
git push -u origin main   # repo: https://github.com/rianonehub/kilo-plugin-nested-git-checkpoints
npm version <patch|minor|major>
npm publish               # "prepublishOnly" rebuilds dist before publishing
```

## License

[MIT](./LICENSE) © Rian Priskanova
