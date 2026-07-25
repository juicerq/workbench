# Workbench

Durable planning storage for a single developer's agent sessions. It holds what a repository's planning has decided, outside the repository itself, so the knowledge survives clones, worktrees, and the end of a conversation.

## Language

**Repository**:
A product codebase, identified by its normalized Git `origin` rather than by a local path.
_Avoid_: project, clone, repo path

**Work**:
One initiative inside a repository, addressed by a stable identifier. It is the only unit that can be created, listed, read, or removed as a whole.
_Avoid_: bundle, item, initiative, effort

**Artifact**:
A named markdown document belonging to a work — its specification, issue breakdown, learnings, or map.
_Avoid_: file, document, output

**Specification**:
The current statement of what a work must deliver.
_Avoid_: PRD, requirements doc

**Breakdown**:
The static list of independently implementable issues derived from a specification.
_Avoid_: tasks, backlog, plan

**Learning**:
Current knowledge one issue discovered that changes how a later issue is implemented.
_Avoid_: notes, log, findings

**Map**:
A work's index of where a large effort is going and what it has already decided. It gists decisions and points at the tickets holding them; it never restates them.
_Avoid_: plan, roadmap, board

**Destination**:
What reaching the end of a map looks like — the specification, decision, or change the effort is finding its way to.
_Avoid_: goal, outcome

**Ticket**:
One question belonging to a map whose resolution is a decision. It is addressed by a slug and carries its question, its resolution, and its state.
_Avoid_: issue, task, card

**Blocker**:
A ticket that must be closed before another ticket can be worked. Recorded only on the blocked ticket.
_Avoid_: dependency, parent

**Frontier**:
The tickets of a map that are open, unclaimed, and free of open blockers — the edge of what can be worked now.
_Avoid_: ready queue, backlog, next up

**Claim**:
The act of naming who is working a ticket, recorded before the work starts, so a session that ends mid-ticket leaves a visible mark.
_Avoid_: lock, assignment, reservation

**Asset**:
A document produced while resolving a ticket and stored beside the map, linked from the ticket rather than pasted into it.
_Avoid_: attachment, artifact, evidence
