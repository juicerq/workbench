import { type } from "arktype"

const trimmedString = type("string").pipe((value) => value.trim())
const nonEmptyString = trimmedString.narrow((value) => value.length > 0)
const timestamp = type("string").narrow((value) => !Number.isNaN(Date.parse(value)))
const taskIdentifier = trimmedString.narrow((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
const taskDependencies = trimmedString.pipe((value) =>
	taskIdentifier.array().assert(value.split(",").map((dependency) => dependency.trim())),
)
const acceptanceCriterion = trimmedString.pipe((value) =>
	type("number.integer >= 1").assert(Number(value)),
)
const phase = type.enumerated("grilling", "decided", "tasked", "implementing")
const phaseTarget = type.enumerated("decided", "tasked", "implementing")
const terminalOutcome = type.enumerated("completed", "abandoned", "superseded")
const specificationArtifact = type.enumerated("decisions", "prd")
const owner = type({
	"+": "reject",
	agent: nonEmptyString,
	conversation: nonEmptyString,
})
const gitContext = type({
	"+": "reject",
	branch: "string | null",
	commit: "string | null",
	repository: nonEmptyString,
	worktree: nonEmptyString,
})
const ownershipTakeover = type({
	"+": "reject",
	at: timestamp,
	from: owner,
	to: owner,
})

const workItem = type({
	"+": "reject",
	createdAt: timestamp,
	"decidedAt?": timestamp,
	id: nonEmptyString,
	"implementingAt?": timestamp,
	name: nonEmptyString,
	phase,
	repository: nonEmptyString,
	specification: type({
		"+": "reject",
		owner,
		takeovers: ownershipTakeover.array(),
	}),
	"taskedAt?": timestamp,
	updatedAt: timestamp,
})
const task = type({
	"+": "reject",
	dependencies: taskIdentifier.array(),
	id: taskIdentifier,
})
const taskOwnerInput = type({
	"+": "reject",
	agent: nonEmptyString,
	conversation: nonEmptyString,
	repo: nonEmptyString,
	task: taskIdentifier,
})

export const WorkSchemas = {
	item: workItem
		.merge(type({ outcome: type.enumerated("active") }))
		.or(workItem.merge(type({ closedAt: timestamp, outcome: terminalOutcome }))),
	focus: type({
		"+": "reject",
		workId: nonEmptyString,
	}),
	task: task
		.merge(type({ status: type.enumerated("pending") }))
		.or(task.merge(type({ completedAt: timestamp, status: type.enumerated("completed") })))
		.or(task.merge(type({ droppedAt: timestamp, status: type.enumerated("dropped") }))),
	taskClaim: type({
		"+": "reject",
		context: gitContext,
		owner,
		takeovers: ownershipTakeover.array(),
	}),
	gitContext,
}

export const CliSchemas = {
	start: type({
		"+": "reject",
		"agent?": nonEmptyString,
		conversation: nonEmptyString,
		name: nonEmptyString,
		repo: nonEmptyString,
	}),
	current: type({
		"+": "reject",
		conversation: nonEmptyString,
		"name?": nonEmptyString,
		repo: nonEmptyString,
	}),
	transition: type({
		"+": "reject",
		conversation: nonEmptyString,
		repo: nonEmptyString,
		to: phaseTarget,
	}),
	specificationWrite: type({
		"+": "reject",
		agent: nonEmptyString,
		artifact: specificationArtifact,
		content: "string",
		conversation: nonEmptyString,
		repo: nonEmptyString,
	}),
	specificationTakeover: type({
		"+": "reject",
		agent: nonEmptyString,
		conversation: nonEmptyString,
		repo: nonEmptyString,
	}),
	taskAdd: type({
		"+": "reject",
		content: "string",
		conversation: nonEmptyString,
		"dependencies?": taskDependencies,
		repo: nonEmptyString,
		task: taskIdentifier,
	}),
	tasks: type({
		"+": "reject",
		conversation: nonEmptyString,
		repo: nonEmptyString,
	}),
	taskClaim: taskOwnerInput,
	taskTakeover: taskOwnerInput,
	taskCheckpoint: taskOwnerInput.merge(type({
		done: nonEmptyString,
		next: nonEmptyString,
		validation: nonEmptyString,
	})),
	taskCheck: taskOwnerInput.merge(type({ criterion: acceptanceCriterion })),
	taskComplete: taskOwnerInput.merge(type({
		validation: nonEmptyString,
	})),
	taskDrop: taskOwnerInput.merge(type({
		reason: nonEmptyString,
	})),
	close: type({
		"+": "reject",
		conversation: nonEmptyString,
		outcome: terminalOutcome,
		repo: nonEmptyString,
	}),
}

export type WorkItem = typeof WorkSchemas.item.infer
export type StartWorkInput = typeof CliSchemas.start.infer
export type CurrentWorkInput = typeof CliSchemas.current.infer
export type TransitionWorkInput = typeof CliSchemas.transition.infer
export type SpecificationWriteInput = typeof CliSchemas.specificationWrite.infer
export type SpecificationTakeoverInput = typeof CliSchemas.specificationTakeover.infer
export type WorkTask = typeof WorkSchemas.task.infer
export type TaskClaim = typeof WorkSchemas.taskClaim.infer
export type GitContext = typeof WorkSchemas.gitContext.infer
export type TaskAddInput = typeof CliSchemas.taskAdd.infer
export type TasksInput = typeof CliSchemas.tasks.infer
export type TaskClaimInput = typeof CliSchemas.taskClaim.infer
export type TaskTakeoverInput = typeof CliSchemas.taskTakeover.infer
export type TaskCheckpointInput = typeof CliSchemas.taskCheckpoint.infer
export type TaskCheckInput = typeof CliSchemas.taskCheck.infer
export type TaskCompleteInput = typeof CliSchemas.taskComplete.infer
export type TaskDropInput = typeof CliSchemas.taskDrop.infer
export type CloseWorkInput = typeof CliSchemas.close.infer
