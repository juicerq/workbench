import { mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { atomicWrite, readJson, withDirectoryLock } from "./filesystem"
import { observeGitContext } from "./git-context"
import {
	WorkSchemas,
	type CloseWorkInput,
	type CurrentWorkInput,
	type SpecificationTakeoverInput,
	type SpecificationWriteInput,
	type StartWorkInput,
	type TaskAddInput,
	type TaskClaimInput,
	type TaskCheckInput,
	type TaskCheckpointInput,
	type TaskCompleteInput,
	type TaskDropInput,
	type TasksInput,
	type TaskTakeoverInput,
	type TransitionWorkInput,
	type WorkItem,
} from "./schemas"
import { TaskCoordination } from "./task-coordination"

type ActiveWorkItem = Extract<WorkItem, { outcome: "active" }>

const phaseTransitions = {
	decided: { from: "grilling", timestamp: "decidedAt" },
	tasked: { from: "decided", timestamp: "taskedAt" },
	implementing: { from: "tasked", timestamp: "implementingAt" },
} as const

const specificationArtifactPaths = {
	decisions: "decisions.md",
	prd: "prd.md",
} as const

export const WORK_RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000

function digest(value: string) {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function dataRoot() {
	if (Bun.env.XDG_DATA_HOME) {
		return join(Bun.env.XDG_DATA_HOME, "grill-workbench")
	}

	if (Bun.env.HOME) {
		return join(Bun.env.HOME, ".local", "share", "grill-workbench")
	}

	throw new Error("XDG_DATA_HOME or HOME is required")
}

async function repositoryDirectory(repositoryPath: string) {
	const { repository } = await observeGitContext(repositoryPath)
	const directory = join(dataRoot(), "repositories", digest(repository))

	await cleanupExpiredWork(directory).catch(() => {})

	return {
		directory,
		repository,
	}
}

function conversationFocusPath(repositoryDirectory: string, conversation: string) {
	return join(repositoryDirectory, "focus", `${digest(conversation)}.json`)
}

async function focusWork(input: { path: string; workId: string }) {
	const focus = WorkSchemas.focus.assert({ workId: input.workId })

	await mkdir(dirname(input.path), { recursive: true })
	await atomicWrite(input.path, `${JSON.stringify(focus, null, 2)}\n`)
}

async function readWorkItem(directory: string) {
	return await readJson(join(directory, "work.json"), WorkSchemas.item)
}

async function readWork(directory: string) {
	const item = await readWorkItem(directory)

	if (item.outcome !== "active") {
		return { ...item, directory }
	}

	const lastActivityAt = await latestActivityAt(directory, item.updatedAt)
	if (Date.now() - new Date(lastActivityAt).getTime() < WORK_RETENTION_PERIOD_MS) {
		return { ...item, directory }
	}

	return {
		...item,
		directory,
		lastActivityAt,
		stale: true as const,
		suggestedActions: ["resume", "close"] as const,
	}
}

async function latestActivityAt(directory: string, updatedAt: string) {
	let latestActivity = new Date(updatedAt).getTime()

	for await (const path of new Bun.Glob("**/*").scan({
		absolute: true,
		cwd: directory,
		onlyFiles: true,
	})) {
		latestActivity = Math.max(latestActivity, Bun.file(path).lastModified)
	}

	return new Date(latestActivity).toISOString()
}

async function removeWorkFocus(repositoryDirectory: string, workId: string) {
	const focusDirectory = join(repositoryDirectory, "focus")
	const entries = await readdir(focusDirectory, { withFileTypes: true }).catch(() => [])

	await Promise.all(
		entries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const path = join(focusDirectory, entry.name)
				const focus = await readJson(path, WorkSchemas.focus).catch(() => undefined)

				if (focus?.workId !== workId) {
					return
				}

				await rm(path, { force: true }).catch(() => {})
			}),
	)
}

