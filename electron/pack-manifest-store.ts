import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import type { PackManifest } from '../src/types'
import { parsePackManifest, serializePackManifest } from './pack-manifest'

/** 每个整合包只有一份本地清单；插件本体仍由共享 DSH Profile 管理。 */
export function packManifestPath(root: string, packId: string): string {
  return path.join(root, `${packId}.yaml`)
}

export async function writePackManifest(root: string, packId: string, manifest: PackManifest): Promise<string> {
  const target = packManifestPath(root, packId)
  await writeFileAtomic(target, serializePackManifest(manifest), { fallbackToDirectWrite: true })
  return target
}

export async function readPackManifest(root: string, packId: string): Promise<PackManifest | null> {
  try {
    return parsePackManifest(await readFile(packManifestPath(root, packId), 'utf8'))
  } catch {
    return null
  }
}

export async function removePackManifest(root: string, packId: string): Promise<void> {
  await rm(packManifestPath(root, packId), { force: true }).catch(() => undefined)
}
