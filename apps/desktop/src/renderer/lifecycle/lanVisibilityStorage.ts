import type { LanVisibility } from '@ruqa/core'

const KEY = 'ruqa.lan.visibility'

/**
 * По умолчанию `paired`: в чужой сети открытый режим — это возможность для
 * незнакомца открыть диалог на твоём экране.
 */
const DEFAULT: LanVisibility = 'paired'

export function getLanVisibility(): LanVisibility {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'off' || value === 'paired' || value === 'all' ? value : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function saveLanVisibility(visibility: LanVisibility): void {
  try {
    window.localStorage.setItem(KEY, visibility)
  } catch {}
}
