# workbench

`grill` stores durable planning artifacts outside product repositories. It shares work between clones by identifying a repository from its normalized Git `origin`.

Each work has one required `spec.md` and may gain `issues.md` and `learnings.md`:

- `spec.md` is the final specification produced by `to-prd`.
- `issues.md` is the implementation breakdown produced by `to-tasks`.
- `learnings.md` exists only when one implementation task discovers information that later tasks need.

Agent execution, task state, ownership, checkpoints, evidence, Git context, and conversation focus belong to the harness and are not stored here.

## Install

Requires [Bun](https://bun.sh/).

```sh
bun install --global github:juicerq/workbench
```

## Commands

Run commands with the product repository passed through `--repo`:

```sh
grill create --repo "$PWD" --name <work-name> --content-file <spec-path>
grill list --repo "$PWD"
grill read --repo "$PWD" --work <work-id>
grill write --repo "$PWD" --work <work-id> --artifact issues --content-file <issues-path>
grill write --repo "$PWD" --work <work-id> --artifact learnings --content-file <learnings-path>
grill write --repo "$PWD" --work <work-id> --artifact spec --content-file <spec-path>
grill remove --repo "$PWD" --work <work-id> --artifact learnings
grill remove --repo "$PWD" --work <work-id>
```

`create` derives the work ID from `--name` and creates the work only after a non-blank `spec.md` is ready. `write` accepts only non-blank `spec`, `issues`, or `learnings` content and preserves it exactly. `remove --artifact` removes only `issues.md` or `learnings.md`; omit `--artifact` to remove the whole work. `spec.md` cannot be removed by itself.

Set `WORKBENCH_HOME` to use a dedicated data root. Otherwise data lives under `$XDG_DATA_HOME/workbench`, or `~/.local/share/workbench` when `XDG_DATA_HOME` is unset. New directories are private to the current user and artifact files are written atomically.

New work lives in a separate `v2` namespace. Legacy work is never scanned, migrated, or removed; there is no automatic cleanup.

## Development

```sh
bun test
bun run typecheck
```
