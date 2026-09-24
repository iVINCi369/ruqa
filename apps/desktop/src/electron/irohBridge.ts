import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { isWindows } from 'which-runtime'

/**
 * Сайдкар второго транспорта (iroh).
 *
 * Bare не поддерживает Node-API, поэтому iroh не может жить внутри воркл ета.
 * Главный процесс поднимает отдельный бинарник и передаёт воркл ету порт его
 * локального моста через `--iroh-bridge=`.
 *
 * Включён по умолчанию: на нём держится радар соседей (главный экран) и
 * второй транспорт. `--no-iroh` (или RUQA_IROH=0) выключает сайдкар, и
 * приложение работает на одном hyperswarm, без соседей в сети.
 */

const READY_TIMEOUT_MS = 10000

let child: ChildProcess | null = null
let bridgePort: number | null = null

function binaryName(): string {
  return isWindows ? 'iroh-bridge.exe' : 'iroh-bridge'
}

/** Собранный сайдкар: в упакованном приложении лежит рядом с ресурсами. */
function findBinary(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, binaryName())]
    : [
        path.join(app.getAppPath(), '../../native/iroh-bridge/target/release', binaryName()),
        path.join(app.getAppPath(), '../../native/iroh-bridge/target/debug', binaryName())
      ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Порт выбираем сами, а не ждём его от сайдкара: воркл ет получает номер сразу,
 * а соединяется с мостом только когда начнётся передача.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (typeof address === 'object' && address) {
        const { port } = address
        probe.close(() => resolve(port))
        return
      }
      probe.close(() => reject(new Error('не удалось занять порт')))
    })
  })
}

export function irohRequested(cliArgs: string[]): boolean {
  if (cliArgs.includes('--no-iroh') || process.env.RUQA_IROH === '0') return false
  return true
}

export function getIrohBridgePort(): number | null {
  return bridgePort
}

/** Поднять сайдкар. Возвращает порт моста или null, если запустить не вышло. */
export async function startIrohBridge(
  options: { offline?: boolean; mdns?: boolean } = {}
): Promise<number | null> {
  if (bridgePort !== null) return bridgePort

  const binary = findBinary()
  if (!binary) {
    console.warn('[iroh] сайдкар не найден, второй транспорт выключен')
    return null
  }

  let port: number
  try {
    port = await pickFreePort()
  } catch (err) {
    console.warn('[iroh] не удалось выбрать порт', err)
    return null
  }

  const args = ['--bridge-port', String(port)]
  if (options.offline) args.push('--offline')
  if (options.mdns !== false) args.push('--mdns')

  const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc

  proc.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[iroh] ${String(data)}`)
  })
  proc.on('exit', (code) => {
    if (child === proc) {
      child = null
      bridgePort = null
    }
    if (code !== 0) console.warn('[iroh] сайдкар вышел с кодом', code)
  })

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS)
    let buffered = ''
    proc.stdout?.on('data', (data: Buffer) => {
      buffered += String(data)
      if (!buffered.includes('\n')) return
      clearTimeout(timer)
      resolve(buffered.includes('"ready"'))
    })
    proc.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })

  if (!ready) {
    console.warn('[iroh] сайдкар не поднялся, второй транспорт выключен')
    stopIrohBridge()
    return null
  }

  bridgePort = port
  console.log('[iroh] мост слушает на 127.0.0.1:' + port)
  return port
}

export function stopIrohBridge(): void {
  bridgePort = null
  const proc = child
  child = null
  if (!proc) return
  try {
    proc.kill()
  } catch (err) {
    console.warn('[iroh] не удалось остановить сайдкар', err)
  }
}
