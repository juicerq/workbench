import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { directoryExists, ensurePrivateDirectory, ignoreMissingDirectory } from "./filesystem"
import { repositoryLocation, slug, worksDirectory } from "./locations"
import type { ListWorkInput, WorkInput } from "./schemas"

async function documentNames(directory: string) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(ignoreMissingDirectory)

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort()
}

export const Workbench = {
	async list(input: ListWorkInput) {
		const repository = await repositoryLocation(input.repo)
		const parentDirectory = worksDirectory(repository.directory)
		const entries = await readdir(parentDirectory, { withFileTypes: true })
			.catch(ignoreMissingDirectory)
		const works = await Promise.all(entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map(async (entry) => {
				const directory = join(parentDirectory, entry.name)

				return {
					directory,
					documents: await documentNames(directory),
					id: entry.name,
					tickets: (await documentNames(join(directory, "tickets"))).length,
				}
			}))

		return {
			repository: repository.repository,
			works: works.sort((first, second) => first.id.localeCompare(second.id)),
		}
	},

	async work(input: WorkInput) {
		const repository = await repositoryLocation(input.repo)
		const id = slug(input.name)
		const directory = join(worksDirectory(repository.directory), id)
		const existed = await directoryExists(directory)

		await ensurePrivateDirectory(directory)

		return {
			created: !existed,
			directory,
			documents: await documentNames(directory),
			id,
			repository: repository.repository,
		}
	},
}
