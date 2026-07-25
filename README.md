# workbench

`workbench` stores durable planning artifacts outside product repositories. It shares work between clones by identifying a repository from its normalized Git `origin`.

A work exists as soon as its directory does. Every document inside it is optional, so charting a map creates the work long before a specification exists:

- `map.md` is a wayfinder map: where a large effort is going and what it has already decided.
- `tickets/<slug>.md` are its decision tickets, each with a title, type, state, assignee, and blockers.
- `assets/<name>.md` are documents produced while resolving a ticket.
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

Every command takes the product repository through `--repo` and prints one line of JSON. Document bodies always arrive through `--content-file`.

### Work

```sh
workbench create --repo "$PWD" --name <work-name> [--content-file <spec-path>]
workbench list --repo "$PWD"
workbench read --repo "$PWD" --work <work-id>
workbench write --repo "$PWD" --work <work-id> --artifact <spec|issues|learnings> --content-file <path>
workbench remove --repo "$PWD" --work <work-id> [--artifact <issues|learnings>]
```

`create` derives the work ID from `--name`. `list` reports each work's artifacts and its map's state. `read` returns `map.md`, `spec.md`, `issues.md`, and `learnings.md` when present, and never a ticket body. `write` accepts only non-blank content and preserves it exactly. `remove --artifact` removes only `issues.md` or `learnings.md`; omit `--artifact` to remove the whole work.

### Map

```sh
workbench map write --repo "$PWD" --work <work-id> --content-file <body-path>
workbench map state --repo "$PWD" --work <work-id> --state <open|closed>
```

A work holds at most one map. The CLI owns its frontmatter and a body write replaces the body whole. A map is removed only by removing its work.

### Tickets

```sh
workbench ticket create --repo "$PWD" --work <work-id> --title <title> --type <research|prototype|grilling|task> [--content-file <path>] [--blocked-by <slug>,<slug>]
workbench ticket block --repo "$PWD" --work <work-id> --ticket <slug> --blocked-by <slug>,<slug>
workbench ticket claim --repo "$PWD" --work <work-id> --ticket <slug> --assignee <dev>
workbench ticket close --repo "$PWD" --work <work-id> --ticket <slug> --content-file <resolution-path>
workbench ticket read --repo "$PWD" --work <work-id> --ticket <slug>
workbench ticket remove --repo "$PWD" --work <work-id> --ticket <slug>
workbench frontier --repo "$PWD" --work <work-id>
```

A ticket's slug comes from its title, using the same derivation as the work ID. Blocking is recorded only on the blocked ticket; `ticket read` derives the reverse direction. `ticket claim` overwrites any existing assignee and never fails. `ticket close` writes the resolution into the body and closes the ticket in one call, and refuses to close without one. `frontier` returns the open, unclaimed tickets whose blockers are all closed, as slug, title, and type.

### Assets

```sh
workbench asset write --repo "$PWD" --work <work-id> --name <asset-name> --content-file <path>
workbench asset read --repo "$PWD" --work <work-id> --name <asset-name>
```

## Storage

Set `WORKBENCH_HOME` to use a dedicated data root. Otherwise data lives under `$XDG_DATA_HOME/workbench`, or `~/.local/share/workbench` when `XDG_DATA_HOME` is unset. New directories are private to the current user and files are written atomically.

Work lives in a `v2` namespace. Legacy work is never scanned, migrated, or removed; there is no automatic cleanup.

## Development

```sh
bun test
bun run typecheck
```
