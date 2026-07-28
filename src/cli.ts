#!/usr/bin/env bun

import { CliSchemas } from "./schemas"
import { storageAccessErrorMessage } from "./storage"
import { Tickets } from "./ticket"
import { Workbench } from "./workbench"

interface Route {
	options: string
	run: (options: unknown) => Promise<unknown>
}

const routes: Record<string, Route> = {
	"list": {
		options: "--repo <path>",
		run: async (options) => await Workbench.list(CliSchemas.list.assert(options)),
	},
	"work": {
		options: "--repo <path> --name <name>",
		run: async (options) => await Workbench.work(CliSchemas.work.assert(options)),
	},
	"frontier": {
		options: "--repo <path> --work <work-id>",
		run: async (options) => await Tickets.frontier(CliSchemas.frontier.assert(options)),
	},
	"ticket create": {
		options:
			"--repo <path> --work <work-id> --title <title> --type <research|prototype|grilling|task> [--blocked-by <slug>,<slug>]",
		run: async (options) => await Tickets.create(CliSchemas.ticketCreate.assert(options)),
	},
	"ticket block": {
		options: "--repo <path> --work <work-id> --ticket <slug> --blocked-by <slug>,<slug>",
		run: async (options) => await Tickets.block(CliSchemas.ticketBlock.assert(options)),
	},
	"ticket claim": {
		options: "--repo <path> --work <work-id> --ticket <slug> --assignee <dev>",
		run: async (options) => await Tickets.claim(CliSchemas.ticketClaim.assert(options)),
	},
	"ticket close": {
		options: "--repo <path> --work <work-id> --ticket <slug>",
		run: async (options) => await Tickets.close(CliSchemas.ticketClose.assert(options)),
	},
	"ticket read": {
		options: "--repo <path> --work <work-id> --ticket <slug>",
		run: async (options) => await Tickets.read(CliSchemas.ticketRead.assert(options)),
	},
	"ticket remove": {
		options: "--repo <path> --work <work-id> --ticket <slug>",
		run: async (options) => await Tickets.remove(CliSchemas.ticketRemove.assert(options)),
	},
}

const usage = [
	"workbench stores a repository's planning outside the repository. It owns work directories and ticket state; every document body is yours to read and edit with your own file tools.",
	"",
	...Object.entries(routes).map(([name, route]) => `  workbench ${name} ${route.options}`),
	"",
	"Every command prints one line of JSON. `work` creates the work when it is missing and prints its directory; write map.md, spec.md, issues.md and learnings.md there yourself. Remove a work by deleting that directory.",
].join("\n")

const groupedCommands = new Set(
	Object.keys(routes).filter((name) => name.includes(" ")).map((name) => name.split(" ")[0]),
)

function parseOptions(args: string[]) {
	const options: Record<string, string> = {}
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

async function main() {
	const args = process.argv.slice(2)

	if (args.length === 0 || ["--help", "-h", "help"].includes(args[0] ?? "")) {
		return usage
	}

	const depth = args[0] && groupedCommands.has(args[0]) ? 2 : 1
	const name = args.slice(0, depth).join(" ")
	const route = routes[name]

	if (!route) {
		throw new Error(`Unknown command ${name}\n\n${usage}`.trim())
	}

	return JSON.stringify(await route.run(parseOptions(args.slice(depth))))
}

await main()
	.then((output) => Bun.write(Bun.stdout, `${output}\n`))
	.catch((error) => {
		console.error(errorMessage(error))
		process.exitCode = 1
	})
