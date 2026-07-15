import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { atomicWrite, readJson, withDirectoryLock } from "./filesystem"
import {
	WorkSchemas,
	type GitContext,
	type TaskAddInput,
	type TaskClaim,
	type TaskClaimInput,
	type TaskCheckInput,
	type TaskCheckpointInput,
	type TaskCompleteInput,
	type TaskDropInput,
	type TaskTakeoverInput,
	type WorkItem,
	type WorkTask,
} from "./schemas"

const contextFields = ["worktree", "branch", "commit"] as const

function contextWarnings(expected: GitContext, observed: GitContext) {
	return contextFields.flatMap((field) =>
		expected[field] === observed[field]
			? []
			: [{ code: `${field}-mismatch`, expected: expected[field], observed: observed[field] }],
	)
}

async function readTask(directory: string) {
	return await readJson(join(directory, "task.json"), WorkSchemas.task)
}

async function readTaskClaim(directory: string) {
	return await readJson(join(directory, "claim", "owner.json"), WorkSchemas.taskClaim)
}

async function requireTask(workDirectory: string, task: string) {
	const directory = join(workDirectory, "tasks", task)
	const metadata = await readTask(directory)

	if (metadata.id !== task) {
		throw new Error(`Task ${task} metadata does not match its directory`)
	}

	return { directory, metadata }
}

async function readTasks(workDirectory: string) {
	const tasksDirectory = join(workDirectory, "tasks")
	const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch((error) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return []
		}

		throw error
	})

	return await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.sort((first, second) => first.name.localeCompare(second.name))
			.map(async (entry) => {
				const directory = join(tasksDirectory, entry.name)

				return { directory, metadata: await readTask(directory) }
			}),
	)
}

async function taskClaim(directory: string) {
	const claimDirectory = join(directory, "claim")

	for (let attempt = 0; attempt < 100; attempt++) {
		if (await Bun.file(join(directory, "claim", "owner.json")).exists()) {
			return await readTaskClaim(directory)
		}

		const exists = await stat(claimDirectory).then(() => true).catch((error) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return false
			}

			throw error
		})

		if (!exists) {
			return
		}

		await Bun.sleep(5)
	}

	throw new Error(`Invalid task claim at ${join(directory, "claim")}`)
}

async function acquireTaskClaim(directory: string, claim: TaskClaim) {
	const claimDirectory = join(directory, "claim")

	for (let attempt = 0; attempt < 100; attempt++) {
		const acquired = await mkdir(claimDirectory).then(() => true).catch((error) => {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				return false
			}

			throw error
		})

		if (acquired) {
			await atomicWrite(join(claimDirectory, "owner.json"), `${JSON.stringify(claim, null, 2)}\n`).catch(async (error) => {
				await rm(claimDirectory, { force: true, recursive: true })
				throw error
			})

			return
		}

		const existing = await taskClaim(directory)

		if (existing) {
			return existing
		}
	}

	throw new Error(`Cannot acquire task claim at ${claimDirectory}`)
}

async function withTaskLock<T>(directory: string, operation: () => Promise<T>) {
	return await withDirectoryLock({
		attempts: 100,
		busyMessage: `Task ${directory} is being changed`,
		path: join(directory, ".write-lock"),
		retryMs: 5,
	}, operation)
}

async function requireOwnedPendingTask(
	workDirectory: string,
	input: { agent: string; conversation: string; task: string },
) {
	const task = await requireTask(workDirectory, input.task)

	if (task.metadata.status !== "pending") {
		throw new Error(`Task ${input.task} is ${task.metadata.status}`)
	}

	const claim = await taskClaim(task.directory)
	if (!claim) {
		throw new Error(`Task ${input.task} is not claimed`)
	}

	if (claim.owner.agent !== input.agent || claim.owner.conversation !== input.conversation) {
		throw new Error(`Task ${input.task} is owned by ${claim.owner.agent} in ${claim.owner.conversation}`)
	}

	return task
}

function acceptanceCriterion(line: string) {
	return line.match(/^(\s*[-*+]\s+)\[([ xX])\]/)
}

