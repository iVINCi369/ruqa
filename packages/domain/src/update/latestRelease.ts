import { releasesApiUrl } from '../constants/links'

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

export interface LatestRelease {
  version: string
  fetchedAt: number
}

interface GithubRelease {
  draft?: boolean
  prerelease?: boolean
  tag_name?: string
}

// Своего канала OTA у Ruqa нет — единственный источник правды о свежей версии
// это последний стабильный релиз в репозитории. Черновики и пререлизы
// отбрасываем, тег приводим к виду semver без ведущей «v».
export async function fetchLatestRelease(
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(releasesApiUrl, {
      headers: { 'User-Agent': 'Ruqa', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!res.ok) return null

    const json = (await res.json()) as GithubRelease
    const tag = json.tag_name ?? ''
    if (json.draft || json.prerelease) return null
    if (!/^v?\d+\.\d+/.test(tag)) return null

    return { version: tag.replace(/^v/, ''), fetchedAt: Date.now() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function isCacheStale(fetchedAt: number, ttlMs: number = UPDATE_CHECK_TTL_MS): boolean {
  return Date.now() - fetchedAt > ttlMs
}
