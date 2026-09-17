/** OMP deployment surface: where DoG state lives and which knobs the host fixes. */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { DogConfig } from '../core/model.ts'

/** Extension root; this module lives in `<root>/omp/`. */
export const EXTENSION_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Project-scoped DoG root. Graphs, runs, captures and evidence travel with the
 * repository they describe — never with the user's global agent directory.
 */
export function dogRootFor(cwd: string): string {
 return join(cwd, '.omp', 'dog')
}

/**
 * Engine configuration.
 *
 * `storageDirectory` stays relative because the core validates it that way; the
 * repository itself is constructed from an absolute `dogRootFor(cwd)`.
 */
export function resolveDogConfig(cwd: string): DogConfig {
 return {
  storageDirectory: join('.omp', 'dog'),
  workspaceRoot: join(dogRootFor(cwd), 'workspace'),
  scriptsDirectory: join(EXTENSION_ROOT, 'scripts'),
  maxGraphNodes: 256,
  maxExpressionNodes: 512,
  maxExpressionDepth: 64,
  maxSandboxBytes: 67_108_864,
  allowPartialRoot: false,
  maxConcurrentVerifications: 1,
  revalidateThreshold: 0.3,
  gmDigestAlgo: 'sha256',
 }
}