async function persistTerminalTask(
	directory: string,
	task: WorkTask,
	evidence: string,
) {
	const evidencePath = join(directory, "evidence.md")
	await atomicWrite(evidencePath, evidence)
	try {
		await atomicWrite(join(directory, "task.json"), `${JSON.stringify(task, null, 2)}\n`)
	} catch (error) {
		await rm(evidencePath, { force: true })
		throw error
	}

	await Promise.all([
		rm(join(directory, "checkpoint.md"), { force: true, recursive: true }),
		rm(join(directory, "claim"), { force: true, recursive: true }),
	])
}

export class TaskCoordination {
	constructor(private readonly workDirectory: string) {}

	async add(input: TaskAddInput, phase: WorkItem["phase"]) {
		if (phase !== "tasked" && phase !== "implementing") {
			throw new Error("Tasks require tasked or implementing work")
		}

		const directory = join(this.workDirectory, "tasks", input.task)
		const task = WorkSchemas.task.assert({
			dependencies: input.dependencies ?? [],
			id: input.task,
			status: "pending",
		})
		const temporaryDirectory = join(dirname(directory), `.${input.task}.${crypto.randomUUID()}.tmp`)

		await mkdir(dirname(directory), { recursive: true })
		await mkdir(temporaryDirectory)

		try {
			await atomicWrite(join(temporaryDirectory, "task.md"), input.content)
			await atomicWrite(join(temporaryDirectory, "task.json"), `${JSON.stringify(task, null, 2)}\n`)
			await rename(temporaryDirectory, directory)
		} catch (error) {
			await rm(temporaryDirectory, { force: true, recursive: true })
			throw error
		}

		return task
	}

	async list(context: GitContext) {
		const tasks = await readTasks(this.workDirectory)
		const statusById = new Map(tasks.map(({ metadata }) => [metadata.id, metadata.status]))

		const statuses = await Promise.all(tasks.map(async ({ directory, metadata }) => {
			if (metadata.status !== "pending") {
				return { ...metadata, availability: metadata.status }
			}

			if (metadata.dependencies.some((dependency) => statusById.get(dependency) !== "completed")) {
				return { ...metadata, availability: "blocked" }
			}

			const claim = await taskClaim(directory)

			if (!claim) {
				return { ...metadata, availability: "available" }
			}

			return {
				...metadata,
				availability: "in-progress",
				claimContext: claim.context,
				owner: claim.owner,
				warnings: contextWarnings(claim.context, context),
			}
		}))

		return { context, tasks: statuses }
	}

	async claim(input: TaskClaimInput, context: GitContext) {
		const { directory, metadata } = await requireTask(this.workDirectory, input.task)

		if (metadata.status !== "pending") {
			throw new Error(`Task ${input.task} is ${metadata.status}`)
		}

		const tasks = await readTasks(this.workDirectory)
		const statusById = new Map(tasks.map(({ metadata: task }) => [task.id, task.status]))
		const blockers = metadata.dependencies.filter((dependency) => statusById.get(dependency) !== "completed")

		if (blockers.length > 0) {
			throw new Error(`Task ${input.task} is blocked by ${blockers.join(", ")}`)
		}

		const owner = { agent: input.agent, conversation: input.conversation }
		const claim = WorkSchemas.taskClaim.assert({ context, owner, takeovers: [] })
		const existing = await acquireTaskClaim(directory, claim)

		if (existing) {
			throw new Error(`Task ${input.task} is claimed by ${existing.owner.agent} in ${existing.owner.conversation}`)
		}

		return claim
	}

	async releaseRejectedClaim(input: TaskClaimInput) {
		const directory = join(this.workDirectory, "tasks", input.task)

		await withTaskLock(directory, async () => {
			const claim = await taskClaim(directory)

			if (!claim) {
				return
			}

			if (
				claim.owner.agent !== input.agent
				|| claim.owner.conversation !== input.conversation
				|| claim.takeovers.length > 0
			) {
				return
			}

			await rm(join(directory, "claim"), { recursive: true })
		})
	}

