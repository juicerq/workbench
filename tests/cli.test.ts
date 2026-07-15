import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, stat, utimes } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WORK_RETENTION_PERIOD_MS } from "../src/workbench"

const projectRoot = join(import.meta.dir, "..")
const cliPath = join(projectRoot, "src", "cli.ts")
const temporaryDirectories: string[] = []

async function pathExists(path: string) {
	return await stat(path).then(
		() => true,
		() => false,
	)
}

async function setArtifactActivity(directory: string, at: Date) {
	for await (const path of new Bun.Glob("**/*").scan({
		absolute: true,
		cwd: directory,
		onlyFiles: true,
	})) {
		await utimes(path, at, at)
	}
}

async function run(command: string[], environment: Record<string, string>) {
	const processEnvironment = { ...Bun.env }
	delete processEnvironment.WORKBENCH_HOME
	delete processEnvironment.XDG_DATA_HOME
	const process = Bun.spawn(["bun", "run", cliPath, ...command], {
		cwd: projectRoot,
		env: { ...processEnvironment, ...environment },
		stderr: "pipe",
		stdout: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])

	return { exitCode, stdout, stderr }
}

describe("storage configuration", () => {
	test("prefers WORKBENCH_HOME as the direct data root", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const workbenchHome = join(root, "dedicated-data")
		const xdgDataHome = join(root, "xdg-data")

		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"Dedicated storage",
		], {
			WORKBENCH_HOME: workbenchHome,
			XDG_DATA_HOME: xdgDataHome,
		})

		expect(started.stderr).toBe("")
		expect(started.exitCode).toBe(0)
		expect(JSON.parse(started.stdout).directory.startsWith(workbenchHome)).toBe(true)
		expect(await pathExists(join(xdgDataHome, "workbench"))).toBe(false)
	})

	test("reports a writable storage override when the data root is read-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const readOnlyRoot = join("/sys", `workbench-${crypto.randomUUID()}`)

		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"Read-only storage",
		], { WORKBENCH_HOME: readOnlyRoot })

		expect(started.exitCode).toBe(1)
		expect(started.stdout).toBe("")
		expect(started.stderr).toContain(readOnlyRoot)
		expect(started.stderr).toContain("WORKBENCH_HOME")
	})

	test("preserves permission errors outside the data root", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")

		const result = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--artifact",
			"prd",
			"--content-file",
			"/proc/1/mem",
		], { WORKBENCH_HOME: join(root, "data") })

		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("/proc/1/mem")
		expect(result.stderr).not.toContain("WORKBENCH_HOME")
	})

	test("uses the HOME data root when dedicated and XDG roots are absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")

		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"HOME storage",
		], { HOME: join(root, "home") })

		expect(started.stderr).toBe("")
		expect(started.exitCode).toBe(0)
		expect(JSON.parse(started.stdout).directory.startsWith(
			join(root, "home", ".local", "share", "workbench"),
		)).toBe(true)
	})
})

async function git(repository: string, ...args: string[]) {
	const process = Bun.spawn(["git", "-C", repository, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])

	if (exitCode === 0) {
		return stdout.trim()
	}

	throw new Error(stderr)
}

