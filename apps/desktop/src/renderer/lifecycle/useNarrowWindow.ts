import { useEffect, useState } from 'react'

// Ниже этой ширины развёрнутый сайдбар съедает больше четверти окна, поэтому
// он сворачивается сам — выбор пользователя при этом не затирается: вернули
// окно шире, вернулось и его состояние.
const NARROW_QUERY = '(max-width: 860px)'

export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches
  )

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return narrow
}