async function cleanupExpiredWork(repositoryDirectory: string) {
	const workDirectory = join(repositoryDirectory, "work")
	const entries = await readdir(workDirectory, { withFileTypes: true }).catch(() => [])

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const directory = join(workDirectory, entry.name)
				const item = await readWorkItem(directory).catch(() => undefined)

				if (!item || item.outcome === "active") {
					return
				}

				if (Date.now() - new Date(item.closedAt).getTime() < WORK_RETENTION_PERIOD_MS) {
					return
				}

				const removed = await rm(directory, { recursive: true }).then(
					() => true,
					() => false,
				)
				if (!removed) {
					return
				}

				await removeWorkFocus(repositoryDirectory, item.id)
			}),
	)
}

async function writeWork(directory: string, item: WorkItem) {
	await atomicWrite(join(directory, "work.json"), `${JSON.stringify(item, null, 2)}\n`)
}

async function withWorkLock<T>(directory: string, operation: () => Promise<T>) {
	return await withDirectoryLock({
		attempts: 100,
		busyMessage: `Work item ${directory} is being changed`,
		path: join(directory, ".write-lock"),
		retryMs: 5,
	}, operation)
}

async function withActiveWork<T>(directory: string, operation: (work: ActiveWorkItem) => Promise<T>) {
	return await withWorkLock(directory, async () => {
		const work = await readWorkItem(directory)

		if (work.outcome !== "active") {
			throw new Error(`Work item is ${work.outcome}`)
		}

		return await operation(work)
	})
}

async function activeWork(repositoryDirectory: string) {
	const workDirectory = join(repositoryDirectory, "work")
	const entries = await readdir(workDirectory, { withFileTypes: true }).catch((error) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return []
		}

		throw error
	})
	const items = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => readWork(join(workDirectory, entry.name)).catch(() => undefined)),
	)

	return items
		.flatMap((item) => item ? [item] : [])
		.filter((item) => item.outcome === "active")
		.sort((first, second) => first.name.localeCompare(second.name))
}

async function selectCurrent(input: CurrentWorkInput) {
	const repositoryContext = await repositoryDirectory(input.repo)
	const focusPath = conversationFocusPath(repositoryContext.directory, input.conversation)

	if (await Bun.file(focusPath).exists()) {
		const focus = await readJson(focusPath, WorkSchemas.focus)
		const directory = join(repositoryContext.directory, "work", focus.workId)

		if (await Bun.file(join(directory, "work.json")).exists()) {
			return await readWork(directory)
		}

		await rm(focusPath, { force: true })
	}

	const activeItems = await activeWork(repositoryContext.directory)
	const nameMatch = input.name?.toLowerCase()
	const candidates =
		activeItems.length === 1 || !nameMatch
			? activeItems
			: activeItems.filter((item) =>
					item.name.toLowerCase().includes(nameMatch),
				)

	const selected = candidates.at(0)
	if (!selected || candidates.length > 1) {
		return { candidates: candidates.map(({ id, name }) => ({ id, name })) }
	}

	await focusWork({ path: focusPath, workId: selected.id })

	return selected
}

async function requireCurrent(input: CurrentWorkInput) {
	const selected = await selectCurrent(input)

	if ("candidates" in selected) {
		throw new Error("A focused work item is required")
	}

	return selected
}

function requireImplementationPhase(phase: WorkItem["phase"]) {
	if (phase !== "implementing") {
		throw new Error("Task claims require implementing work")
	}
}

