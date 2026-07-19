import { type } from "arktype"

const nonEmptyString = type("string").pipe((value) => value.trim()).narrow((value) => value.length > 0)
const nonBlankContent = type("string").narrow((value) => value.trim().length > 0)
const workIdentifier = nonEmptyString.narrow((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
const artifact = type.enumerated("spec", "issues", "learnings")
const removableArtifact = type.enumerated("issues", "learnings")

export const CliSchemas = {
	create: type({
		"+": "reject",
		content: nonBlankContent,
		name: nonEmptyString,
		repo: nonEmptyString,
	}),
	list: type({
		"+": "reject",
		repo: nonEmptyString,
	}),
	read: type({
		"+": "reject",
		repo: nonEmptyString,
		work: workIdentifier,
	}),
	write: type({
		"+": "reject",
		artifact,
		content: nonBlankContent,
		repo: nonEmptyString,
		work: workIdentifier,
	}),
	remove: type({
		"+": "reject",
		"artifact?": removableArtifact,
		repo: nonEmptyString,
		work: workIdentifier,
	}),
}

export type CreateWorkInput = typeof CliSchemas.create.infer
export type ListWorkInput = typeof CliSchemas.list.infer
export type ReadWorkInput = typeof CliSchemas.read.infer
export type WriteArtifactInput = typeof CliSchemas.write.infer
export type RemoveWorkInput = typeof CliSchemas.remove.infer
export type Artifact = typeof artifact.infer
