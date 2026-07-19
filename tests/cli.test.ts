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

	test("lists only directories that contain spec.md", async () => {
		const input = await fixture()
		const first = JSON.parse((await createWork(input, "Zulu")).stdout)
		const second = JSON.parse((await createWork(input, "Alpha")).stdout)
		const workParent = join(first.directory, "..")
		await mkdir(join(workParent, "legacy", "tasks"), { recursive: true })
		await Bun.write(join(workParent, "legacy", "work.json"), "{}")
		await mkdir(join(workParent, ".unfinished"))

		const listed = await run(["list", "--repo", input.repository], {
			WORKBENCH_HOME: input.workbenchHome,
		})

		expect(listed.exitCode).toBe(0)
		expect(JSON.parse(listed.stdout).works).toEqual([
			{ directory: second.directory, id: "alpha" },
			{ directory: first.directory, id: "zulu" },
		])
		expect(await Bun.file(join(workParent, "legacy", "work.json")).exists()).toBe(true)
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

		expect(JSON.parse(listed.stdout).works).toEqual([{ directory: work.directory, id: work.id }])
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

	test("requires spec.md before reading, writing, or removing work", async () => {
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

describe("CLI boundary", () => {
	test("requires content files and rejects unknown or duplicate options", async () => {
		const input = await fixture()

		for (const command of [
			["create", "--repo", input.repository, "--name", "Missing content"],
			[
				"create", "--repo", input.repository, "--repo", input.repository,
				"--name", "Duplicate", "--content-file", input.specPath,
			],
			["start", "--repo", input.repository],
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
