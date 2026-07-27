#!/usr/bin/env bun

import { Assets } from "./asset"
import { Maps } from "./map"
import { CliSchemas } from "./schemas"
import { storageAccessErrorMessage } from "./storage"
import { Tickets } from "./ticket"
import { Workbench } from "./workbench"

interface Route {
	content?: "optional" | "required"
	flags?: string[]
	run: (options: unknown) => Promise<unknown>
}

const routes: Record<string, Route> = {
	"create": {
		content: "optional",
		run: async (options) => await Workbench.create(CliSchemas.create.assert(options)),
	},
	"list": {
		run: async (options) => await Workbench.list(CliSchemas.list.assert(options)),
	},
	"read": {
		run: async (options) => await Workbench.read(CliSchemas.read.assert(options)),
	},
	"write": {
		content: "required",
		run: async (options) => await Workbench.write(CliSchemas.write.assert(options)),
	},
	"remove": {
		run: async (options) => await Workbench.remove(CliSchemas.remove.assert(options)),
	},
	"frontier": {
		run: async (options) => await Tickets.frontier(CliSchemas.frontier.assert(options)),
	},
	"map write": {
		content: "required",
		run: async (options) => await Maps.write(CliSchemas.mapWrite.assert(options)),
	},
	"map state": {
		run: async (options) => await Maps.state(CliSchemas.mapState.assert(options)),
	},
	"ticket create": {
		content: "optional",
		run: async (options) => await Tickets.create(CliSchemas.ticketCreate.assert(options)),
	},
	"ticket block": {
		run: async (options) => await Tickets.block(CliSchemas.ticketBlock.assert(options)),
	},
	"ticket claim": {
		run: async (options) => await Tickets.claim(CliSchemas.ticketClaim.assert(options)),
	},
	"ticket close": {
		content: "required",
		flags: ["replace"],
		run: async (options) => await Tickets.close(CliSchemas.ticketClose.assert(options)),
	},
	"ticket read": {
		run: async (options) => await Tickets.read(CliSchemas.ticketRead.assert(options)),
	},
	"ticket remove": {
		run: async (options) => await Tickets.remove(CliSchemas.ticketRemove.assert(options)),
	},
	"asset write": {
		content: "required",
		run: async (options) => await Assets.write(CliSchemas.assetWrite.assert(options)),
	},
	"asset read": {
		run: async (options) => await Assets.read(CliSchemas.assetRead.assert(options)),
	},
}

const groupedCommands = new Set(
	Object.keys(routes).filter((name) => name.includes(" ")).map((name) => name.split(" ")[0]),
)

function parseOptions(args: string[], flags: string[] = []) {
	const options: Record<string, string | true> = {}
	let index = 0

	while (index < args.length) {
		const key = args[index]

		if (!key?.startsWith("--")) {
			throw new Error(`Invalid argument ${key ?? ""}`.trim())
		}

		const name = key.slice(2)
		if (options[name] !== undefined) {
			throw new Error(`Duplicate option ${key}`)
		}

		if (flags.includes(name)) {
			options[name] = true
			index += 1
			continue
		}

		const value = args[index + 1]
		if (value === undefined) {
			throw new Error(`Invalid argument ${key}`)
		}

		options[name] = value
		index += 2
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

async function withContent(
	options: Record<string, string | true>,
	requirement: Route["content"],
) {
	if (!requirement) {
		return options
	}

	const { ["content-file"]: contentFile, ...input } = options

	if (typeof contentFile !== "string" || !contentFile) {
		if (requirement === "required") {
			throw new Error("--content-file is required")
		}

		return input
	}

	return { ...input, content: await Bun.file(contentFile).text() }
}

async function main() {
	const args = process.argv.slice(2)
	const depth = args[0] && groupedCommands.has(args[0]) ? 2 : 1
	const name = args.slice(0, depth).join(" ")
	const route = routes[name]

	if (!route) {
		throw new Error(`Unknown command ${name}`.trim())
	}

	return await route.run(
		await withContent(parseOptions(args.slice(depth), route.flags), route.content),
	)
}

await main()
	.then((result) => Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`))
	.catch((error) => {
		console.error(errorMessage(error))
		process.exitCode = 1
	})
