import type { LatestRelease } from '@ruqa/domain'

const KEY = 'ruqa.updateCheck'

export interface UpdateCheckCache extends LatestRelease {
  dismissedVersion?: string
}

export function readUpdateCheck(): UpdateCheckCache | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null

    const data = JSON.parse(raw) as Partial<UpdateCheckCache>
    if (typeof data.version !== 'string' || typeof data.fetchedAt !== 'number') return null

    return {
      version: data.version,
      fetchedAt: data.fetchedAt,
      dismissedVersion:
        typeof data.dismissedVersion === 'string' ? data.dismissedVersion : undefined
    }
  } catch {
    return null
  }
}

export function writeUpdateCheck(entry: UpdateCheckCache): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entry))
  } catch {}
}
