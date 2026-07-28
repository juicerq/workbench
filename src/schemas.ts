import { type } from "arktype"

const nonEmptyString = type("string").pipe((value) => value.trim()).narrow((value) => value.length > 0)
const identifier = nonEmptyString.narrow((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
const identifierList = nonEmptyString.pipe((value) => value.split(",")).to(identifier.array())
const state = type.enumerated("open", "closed")
const ticketType = type.enumerated("research", "prototype", "grilling", "task")

const workReference = {
	repo: nonEmptyString,
	work: identifier,
}

export const CliSchemas = {
	list: type({
		"+": "reject",
		repo: nonEmptyString,
	}),
	work: type({
		"+": "reject",
		name: nonEmptyString,
		repo: nonEmptyString,
	}),
	ticketCreate: type({
		"+": "reject",
		"blocked-by?": identifierList,
		title: nonEmptyString,
		type: ticketType,
		...workReference,
	}).pipe(({ "blocked-by": blockedBy, ...input }) => ({ ...input, blockedBy: blockedBy ?? [] })),
	ticketBlock: type({
		"+": "reject",
		"blocked-by": identifierList,
		ticket: identifier,
		...workReference,
	}).pipe(({ "blocked-by": blockedBy, ...input }) => ({ ...input, blockedBy })),
	ticketClaim: type({
		"+": "reject",
		assignee: nonEmptyString,
		ticket: identifier,
		...workReference,
	}),
	ticketClose: type({
		"+": "reject",
		ticket: identifier,
		...workReference,
	}),
	ticketRead: type({
		"+": "reject",
		ticket: identifier,
		...workReference,
	}),
	ticketRemove: type({
		"+": "reject",
		ticket: identifier,
		...workReference,
	}),
	frontier: type({
		"+": "reject",
		...workReference,
	}),
}

export const TicketRecord = type({
	"+": "reject",
	"assignee?": nonEmptyString,
	"blocked_by?": identifier.array(),
	state,
	title: nonEmptyString,
	type: ticketType,
}).pipe(({ blocked_by: blockedBy, ...fields }) => ({ ...fields, blockedBy: blockedBy ?? [] }))

export type ListWorkInput = typeof CliSchemas.list.infer
export type WorkInput = typeof CliSchemas.work.infer
export type TicketCreateInput = typeof CliSchemas.ticketCreate.infer
export type TicketBlockInput = typeof CliSchemas.ticketBlock.infer
export type TicketClaimInput = typeof CliSchemas.ticketClaim.infer
export type TicketCloseInput = typeof CliSchemas.ticketClose.infer
export type TicketReadInput = typeof CliSchemas.ticketRead.infer
export type TicketRemoveInput = typeof CliSchemas.ticketRemove.infer
export type FrontierInput = typeof CliSchemas.frontier.infer
export type Ticket = typeof TicketRecord.infer
