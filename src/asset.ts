import { join } from "node:path"
import { atomicWrite } from "./filesystem"
import { slug, workLocation } from "./locations"
import type { AssetReadInput, AssetWriteInput } from "./schemas"

function assetPath(name: string) {
	return join("assets", `${name}.md`)
}

export const Assets = {
	async write(input: AssetWriteInput) {
		const work = await workLocation(input)
		const name = slug(input.name)

		await atomicWrite(join(work.directory, assetPath(name)), input.content)

		return { id: work.id, name, path: assetPath(name) }
	},

	async read(input: AssetReadInput) {
		const work = await workLocation(input)
		const name = slug(input.name)
		const file = Bun.file(join(work.directory, assetPath(name)))

		if (!await file.exists()) {
			throw new Error(`Asset ${name} does not exist`)
		}

		return { content: await file.text(), id: work.id, name, path: assetPath(name) }
	},
}
