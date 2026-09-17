/** JSON Schema validation layer: every exchange payload is validated before parsing or persistence. */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export interface SchemaSet {
 readonly validateGraph: ValidateFunction
 readonly validateRun: ValidateFunction
 readonly validateVerification: ValidateFunction
 readonly validateRuntimeEvent: ValidateFunction
 readonly validateReport: ValidateFunction
}

/** Load the five normative schemas from schemas/schema-0.2 (checked into the package root). */
export async function loadSchemaSet(): Promise<SchemaSet> {
 const schemasDir = locateSchemasDirectory()
 const ajv = new Ajv2020({ allErrors: true, strict: false })
 addFormats(ajv)
 const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(schemasDir, name), 'utf8')) as unknown
 const compile = (schema: unknown): ValidateFunction => ajv.compile(schema as object) as unknown as ValidateFunction
 const graph = compile(await load('graph.schema.json'))
 const run = compile(await load('run.schema.json'))
 const verification = compile(await load('verification.schema.json'))
 const runtimeEvent = compile(await load('runtime-event.schema.json'))
 const report = compile(await load('report.schema.json'))
 return { validateGraph: graph, validateRun: run, validateVerification: verification, validateRuntimeEvent: runtimeEvent, validateReport: report }
}

/**
 * Resolve `schemas/schema-0.2` by walking up from this module, so the same
 * code works from `src/core/` (tests) and from the bundled `lib/index.js`
 * (installed package) without a depth-sensitive relative path.
 */
function locateSchemasDirectory(): string {
 let directory = fileURLToPath(new URL('.', import.meta.url))
 for (let depth = 0; depth < 5; depth += 1) {
  const candidate = join(directory, 'schemas', 'schema-0.2')
  if (existsSync(candidate)) return candidate
  directory = dirname(directory)
 }
 throw new Error('schemas/schema-0.2 was not found beside the package root')
}

/** Format ajv errors into one-line messages with instance paths. */
export function schemaErrorText(validate: ValidateFunction): string[] {
 return (validate.errors ?? []).map(error =>
  `${error.instancePath || '$'} ${error.message ?? 'is invalid'}${'params' in error && typeof error.params === 'object' && error.params !== null ? ` (${JSON.stringify(error.params)})` : ''}`,
 )
}
