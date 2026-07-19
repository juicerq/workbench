#!/usr/bin/env bun

import { CliSchemas } from "./schemas"
import { storageAccessErrorMessage } from "./storage"
import { Workbench } from "./workbench"

function parseOptions(args: string[]) {
	const options: Record<string, string> = {}

	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]

		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Invalid argument ${key ?? ""}`.trim())
		}

		const name = key.slice(2)
		if (options[name] !== undefined) {
			throw new Error(`Duplicate option ${key}`)
		}

		options[name] = value
	}

	return options
}

function errorMessage(error: unknown) {
	const storageMessage = storageAccessErrorMessage(error)
	if (storageMessage) {
		return storageMessage
	}

	return error instanceof Error ? error.message : String(error)
}

async function contentOptions(options: Record<string, string>) {
	const { ["content-file"]: contentFile, ...input } = options
	if (!contentFile) {
		throw new Error("--content-file is required")
	}

	return { ...input, content: await Bun.file(contentFile).text() }
}

async function main() {
	const [command, ...args] = process.argv.slice(2)
	const options = parseOptions(args)

	switch (command) {
		case "create":
			return await Workbench.create(CliSchemas.create.assert(await contentOptions(options)))
		case "list":
			return await Workbench.list(CliSchemas.list.assert(options))
		case "read":
			return await Workbench.read(CliSchemas.read.assert(options))
		case "write":
			return await Workbench.write(CliSchemas.write.assert(await contentOptions(options)))
		case "remove":
			return await Workbench.remove(CliSchemas.remove.assert(options))
		default:
			throw new Error(`Unknown command ${command ?? ""}`.trim())
	}
}

await main()
	.then((result) => Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`))
	.catch((error) => {
		console.error(errorMessage(error))
		process.exitCode = 1
	})
