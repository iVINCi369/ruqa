import Constants from 'expo-constants'
import { Directory, File, Paths } from 'expo-file-system'
import { useCallback, useEffect, useState } from 'react'
import { fetchLatestRelease, isCacheStale, isNewerVersion } from '@ruqa/domain'

const CACHE_DIR = 'ruqa'
const CACHE_FILE = 'update-check.json'

interface CacheEntry {
  version: string
  fetchedAt: number
  dismissedVersion?: string
}

function getCacheFile(): File | null {
  const base = Paths.document
  if (!base?.uri) return null
  return new File(new Directory(base, CACHE_DIR), CACHE_FILE)
}

function readCache(): CacheEntry | null {
  try {
    const file = getCacheFile()
    if (!file?.exists) return null
    const data = JSON.parse(file.textSync())
    if (typeof data.version === 'string' && typeof data.fetchedAt === 'number') return data
    return null
  } catch {
    return null
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    const base = Paths.document
    if (!base?.uri) return
    const dir = new Directory(base, CACHE_DIR)
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true })
    new File(dir, CACHE_FILE).write(JSON.stringify(entry))
  } catch {}
}

export function useUpdateCheck(): { needsUpdate: boolean; dismiss: () => void } {
  const [entry, setEntry] = useState<CacheEntry | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      const current = Constants.expoConfig?.version
      if (!current) return

      let cached = readCache()
      if (!cached || isCacheStale(cached.fetchedAt)) {
        const fetched = await fetchLatestRelease()
        if (fetched) {
          const next = { ...fetched, dismissedVersion: cached?.dismissedVersion }
          writeCache(next)
          cached = next
        }
      }

      if (!cancelled && cached) setEntry(cached)
    }

    const timer = setTimeout(check, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const dismiss = useCallback(() => {
    if (!entry) return
    const updated = { ...entry, dismissedVersion: entry.version }
    writeCache(updated)
    setEntry(updated)
  }, [entry])

  const current = Constants.expoConfig?.version ?? ''
  const needsUpdate =
    !!current &&
    !!entry &&
    entry.dismissedVersion !== entry.version &&
    isNewerVersion(entry.version, current)

  return { needsUpdate, dismiss }
}
