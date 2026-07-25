import { type } from "arktype"

const nonEmptyString = type("string").pipe((value) => value.trim()).narrow((value) => value.length > 0)
const nonBlankContent = type("string").narrow((value) => value.trim().length > 0)
const identifier = nonEmptyString.narrow((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
const identifierList = nonEmptyString.pipe((value) => value.split(",")).to(identifier.array())
const artifact = type.enumerated("spec", "issues", "learnings")
const removableArtifact = type.enumerated("issues", "learnings")
const state = type.enumerated("open", "closed")
const ticketType = type.enumerated("research", "prototype", "grilling", "task")

const workReference = {
	repo: nonEmptyString,
	work: identifier,
}

export const CliSchemas = {
	create: type({
		"+": "reject",
		"content?": nonBlankContent,
		name: nonEmptyString,
		repo: nonEmptyString,
	}),
	list: type({
		"+": "reject",
		repo: nonEmptyString,
	}),
	read: type({
		"+": "reject",
		...workReference,
	}),
	write: type({
		"+": "reject",
		artifact,
		content: nonBlankContent,
		...workReference,
	}),
	remove: type({
		"+": "reject",
		"artifact?": removableArtifact,
		...workReference,
	}),
	mapWrite: type({
		"+": "reject",
		content: nonBlankContent,
		...workReference,
	}),
	mapState: type({
		"+": "reject",
		state,
		...workReference,
	}),
	ticketCreate: type({
		"+": "reject",
		"blocked-by?": identifierList,
		"content?": nonBlankContent,
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
		content: nonBlankContent,
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
	assetWrite: type({
		"+": "reject",
		content: nonBlankContent,
		name: nonEmptyString,
		...workReference,
	}),
	assetRead: type({
		"+": "reject",
		name: nonEmptyString,
		...workReference,
	}),
}

export const MapRecord = type({
	"+": "reject",
	state,
})

export const TicketRecord = type({
	"+": "reject",
	"assignee?": nonEmptyString,
	"blocked_by?": identifier.array(),
	state,
	title: nonEmptyString,
	type: ticketType,
}).pipe(({ blocked_by: blockedBy, ...fields }) => ({ ...fields, blockedBy: blockedBy ?? [] }))

export type CreateWorkInput = typeof CliSchemas.create.infer
export type ListWorkInput = typeof CliSchemas.list.infer
export type ReadWorkInput = typeof CliSchemas.read.infer
export type WriteArtifactInput = typeof CliSchemas.write.infer
export type RemoveWorkInput = typeof CliSchemas.remove.infer
export type MapWriteInput = typeof CliSchemas.mapWrite.infer
export type MapStateInput = typeof CliSchemas.mapState.infer
export type TicketCreateInput = typeof CliSchemas.ticketCreate.infer
export type TicketBlockInput = typeof CliSchemas.ticketBlock.infer
export type TicketClaimInput = typeof CliSchemas.ticketClaim.infer
export type TicketCloseInput = typeof CliSchemas.ticketClose.infer
export type TicketReadInput = typeof CliSchemas.ticketRead.infer
export type TicketRemoveInput = typeof CliSchemas.ticketRemove.infer
export type FrontierInput = typeof CliSchemas.frontier.infer
export type AssetWriteInput = typeof CliSchemas.assetWrite.infer
export type AssetReadInput = typeof CliSchemas.assetRead.infer
export type Artifact = typeof artifact.infer
export type Ticket = typeof TicketRecord.infer