export const Workbench = {
	async start(input: StartWorkInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const id = crypto.randomUUID()
		const directory = join(repositoryContext.directory, "work", id)
		const now = new Date().toISOString()
		const item = WorkSchemas.item.assert({
			createdAt: now,
			id,
			name: input.name,
			outcome: "active",
			phase: "grilling",
			repository: repositoryContext.repository,
			specification: {
				owner: {
					agent: input.agent ?? input.conversation,
					conversation: input.conversation,
				},
				takeovers: [],
			},
			updatedAt: now,
		})

		await mkdir(directory, { recursive: true })
		await writeWork(directory, item)
		await atomicWrite(join(directory, "decisions.md"), "# Decisions\n")
		await focusWork({
			path: conversationFocusPath(repositoryContext.directory, input.conversation),
			workId: id,
		})

		return { ...item, directory }
	},

	async current(input: CurrentWorkInput) {
		return await selectCurrent(input)
	},

	async transition(input: TransitionWorkInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async (current) => {
			const transition = phaseTransitions[input.to]

			if (current.phase !== transition.from) {
				throw new Error(`Cannot transition from ${current.phase} to ${input.to}`)
			}

			const now = new Date().toISOString()
			const item = WorkSchemas.item.assert({
				...current,
				phase: input.to,
				[transition.timestamp]: now,
				updatedAt: now,
			})

			await writeWork(selected.directory, item)

			return { ...item, directory: selected.directory }
		})
	},

	async writeSpecification(input: SpecificationWriteInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async (current) => {
			const owner = current.specification.owner

			if (owner.agent !== input.agent || owner.conversation !== input.conversation) {
				throw new Error(`Specification is owned by ${owner.agent} in ${owner.conversation}`)
			}

			await atomicWrite(
				join(selected.directory, specificationArtifactPaths[input.artifact]),
				input.content,
			)

			return { artifact: input.artifact, workId: current.id }
		})
	},

	async takeOverSpecification(input: SpecificationTakeoverInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async (current) => {
			const nextOwner = { agent: input.agent, conversation: input.conversation }
			const now = new Date().toISOString()
			const item = WorkSchemas.item.assert({
				...current,
				specification: {
					owner: nextOwner,
					takeovers: [
						...current.specification.takeovers,
						{ at: now, from: current.specification.owner, to: nextOwner },
					],
				},
				updatedAt: now,
			})

			await writeWork(selected.directory, item)

			return { ...item, directory: selected.directory }
		})
	},

	async addTask(input: TaskAddInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async (current) =>
			await new TaskCoordination(selected.directory).add(input, current.phase),
		)
	},

	async tasks(input: TasksInput) {
		const selected = await requireCurrent(input)
		const context = await observeGitContext(input.repo)

		return await new TaskCoordination(selected.directory).list(context)
	},

	async claimTask(input: TaskClaimInput) {
		const selected = await requireCurrent(input)
		const context = await observeGitContext(input.repo)
		const coordination = new TaskCoordination(selected.directory)

		await withActiveWork(selected.directory, async (current) => {
			requireImplementationPhase(current.phase)
		})

		const claim = await coordination.claim(input, context)

		try {
			return await withActiveWork(selected.directory, async (current) => {
				requireImplementationPhase(current.phase)

				return claim
			})
		} catch (error) {
			await coordination.releaseRejectedClaim(input).catch(() => {})
			throw error
		}
	},

	async takeOverTask(input: TaskTakeoverInput) {
		const selected = await requireCurrent(input)
		const context = await observeGitContext(input.repo)

		return await withActiveWork(selected.directory, async (current) => {
			requireImplementationPhase(current.phase)

			return await new TaskCoordination(selected.directory).takeOver(input, context)
		})
	},

	async checkpointTask(input: TaskCheckpointInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async () =>
			await new TaskCoordination(selected.directory).checkpoint(input),
		)
	},

	async checkTask(input: TaskCheckInput) {
		const selected = await requireCurrent(input)

		return await withActiveWork(selected.directory, async () =>
			await new TaskCoordination(selected.directory).check(input),
		)
	},

	async completeTask(input: TaskCompleteInput) {
		const selected = await requireCurrent(input)
		const context = await observeGitContext(input.repo)

		return await withActiveWork(selected.directory, async () =>
			await new TaskCoordination(selected.directory).complete(input, context),
		)
	},

	async dropTask(input: TaskDropInput) {
		const selected = await requireCurrent(input)
		const context = await observeGitContext(input.repo)

		return await withActiveWork(selected.directory, async () =>
			await new TaskCoordination(selected.directory).drop(input, context),
		)
	},

	async close(input: CloseWorkInput) {
		const selected = await requireCurrent(input)

		return await withWorkLock(selected.directory, async () => {
			const current = await readWorkItem(selected.directory)

			if (current.outcome !== "active") {
				throw new Error(`Work item is already ${current.outcome}`)
			}

			const now = new Date().toISOString()
			const item = WorkSchemas.item.assert({
				...current,
				closedAt: now,
				outcome: input.outcome,
				updatedAt: now,
			})

			await writeWork(selected.directory, item)

			return { ...item, directory: selected.directory }
		})
	},
}
