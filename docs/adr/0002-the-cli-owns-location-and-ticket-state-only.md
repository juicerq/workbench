# The CLI owns location and ticket state only

Two weeks of real sessions in two repositories showed where the CLI paid and where it charged. Thirty of the thirty-four works held nothing but `spec.md` and `issues.md` — a filing cabinet a directory would have served. Bodies could only enter through `--content-file`, so every map correction became copy the file out, patch it with a script, write the whole body back, while reading already bypassed the CLI by design after `read` was reduced to returning paths. The ticket layer paid for itself, but only on the four large efforts, where `frontier` answered "what can be worked now" across ten to eighteen tickets without opening any of them.

So the CLI keeps what a directory cannot give cheaply — a work's location, derived from the repository's `origin`, and the frontmatter that makes blocking, claiming, and the frontier possible — and gives up everything else. `create`, `read`, `write`, `remove`, `map write`, `map state`, `asset write`, and `asset read` are gone, replaced by `work`, which creates the directory when it is missing and prints it. No command accepts `--content-file`.

## Consequences

Every document body is now written and read with ordinary file tools, including a ticket's question and resolution: `ticket create` seeds the frontmatter and a `## Question` heading and returns the path, and `ticket close` refuses a ticket whose body holds no `## Resolution` section instead of writing one. Correcting a resolution is an edit, so `--replace` and the refusal to close a closed ticket disappear with it.

`map.md` loses its frontmatter and with it a map's `open`/`closed` state, which three calls ever set. Maps written before this decision keep a stale `state:` block; nothing reads it. Removing a work is now deleting its directory, which the CLI no longer offers as a command.