async function createRepository(root: string, name: string, remote = "git@github.com:juicerq/example.git") {
	const repository = join(root, name)
	await mkdir(repository)
	await git(repository, "init", "-q")
	await git(repository, "remote", "add", "origin", remote)

	return repository
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("work item focus", () => {
	test("rejects blank identities before persisting work", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }

		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"   ",
			"--name",
			"Invalid identity",
		], environment)

		expect(started.exitCode).toBe(1)
		expect(started.stdout).toBe("")
	})

	test("reports no candidates before the first work item exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")

		const current = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
		], { XDG_DATA_HOME: join(root, "data") })

		expect(current.stderr).toBe("")
		expect(current.exitCode).toBe(0)
		expect(JSON.parse(current.stdout)).toEqual({ candidates: [] })
	})

	test("starts work outside the repository and reads it from another clone", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const firstClone = await createRepository(root, "first-clone")
		const secondClone = await createRepository(root, "second-clone", "https://github.com/juicerq/example.git")
		const dataDirectory = join(root, "data")
		const environment = { XDG_DATA_HOME: dataDirectory }

		const started = await run([
			"start",
			"--repo",
			firstClone,
			"--conversation",
			"conversation-1",
			"--name",
			"Improve grill workflow",
		], environment)

		expect(started.stderr).toBe("")
		expect(started.exitCode).toBe(0)
		const startedWork = JSON.parse(started.stdout)
		expect(startedWork).toMatchObject({
			name: "Improve grill workflow",
			phase: "grilling",
			outcome: "active",
			repository: "github.com/juicerq/example",
		})

		const current = await run([
			"current",
			"--repo",
			secondClone,
			"--conversation",
			"conversation-1",
		], environment)

		expect(current.stderr).toBe("")
		expect(current.exitCode).toBe(0)
		expect(JSON.parse(current.stdout)).toEqual(startedWork)
		expect(startedWork.directory.startsWith(dataDirectory)).toBe(true)
		expect(startedWork.directory.startsWith(firstClone)).toBe(false)
		expect(await Bun.file(join(startedWork.directory, "work.json")).exists()).toBe(true)
		expect(await Bun.file(join(startedWork.directory, "decisions.md")).text()).toBe("# Decisions\n")

		await Bun.write(join(startedWork.directory, "work.json"), JSON.stringify({ name: 7 }))
		const corrupted = await run([
			"current",
			"--repo",
			secondClone,
			"--conversation",
			"conversation-1",
		], environment)

		expect(corrupted.exitCode).toBe(1)
		expect(corrupted.stderr).toContain("work.json")
	})

	test("uses the Codex thread as the conversation identifier", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = {
			CODEX_THREAD_ID: "codex-thread-1",
			XDG_DATA_HOME: join(root, "data"),
		}

		const started = await run([
			"start",
			"--repo",
			repository,
			"--name",
			"Codex work",
		], environment)

		expect(started.exitCode).toBe(0)
		const current = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"codex-thread-1",
		], environment)
		expect(current.exitCode).toBe(0)
		expect(JSON.parse(current.stdout)).toEqual(JSON.parse(started.stdout))
	})

	test("keeps independent conversation focus and gives it precedence over a name", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const dataDirectory = join(root, "data")
		const environment = { XDG_DATA_HOME: dataDirectory }

		const first = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"Payments API",
		], environment)
		const second = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--name",
			"Payments UI",
		], environment)

		expect(first.exitCode).toBe(0)
		expect(second.exitCode).toBe(0)
		const firstWork = JSON.parse(first.stdout)
		const secondWork = JSON.parse(second.stdout)
		const focusFiles = await Array.fromAsync(
			new Bun.Glob("workbench/repositories/*/focus/*.json").scan({
				absolute: true,
				cwd: dataDirectory,
			}),
		)
		const focusedWorkIds = await Promise.all(
			focusFiles.map(async (path) => (await Bun.file(path).json()).workId),
		)
		expect(focusedWorkIds.sort()).toEqual([firstWork.id, secondWork.id].sort())

		const firstCurrent = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"Payments UI",
		], environment)
		const secondCurrent = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--name",
			"Payments API",
		], environment)

		expect(firstCurrent.exitCode).toBe(0)
		expect(secondCurrent.exitCode).toBe(0)
		expect(JSON.parse(firstCurrent.stdout)).toEqual(firstWork)
		expect(JSON.parse(secondCurrent.stdout)).toEqual(secondWork)
	})

	test("focuses the only active work item for a new conversation", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Only work",
		], environment)

		const inferred = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"new-conversation",
		], environment)

		expect(inferred.exitCode).toBe(0)
		expect(JSON.parse(inferred.stdout)).toEqual(JSON.parse(started.stdout))

		await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"another-creator",
			"--name",
			"Later work",
		], environment)
		const stillFocused = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"new-conversation",
		], environment)

		expect(stillFocused.exitCode).toBe(0)
		expect(JSON.parse(stillFocused.stdout)).toEqual(JSON.parse(started.stdout))
	})

	test("focuses an unambiguous name and reports ambiguous candidates without changing focus", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const works = await Promise.all([
			run(["start", "--repo", repository, "--conversation", "creator-1", "--name", "Payments API"], environment),
			run(["start", "--repo", repository, "--conversation", "creator-2", "--name", "Payments UI"], environment),
			run(["start", "--repo", repository, "--conversation", "creator-3", "--name", "Invoices"], environment),
		])
		const [paymentsApi, paymentsUi, invoices] = works.map((work) => JSON.parse(work.stdout))

		const ambiguous = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"ambiguous-conversation",
			"--name",
			"payments",
		], environment)

		expect(ambiguous.stderr).toBe("")
		expect(ambiguous.exitCode).toBe(0)
		expect(JSON.parse(ambiguous.stdout)).toEqual({
			candidates: [
				{ id: paymentsApi.id, name: "Payments API" },
				{ id: paymentsUi.id, name: "Payments UI" },
			],
		})

		const selected = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"ambiguous-conversation",
			"--name",
			"invoices",
		], environment)
		expect(selected.exitCode).toBe(0)
		expect(JSON.parse(selected.stdout)).toEqual(invoices)

		const focusWins = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"ambiguous-conversation",
			"--name",
			"payments",
		], environment)
		expect(focusWins.exitCode).toBe(0)
		expect(JSON.parse(focusWins.stdout)).toEqual(invoices)
	})
})

