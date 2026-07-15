#!/usr/bin/env bun

import { CliSchemas } from "./schemas"
import { Workbench } from "./workbench"

function parseOptions(args: string[]) {
	const options: Record<string, string> = {}

	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]

		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Invalid argument ${key ?? ""}`.trim())
		}

		options[key.slice(2)] = value
	}

	return options
}

function conversation(options: Record<string, string>) {
	if (options.conversation) {
		return options.conversation
	}

	if (Bun.env.CODEX_THREAD_ID) {
		return Bun.env.CODEX_THREAD_ID
	}

	throw new Error("--conversation or CODEX_THREAD_ID is required")
}

async function resolveContentFile(options: Record<string, string>) {
	const { ["content-file"]: contentFile, ...resolved } = options
	if (!contentFile) {
		return options
	}

	if (options.content !== undefined) {
		throw new Error("Use either --content or --content-file")
	}

	return {
		...resolved,
		content: await Bun.file(contentFile).text(),
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2)
	const options = parseOptions(args)

	switch (command) {
		case "start": {
			const input = CliSchemas.start.assert({ ...options, conversation: conversation(options) })
			return await Workbench.start(input)
		}
		case "current": {
			const input = CliSchemas.current.assert({ ...options, conversation: conversation(options) })
			return await Workbench.current(input)
		}
		case "transition": {
			const input = CliSchemas.transition.assert({ ...options, conversation: conversation(options) })
			return await Workbench.transition(input)
		}
		case "spec-write": {
			const input = CliSchemas.specificationWrite.assert({
				...await resolveContentFile(options),
				conversation: conversation(options),
			})
			return await Workbench.writeSpecification(input)
		}
		case "spec-takeover": {
			const input = CliSchemas.specificationTakeover.assert({
				...options,
				conversation: conversation(options),
			})
			return await Workbench.takeOverSpecification(input)
		}
		case "task-add": {
			const input = CliSchemas.taskAdd.assert({
				...await resolveContentFile(options),
				conversation: conversation(options),
			})
			return await Workbench.addTask(input)
		}
		case "tasks": {
			const input = CliSchemas.tasks.assert({ ...options, conversation: conversation(options) })
			return await Workbench.tasks(input)
		}
		case "task-claim": {
			const input = CliSchemas.taskClaim.assert({ ...options, conversation: conversation(options) })
			return await Workbench.claimTask(input)
		}
		case "task-takeover": {
			const input = CliSchemas.taskTakeover.assert({ ...options, conversation: conversation(options) })
			return await Workbench.takeOverTask(input)
		}
		case "task-checkpoint": {
			const input = CliSchemas.taskCheckpoint.assert({ ...options, conversation: conversation(options) })
			return await Workbench.checkpointTask(input)
		}
		case "task-check": {
			const input = CliSchemas.taskCheck.assert({ ...options, conversation: conversation(options) })
			return await Workbench.checkTask(input)
		}
		case "task-complete": {
			const input = CliSchemas.taskComplete.assert({ ...options, conversation: conversation(options) })
			return await Workbench.completeTask(input)
		}
		case "task-drop": {
			const input = CliSchemas.taskDrop.assert({ ...options, conversation: conversation(options) })
			return await Workbench.dropTask(input)
		}
		case "close": {
			const input = CliSchemas.close.assert({ ...options, conversation: conversation(options) })
			return await Workbench.close(input)
		}
		default:
			throw new Error(`Unknown command ${command ?? ""}`.trim())
	}
}

await main()
	.then((result) => Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`))
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