	async takeOver(input: TaskTakeoverInput, context: GitContext) {
		const directory = join(this.workDirectory, "tasks", input.task)

		return await withTaskLock(directory, async () => {
			const { metadata } = await requireTask(this.workDirectory, input.task)

			if (metadata.status !== "pending") {
				throw new Error(`Task ${input.task} is ${metadata.status}`)
			}

			const current = await taskClaim(directory)

			if (!current) {
				throw new Error(`Task ${input.task} is not claimed`)
			}

			const nextOwner = { agent: input.agent, conversation: input.conversation }
			const claim = WorkSchemas.taskClaim.assert({
				context,
				owner: nextOwner,
				takeovers: [
					...current.takeovers,
					{ at: new Date().toISOString(), from: current.owner, to: nextOwner },
				],
			})

			await atomicWrite(join(directory, "claim", "owner.json"), `${JSON.stringify(claim, null, 2)}\n`)

			return claim
		})
	}

	async checkpoint(input: TaskCheckpointInput) {
		const directory = join(this.workDirectory, "tasks", input.task)

		return await withTaskLock(directory, async () => {
			await requireOwnedPendingTask(this.workDirectory, input)
			const checkpoint = `# Done\n\n${input.done}\n\n# Next\n\n${input.next}\n\n# Validation\n\n${input.validation}\n`

			await atomicWrite(join(directory, "checkpoint.md"), checkpoint)

			return { checkpoint: "checkpoint.md", task: input.task }
		})
	}

	async check(input: TaskCheckInput) {
		const directory = join(this.workDirectory, "tasks", input.task)

		return await withTaskLock(directory, async () => {
			await requireOwnedPendingTask(this.workDirectory, input)
			const intentPath = join(directory, "task.md")
			const lines = (await Bun.file(intentPath).text()).split("\n")
			const criterionLines = lines.flatMap((line, index) =>
				acceptanceCriterion(line) ? [index] : [],
			)
			const lineIndex = criterionLines[input.criterion - 1]

			if (lineIndex === undefined) {
				throw new Error(`Task ${input.task} has no acceptance criterion ${input.criterion}`)
			}

			const line = lines[lineIndex]
			const checkbox = line ? acceptanceCriterion(line) : undefined

			if (!line || !checkbox) {
				throw new Error(`Task ${input.task} has invalid acceptance criterion ${input.criterion}`)
			}

			lines[lineIndex] = `${checkbox[1]}[x]${line.slice(checkbox[0].length)}`

			await atomicWrite(intentPath, lines.join("\n"))

			return { criterion: input.criterion, task: input.task }
		})
	}

	async complete(input: TaskCompleteInput, context: GitContext) {
		const directory = join(this.workDirectory, "tasks", input.task)

		return await withTaskLock(directory, async () => {
			const { metadata } = await requireOwnedPendingTask(this.workDirectory, input)
			const intent = await Bun.file(join(directory, "task.md")).text()

			if (intent.split("\n").some((line) => acceptanceCriterion(line)?.[2] === " ")) {
				throw new Error(`Task ${input.task} has unchecked acceptance criteria`)
			}

			const task = WorkSchemas.task.assert({
				...metadata,
				completedAt: new Date().toISOString(),
				status: "completed",
			})

			await persistTerminalTask(
				directory,
				task,
				`# Validation\n\n${input.validation}\n`,
			)

			return { exhausted: await this.exhausted(context), task }
		})
	}

	async drop(input: TaskDropInput, context: GitContext) {
		const directory = join(this.workDirectory, "tasks", input.task)

		return await withTaskLock(directory, async () => {
			const { metadata } = await requireOwnedPendingTask(this.workDirectory, input)
			const task = WorkSchemas.task.assert({
				...metadata,
				droppedAt: new Date().toISOString(),
				status: "dropped",
			})

			await persistTerminalTask(
				directory,
				task,
				`# Drop reason\n\n${input.reason}\n`,
			)

			return { exhausted: await this.exhausted(context), task }
		})
	}

	private async exhausted(context: GitContext) {
		const { tasks } = await this.list(context)

		return !tasks.some(({ availability }) =>
			availability === "available" || availability === "in-progress",
		)
	}
}