describe("specification lifecycle", () => {
	test("reads specification and task Markdown from files", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const decisionsPath = join(root, "decisions-source.md")
		const taskPath = join(root, "task-source.md")
		await Bun.write(decisionsPath, "# Decisions\n\nKeep the CLI authoritative.\n")
		await Bun.write(taskPath, "# Adapter\n\n- [ ] Routes natural language\n")

		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--name",
			"File input",
		], environment)
		const work = JSON.parse(started.stdout)
		const written = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--artifact",
			"decisions",
			"--content-file",
			decisionsPath,
		], environment)

		expect(written.stderr).toBe("")
		expect(written.exitCode).toBe(0)
		expect(await Bun.file(join(work.directory, "decisions.md")).text()).toBe(
			"# Decisions\n\nKeep the CLI authoritative.\n",
		)

		for (const phase of ["decided", "tasked"]) {
			const transitioned = await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"conversation-1",
				"--to",
				phase,
			], environment)
			expect(transitioned.exitCode).toBe(0)
		}

		const added = await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--task",
			"adapter",
			"--content-file",
			taskPath,
		], environment)

		expect(added.stderr).toBe("")
		expect(added.exitCode).toBe(0)
		expect(await Bun.file(join(work.directory, "tasks", "adapter", "task.md")).text()).toBe(
			"# Adapter\n\n- [ ] Routes natural language\n",
		)
	})

	test("applies legal phase transitions atomically and preserves disk after an illegal transition", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--name",
			"Lifecycle",
		], environment)
		const work = JSON.parse(started.stdout)
		const workPath = join(work.directory, "work.json")
		const beforeIllegalTransition = await Bun.file(workPath).text()

		const illegal = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"tasked",
		], environment)

		expect(illegal.exitCode).toBe(1)
		expect(illegal.stderr).toContain("Cannot transition from grilling to tasked")
		expect(await Bun.file(workPath).text()).toBe(beforeIllegalTransition)

		const decided = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"decided",
		], environment)

		expect(decided.stderr).toBe("")
		expect(decided.exitCode).toBe(0)
		const decidedWork = JSON.parse(decided.stdout)
		expect(decidedWork.phase).toBe("decided")
		expect(decidedWork.decidedAt).toBe(decidedWork.updatedAt)
		const { directory, ...persistedDecidedWork } = decidedWork
		expect(directory).toBe(work.directory)
		expect(await Bun.file(workPath).json()).toEqual(persistedDecidedWork)

		const tasked = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"tasked",
		], environment)

		expect(tasked.exitCode).toBe(0)
		const taskedWork = JSON.parse(tasked.stdout)
		expect(taskedWork.phase).toBe("tasked")
		expect(taskedWork.taskedAt).toBe(taskedWork.updatedAt)
	})

	test("requires specification ownership and records an explicit takeover", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--name",
			"Specification",
		], environment)
		expect(started.stderr).toBe("")
		expect(started.exitCode).toBe(0)
		const work = JSON.parse(started.stdout)
		const decisionsPath = join(work.directory, "decisions.md")

		const ownerWrite = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--artifact",
			"decisions",
			"--content",
			"# Decisions\n\nUse local storage.\n",
		], environment)

		expect(ownerWrite.exitCode).toBe(0)
		expect(await Bun.file(decisionsPath).text()).toBe("# Decisions\n\nUse local storage.\n")

		const rejectedWrite = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--agent",
			"agent-2",
			"--artifact",
			"decisions",
			"--content",
			"# Decisions\n\nOverwrite.\n",
		], environment)

		expect(rejectedWrite.exitCode).toBe(1)
		expect(rejectedWrite.stderr).toContain("Specification is owned by agent-1 in conversation-1")
		expect(await Bun.file(decisionsPath).text()).toBe("# Decisions\n\nUse local storage.\n")

		const takeover = await run([
			"spec-takeover",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--agent",
			"agent-2",
		], environment)

		expect(takeover.stderr).toBe("")
		expect(takeover.exitCode).toBe(0)
		const takeoverResult = JSON.parse(takeover.stdout)
		expect(takeoverResult.specification.owner).toEqual({
			agent: "agent-2",
			conversation: "conversation-2",
		})
		expect(takeoverResult.specification.takeovers.at(-1)).toMatchObject({
			from: { agent: "agent-1", conversation: "conversation-1" },
			to: { agent: "agent-2", conversation: "conversation-2" },
		})

		const prdWrite = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--agent",
			"agent-2",
			"--artifact",
			"prd",
			"--content",
			"# PRD\n",
		], environment)

		expect(prdWrite.exitCode).toBe(0)
		expect(await Bun.file(join(work.directory, "prd.md")).text()).toBe("# PRD\n")
		const decided = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"decided",
		], environment)
		const tasked = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"tasked",
		], environment)

		expect(decided.exitCode).toBe(0)
		expect(tasked.exitCode).toBe(0)
		expect(JSON.parse(tasked.stdout).phase).toBe("tasked")
		expect(await Bun.file(join(work.directory, "state.md")).exists()).toBe(false)
	})

	test("reports terminal work while freezing its lifecycle and artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--name",
			"Terminal work",
		], environment)
		const work = JSON.parse(started.stdout)
		const closed = await run([
			"close",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--outcome",
			"abandoned",
		], environment)
		expect(closed.exitCode).toBe(0)

		const current = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
		], environment)
		expect(JSON.parse(current.stdout)).toMatchObject({ outcome: "abandoned", phase: "grilling" })

		const transition = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--to",
			"decided",
		], environment)
		const specificationWrite = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--artifact",
			"decisions",
			"--content",
			"# Changed after close\n",
		], environment)

		expect(transition.exitCode).toBe(1)
		expect(transition.stderr).toContain("Work item is abandoned")
		expect(specificationWrite.exitCode).toBe(1)
		expect(specificationWrite.stderr).toContain("Work item is abandoned")
		expect(await Bun.file(join(work.directory, "decisions.md")).text()).toBe("# Decisions\n")
	})
})

