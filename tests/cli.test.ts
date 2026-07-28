import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const specification = "# Specification\n\nBuild the direct path.\n"
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

	return { repository, root, workbenchHome: join(root, "data") }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function openWork(input: Fixture, name = "Improve café") {
	return await run(["work", "--repo", input.repository, "--name", name], {
		WORKBENCH_HOME: input.workbenchHome,
	})
}

async function work(input: Fixture, name = "Improve café") {
	const opened = await openWork(input, name)

	expect(opened.stderr).toBe("")
	expect(opened.exitCode).toBe(0)

	return JSON.parse(opened.stdout)
}

async function createTicket(
	input: Fixture,
	workId: string,
	title: string,
	type: string,
	blockedBy?: string[],
) {
	return await run([
		"ticket", "create", "--repo", input.repository, "--work", workId,
		"--title", title, "--type", type,
		...blockedBy ? ["--blocked-by", blockedBy.join(",")] : [],
	], { WORKBENCH_HOME: input.workbenchHome })
}

async function ticket(input: Fixture, workId: string, slug: string) {
	const read = await run([
		"ticket", "read", "--repo", input.repository, "--work", workId, "--ticket", slug,
	], { WORKBENCH_HOME: input.workbenchHome })

	expect(read.exitCode).toBe(0)

	return JSON.parse(read.stdout)
}

async function resolve(path: string, resolution: string) {
	await Bun.write(path, `${(await Bun.file(path).text()).trimEnd()}\n\n## Resolution\n\n${resolution}\n`)
}

