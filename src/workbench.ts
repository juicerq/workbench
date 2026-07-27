import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import {
	atomicWrite,
	directoryExists,
	ensurePrivateDirectory,
	ignoreMissingDirectory,
} from "./filesystem"
import { repositoryLocation, slug, workLocation, worksDirectory } from "./locations"
import { mapFileName, readMap } from "./map"
import type {
	Artifact,
	CreateWorkInput,
	ListWorkInput,
	ReadWorkInput,
	RemoveWorkInput,
	WriteArtifactInput,
} from "./schemas"

const artifactPaths = {
	issues: "issues.md",
	learnings: "learnings.md",
	spec: "spec.md",
} satisfies Record<Artifact, string>

const artifacts = Object.keys(artifactPaths) as Artifact[]

async function presentArtifacts(directory: string) {
	const present = await Promise.all(artifacts.map(async (artifact) =>
		await Bun.file(join(directory, artifactPaths[artifact])).exists() ? [artifact] : []
	))

	return present.flat()
}

async function locateArtifacts(directory: string) {
	const documents = { ...artifactPaths, map: mapFileName }
	const located = await Promise.all(Object.entries(documents).map(async ([name, fileName]) => {
		const path = join(directory, fileName)
		const file = Bun.file(path)

		return await file.exists() ? [[name, { bytes: file.size, path }] as const] : []
	}))

	return Object.fromEntries(located.flat())
}

export const Workbench = {
	async create(input: CreateWorkInput) {
		const repository = await repositoryLocation(input.repo)
		const id = slug(input.name)
		const parentDirectory = worksDirectory(repository.directory)
		const directory = join(parentDirectory, id)
		const temporaryDirectory = join(parentDirectory, `.${id}.${crypto.randomUUID()}.tmp`)

		await ensurePrivateDirectory(parentDirectory)

		if (await directoryExists(directory)) {
			throw new Error(`Work ${id} already exists`)
		}

		await mkdir(temporaryDirectory, { mode: 0o700 })

		try {
			if (input.content) {
				await atomicWrite(join(temporaryDirectory, artifactPaths.spec), input.content)
			}

			await rename(temporaryDirectory, directory)
		} catch (error) {
			await rm(temporaryDirectory, { force: true, recursive: true })
			throw error
		}

		return { directory, id, repository: repository.repository }
	},

	async list(input: ListWorkInput) {
		const repository = await repositoryLocation(input.repo)
		const parentDirectory = worksDirectory(repository.directory)
		const entries = await readdir(parentDirectory, { withFileTypes: true })
			.catch(ignoreMissingDirectory)
		const works = await Promise.all(entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map(async (entry) => {
				const directory = join(parentDirectory, entry.name)
				const map = await readMap(directory)

				return {
					artifacts: await presentArtifacts(directory),
					directory,
					id: entry.name,
					...map && { map: map.state },
				}
			}))

		return {
			repository: repository.repository,
			works: works.sort((first, second) => first.id.localeCompare(second.id)),
		}
	},

	async read(input: ReadWorkInput) {
		const work = await workLocation(input)

		return {
			artifacts: await locateArtifacts(work.directory),
			directory: work.directory,
			id: work.id,
			repository: work.repository,
		}
	},

	async write(input: WriteArtifactInput) {
		const work = await workLocation(input)

		await atomicWrite(join(work.directory, artifactPaths[input.artifact]), input.content)

		return { artifact: input.artifact, id: work.id }
	},

	async remove(input: RemoveWorkInput) {
		const work = await workLocation(input)

		if (input.artifact) {
			await rm(join(work.directory, artifactPaths[input.artifact]), { force: true })

			return { artifact: input.artifact, id: work.id, removed: true }
		}

		await rm(work.directory, { recursive: true })

		return { id: work.id, removed: true }
	},
}
