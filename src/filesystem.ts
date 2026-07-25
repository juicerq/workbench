import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export async function ensurePrivateDirectory(path: string) {
	await mkdir(path, { mode: 0o700, recursive: true })
}

export async function directoryExists(path: string) {
	return await stat(path).then((entry) => entry.isDirectory()).catch(() => false)
}

export function ignoreMissingDirectory(error: unknown) {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") {
		return []
	}

	throw error
}

export async function atomicWrite(path: string, content: string) {
	const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`

	await ensurePrivateDirectory(dirname(path))

	try {
		await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 })
		await rename(temporaryPath, path)
	} finally {
		await rm(temporaryPath, { force: true })
	}
}
