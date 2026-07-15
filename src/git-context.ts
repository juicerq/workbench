import { WorkSchemas } from "./schemas"

function normalizeRemote(remote: string) {
	if (remote.includes("://")) {
		const url = new URL(remote)

		return `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\.git$/, "").replace(/\/$/, "")
	}

	const scpRemote = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
	if (scpRemote) {
		const host = scpRemote[1]
		const path = scpRemote[2]

		if (!host || !path) {
			throw new Error(`Invalid Git remote ${remote}`)
		}

		return `${host.toLowerCase()}/${path}`.replace(/\.git$/, "").replace(/\/$/, "")
	}

	return remote.replace(/\.git$/, "").replace(/\/$/, "")
}

async function gitOutput(repositoryPath: string, ...args: string[]) {
	const process = Bun.spawn(["git", "-C", repositoryPath, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])

	if (exitCode !== 0) {
		throw new Error(stderr.trim())
	}

	return stdout.trim()
}

export async function observeGitContext(repositoryPath: string) {
	const [remote, worktree, branch, commit] = await Promise.all([
		gitOutput(repositoryPath, "remote", "get-url", "origin"),
		gitOutput(repositoryPath, "rev-parse", "--show-toplevel"),
		gitOutput(repositoryPath, "branch", "--show-current"),
		gitOutput(repositoryPath, "rev-parse", "--verify", "HEAD").catch(() => null),
	])

	return WorkSchemas.gitContext.assert({
		branch: branch || null,
		commit,
		repository: normalizeRemote(remote),
		worktree,
	})
}
