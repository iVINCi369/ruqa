import { BrowserWindow } from 'electron'
import { createJsonStore } from './store/index.js'

// На 4K-мониторе системный масштаб не всегда спасает: шаг Windows между 150 %
// и 175 % слишком груб, а окно приложения остаётся мелким. Даём свой множитель
// поверх системного — теми же значениями, что привычны по браузеру.
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

const DEFAULT_FACTOR = 1

interface StoredZoom {
  factor: number
}

const store = createJsonStore<StoredZoom>('zoom.json', { factor: DEFAULT_FACTOR })

let current = DEFAULT_FACTOR

/** Ближайший разрешённый шаг: в файл могло попасть что угодно. */
function normalize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FACTOR
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best
  )
}

export function currentZoomFactor(): number {
  return current
}

export async function loadZoomFactor(): Promise<number> {
  current = normalize((await store.read()).factor)
  return current
}

export function applyZoomFactor(win: BrowserWindow, factor: number = current): void {
  if (win.isDestroyed()) return
  win.webContents.setZoomFactor(factor)
}

export function setZoomFactor(factor: number): number {
  current = normalize(factor)
  for (const win of BrowserWindow.getAllWindows()) applyZoomFactor(win, current)
  void store.write({ factor: current })
  return current
}

/** delta: +1 крупнее, −1 мельче, 0 вернуть к 100 %. */
export function stepZoomFactor(delta: number): number {
  if (delta === 0) return setZoomFactor(DEFAULT_FACTOR)
  const index = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number])
  const from = index === -1 ? ZOOM_STEPS.indexOf(DEFAULT_FACTOR) : index
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + Math.sign(delta)))
  return setZoomFactor(ZOOM_STEPS[next])
}
