#!/usr/bin/env node
/**
 * Проверка типа пути между двумя машинами за разными NAT.
 *
 * Приложение для этого не нужно: достаточно двух сайдкаров. На первой машине
 *
 *   node scripts/nat-probe.mjs --host
 *
 * печатает join-код, на второй
 *
 *   node scripts/nat-probe.mjs --guest <код>
 *
 * соединяется по нему. Обе стороны печатают, каким путём реально пошли данные:
 * `direct` — пробивка удалась, `relay` — трафик идёт через ретранслятор.
 * Именно это в продукте и стоит знать: неудачная пробивка не выглядит ошибкой,
 * она выглядит работающей передачей, за которую платишь трафиком релея.
 *
 * Нужен собранный сайдкар: cargo build --release в native/iroh-bridge.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(
  ROOT,
  'native/iroh-bridge/target/release',
  process.platform === 'win32' ? 'iroh-bridge.exe' : 'iroh-bridge'
)

const argv = process.argv.slice(2)
const isHost = argv.includes('--host')
const guestIndex = argv.indexOf('--guest')
const code = guestIndex === -1 ? null : argv[guestIndex + 1]

if (!isHost && !code) {
  console.error('нужно --host или --guest <код>')
  process.exit(2)
}

function command(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1')
    let buf = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      socket.end()
      try {
        resolve(JSON.parse(buf.slice(0, nl)))
      } catch (err) {
        reject(err)
      }
    })
  })
}

const child = spawn(BIN, ['--bridge-port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
const ready = await new Promise((resolve, reject) => {
  const rl = createInterface({ input: child.stdout })
  rl.once('line', (line) => {
    rl.close()
    try {
      resolve(JSON.parse(line))
    } catch {
      reject(new Error(`первая строка не JSON: ${line}`))
    }
  })
  child.once('error', reject)
})
child.stdout.resume()
const port = ready.bridgePort

// Канал событий: тип пути приезжает именно сюда.
const control = createConnection(port, '127.0.0.1')
control.on('connect', () => control.write('{"op":"control"}\n'))
createInterface({ input: control }).on('line', (line) => {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.event === 'peer') {
    console.log(`пир подключился: ${event.endpointId?.slice(0, 12)}… (${event.direction})`)
  }
  if (event.event === 'conn-type') {
    const label = event.connectionType === 'direct' ? 'НАПРЯМУЮ' : 'ЧЕРЕЗ РЕТРАНСЛЯТОР'
    console.log(`путь: ${label} (${event.connectionType})`)
  }
  if (event.event === 'error') console.error(`ошибка: ${event.message}`)
})

const topic = isHost ? randomBytes(32).toString('hex') : code
const reply = await command(port, {
  op: 'join',
  session: 'transfer',
  topic,
  role: isHost ? 'host' : 'guest'
})

if (isHost) {
  console.log(`\nкод для второй машины:\n\n  node scripts/nat-probe.mjs --guest ${topic}\n`)
  console.log(`мои адреса: ${(reply.addrs ?? []).join(', ') || '(ещё не определились)'}`)
}
console.log('жду соединения; Ctrl+C чтобы выйти\n')

const stop = () => {
  control.destroy()
  child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
