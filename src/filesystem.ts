import { mkdir, rename, rm } from "node:fs/promises"

export async function atomicWrite(path: string, content: string) {
	const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`

	try {
		await Bun.write(temporaryPath, content)
		await rename(temporaryPath, path)
	} finally {
		await rm(temporaryPath, { force: true })
	}
}

export async function readJson<T>(path: string, schema: { assert(value: unknown): T }) {
	const value = await Bun.file(path).json().catch((error) => {
		throw new Error(`Cannot read ${path}: ${error.message}`)
	})

	try {
		return schema.assert(value)
	} catch (error) {
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export async function withDirectoryLock<T>(
	input: { attempts: number; busyMessage: string; path: string; retryMs: number },
	operation: () => Promise<T>,
) {
	for (let attempt = 0; attempt < input.attempts; attempt++) {
		const acquired = await mkdir(input.path).then(() => true).catch((error) => {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				return false
			}

			throw error
		})

		if (acquired) {
			try {
				return await operation()
			} finally {
				await rm(input.path, { recursive: true })
			}
		}

		if (attempt < input.attempts - 1) {
			await Bun.sleep(input.retryMs)
		}
	}

	throw new Error(input.busyMessage)
}
