import { isAbsolute, join, relative, resolve, sep } from "node:path"

export function storageRoot() {
	if (Bun.env.WORKBENCH_HOME) {
		return Bun.env.WORKBENCH_HOME
	}

	if (Bun.env.XDG_DATA_HOME) {
		return join(Bun.env.XDG_DATA_HOME, "workbench")
	}

	if (Bun.env.HOME) {
		return join(Bun.env.HOME, ".local", "share", "workbench")
	}

	throw new Error("WORKBENCH_HOME, XDG_DATA_HOME, or HOME is required")
}

export function storageAccessErrorMessage(error: unknown) {
	if (
		!(error instanceof Error)
		|| !("code" in error)
		|| (error.code !== "EROFS" && error.code !== "EACCES")
		|| !("path" in error)
		|| typeof error.path !== "string"
	) {
		return
	}

	const pathFromRoot = relative(resolve(storageRoot()), resolve(error.path))
	if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
		return
	}

	return `Cannot access workbench data at ${error.path}. Set WORKBENCH_HOME to a writable directory.`
}