describe("task coordination", () => {
	test("records claim Git context and warns when status runs from another worktree", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const worktree = join(root, "feature-worktree")
		const environment = { XDG_DATA_HOME: join(root, "data") }

		await git(repository, "config", "user.email", "test@example.com")
		await git(repository, "config", "user.name", "Test User")
		await Bun.write(join(repository, "tracked.txt"), "main\n")
		await git(repository, "add", "tracked.txt")
		await git(repository, "commit", "-qm", "initial")
		await git(repository, "branch", "feature")
		await git(repository, "worktree", "add", "-q", worktree, "feature")
		await Bun.write(join(worktree, "tracked.txt"), "feature\n")
		await git(worktree, "commit", "-qam", "feature")

		await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Git context",
		], environment)
		for (const phase of ["decided", "tasked"]) {
			await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
		}
		await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"git-aware",
			"--content",
			"# Git aware\n",
		], environment)
		const prematureClaim = await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"agent-conversation",
			"--agent",
			"agent-1",
			"--task",
			"git-aware",
		], environment)
		expect(prematureClaim.exitCode).toBe(1)
		expect(prematureClaim.stderr).toContain("Task claims require implementing work")
		const implementing = await run([
			"transition",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--to",
			"implementing",
		], environment)
		expect(implementing.exitCode).toBe(0)

		const mainContext = {
			branch: await git(repository, "branch", "--show-current"),
			commit: await git(repository, "rev-parse", "HEAD"),
			repository: "github.com/juicerq/example",
			worktree: repository,
		}
		const featureContext = {
			branch: await git(worktree, "branch", "--show-current"),
			commit: await git(worktree, "rev-parse", "HEAD"),
			repository: "github.com/juicerq/example",
			worktree,
		}
		const gitStateBefore = {
			mainBranch: mainContext.branch,
			mainCommit: mainContext.commit,
			mainStatus: await git(repository, "status", "--porcelain"),
			featureBranch: featureContext.branch,
			featureCommit: featureContext.commit,
			featureStatus: await git(worktree, "status", "--porcelain"),
			worktrees: await git(repository, "worktree", "list", "--porcelain"),
		}

		const claimed = await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"agent-conversation",
			"--agent",
			"agent-1",
			"--task",
			"git-aware",
		], environment)
		expect(claimed.stderr).toBe("")
		expect(claimed.exitCode).toBe(0)
		expect(JSON.parse(claimed.stdout)).toEqual({
			context: mainContext,
			owner: { agent: "agent-1", conversation: "agent-conversation" },
			takeovers: [],
		})

		const status = await run([
			"tasks",
			"--repo",
			worktree,
			"--conversation",
			"creator",
		], environment)
		expect(status.stderr).toBe("")
		expect(status.exitCode).toBe(0)
		expect(JSON.parse(status.stdout)).toEqual({
			context: featureContext,
			tasks: [{
				availability: "in-progress",
				claimContext: mainContext,
				dependencies: [],
				id: "git-aware",
				owner: { agent: "agent-1", conversation: "agent-conversation" },
				status: "pending",
				warnings: [
					{
						code: "worktree-mismatch",
						expected: repository,
						observed: worktree,
					},
					{
						code: "branch-mismatch",
						expected: mainContext.branch,
						observed: featureContext.branch,
					},
					{
						code: "commit-mismatch",
						expected: mainContext.commit,
						observed: featureContext.commit,
					},
				],
			}],
		})
		expect({
			mainBranch: await git(repository, "branch", "--show-current"),
			mainCommit: await git(repository, "rev-parse", "HEAD"),
			mainStatus: await git(repository, "status", "--porcelain"),
			featureBranch: await git(worktree, "branch", "--show-current"),
			featureCommit: await git(worktree, "rev-parse", "HEAD"),
			featureStatus: await git(worktree, "status", "--porcelain"),
			worktrees: await git(repository, "worktree", "list", "--porcelain"),
		}).toEqual(gitStateBefore)
	})

	test("rejects completion by a non-owner and with unchecked acceptance criteria", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }

		await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Evidence-backed completion",
		], environment)
		for (const phase of ["decided", "tasked", "implementing"]) {
			const transitioned = await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
			expect(transitioned.exitCode).toBe(0)
		}
		await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"implement",
			"--content",
			"# Implement\n\n- [x] First criterion\n- [ ] Second criterion\n",
		], environment)
		await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
		], environment)

		const nonOwner = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"other-conversation",
			"--agent",
			"other-agent",
			"--task",
			"implement",
			"--validation",
			"bun test",
		], environment)
		expect(nonOwner.exitCode).toBe(1)
		expect(nonOwner.stderr).toContain("Task implement is owned by owner-agent in owner-conversation")

		const unchecked = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
			"--validation",
			"bun test",
		], environment)
		expect(unchecked.exitCode).toBe(1)
		expect(unchecked.stderr).toContain("Task implement has unchecked acceptance criteria")

		const nonOwnerCheck = await run([
			"task-check",
			"--repo",
			repository,
			"--conversation",
			"other-conversation",
			"--agent",
			"other-agent",
			"--task",
			"implement",
			"--criterion",
			"2",
		], environment)
		expect(nonOwnerCheck.exitCode).toBe(1)
		expect(nonOwnerCheck.stderr).toContain("Task implement is owned by owner-agent in owner-conversation")

		const invalidCriterion = await run([
			"task-check",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
			"--criterion",
			"3",
		], environment)
		expect(invalidCriterion.exitCode).toBe(1)
		expect(invalidCriterion.stderr).toContain("Task implement has no acceptance criterion 3")

		const checked = await run([
			"task-check",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
			"--criterion",
			"2",
		], environment)
		expect(checked.stderr).toBe("")
		expect(checked.exitCode).toBe(0)

		const emptyValidation = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
			"--validation",
			" ",
		], environment)
		expect(emptyValidation.exitCode).toBe(1)

		const completed = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"implement",
			"--validation",
			"bun test",
		], environment)
		expect(completed.stderr).toBe("")
		expect(completed.exitCode).toBe(0)
		expect(JSON.parse(completed.stdout).task.status).toBe("completed")
	})

	test("replaces the owner checkpoint and completes with evidence without closing work", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Task handoff",
		], environment)
		const work = JSON.parse(started.stdout)
		for (const phase of ["decided", "tasked", "implementing"]) {
			await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
		}
		await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"handoff",
			"--content",
			"# Handoff\n\n- [x] Persists evidence\n",
		], environment)
		await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"handoff",
		], environment)

		const rejectedCheckpoint = await run([
			"task-checkpoint",
			"--repo",
			repository,
			"--conversation",
			"other-conversation",
			"--agent",
			"other-agent",
			"--task",
			"handoff",
			"--done",
			"Nothing",
			"--next",
			"Take over",
			"--validation",
			"Not run",
		], environment)
		expect(rejectedCheckpoint.exitCode).toBe(1)

		for (const done of ["Implemented parser", "Implemented and refactored parser"]) {
			const checkpoint = await run([
				"task-checkpoint",
				"--repo",
				repository,
				"--conversation",
				"owner-conversation",
				"--agent",
				"owner-agent",
				"--task",
				"handoff",
				"--done",
				done,
				"--next",
				"Run the suite",
				"--validation",
				"Focused test passes",
			], environment)
			expect(checkpoint.exitCode).toBe(0)
		}
		const taskDirectory = join(work.directory, "tasks", "handoff")
		expect(await Bun.file(join(taskDirectory, "checkpoint.md")).text()).toBe(
			"# Done\n\nImplemented and refactored parser\n\n# Next\n\nRun the suite\n\n# Validation\n\nFocused test passes\n",
		)
		await rm(join(taskDirectory, "checkpoint.md"))
		await mkdir(join(taskDirectory, "checkpoint.md"))

		const completed = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"handoff",
			"--validation",
			"bun test and bun run typecheck",
		], environment)
		expect(completed.stderr).toBe("")
		expect(completed.exitCode).toBe(0)
		const result = JSON.parse(completed.stdout)
		expect(result.exhausted).toBe(true)
		expect(result.task).toMatchObject({
			dependencies: [],
			id: "handoff",
			status: "completed",
		})
		expect(result.task.completedAt).toBeString()
		expect(await Bun.file(join(taskDirectory, "task.json")).json()).toEqual(result.task)
		expect(await Bun.file(join(taskDirectory, "evidence.md")).text()).toBe(
			"# Validation\n\nbun test and bun run typecheck\n",
		)
		expect(await Bun.file(join(taskDirectory, "checkpoint.md")).exists()).toBe(false)
		expect(await Bun.file(join(taskDirectory, "claim")).exists()).toBe(false)

		const current = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(JSON.parse(current.stdout)).toMatchObject({ outcome: "active" })
		expect(JSON.parse(current.stdout).closedAt).toBeUndefined()
	})

	test("drops with a reason and closes work only through an explicit terminal outcome", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Dropped task",
		], environment)
		const work = JSON.parse(started.stdout)
		for (const phase of ["decided", "tasked", "implementing"]) {
			await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
		}
		await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"discarded",
			"--content",
			"# Discarded\n\n- [ ] Cannot finish\n",
		], environment)
		await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"discarded",
		], environment)

		const missingReason = await run([
			"task-drop",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"discarded",
			"--reason",
			"",
		], environment)
		expect(missingReason.exitCode).toBe(1)

		const dropped = await run([
			"task-drop",
			"--repo",
			repository,
			"--conversation",
			"owner-conversation",
			"--agent",
			"owner-agent",
			"--task",
			"discarded",
			"--reason",
			"The dependency is no longer needed",
		], environment)
		expect(dropped.exitCode).toBe(0)
		const droppedResult = JSON.parse(dropped.stdout)
		expect(droppedResult.exhausted).toBe(true)
		expect(droppedResult.task).toMatchObject({ status: "dropped" })
		expect(droppedResult.task.completedAt).toBeUndefined()
		expect(droppedResult.task.validation).toBeUndefined()
		expect(droppedResult.task.reason).toBeUndefined()
		expect(
			await Bun.file(join(work.directory, "tasks", "discarded", "evidence.md")).text(),
		).toBe("# Drop reason\n\nThe dependency is no longer needed\n")

		const invalidOutcome = await run([
			"close",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--outcome",
			"active",
		], environment)
		expect(invalidOutcome.exitCode).toBe(1)

		const closed = await run([
			"close",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--outcome",
			"abandoned",
		], environment)
		expect(closed.stderr).toBe("")
		expect(closed.exitCode).toBe(0)
		const closedWork = JSON.parse(closed.stdout)
		expect(closedWork).toMatchObject({ outcome: "abandoned" })
		expect(closedWork.closedAt).toBe(closedWork.updatedAt)
		const { directory, ...persistedWork } = closedWork
		expect(directory).toBe(work.directory)
		expect(await Bun.file(join(work.directory, "work.json")).json()).toEqual(persistedWork)

		const repeatedClose = await run([
			"close",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--outcome",
			"completed",
		], environment)
		expect(repeatedClose.exitCode).toBe(1)
		expect(repeatedClose.stderr).toContain("Work item is already abandoned")
	})

	test("gives exactly one of two competing CLI processes the task claim", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Concurrent claims",
		], environment)
		const work = JSON.parse(started.stdout)
		for (const phase of ["decided", "tasked", "implementing"]) {
			const transitioned = await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
			expect(transitioned.exitCode).toBe(0)
		}

		const added = await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"implement-claims",
			"--content",
			"# Implement claims\n",
		], environment)
		expect(added.exitCode).toBe(0)

		const contenders = [
			{ agent: "agent-1", conversation: "conversation-1" },
			{ agent: "agent-2", conversation: "conversation-2" },
		]
		const results = await Promise.all(
			contenders.map(({ agent, conversation }) =>
				run([
					"task-claim",
					"--repo",
					repository,
					"--conversation",
					conversation,
					"--agent",
					agent,
					"--task",
					"implement-claims",
				], environment),
			),
		)
		const winner = results.find((result) => result.exitCode === 0)
		const loser = results.find((result) => result.exitCode === 1)

		expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1)
		expect(results.filter((result) => result.exitCode === 1)).toHaveLength(1)
		expect(winner?.stderr).toBe("")
		const claim = JSON.parse(winner?.stdout ?? "")
		const owner = claim.owner
		expect(contenders).toContainEqual(owner)
		expect(loser?.stderr).toContain(`Task implement-claims is claimed by ${owner.agent} in ${owner.conversation}`)
		expect(await Bun.file(join(work.directory, "tasks", "implement-claims", "claim", "owner.json")).json()).toEqual(claim)
	})

	test("derives task availability and records explicit takeover without persisting derived states", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Task states",
		], environment)
		const work = JSON.parse(started.stdout)
		const prematureTask = await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"premature",
			"--content",
			"# Premature\n",
		], environment)
		expect(prematureTask.exitCode).toBe(1)
		expect(prematureTask.stderr).toContain("Tasks require tasked or implementing work")
		for (const phase of ["decided", "tasked", "implementing"]) {
			const transitioned = await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
			expect(transitioned.exitCode).toBe(0)
		}
		const taskDefinitions = [
			{ id: "foundation", content: "# Foundation\n" },
			{ id: "blocked", content: "# Blocked\n", dependencies: "missing" },
			{ id: "available", content: "# Available\n", dependencies: "foundation" },
			{ id: "claimed", content: "# Claimed\n" },
		]

		for (const task of taskDefinitions) {
			const command = [
				"task-add",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--task",
				task.id,
				"--content",
				task.content,
			]
			if (task.dependencies) {
				command.push("--dependencies", task.dependencies)
			}

			const added = await run(command, environment)
			expect(added.exitCode).toBe(0)
			expect(await Bun.file(join(work.directory, "tasks", task.id, "task.md")).text()).toBe(task.content)
		}

		await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"foundation-conversation",
			"--agent",
			"foundation-agent",
			"--task",
			"foundation",
		], environment)
		const foundationCompletion = await run([
			"task-complete",
			"--repo",
			repository,
			"--conversation",
			"foundation-conversation",
			"--agent",
			"foundation-agent",
			"--task",
			"foundation",
			"--validation",
			"Foundation behavior verified",
		], environment)
		expect(foundationCompletion.exitCode).toBe(0)
		const blockedClaim = await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--task",
			"blocked",
		], environment)
		expect(blockedClaim.exitCode).toBe(1)
		expect(blockedClaim.stderr).toContain("Task blocked is blocked by missing")

		const initialClaim = await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"conversation-1",
			"--agent",
			"agent-1",
			"--task",
			"claimed",
		], environment)
		expect(initialClaim.exitCode).toBe(0)
		const initialClaimResult = JSON.parse(initialClaim.stdout)

		const listed = await run([
			"tasks",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(listed.stderr).toBe("")
		expect(listed.exitCode).toBe(0)
		expect(JSON.parse(listed.stdout)).toEqual({
			context: initialClaimResult.context,
			tasks: [
				{ availability: "available", dependencies: ["foundation"], id: "available", status: "pending" },
				{ availability: "blocked", dependencies: ["missing"], id: "blocked", status: "pending" },
				{
					availability: "in-progress",
					claimContext: initialClaimResult.context,
					dependencies: [],
					id: "claimed",
					owner: { agent: "agent-1", conversation: "conversation-1" },
					status: "pending",
					warnings: [],
				},
				{
					availability: "completed",
					completedAt: expect.any(String),
					dependencies: [],
					id: "foundation",
					status: "completed",
				},
			],
		})
		for (const task of taskDefinitions) {
			const metadata = await Bun.file(join(work.directory, "tasks", task.id, "task.json")).json()
			expect(["pending", "completed", "dropped"]).toContain(metadata.status)
			expect(metadata.availability).toBeUndefined()
		}

		const takeover = await run([
			"task-takeover",
			"--repo",
			repository,
			"--conversation",
			"conversation-2",
			"--agent",
			"agent-2",
			"--task",
			"claimed",
		], environment)
		expect(takeover.stderr).toBe("")
		expect(takeover.exitCode).toBe(0)
		const claim = JSON.parse(takeover.stdout)
		expect(claim.owner).toEqual({ agent: "agent-2", conversation: "conversation-2" })
		expect(claim.takeovers).toHaveLength(1)
		expect(claim.takeovers[0]).toMatchObject({
			from: { agent: "agent-1", conversation: "conversation-1" },
			to: { agent: "agent-2", conversation: "conversation-2" },
	})
		expect(await Bun.file(join(work.directory, "tasks", "claimed", "claim", "owner.json")).json()).toEqual(claim)
		const concurrentTakeovers = await Promise.all([
			run([
				"task-takeover",
				"--repo",
				repository,
				"--conversation",
				"conversation-3",
				"--agent",
				"agent-3",
				"--task",
				"claimed",
			], environment),
			run([
				"task-takeover",
				"--repo",
				repository,
				"--conversation",
				"conversation-4",
				"--agent",
				"agent-4",
				"--task",
				"claimed",
			], environment),
		])
		expect(concurrentTakeovers.every((result) => result.exitCode === 0)).toBe(true)
		const takeoverHistory = await Bun.file(join(work.directory, "tasks", "claimed", "claim", "owner.json")).json()
		expect(takeoverHistory.takeovers).toHaveLength(3)
		expect(takeoverHistory.takeovers.at(-1).to).toEqual(takeoverHistory.owner)

		await Bun.write(join(work.directory, "tasks", "available", "task.json"), JSON.stringify({
			dependencies: ["foundation"],
			id: "available",
			status: "in-progress",
		}))
		const malformed = await run([
			"tasks",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(malformed.exitCode).toBe(1)
		expect(malformed.stderr).toContain("task.json")
	})
})

