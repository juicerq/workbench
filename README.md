# grill-workbench

Local, temporary coordination for conversational implementation work.

`grill` keeps grills, decisions, PRDs, tasks, ownership, and checkpoints outside product repositories. It is agent-agnostic: Codex uses `CODEX_THREAD_ID`, while other harnesses pass stable conversation and agent identifiers.

## Install

Requires [Bun](https://bun.sh/).

```sh
bun install --global github:juicerq/grill-workbench
```

This installs the dependencies and exposes the `grill` executable. Run the same command again to update it.

## Workflow

Run commands from the product repository and pass it through `--repo`:

```sh
grill current --repo "$PWD"
grill start --repo "$PWD" --name <work-name> --agent <agent-id>
grill spec-write --repo "$PWD" --agent <agent-id> --artifact decisions --content-file <path>
grill transition --repo "$PWD" --to decided
grill transition --repo "$PWD" --to tasked
grill task-add --repo "$PWD" --task <task-id> --content-file <path>
grill transition --repo "$PWD" --to implementing
grill task-claim --repo "$PWD" --task <task-id> --agent <agent-id>
grill tasks --repo "$PWD"
grill close --repo "$PWD" --outcome completed
```

Outside Codex, add `--conversation <stable-conversation-id>` to every command. Markdown content should cross the CLI boundary through temporary files outside the product repository.

The full conversational adapter contract lives in the companion `agent-setup` skill at `skills/grill-workbench/CONTRACT.md`.

## Storage and lifecycle

Data lives under `$XDG_DATA_HOME/grill-workbench`, or `~/.local/share/grill-workbench` when `XDG_DATA_HOME` is unset. Repositories are identified by normalized Git remote, so separate clones share the same local work namespace.

Active work is never deleted automatically. It is reported as stale after seven days without artifact activity. Work closed as `completed`, `abandoned`, or `superseded` is deleted opportunistically after seven days.

Task claims never expire. Another agent must perform an explicit takeover. The CLI observes Git context for warnings but never mutates Git state.

## Development

```sh
bun test
bun run typecheck
```
