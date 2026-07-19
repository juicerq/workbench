import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { atomicWrite, ensurePrivateDirectory } from "./filesystem"
import { repositoryIdentity } from "./repository"
import type {
	Artifact,
	CreateWorkInput,
	ListWorkInput,
	ReadWorkInput,
	RemoveWorkInput,
	WriteArtifactInput,
} from "./schemas"
import { storageRoot } from "./storage"

const artifactPaths = {
	issues: "issues.md",
	learnings: "learnings.md",
	spec: "spec.md",
} satisfies Record<Artifact, string>

function digest(value: string) {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function workIdentifier(name: string) {
	const identifier = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")

	if (!identifier) {
		throw new Error("--name must contain at least one letter or number")
	}

	return identifier
}

async function repositoryDirectory(repositoryPath: string) {
	const repository = await repositoryIdentity(repositoryPath)

	return {
		directory: join(storageRoot(), "v2", "repositories", digest(repository)),
		repository,
	}
}

function workDirectory(repositoryDirectory: string, work: string) {
	return join(repositoryDirectory, "work", work)
}

async function requireWork(directory: string, work: string) {
	if (!await Bun.file(join(directory, artifactPaths.spec)).exists()) {
		throw new Error(`Work ${work} does not exist`)
	}
}

async function readArtifacts(directory: string) {
	const artifacts = { spec: await Bun.file(join(directory, artifactPaths.spec)).text() } as {
		spec: string
		issues?: string
		learnings?: string
	}

	for (const artifact of ["issues", "learnings"] as const) {
		const path = join(directory, artifactPaths[artifact])
		if (await Bun.file(path).exists()) {
			artifacts[artifact] = await Bun.file(path).text()
		}
	}

	return artifacts
}

export const Workbench = {
	async create(input: CreateWorkInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const id = workIdentifier(input.name)
		const parentDirectory = join(repositoryContext.directory, "work")
		const directory = workDirectory(repositoryContext.directory, id)
		const temporaryDirectory = join(parentDirectory, `.${id}.${crypto.randomUUID()}.tmp`)

		await ensurePrivateDirectory(parentDirectory)
		await mkdir(temporaryDirectory, { mode: 0o700 })

		try {
			await atomicWrite(join(temporaryDirectory, artifactPaths.spec), input.content)
			await rename(temporaryDirectory, directory)
		} catch (error) {
			await rm(temporaryDirectory, { force: true, recursive: true })
			throw error
		}

		return { directory, id, repository: repositoryContext.repository }
	},

	async list(input: ListWorkInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const parentDirectory = join(repositoryContext.directory, "work")
		const entries = await readdir(parentDirectory, { withFileTypes: true }).catch((error) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return []
			}

			throw error
		})
		const works = await Promise.all(entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map(async (entry) => {
				const directory = workDirectory(repositoryContext.directory, entry.name)

				return await Bun.file(join(directory, artifactPaths.spec)).exists()
					? [{ directory, id: entry.name }]
					: []
			}))

		return {
			repository: repositoryContext.repository,
			works: works.flat().sort((first, second) => first.id.localeCompare(second.id)),
		}
	},

	async read(input: ReadWorkInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const directory = workDirectory(repositoryContext.directory, input.work)

		await requireWork(directory, input.work)

		return {
			artifacts: await readArtifacts(directory),
			directory,
			id: input.work,
			repository: repositoryContext.repository,
		}
	},

	async write(input: WriteArtifactInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const directory = workDirectory(repositoryContext.directory, input.work)

		await requireWork(directory, input.work)
		await atomicWrite(join(directory, artifactPaths[input.artifact]), input.content)

		return { artifact: input.artifact, id: input.work }
	},

	async remove(input: RemoveWorkInput) {
		const repositoryContext = await repositoryDirectory(input.repo)
		const directory = workDirectory(repositoryContext.directory, input.work)

		await requireWork(directory, input.work)
		if (input.artifact) {
			await rm(join(directory, artifactPaths[input.artifact]), { force: true })

			return { artifact: input.artifact, id: input.work, removed: true }
		}

		await rm(directory, { recursive: true })

		return { id: input.work, removed: true }
	},
}
