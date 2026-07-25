import { join } from "node:path"
import { directoryExists } from "./filesystem"
import { repositoryIdentity } from "./repository"
import { storageRoot } from "./storage"

function digest(value: string) {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function slug(name: string) {
	const identifier = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")

	if (!identifier) {
		throw new Error(`Cannot derive an identifier from ${name}`)
	}

	return identifier
}

export async function repositoryLocation(repositoryPath: string) {
	const repository = await repositoryIdentity(repositoryPath)

	return {
		directory: join(storageRoot(), "v2", "repositories", digest(repository)),
		repository,
	}
}

export function worksDirectory(repositoryDirectory: string) {
	return join(repositoryDirectory, "work")
}

export async function workLocation(input: { repo: string, work: string }) {
	const repository = await repositoryLocation(input.repo)
	const directory = join(worksDirectory(repository.directory), input.work)

	if (!await directoryExists(directory)) {
		throw new Error(`Work ${input.work} does not exist`)
	}

	return { directory, id: input.work, repository: repository.repository }
}
