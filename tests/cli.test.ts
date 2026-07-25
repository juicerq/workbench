import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const projectRoot = join(import.meta.dir, "..")
const cliPath = join(projectRoot, "src", "cli.ts")
const temporaryDirectories: string[] = []

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

	if (exitCode !== 0) {
		throw new Error(stderr)
	}

	return stdout.trim()
}

async function createRepository(root: string, name: string, remote = "git@github.com:juicerq/example.git") {
	const repository = join(root, name)
	await mkdir(repository)
	await git(repository, "init", "-q")
	await git(repository, "remote", "add", "origin", remote)

	return repository
}

async function run(command: string[], environment: Record<string, string>) {
	const processEnvironment = { ...Bun.env }
	delete processEnvironment.WORKBENCH_HOME
	delete processEnvironment.XDG_DATA_HOME
	delete processEnvironment.HOME
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

	return { exitCode, stderr, stdout }
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "workbench-"))
	temporaryDirectories.push(root)
	const repository = await createRepository(root, "repository")
	const workbenchHome = join(root, "data")
	const specPath = join(root, "spec-source.md")
	await Bun.write(specPath, "# Specification\n\nBuild the direct path.\n")

	return { repository, root, specPath, workbenchHome }
}

async function createWork(input: Awaited<ReturnType<typeof fixture>>, name = "Improve café") {
	return await run([
		"create",
		"--repo",
		input.repository,
		"--name",
		name,
		"--content-file",
		input.specPath,
	], { WORKBENCH_HOME: input.workbenchHome })
}

async function contentFile(input: Awaited<ReturnType<typeof fixture>>, name: string, content: string) {
	const path = join(input.root, name)
	await Bun.write(path, content)

	return path
}

async function createTicket(
	input: Awaited<ReturnType<typeof fixture>>,
	work: string,
	title: string,
	type: string,
	body?: string,
	blockedBy?: string[],
) {
	return await run([
		"ticket", "create", "--repo", input.repository, "--work", work,
		"--title", title, "--type", type,
		...body ? ["--content-file", body] : [],
		...blockedBy ? ["--blocked-by", blockedBy.join(",")] : [],
	], { WORKBENCH_HOME: input.workbenchHome })
}

async function frontier(input: Awaited<ReturnType<typeof fixture>>, work: string) {
	const result = await run(["frontier", "--repo", input.repository, "--work", work], {
		WORKBENCH_HOME: input.workbenchHome,
	})

	expect(result.exitCode).toBe(0)

	return JSON.parse(result.stdout).tickets
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
		await rm(directory, { force: true, recursive: true }),
	))
})

describe("storage", () => {
	test("uses WORKBENCH_HOME directly and keeps new data private", async () => {
		const input = await fixture()
		const created = await createWork(input)

		expect(created.stderr).toBe("")
		expect(created.exitCode).toBe(0)
		const work = JSON.parse(created.stdout)
		expect(work).toMatchObject({
			id: "improve-cafe",
			repository: "github.com/juicerq/example",
		})
		expect(work.directory.startsWith(input.workbenchHome)).toBe(true)
		expect((await stat(work.directory)).mode & 0o777).toBe(0o700)
		expect((await stat(join(work.directory, "spec.md"))).mode & 0o777).toBe(0o600)
		expect(await Bun.file(join(work.directory, "spec.md")).text()).toBe(
			"# Specification\n\nBuild the direct path.\n",
		)
		expect((await Array.fromAsync(new Bun.Glob("*").scan({ cwd: work.directory }))).sort()).toEqual([
			"spec.md",
		])
	})

	test("uses XDG_DATA_HOME and HOME fallbacks", async () => {
		const input = await fixture()
		const xdg = await run([
			"create", "--repo", input.repository, "--name", "XDG", "--content-file", input.specPath,
		], { XDG_DATA_HOME: join(input.root, "xdg") })
		const home = await run([
			"create", "--repo", input.repository, "--name", "Home", "--content-file", input.specPath,
		], { HOME: join(input.root, "home") })

		expect(JSON.parse(xdg.stdout).directory.startsWith(join(input.root, "xdg", "workbench"))).toBe(true)
		expect(JSON.parse(home.stdout).directory.startsWith(
			join(input.root, "home", ".local", "share", "workbench"),
		)).toBe(true)
	})

	test("suggests WORKBENCH_HOME when its data root is read-only", async () => {
		const input = await fixture()
		const readOnlyRoot = join("/sys", `workbench-${crypto.randomUUID()}`)
		const created = await run([
			"create", "--repo", input.repository, "--name", "Read only", "--content-file", input.specPath,
		], { WORKBENCH_HOME: readOnlyRoot })

		expect(created.exitCode).toBe(1)
		expect(created.stdout).toBe("")
		expect(created.stderr).toContain(readOnlyRoot)
		expect(created.stderr).toContain("WORKBENCH_HOME")
	})
})

