const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const plainScalar = /^[\p{L}\p{N}][\p{L}\p{N} .,()\/_-]*$/u
const reservedScalars = new Set(["false", "no", "null", "off", "on", "true", "yes"])

function scalar(value: string) {
	if (plainScalar.test(value) && !reservedScalars.has(value.toLowerCase())) {
		return value
	}

	return JSON.stringify(value)
}

export function parseDocument(text: string) {
	const match = text.match(frontmatter)

	if (!match?.[1]) {
		return { body: text.trim(), fields: {} }
	}

	return { body: text.slice(match[0].length).trim(), fields: Bun.YAML.parse(match[1]) }
}

export function serializeDocument(fields: Record<string, string | string[] | undefined>, body: string) {
	const lines = Object.entries(fields).flatMap(([key, value]) => {
		if (value === undefined) {
			return []
		}

		if (Array.isArray(value)) {
			return value.length > 0 ? [`${key}:`, ...value.map((entry) => `  - ${scalar(entry)}`)] : []
		}

		return [`${key}: ${scalar(value)}`]
	})
	const content = body.trim()

	return `---\n${lines.join("\n")}\n---\n${content ? `\n${content}\n` : ""}`
}
