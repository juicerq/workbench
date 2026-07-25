import { join } from "node:path"
import { parseDocument, serializeDocument } from "./document"
import { atomicWrite } from "./filesystem"
import { workLocation } from "./locations"
import { MapRecord, type MapStateInput, type MapWriteInput } from "./schemas"

export const mapFileName = "map.md"

export async function readMap(workDirectory: string) {
	const file = Bun.file(join(workDirectory, mapFileName))

	if (!await file.exists()) {
		return
	}

	const document = parseDocument(await file.text())

	return { body: document.body, state: MapRecord.assert(document.fields).state }
}

export const Maps = {
	async write(input: MapWriteInput) {
		const work = await workLocation(input)
		const state = (await readMap(work.directory))?.state ?? "open"

		await atomicWrite(join(work.directory, mapFileName), serializeDocument({ state }, input.content))

		return { id: work.id, state }
	},

	async state(input: MapStateInput) {
		const work = await workLocation(input)
		const map = await readMap(work.directory)

		if (!map) {
			throw new Error(`Work ${work.id} has no map`)
		}

		await atomicWrite(
			join(work.directory, mapFileName),
			serializeDocument({ state: input.state }, map.body),
		)

		return { id: work.id, state: input.state }
	},
}
