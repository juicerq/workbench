# workbench

`workbench` gives a repository's planning a durable home outside the repository, and shares it between clones by identifying the repository from its normalized Git `origin`.

It owns two things only: where a work lives, and the state of that work's tickets. Every document body belongs to whoever is editing — an agent reads and writes these files with its own file tools, not through this CLI:

- `map.md` is a wayfinder map: where a large effort is going and what it has already decided.
- `tickets/<slug>.md` are its decision tickets, each with a title, type, state, assignee, and blockers.
- `assets/<name>.md` are documents produced while resolving a ticket.
- `spec.md` is the final specification produced by `to-prd`.
- `issues.md` is the implementation breakdown produced by `to-tasks`.
- `learnings.md` exists only when one implementation task discovers information that later tasks need.

A work exists as soon as its directory does and every document inside it is optional, so charting a map creates the work long before a specification exists.

Agent execution, task state, ownership, checkpoints, evidence, Git context, and conversation focus belong to the harness and are not stored here.

## Install

Requires [Bun](https://bun.sh/).

```sh
bun install --global github:juicerq/workbench
```

## Commands

Every command takes the product repository through `--repo` and prints one line of JSON. `workbench --help` prints the same list.

### Work

```sh
workbench list --repo "$PWD"
workbench work --repo "$PWD" --name <work-name>
```

`work` derives the work ID from `--name`, creates the directory when it is missing, and prints that directory, whether it had to create it, and the documents already there. Write `map.md`, `spec.md`, `issues.md`, `learnings.md`, and anything else into it yourself, and read them the same way — reading only the part you need, because a specification and a breakdown are long. `list` reports every work with its directory, its documents, and how many tickets it holds. Remove a work by deleting its directory.

### Tickets

```sh
workbench ticket create --repo "$PWD" --work <work-id> --title <title> --type <research|prototype|grilling|task> [--blocked-by <slug>,<slug>]
workbench ticket block --repo "$PWD" --work <work-id> --ticket <slug> --blocked-by <slug>,<slug>
workbench ticket claim --repo "$PWD" --work <work-id> --ticket <slug> --assignee <dev>
workbench ticket close --repo "$PWD" --work <work-id> --ticket <slug>
workbench ticket read --repo "$PWD" --work <work-id> --ticket <slug>
workbench ticket remove --repo "$PWD" --work <work-id> --ticket <slug>
workbench frontier --repo "$PWD" --work <work-id>
```

A ticket's slug comes from its title, using the same derivation as the work ID. `ticket create` writes the frontmatter and a `## Question` heading, then returns the file's path: the question and the resolution are written into that file directly. The CLI rewrites the frontmatter on every state change and never touches the body.

Blocking is recorded only on the blocked ticket; `ticket read` derives the reverse direction and returns the ticket's fields and path, never its body. `ticket claim` overwrites any existing assignee and never fails. `ticket close` refuses a ticket whose body carries no `## Resolution` section with content under it; correcting a resolution is an edit to the file, and closing again is allowed. `frontier` returns the open, unclaimed tickets whose blockers are all closed, as slug, title, and type.

## Storage

Set `WORKBENCH_HOME` to use a dedicated data root. Otherwise data lives under `$XDG_DATA_HOME/workbench`, or `~/.local/share/workbench` when `XDG_DATA_HOME` is unset. New directories are private to the current user and ticket files are written atomically.

Work lives in a `v2` namespace. Legacy work is never scanned, migrated, or removed; there is no automatic cleanup.

## Development

```sh
bun test
bun run typecheck
```