describe("temporary work retention", () => {
	test("derives stale active work from artifact activity without persisting or deleting it", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const started = await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--name",
			"Inactive work",
		], environment)
		const work = JSON.parse(started.stdout)
		const inactiveAt = new Date(Date.now() - WORK_RETENTION_PERIOD_MS - 1_000)
		const workPath = join(work.directory, "work.json")
		const metadata = await Bun.file(workPath).json()

		await Bun.write(workPath, `${JSON.stringify({
			...metadata,
			createdAt: inactiveAt.toISOString(),
			updatedAt: inactiveAt.toISOString(),
		}, null, 2)}\n`)
		await Promise.all([
			utimes(workPath, inactiveAt, inactiveAt),
			utimes(join(work.directory, "decisions.md"), inactiveAt, inactiveAt),
		])

		const status = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)

		expect(status.stderr).toBe("")
		expect(status.exitCode).toBe(0)
		expect(JSON.parse(status.stdout)).toMatchObject({
			id: work.id,
			outcome: "active",
			stale: true,
			suggestedActions: ["resume", "close"],
		})
		expect(await Bun.file(workPath).json()).toEqual({
			...metadata,
			createdAt: inactiveAt.toISOString(),
			updatedAt: inactiveAt.toISOString(),
		})
		expect(await pathExists(work.directory)).toBe(true)

		const specificationWrite = await run([
			"spec-write",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--agent",
			"creator",
			"--artifact",
			"decisions",
			"--content",
			"# Decisions\n\nRecently changed.\n",
		], environment)
		expect(specificationWrite.exitCode).toBe(0)

		const recentlyActive = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(recentlyActive.exitCode).toBe(0)
		expect(JSON.parse(recentlyActive.stdout).stale).toBeUndefined()

		for (const phase of ["decided", "tasked", "implementing"]) {
			const transitioned = await run([
				"transition",
				"--repo",
				repository,
				"--conversation",
				"creator",
				"--to",
				phase,
			], environment)
			expect(transitioned.exitCode).toBe(0)
		}
		const added = await run([
			"task-add",
			"--repo",
			repository,
			"--conversation",
			"creator",
			"--task",
			"resume-work",
			"--content",
			"# Resume work\n",
		], environment)
		expect(added.exitCode).toBe(0)
		const taskedMetadata = await Bun.file(workPath).json()
		await Bun.write(workPath, `${JSON.stringify({
			...taskedMetadata,
			updatedAt: inactiveAt.toISOString(),
		}, null, 2)}\n`)
		await setArtifactActivity(work.directory, inactiveAt)

		const claimed = await run([
			"task-claim",
			"--repo",
			repository,
			"--conversation",
			"agent-conversation",
			"--agent",
			"agent-1",
			"--task",
			"resume-work",
		], environment)
		expect(claimed.exitCode).toBe(0)
		const activeClaim = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(JSON.parse(activeClaim.stdout).stale).toBeUndefined()

		await setArtifactActivity(work.directory, inactiveAt)
		const checkpoint = await run([
			"task-checkpoint",
			"--repo",
			repository,
			"--conversation",
			"agent-conversation",
			"--agent",
			"agent-1",
			"--task",
			"resume-work",
			"--done",
			"Claimed the task",
			"--next",
			"Resume implementation",
			"--validation",
			"Not run",
		], environment)
		expect(checkpoint.exitCode).toBe(0)
		const activeCheckpoint = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(JSON.parse(activeCheckpoint.stdout).stale).toBeUndefined()

		const currentMetadata = await Bun.file(workPath).json()
		await Bun.write(workPath, `${JSON.stringify({
			...currentMetadata,
			updatedAt: "not a timestamp",
		}, null, 2)}\n`)
		const invalidTimestamp = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"creator",
		], environment)
		expect(invalidTimestamp.exitCode).toBe(1)
		expect(invalidTimestamp.stderr).toContain("work.json")
	})

	test("removes every expired terminal outcome on normal CLI use and preserves active work", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-"))
		temporaryDirectories.push(root)
		const repository = await createRepository(root, "repository")
		const environment = { XDG_DATA_HOME: join(root, "data") }
		const active = JSON.parse((await run([
			"start",
			"--repo",
			repository,
			"--conversation",
			"active-conversation",
			"--name",
			"Still active",
		], environment)).stdout)
		const expiredAt = new Date(Date.now() - WORK_RETENTION_PERIOD_MS - 1_000)
		const terminalWorks = []

		for (const outcome of ["completed", "abandoned", "superseded"]) {
			const conversation = `${outcome}-conversation`
			const started = JSON.parse((await run([
				"start",
				"--repo",
				repository,
				"--conversation",
				conversation,
				"--name",
				`${outcome} work`,
			], environment)).stdout)
			await run([
				"close",
				"--repo",
				repository,
				"--conversation",
				conversation,
				"--outcome",
				outcome,
			], environment)
			const metadata = await Bun.file(join(started.directory, "work.json")).json()
			await Bun.write(join(started.directory, "work.json"), `${JSON.stringify({
				...metadata,
				closedAt: expiredAt.toISOString(),
			}, null, 2)}\n`)
			terminalWorks.push(started)
		}
		const malformedWorkDirectory = join(active.directory, "..", "malformed-work")
		await mkdir(malformedWorkDirectory)
		await Bun.write(join(malformedWorkDirectory, "work.json"), JSON.stringify({
			closedAt: "not a timestamp",
			outcome: "completed",
		}))

		const current = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"active-conversation",
		], environment)

		expect(current.stderr).toBe("")
		expect(current.exitCode).toBe(0)
		expect(JSON.parse(current.stdout).id).toBe(active.id)
		expect(await pathExists(active.directory)).toBe(true)
		expect(await pathExists(malformedWorkDirectory)).toBe(true)
		for (const work of terminalWorks) {
			expect(await pathExists(work.directory)).toBe(false)
		}

		const removedFocus = await run([
			"current",
			"--repo",
			repository,
			"--conversation",
			"completed-conversation",
		], environment)
		expect(removedFocus.exitCode).toBe(0)
		expect(JSON.parse(removedFocus.stdout).id).toBe(active.id)
	})
})