async function frontier(input: Fixture, workId: string) {
	const result = await run(["frontier", "--repo", input.repository, "--work", workId], {
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
	test("uses WORKBENCH_HOME directly and keeps a new work private", async () => {
		const input = await fixture()
		const opened = await work(input)

		expect(opened).toMatchObject({
			created: true,
			documents: [],
			id: "improve-cafe",
			repository: "github.com/juicerq/example",
		})
		expect(opened.directory.startsWith(input.workbenchHome)).toBe(true)
		expect((await stat(opened.directory)).mode & 0o777).toBe(0o700)
	})

	test("uses XDG_DATA_HOME and HOME fallbacks", async () => {
		const input = await fixture()
		const xdg = await run(["work", "--repo", input.repository, "--name", "XDG"], {
			XDG_DATA_HOME: join(input.root, "xdg"),
		})
		const home = await run(["work", "--repo", input.repository, "--name", "Home"], {
			HOME: join(input.root, "home"),
		})

		expect(JSON.parse(xdg.stdout).directory.startsWith(join(input.root, "xdg", "workbench"))).toBe(true)
		expect(JSON.parse(home.stdout).directory.startsWith(
			join(input.root, "home", ".local", "share", "workbench"),
		)).toBe(true)
	})

	test("suggests WORKBENCH_HOME when its data root is read-only", async () => {
		const input = await fixture()
		const readOnlyRoot = join("/sys", `workbench-${crypto.randomUUID()}`)
		const opened = await run(["work", "--repo", input.repository, "--name", "Read only"], {
			WORKBENCH_HOME: readOnlyRoot,
		})

		expect(opened.exitCode).toBe(1)
		expect(opened.stdout).toBe("")
		expect(opened.stderr).toContain(readOnlyRoot)
		expect(opened.stderr).toContain("WORKBENCH_HOME")
	})
})

describe("work", () => {
	test("shares repository work between clones with equivalent remotes", async () => {
		const input = await fixture()
		const secondClone = await createRepository(
			input.root,
			"second-clone",
			"https://github.com/juicerq/example.git",
		)
		const first = await work(input)
		await Bun.write(join(first.directory, "spec.md"), specification)
		const reopened = await run(["work", "--repo", secondClone, "--name", "Improve café"], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(JSON.parse(reopened.stdout)).toEqual({
			created: false,
			directory: first.directory,
			documents: ["spec.md"],
			id: "improve-cafe",
			repository: "github.com/juicerq/example",
		})
	})

	test("reopens a work without touching the documents it already holds", async () => {
		const input = await fixture()
		const first = await work(input, "Same work")
		await Bun.write(join(first.directory, "spec.md"), specification)
		const reopened = await work(input, "Same work")

		expect(reopened.created).toBe(false)
		expect(await Bun.file(join(first.directory, "spec.md")).text()).toBe(specification)
	})

	test("lists every work with the documents and tickets it holds", async () => {
		const input = await fixture()
		const zulu = await work(input, "Zulu")
		const alpha = await work(input, "Alpha")
		await Bun.write(join(zulu.directory, "spec.md"), specification)
		await Bun.write(join(alpha.directory, "map.md"), "# Map\n")
		await Bun.write(join(alpha.directory, "issues.md"), "# Issues\n")
		await createTicket(input, alpha.id, "Only ticket", "task")
		await mkdir(join(zulu.directory, "..", ".unfinished"))

		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(listed.exitCode).toBe(0)
		expect(JSON.parse(listed.stdout).works).toEqual([
			{
				directory: alpha.directory,
				documents: ["issues.md", "map.md"],
				id: "alpha",
				tickets: 1,
			},
			{ directory: zulu.directory, documents: ["spec.md"], id: "zulu", tickets: 0 },
		])
	})

	test("never scans work outside the v2 namespace", async () => {
		const input = await fixture()
		const current = await work(input, "Current work")
		const legacyDirectory = join(
			input.workbenchHome,
			"repositories",
			current.directory.split("/").at(-3),
			"work",
			"legacy-work",
		)
		await mkdir(legacyDirectory, { recursive: true })
		await Bun.write(join(legacyDirectory, "spec.md"), "legacy")

		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(JSON.parse(listed.stdout).works).toEqual([
			{ directory: current.directory, documents: [], id: "current-work", tickets: 0 },
		])
	})

	test("requires the work directory before any ticket command", async () => {
		const input = await fixture()

		for (const command of [
			["frontier", "--repo", input.repository, "--work", "legacy"],
			["ticket", "read", "--repo", input.repository, "--work", "legacy", "--ticket", "any"],
			[
				"ticket", "create", "--repo", input.repository, "--work", "legacy",
				"--title", "Any", "--type", "task",
			],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("Work legacy does not exist")
		}
	})
})

describe("tickets", () => {
	test("derives a slug from the title and seeds an editable question", async () => {
		const input = await fixture()
		const opened = await work(input)
		const created = await createTicket(input, opened.id, "Onde está a captura?", "research")
		const path = join(opened.directory, "tickets", "onde-esta-a-captura.md")

		expect(JSON.parse(created.stdout)).toEqual({
			blockedBy: [],
			id: opened.id,
			path,
			slug: "onde-esta-a-captura",
		})
		expect(await Bun.file(path).text()).toBe(
			'---\ntitle: "Onde está a captura?"\ntype: research\nstate: open\n---\n\n## Question\n',
		)
		expect((await stat(path)).mode & 0o777).toBe(0o600)
	})

	test("reads a ticket's fields and its path without its body", async () => {
		const input = await fixture()
		const opened = await work(input)
		const created = JSON.parse((await createTicket(input, opened.id, "Which format", "grilling")).stdout)
		await resolve(created.path, "Body that must stay out of the read.")

		expect(await ticket(input, opened.id, "which-format")).toEqual({
			blockedBy: [],
			blocks: [],
			id: opened.id,
			path: created.path,
			slug: "which-format",
			state: "open",
			title: "Which format",
			type: "grilling",
		})
	})

	test("keeps the body a hand edit wrote when the CLI rewrites the fields", async () => {
		const input = await fixture()
		const opened = await work(input)
		const created = JSON.parse((await createTicket(input, opened.id, "Pick the shape", "grilling")).stdout)
		await Bun.write(created.path, "---\ntitle: Pick the shape\ntype: grilling\nstate: open\n---\n\n## Question\n\nWhich shape survives?\n")
		const first = await run([
			"ticket", "claim", "--repo", input.repository, "--work", opened.id,
			"--ticket", "pick-the-shape", "--assignee", "wayfinder-a",
		], { WORKBENCH_HOME: input.workbenchHome })
		const second = await run([
			"ticket", "claim", "--repo", input.repository, "--work", opened.id,
			"--ticket", "pick-the-shape", "--assignee", "wayfinder-b",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(first.exitCode).toBe(0)
		expect(second.exitCode).toBe(0)
		expect((await ticket(input, opened.id, "pick-the-shape")).assignee).toBe("wayfinder-b")
		expect(await Bun.file(created.path).text()).toContain("Which shape survives?")
	})

	test("refuses to close a ticket whose body holds no resolution", async () => {
		const input = await fixture()
		const opened = await work(input)
		const created = JSON.parse((await createTicket(input, opened.id, "Which format", "grilling")).stdout)
		const close = ["ticket", "close", "--repo", input.repository, "--work", opened.id, "--ticket", "which-format"]
		const refused = await run(close, { WORKBENCH_HOME: input.workbenchHome })
		await Bun.write(created.path, `${await Bun.file(created.path).text()}\n\n## Resolution\n`)
		const blank = await run(close, { WORKBENCH_HOME: input.workbenchHome })
		await resolve(created.path, "The compact one.")
		const closed = await run(close, { WORKBENCH_HOME: input.workbenchHome })

		expect(refused.exitCode).toBe(1)
		expect(refused.stderr).toContain(created.path)
		expect(blank.exitCode).toBe(1)
		expect(JSON.parse(closed.stdout)).toEqual({
			id: opened.id,
			slug: "which-format",
			state: "closed",
		})
		expect((await ticket(input, opened.id, "which-format")).state).toBe("closed")
		expect(await Bun.file(created.path).text()).toContain("## Resolution\n\nThe compact one.")
	})

	test("closes a ticket that was already closed after its resolution changed", async () => {
		const input = await fixture()
		const opened = await work(input)
		const created = JSON.parse((await createTicket(input, opened.id, "Which format", "grilling")).stdout)
		const close = ["ticket", "close", "--repo", input.repository, "--work", opened.id, "--ticket", "which-format"]
		await resolve(created.path, "The compact one.")
		await run(close, { WORKBENCH_HOME: input.workbenchHome })
		await Bun.write(
			created.path,
			(await Bun.file(created.path).text()).replace("The compact one.", "The verbose one, actually."),
		)
		const reclosed = await run(close, { WORKBENCH_HOME: input.workbenchHome })

		expect(reclosed.exitCode).toBe(0)
		expect((await ticket(input, opened.id, "which-format")).state).toBe("closed")
		expect(await Bun.file(created.path).text()).toContain("The verbose one, actually.")
	})

	test("stores blockers on the blocked ticket only and derives the reverse edge", async () => {
		const input = await fixture()
		const opened = await work(input)
		await createTicket(input, opened.id, "Explore the source", "research")
		await createTicket(input, opened.id, "Decide the shape", "grilling", ["explore-the-source"])
		await createTicket(input, opened.id, "Prototype the write", "prototype")
		const wired = await run([
			"ticket", "block", "--repo", input.repository, "--work", opened.id,
			"--ticket", "prototype-the-write", "--blocked-by", "explore-the-source,decide-the-shape",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(wired.stdout).blockedBy).toEqual(["explore-the-source", "decide-the-shape"])
		expect(await ticket(input, opened.id, "explore-the-source")).toMatchObject({
			blockedBy: [],
			blocks: ["decide-the-shape", "prototype-the-write"],
		})
		expect(await Bun.file(join(opened.directory, "tickets", "explore-the-source.md")).text())
			.not.toContain("blocks")
	})

	test("rejects an unknown blocker, a self blocker, and an invented type", async () => {
		const input = await fixture()
		const opened = await work(input)
		await createTicket(input, opened.id, "Only ticket", "task")

		for (const command of [
			[
				"ticket", "create", "--repo", input.repository, "--work", opened.id,
				"--title", "Second", "--type", "task", "--blocked-by", "nowhere",
			],
			[
				"ticket", "block", "--repo", input.repository, "--work", opened.id,
				"--ticket", "only-ticket", "--blocked-by", "only-ticket",
			],
			[
				"ticket", "create", "--repo", input.repository, "--work", opened.id,
				"--title", "Third", "--type", "invented",
			],
		]) {
			const result = await run(command, { WORKBENCH_HOME: input.workbenchHome })
			expect(result.exitCode).toBe(1)
			expect(result.stdout).toBe("")
		}

		expect((await Array.fromAsync(new Bun.Glob("*.md").scan({
			cwd: join(opened.directory, "tickets"),
		}))).sort()).toEqual(["only-ticket.md"])
	})

	test("removes one ticket and keeps the work and its siblings", async () => {
		const input = await fixture()
		const opened = await work(input)
		await Bun.write(join(opened.directory, "spec.md"), specification)
		await createTicket(input, opened.id, "Removed ticket", "task")
		await createTicket(input, opened.id, "Retained ticket", "task")
		const removed = await run([
			"ticket", "remove", "--repo", input.repository, "--work", opened.id,
			"--ticket", "removed-ticket",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(JSON.parse(removed.stdout)).toEqual({
			id: opened.id,
			removed: true,
			slug: "removed-ticket",
		})
		expect(await Bun.file(join(opened.directory, "tickets", "retained-ticket.md")).exists()).toBe(true)
		expect(await Bun.file(join(opened.directory, "spec.md")).exists()).toBe(true)
	})

	test("refuses to remove a ticket another ticket still declares as a blocker", async () => {
		const input = await fixture()
		const opened = await work(input)
		await createTicket(input, opened.id, "Blocker ticket", "research")
		await createTicket(input, opened.id, "Blocked ticket", "task", ["blocker-ticket"])
		const removed = await run([
			"ticket", "remove", "--repo", input.repository, "--work", opened.id,
			"--ticket", "blocker-ticket",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(removed.exitCode).toBe(1)
		expect(removed.stderr).toContain("blocked-ticket")
		expect(await Bun.file(join(opened.directory, "tickets", "blocker-ticket.md")).exists()).toBe(true)
	})
})

describe("frontier", () => {
	test("moves a ticket on when its blocker closes and off when it is claimed", async () => {
		const input = await fixture()
		const opened = await work(input)
		const explore = JSON.parse(
			(await createTicket(input, opened.id, "Explore the source", "research")).stdout,
		)
		await createTicket(input, opened.id, "Decide the shape", "grilling", ["explore-the-source"])
		const blocked = await frontier(input, opened.id)
		await resolve(explore.path, "Found it.")
		await run([
			"ticket", "close", "--repo", input.repository, "--work", opened.id,
			"--ticket", "explore-the-source",
		], { WORKBENCH_HOME: input.workbenchHome })
		const unblocked = await frontier(input, opened.id)
		await run([
			"ticket", "claim", "--repo", input.repository, "--work", opened.id,
			"--ticket", "decide-the-shape", "--assignee", "wayfinder",
		], { WORKBENCH_HOME: input.workbenchHome })
		const claimed = await frontier(input, opened.id)

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
		const opened = await work(input)

		expect(await frontier(input, opened.id)).toEqual([])
	})
})

describe("CLI boundary", () => {
	test("prints every command when asked for help and when a command is unknown", async () => {
		const input = await fixture()
		const help = await run(["--help"], { WORKBENCH_HOME: input.workbenchHome })
		const bare = await run([], { WORKBENCH_HOME: input.workbenchHome })
		const unknown = await run(["start", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(help.exitCode).toBe(0)
		expect(help.stdout).toContain("workbench ticket close")
		expect(bare.stdout).toBe(help.stdout)
		expect(unknown.exitCode).toBe(1)
		expect(unknown.stdout).toBe("")
		expect(unknown.stderr).toContain("workbench ticket close")
	})

	test("rejects unknown, duplicate, and valueless options", async () => {
		const input = await fixture()
		const opened = await work(input)

		for (const command of [
			["work", "--repo", input.repository, "--name", "Duplicate", "--name", "Again"],
			["list", "--repo", input.repository, "--artifact", "issues"],
			["list", "--repo"],
			["ticket", "start", "--repo", input.repository, "--work", opened.id],
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
			"frontier", "--repo", input.repository, "--work", "../other",
		], { WORKBENCH_HOME: input.workbenchHome })

		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe("")
	})
})
