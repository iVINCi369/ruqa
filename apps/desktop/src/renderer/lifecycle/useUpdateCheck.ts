import { useCallback, useEffect, useState } from 'react'
import { fetchLatestRelease, isCacheStale, isNewerVersion } from '@ruqa/domain'
import { readUpdateCheck, writeUpdateCheck, type UpdateCheckCache } from './updateCheckStorage'

const START_DELAY_MS = 1000

// OTA у Ruqa выключены, поэтому обновление ищем сами: раз в сутки спрашиваем
// у репозитория последний стабильный релиз и, если он новее собранной версии,
// предлагаем перейти на страницу релизов.
export function useUpdateCheck(currentVersion: string): {
  needsUpdate: boolean
  dismiss: () => void
} {
  const [entry, setEntry] = useState<UpdateCheckCache | null>(null)

  useEffect(() => {
    if (!currentVersion) return
    let cancelled = false

    async function check() {
      let cached = readUpdateCheck()

      if (!cached || isCacheStale(cached.fetchedAt)) {
        const fetched = await fetchLatestRelease()
        if (fetched) {
          cached = { ...fetched, dismissedVersion: cached?.dismissedVersion }
          writeUpdateCheck(cached)
        }
      }

      if (!cancelled && cached) setEntry(cached)
    }

    const timer = setTimeout(() => void check(), START_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [currentVersion])

  const dismiss = useCallback(() => {
    if (!entry) return
    const updated = { ...entry, dismissedVersion: entry.version }
    writeUpdateCheck(updated)
    setEntry(updated)
  }, [entry])

  const needsUpdate =
    !!currentVersion &&
    !!entry &&
    entry.dismissedVersion !== entry.version &&
    isNewerVersion(entry.version, currentVersion)

  return { needsUpdate, dismiss }
}