describe("work artifacts", () => {
	test("shares repository work between clones with equivalent remotes", async () => {
		const input = await fixture()
		const secondClone = await createRepository(
			input.root,
			"second-clone",
			"https://github.com/juicerq/example.git",
		)
		const created = await createWork(input)
		const work = JSON.parse(created.stdout)
		const read = await run([
			"read", "--repo", secondClone, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(read.stderr).toBe("")
		expect(read.exitCode).toBe(0)
		expect(JSON.parse(read.stdout)).toEqual({
			artifacts: { spec: "# Specification\n\nBuild the direct path.\n" },
			directory: work.directory,
			id: "improve-cafe",
			repository: "github.com/juicerq/example",
		})
	})

	test("creates a work only once without replacing its specification", async () => {
		const input = await fixture()
		const first = await createWork(input, "Same work")
		await Bun.write(input.specPath, "replacement")
		const duplicate = await createWork(input, "Same work")

		expect(first.exitCode).toBe(0)
		expect(duplicate.exitCode).toBe(1)
		expect(await Bun.file(join(JSON.parse(first.stdout).directory, "spec.md")).text()).toBe(
			"# Specification\n\nBuild the direct path.\n",
		)
	})

	test("rejects blank specifications without creating a work", async () => {
		const input = await fixture()
		await Bun.write(input.specPath, " \n\t")
		const created = await createWork(input, "Blank spec")
		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(created.exitCode).toBe(1)
		expect(JSON.parse(listed.stdout).works).toEqual([])
	})

	test("lists every work directory with the artifacts it holds", async () => {
		const input = await fixture()
		const first = JSON.parse((await createWork(input, "Zulu")).stdout)
		const second = JSON.parse((await createWork(input, "Alpha")).stdout)
		const workParent = join(first.directory, "..")
		await mkdir(join(workParent, ".unfinished"))
		await run([
			"write", "--repo", input.repository, "--work", "alpha",
			"--artifact", "issues", "--content-file", input.specPath,
		], { WORKBENCH_HOME: input.workbenchHome })

		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(listed.exitCode).toBe(0)
		expect(JSON.parse(listed.stdout).works).toEqual([
			{ artifacts: ["issues", "spec"], directory: second.directory, id: "alpha" },
			{ artifacts: ["spec"], directory: first.directory, id: "zulu" },
		])
	})

	test("creates and lists a work that has no specification", async () => {
		const input = await fixture()
		const created = await run([
			"create", "--repo", input.repository, "--name", "Chart first",
		], { WORKBENCH_HOME: input.workbenchHome })
		const work = JSON.parse(created.stdout)
		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})
		const read = await run([
			"read", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })
		const written = await run([
			"write", "--repo", input.repository, "--work", work.id,
			"--artifact", "spec", "--content-file", input.specPath,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(created.exitCode).toBe(0)
		expect(JSON.parse(listed.stdout).works).toEqual([
			{ artifacts: [], directory: work.directory, id: "chart-first" },
		])
		expect(JSON.parse(read.stdout).artifacts).toEqual({})
		expect(written.exitCode).toBe(0)
		expect(await Bun.file(join(work.directory, "spec.md")).text()).toBe(
			"# Specification\n\nBuild the direct path.\n",
		)
	})

	test("never scans or removes legacy work outside the v2 namespace", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input, "Current work")).stdout)
		const repositoryHash = work.directory.split("/").at(-3)
		const legacyDirectory = join(
			input.workbenchHome,
			"repositories",
			repositoryHash,
			"work",
			"legacy-work",
		)
		await mkdir(legacyDirectory, { recursive: true })
		await Bun.write(join(legacyDirectory, "spec.md"), "legacy")

		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})
		const removed = await run([
			"remove", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(listed.stdout).works).toEqual([
			{ artifacts: ["spec"], directory: work.directory, id: work.id },
		])
		expect(removed.exitCode).toBe(0)
		expect(await Bun.file(join(legacyDirectory, "spec.md")).text()).toBe("legacy")
	})

	test("writes and reads only the three approved artifacts", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const issuesPath = join(input.root, "issues-source.md")
		const learningsPath = join(input.root, "learnings-source.md")
		await Bun.write(issuesPath, "# Issues\n\n- Implement the slice.\n")
		await Bun.write(learningsPath, "# Learnings\n\nThe API returns UTC.\n")

		for (const [artifact, path] of [["issues", issuesPath], ["learnings", learningsPath]]) {
			const written = await run([
				"write", "--repo", input.repository, "--work", work.id,
				"--artifact", artifact, "--content-file", path,
			], { WORKBENCH_HOME: input.workbenchHome })
			expect(written.exitCode).toBe(0)
			expect((await stat(join(work.directory, `${artifact}.md`))).mode & 0o777).toBe(0o600)
		}

		const read = await run([
			"read", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })
		expect(JSON.parse(read.stdout).artifacts).toEqual({
			issues: "# Issues\n\n- Implement the slice.\n",
			learnings: "# Learnings\n\nThe API returns UTC.\n",
			spec: "# Specification\n\nBuild the direct path.\n",
		})

		const rejected = await run([
			"write", "--repo", input.repository, "--work", work.id,
			"--artifact", "decisions", "--content-file", issuesPath,
		], { WORKBENCH_HOME: input.workbenchHome })
		expect(rejected.exitCode).toBe(1)
		expect(await Bun.file(join(work.directory, "decisions.md")).exists()).toBe(false)
	})

	test("rejects blank writes and preserves the previous artifact byte for byte", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const original = "  # Issues\n\nKeep surrounding whitespace.  \n"
		const contentPath = join(input.root, "content.md")
		await Bun.write(contentPath, original)
		const written = await run([
			"write", "--repo", input.repository, "--work", work.id,
			"--artifact", "issues", "--content-file", contentPath,
		], { WORKBENCH_HOME: input.workbenchHome })
		await Bun.write(contentPath, " \n\t")
		const rejected = await run([
			"write", "--repo", input.repository, "--work", work.id,
			"--artifact", "issues", "--content-file", contentPath,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(written.exitCode).toBe(0)
		expect(rejected.exitCode).toBe(1)
		expect(await Bun.file(join(work.directory, "issues.md")).text()).toBe(original)
	})

	test("requires the work directory before reading, writing, or removing work", async () => {
		const input = await fixture()
		const contentPath = join(input.root, "content.md")
		await Bun.write(contentPath, "content")

		for (const command of [
			["read", "--repo", input.repository, "--work", "legacy"],
			[
				"write", "--repo", input.repository, "--work", "legacy",
				"--artifact", "issues", "--content-file", contentPath,
			],
			["remove", "--repo", input.repository, "--work", "legacy"],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("Work legacy does not exist")
		}
	})

	test("removes the requested work and leaves sibling work intact", async () => {
		const input = await fixture()
		const removedWork = JSON.parse((await createWork(input, "Remove me")).stdout)
		const retainedWork = JSON.parse((await createWork(input, "Keep me")).stdout)
		const removed = await run([
			"remove", "--repo", input.repository, "--work", removedWork.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(removed.stdout)).toEqual({ id: "remove-me", removed: true })
		expect(await Bun.file(join(removedWork.directory, "spec.md")).exists()).toBe(false)
		expect(await Bun.file(join(retainedWork.directory, "spec.md")).exists()).toBe(true)
	})

	test("removes optional artifacts without removing the work", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const contentPath = join(input.root, "content.md")
		await Bun.write(contentPath, "Shared learning")
		await run([
			"write", "--repo", input.repository, "--work", work.id,
			"--artifact", "learnings", "--content-file", contentPath,
		], { WORKBENCH_HOME: input.workbenchHome })
		const removed = await run([
			"remove", "--repo", input.repository, "--work", work.id,
			"--artifact", "learnings",
		], { WORKBENCH_HOME: input.workbenchHome })
		const read = await run([
			"read", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(removed.stdout)).toEqual({
			artifact: "learnings",
			id: work.id,
			removed: true,
		})
		expect(JSON.parse(read.stdout).artifacts).toEqual({
			spec: "# Specification\n\nBuild the direct path.\n",
		})
	})

	test("does not allow spec.md to be removed by itself", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const removed = await run([
			"remove", "--repo", input.repository, "--work", work.id, "--artifact", "spec",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(removed.exitCode).toBe(1)
		expect(await Bun.file(join(work.directory, "spec.md")).text()).toBe(
			"# Specification\n\nBuild the direct path.\n",
		)
	})
})

describe("maps", () => {
	test("keeps the map's state across body writes and removes it with its work", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const first = await contentFile(input, "map-source.md", "# Map\n\nHeading somewhere.\n")
		const second = await contentFile(input, "map-update.md", "# Map\n\nHalfway there.\n")
		const written = await run([
			"map", "write", "--repo", input.repository, "--work", work.id, "--content-file", first,
		], { WORKBENCH_HOME: input.workbenchHome })
		const closed = await run([
			"map", "state", "--repo", input.repository, "--work", work.id, "--state", "closed",
		], { WORKBENCH_HOME: input.workbenchHome })
		const rewritten = await run([
			"map", "write", "--repo", input.repository, "--work", work.id, "--content-file", second,
		], { WORKBENCH_HOME: input.workbenchHome })
		const read = await run([
			"read", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(written.stdout)).toEqual({ id: work.id, state: "open" })
		expect(JSON.parse(closed.stdout)).toEqual({ id: work.id, state: "closed" })
		expect(JSON.parse(rewritten.stdout)).toEqual({ id: work.id, state: "closed" })
		expect(JSON.parse(read.stdout).artifacts.map).toBe(
			"---\nstate: closed\n---\n\n# Map\n\nHalfway there.\n",
		)

		await run(["remove", "--repo", input.repository, "--work", work.id], {
			WORKBENCH_HOME: input.workbenchHome,
		})
		expect(await Bun.file(join(work.directory, "map.md")).exists()).toBe(false)
	})

	test("rejects an unknown map state and removing a map on its own", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const source = await contentFile(input, "map-source.md", "# Map\n")
		await run([
			"map", "write", "--repo", input.repository, "--work", work.id, "--content-file", source,
		], { WORKBENCH_HOME: input.workbenchHome })

		for (const command of [
			["map", "state", "--repo", input.repository, "--work", work.id, "--state", "paused"],
			["remove", "--repo", input.repository, "--work", work.id, "--artifact", "map"],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stdout).toBe("")
		}

		expect(await Bun.file(join(work.directory, "map.md")).text()).toBe("---\nstate: open\n---\n\n# Map\n")
	})
})

describe("tickets", () => {
	test("derives a slug from the title and carries the CLI-owned fields", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const question = await contentFile(input, "question.md", "Where does capture happen?")
		const created = await createTicket(input, work.id, "Onde está a captura?", "research", question)
		const read = await run([
			"ticket", "read", "--repo", input.repository, "--work", work.id,
			"--ticket", "onde-esta-a-captura",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(created.stdout)).toEqual({
			blockedBy: [],
			id: work.id,
			slug: "onde-esta-a-captura",
		})
		expect(JSON.parse(read.stdout)).toEqual({
			blockedBy: [],
			blocks: [],
			body: "Where does capture happen?",
			id: work.id,
			slug: "onde-esta-a-captura",
			state: "open",
			title: "Onde está a captura?",
			type: "research",
		})
		expect((await stat(join(work.directory, "tickets", "onde-esta-a-captura.md"))).mode & 0o777)
			.toBe(0o600)
	})

	test("claims a ticket and overwrites an existing assignee", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		await createTicket(input, work.id, "Pick the shape", "grilling")
		const first = await run([
			"ticket", "claim", "--repo", input.repository, "--work", work.id,
			"--ticket", "pick-the-shape", "--assignee", "wayfinder-a",
		], { WORKBENCH_HOME: input.workbenchHome })
		const second = await run([
			"ticket", "claim", "--repo", input.repository, "--work", work.id,
			"--ticket", "pick-the-shape", "--assignee", "wayfinder-b",
		], { WORKBENCH_HOME: input.workbenchHome })
		const read = await run([
			"ticket", "read", "--repo", input.repository, "--work", work.id,
			"--ticket", "pick-the-shape",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(first.exitCode).toBe(0)
		expect(second.exitCode).toBe(0)
		expect(JSON.parse(read.stdout).assignee).toBe("wayfinder-b")
	})

	test("closes a ticket with its resolution and refuses to close without one", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const question = await contentFile(input, "question.md", "Which format wins?")
		const resolution = await contentFile(input, "resolution.md", "The compact one.")
		const blank = await contentFile(input, "blank.md", " \n\t")
		await createTicket(input, work.id, "Which format", "grilling", question)
		const rejected = await run([
			"ticket", "close", "--repo", input.repository, "--work", work.id,
			"--ticket", "which-format", "--content-file", blank,
		], { WORKBENCH_HOME: input.workbenchHome })
		const missing = await run([
			"ticket", "close", "--repo", input.repository, "--work", work.id, "--ticket", "which-format",
		], { WORKBENCH_HOME: input.workbenchHome })
		const closed = await run([
			"ticket", "close", "--repo", input.repository, "--work", work.id,
			"--ticket", "which-format", "--content-file", resolution,
		], { WORKBENCH_HOME: input.workbenchHome })
		const read = await run([
			"ticket", "read", "--repo", input.repository, "--work", work.id, "--ticket", "which-format",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(rejected.exitCode).toBe(1)
		expect(missing.exitCode).toBe(1)
		expect(JSON.parse(closed.stdout)).toEqual({
			id: work.id,
			slug: "which-format",
			state: "closed",
		})
		expect(JSON.parse(read.stdout)).toMatchObject({
			body: "Which format wins?\n\n## Resolution\n\nThe compact one.",
			state: "closed",
		})
	})

	test("stores blockers on the blocked ticket only and derives the reverse edge", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		await createTicket(input, work.id, "Explore the source", "research")
		await createTicket(input, work.id, "Decide the shape", "grilling", undefined, [
			"explore-the-source",
		])
		await createTicket(input, work.id, "Prototype the write", "prototype")
		const wired = await run([
			"ticket", "block", "--repo", input.repository, "--work", work.id,
			"--ticket", "prototype-the-write", "--blocked-by", "explore-the-source,decide-the-shape",
		], { WORKBENCH_HOME: input.workbenchHome })
		const blocker = await run([
			"ticket", "read", "--repo", input.repository, "--work", work.id,
			"--ticket", "explore-the-source",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(wired.stdout).blockedBy).toEqual(["explore-the-source", "decide-the-shape"])
		expect(JSON.parse(blocker.stdout)).toMatchObject({
			blockedBy: [],
			blocks: ["decide-the-shape", "prototype-the-write"],
		})
		expect(await Bun.file(join(work.directory, "tickets", "explore-the-source.md")).text())
			.not.toContain("blocks")
	})

	test("rejects an unknown blocker, a self blocker, and an invented type", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		await createTicket(input, work.id, "Only ticket", "task")

		for (const command of [
			[
				"ticket", "create", "--repo", input.repository, "--work", work.id,
				"--title", "Second", "--type", "task", "--blocked-by", "nowhere",
			],
			[
				"ticket", "block", "--repo", input.repository, "--work", work.id,
				"--ticket", "only-ticket", "--blocked-by", "only-ticket",
			],
			[
				"ticket", "create", "--repo", input.repository, "--work", work.id,
				"--title", "Third", "--type", "invented",
			],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stdout).toBe("")
		}

		expect((await Array.fromAsync(new Bun.Glob("*.md").scan({
			cwd: join(work.directory, "tickets"),
		}))).sort()).toEqual(["only-ticket.md"])
	})

	test("removes one ticket and keeps the work and its siblings", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		await createTicket(input, work.id, "Removed ticket", "task")
		await createTicket(input, work.id, "Retained ticket", "task")
		const removed = await run([
			"ticket", "remove", "--repo", input.repository, "--work", work.id,
			"--ticket", "removed-ticket",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(removed.stdout)).toEqual({
			id: work.id,
			removed: true,
			slug: "removed-ticket",
		})
		expect(await Bun.file(join(work.directory, "tickets", "retained-ticket.md")).exists()).toBe(true)
		expect(await Bun.file(join(work.directory, "spec.md")).exists()).toBe(true)
	})

	test("refuses to remove a ticket another ticket still declares as a blocker", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		await createTicket(input, work.id, "Blocker ticket", "research")
		await createTicket(input, work.id, "Blocked ticket", "task", undefined, ["blocker-ticket"])
		const removed = await run([
			"ticket", "remove", "--repo", input.repository, "--work", work.id,
			"--ticket", "blocker-ticket",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(removed.exitCode).toBe(1)
		expect(removed.stderr).toContain("blocked-ticket")
		expect(await Bun.file(join(work.directory, "tickets", "blocker-ticket.md")).exists()).toBe(true)
	})

	test("keeps ticket bodies out of the work read", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const question = await contentFile(input, "question.md", "Body that must stay hidden")
		await createTicket(input, work.id, "Hidden body", "task", question)
		const read = await run([
			"read", "--repo", input.repository, "--work", work.id,
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(read.stdout).not.toContain("Body that must stay hidden")
	})
})

describe("frontier", () => {
	test("moves a ticket on when its blocker closes and off when it is claimed", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const resolution = await contentFile(input, "resolution.md", "Found it.")
		await createTicket(input, work.id, "Explore the source", "research")
		await createTicket(input, work.id, "Decide the shape", "grilling", undefined, [
			"explore-the-source",
		])
		const blocked = await frontier(input, work.id)
		await run([
			"ticket", "close", "--repo", input.repository, "--work", work.id,
			"--ticket", "explore-the-source", "--content-file", resolution,
		], { WORKBENCH_HOME: input.workbenchHome })
		const unblocked = await frontier(input, work.id)
		await run([
			"ticket", "claim", "--repo", input.repository, "--work", work.id,
			"--ticket", "decide-the-shape", "--assignee", "wayfinder",
		], { WORKBENCH_HOME: input.workbenchHome })
		const claimed = await frontier(input, work.id)

		expect(blocked).toEqual([
			{ slug: "explore-the-source", title: "Explore the source", type: "research" },
		])
		expect(unblocked).toEqual([
			{ slug: "decide-the-shape", title: "Decide the shape", type: "grilling" },
		])
		expect(claimed).toEqual([])
	})

	test("returns an empty frontier for a work without tickets", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)

		expect(await frontier(input, work.id)).toEqual([])
	})
})

describe("assets", () => {
	test("stores an asset under a derived name and reads it back", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const source = await contentFile(input, "asset-source.md", "# Conversa\n\nThe raw notes.\n")
		const written = await run([
			"asset", "write", "--repo", input.repository, "--work", work.id,
			"--name", "Conversa Lobo", "--content-file", source,
		], { WORKBENCH_HOME: input.workbenchHome })
		const read = await run([
			"asset", "read", "--repo", input.repository, "--work", work.id, "--name", "Conversa Lobo",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(written.stdout)).toEqual({
			id: work.id,
			name: "conversa-lobo",
			path: "assets/conversa-lobo.md",
		})
		expect(JSON.parse(read.stdout).content).toBe("# Conversa\n\nThe raw notes.\n")
		expect(await Bun.file(join(work.directory, "assets", "conversa-lobo.md")).exists()).toBe(true)
	})

	test("fails on an asset that was never written", async () => {
		const input = await fixture()
		const work = JSON.parse((await createWork(input)).stdout)
		const read = await run([
			"asset", "read", "--repo", input.repository, "--work", work.id, "--name", "Missing",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(read.exitCode).toBe(1)
		expect(read.stdout).toBe("")
	})
})

describe("CLI boundary", () => {
	test("requires content files and rejects unknown or duplicate options", async () => {
		const input = await fixture()

		for (const command of [
			["write", "--repo", input.repository, "--work", "any-work", "--artifact", "issues"],
			[
				"create", "--repo", input.repository, "--repo", input.repository,
				"--name", "Duplicate", "--content-file", input.specPath,
			],
			["start", "--repo", input.repository],
			["ticket", "start", "--repo", input.repository],
			["ticket"],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stdout).toBe("")
		}
	})

	test("rejects work identifiers that can escape their directory", async () => {
		const input = await fixture()
		const result = await run([
			"read", "--repo", input.repository, "--work", "../other",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe("")
	})
})
