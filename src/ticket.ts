import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseDocument, serializeDocument } from "./document"
import { atomicWrite, ignoreMissingDirectory } from "./filesystem"
import { slug, workLocation } from "./locations"
import {
	type FrontierInput,
	type Ticket,
	TicketRecord,
	type TicketBlockInput,
	type TicketClaimInput,
	type TicketCloseInput,
	type TicketCreateInput,
	type TicketReadInput,
	type TicketRemoveInput,
} from "./schemas"

const questionHeading = "## Question"
const resolutionHeading = "## Resolution"

interface StoredTicket extends Ticket {
	body: string
	slug: string
}

function ticketPath(workDirectory: string, ticket: string) {
	return join(workDirectory, "tickets", `${ticket}.md`)
}

async function readTicket(workDirectory: string, ticket: string) {
	const file = Bun.file(ticketPath(workDirectory, ticket))

	if (!await file.exists()) {
		throw new Error(`Ticket ${ticket} does not exist`)
	}

	const document = parseDocument(await file.text())

	return { ...TicketRecord.assert(document.fields), body: document.body, slug: ticket }
}

async function readTickets(workDirectory: string) {
	const entries = await readdir(join(workDirectory, "tickets")).catch(ignoreMissingDirectory)

	return await Promise.all(entries
		.filter((entry) => entry.endsWith(".md"))
		.map(async (entry) => await readTicket(workDirectory, entry.slice(0, -".md".length))))
}

async function writeTicket(workDirectory: string, ticket: StoredTicket) {
	await atomicWrite(
		ticketPath(workDirectory, ticket.slug),
		serializeDocument({
			title: ticket.title,
			type: ticket.type,
			state: ticket.state,
			assignee: ticket.assignee,
			blocked_by: ticket.blockedBy,
		}, ticket.body),
	)
}

function hasResolution(body: string) {
	const lines = body.split("\n")
	const heading = lines.indexOf(resolutionHeading)

	return heading !== -1 && lines.slice(heading + 1).join("\n").trim().length > 0
}

async function requireBlockers(workDirectory: string, ticket: string, blockers: string[]) {
	for (const blocker of blockers) {
		if (blocker === ticket) {
			throw new Error(`Ticket ${ticket} cannot block itself`)
		}

		if (!await Bun.file(ticketPath(workDirectory, blocker)).exists()) {
			throw new Error(`Blocker ${blocker} does not exist`)
		}
	}
}

export const Tickets = {
	async create(input: TicketCreateInput) {
		const work = await workLocation(input)
		const ticket = slug(input.title)

		if (await Bun.file(ticketPath(work.directory, ticket)).exists()) {
			throw new Error(`Ticket ${ticket} already exists`)
		}

		await requireBlockers(work.directory, ticket, input.blockedBy)
		await writeTicket(work.directory, {
			blockedBy: input.blockedBy,
			body: questionHeading,
			slug: ticket,
			state: "open",
			title: input.title,
			type: input.type,
		})

		return {
			blockedBy: input.blockedBy,
			id: work.id,
			path: ticketPath(work.directory, ticket),
			slug: ticket,
		}
	},

	async block(input: TicketBlockInput) {
		const work = await workLocation(input)
		const ticket = await readTicket(work.directory, input.ticket)

		await requireBlockers(work.directory, ticket.slug, input.blockedBy)
		await writeTicket(work.directory, { ...ticket, blockedBy: input.blockedBy })

		return { blockedBy: input.blockedBy, id: work.id, slug: ticket.slug }
	},

	async claim(input: TicketClaimInput) {
		const work = await workLocation(input)
		const ticket = await readTicket(work.directory, input.ticket)

		await writeTicket(work.directory, { ...ticket, assignee: input.assignee })

		return { assignee: input.assignee, id: work.id, slug: ticket.slug }
	},

	async close(input: TicketCloseInput) {
		const work = await workLocation(input)
		const ticket = await readTicket(work.directory, input.ticket)

		if (!hasResolution(ticket.body)) {
			throw new Error(
				`Ticket ${ticket.slug} has no ${resolutionHeading} section; write the resolution into ${
					ticketPath(work.directory, ticket.slug)
				} before closing it`,
			)
		}

		await writeTicket(work.directory, { ...ticket, state: "closed" })

		return { id: work.id, slug: ticket.slug, state: "closed" }
	},

	async read(input: TicketReadInput) {
		const work = await workLocation(input)
		const tickets = await readTickets(work.directory)
		const ticket = tickets.find((entry) => entry.slug === input.ticket)

		if (!ticket) {
			throw new Error(`Ticket ${input.ticket} does not exist`)
		}

		return {
			assignee: ticket.assignee,
			blockedBy: ticket.blockedBy,
			blocks: tickets
				.filter((entry) => entry.blockedBy.includes(ticket.slug))
				.map((entry) => entry.slug)
				.sort(),
			id: work.id,
			path: ticketPath(work.directory, ticket.slug),
			slug: ticket.slug,
			state: ticket.state,
			title: ticket.title,
			type: ticket.type,
		}
	},

	async remove(input: TicketRemoveInput) {
		const work = await workLocation(input)
		const tickets = await readTickets(work.directory)

		if (!tickets.some((entry) => entry.slug === input.ticket)) {
			throw new Error(`Ticket ${input.ticket} does not exist`)
		}

		const blocked = tickets.filter((entry) => entry.blockedBy.includes(input.ticket))
		if (blocked.length > 0) {
			throw new Error(
				`Ticket ${input.ticket} still blocks ${blocked.map((entry) => entry.slug).sort().join(", ")}`,
			)
		}

		await rm(ticketPath(work.directory, input.ticket))

		return { id: work.id, removed: true, slug: input.ticket }
	},

	async frontier(input: FrontierInput) {
		const work = await workLocation(input)
		const tickets = await readTickets(work.directory)
		const closed = new Set(
			tickets.filter((entry) => entry.state === "closed").map((entry) => entry.slug),
		)

		return {
			id: work.id,
			tickets: tickets
				.filter((entry) =>
					entry.state === "open"
					&& !entry.assignee
					&& entry.blockedBy.every((blocker) => closed.has(blocker))
				)
				.map((entry) => ({ slug: entry.slug, title: entry.title, type: entry.type }))
				.sort((first, second) => first.slug.localeCompare(second.slug)),
		}
	},
}
