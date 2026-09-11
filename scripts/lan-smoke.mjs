#!/usr/bin/env node
/**
 * Живая проверка соседей по локальной сети: два экземпляра сайдкара на одной
 * машине находят друг друга по mDNS, приглашение доходит, приём и отказ
 * возвращаются, а у передачи появляется честный тип пути.
 *
 * Юнит-тесты покрывают видимость и блокировку отказов — они живут в TypeScript.
 * Здесь проверяется то, что тестами не проверить: mDNS, QUIC и сам сайдкар.
 *
 *   node scripts/lan-smoke.mjs            # обычный режим
 *   node scripts/lan-smoke.mjs --offline  # без релея и DNS: только UDP и mDNS
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
const OFFLINE = process.argv.includes('--offline')
const DISCOVER_TIMEOUT_MS = 25_000
const STEP_TIMEOUT_MS = 20_000

const hex = (n) => randomBytes(n).toString('hex')

function deadline(ms, what) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`таймаут ${ms} мс: ${what}`)), ms).unref()
  )
}

/** Одна команда моста: соединение, строка, однострочный ответ, закрыли. */
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

class Side {
  constructor(name) {
    this.name = name
    this.events = []
    this.waiters = []
  }

  async start() {
    this.proc = spawn(BIN, ['--bridge-port', '0', '--mdns', ...(OFFLINE ? ['--offline'] : [])], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc.stderr.resume()

    const ready = await new Promise((resolve, reject) => {
      const rl = createInterface({ input: this.proc.stdout })
      rl.once('line', (line) => {
        rl.close()
        try {
          resolve(JSON.parse(line))
        } catch (err) {
          reject(new Error(`${this.name}: первая строка не JSON: ${line}`))
        }
      })
      this.proc.once('error', reject)
    })
    this.port = ready.bridgePort
    this.proc.stdout.resume()

    // Канал событий держим открытым всё время проверки.
    await new Promise((resolve, reject) => {
      const socket = createConnection(this.port, '127.0.0.1')
      this.control = socket
      socket.on('error', reject)
      socket.on('connect', () => socket.write('{"op":"control"}\n'))
      const rl = createInterface({ input: socket })
      let first = true
      rl.on('line', (line) => {
        if (first) {
          first = false
          resolve()
          return
        }
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        this.events.push(event)
        for (const waiter of [...this.waiters]) {
          if (!waiter.match(event)) continue
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      })
    })
    return this
  }

  /** Событие, уже пришедшее или будущее. */
  wait(match, what, ms = STEP_TIMEOUT_MS) {
    const seen = this.events.find(match)
    if (seen) return Promise.resolve(seen)
    const pending = new Promise((resolve) => this.waiters.push({ match, resolve }))
    return Promise.race([pending, deadline(ms, `${this.name}: ${what}`)])
  }

  send(payload) {
    return command(this.port, payload)
  }

  stop() {
    this.control?.destroy()
    this.proc?.kill()
  }
}

const results = []
const check = (ok, text) => {
  results.push({ ok, text })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${text}`)
}

async function main() {
  console.log(`режим: ${OFFLINE ? 'offline (без релея и DNS)' : 'обычный'}`)
  const a = await new Side('A').start()
  const b = await new Side('B').start()
  console.log(`сайдкары подняты: A=${a.port} B=${b.port}`)

  const secretA = hex(32)
  const secretB = hex(32)
  const startedA = await a.send({
    op: 'lan-start',
    secret: secretA,
    userData: JSON.stringify({ n: 'Сайдкар A', t: 'laptop', k: hex(32) })
  })
  const startedB = await b.send({
    op: 'lan-start',
    secret: secretB,
    userData: JSON.stringify({ n: 'Сайдкар B', t: 'phone', k: hex(32) })
  })
  const idA = startedA.endpointId
  const idB = startedB.endpointId
  check(Boolean(idA && idB), `личности подняты: A=${idA?.slice(0, 8)} B=${idB?.slice(0, 8)}`)

  const seenB = await a.wait(
    (e) => e.event === 'lan-peer' && e.endpointId === idB,
    'A не увидел B по mDNS',
    DISCOVER_TIMEOUT_MS
  )
  const seenA = await b.wait(
    (e) => e.event === 'lan-peer' && e.endpointId === idA,
    'B не увидел A по mDNS',
    DISCOVER_TIMEOUT_MS
  )
  check(true, 'mDNS: нашли друг друга')
  const advert = JSON.parse(seenB.userData ?? '{}')
  check(advert.n === 'Сайдкар B', `объявление дошло целиком: имя «${advert.n}», тип ${advert.t}`)
  check(
    Array.isArray(seenA.addrs) && seenA.addrs.length > 0,
    `адреса пришли: ${seenA.addrs?.length}`
  )

  // Приглашение с согласием.
  const acceptTopic = hex(32)
  const acceptFlow = a.send({
    op: 'lan-invite',
    endpointId: idB,
    addrs: seenB.addrs ?? [],
    topic: acceptTopic,
    displayName: 'Сайдкар A',
    deviceType: 'laptop',
    fileCount: 2,
    totalSize: 1024
  })
  const inviteOnB = await b.wait(
    (e) => e.event === 'lan-invite' && e.topic === acceptTopic,
    'B не получил приглашение'
  )
  check(
    inviteOnB.displayName === 'Сайдкар A' && inviteOnB.fileCount === 2,
    `приглашение дошло с содержимым: ${inviteOnB.fileCount} файла, ${inviteOnB.totalSize} Б`
  )
  await b.send({ op: 'lan-respond', requestId: inviteOnB.requestId, response: 'accepted' })
  const accepted = await Promise.race([acceptFlow, deadline(STEP_TIMEOUT_MS, 'ответ на согласие')])
  check(accepted.response === 'accepted', `согласие вернулось отправителю: ${accepted.response}`)

  // Приглашение с отказом.
  const declineTopic = hex(32)
  const declineFlow = a.send({
    op: 'lan-invite',
    endpointId: idB,
    addrs: seenB.addrs ?? [],
    topic: declineTopic,
    displayName: 'Сайдкар A',
    deviceType: 'laptop'
  })
  const declineOnB = await b.wait(
    (e) => e.event === 'lan-invite' && e.topic === declineTopic,
    'B не получил второе приглашение'
  )
  await b.send({ op: 'lan-respond', requestId: declineOnB.requestId, response: 'declined' })
  const declined = await Promise.race([declineFlow, deadline(STEP_TIMEOUT_MS, 'ответ на отказ')])
  check(declined.response === 'declined', `отказ вернулся отправителю: ${declined.response}`)

  // Передача: тип пути должен приехать событием, а не угадываться.
  const topic = hex(32)
  const host = await a.send({ op: 'join', session: 'transfer', topic, role: 'host' })
  // Адреса хоста передаём прямо: без них гость пошёл бы искать его через
  // DNS/pkarr, а проверяем мы не обнаружение, а тип выбранного пути.
  await b.send({ op: 'join', session: 'transfer', topic, role: 'guest', addrs: host.addrs ?? [] })
  await a.wait((e) => e.event === 'peer' && e.session === 'transfer', 'A не дождался пира')
  const connType = await a.wait(
    (e) => e.event === 'conn-type' && e.session === 'transfer',
    'не пришёл тип соединения'
  )
  check(
    connType.connectionType === 'direct' || connType.connectionType === 'relay',
    `тип пути пришёл событием: ${connType.connectionType}`
  )
  check(
    !OFFLINE || connType.connectionType === 'direct',
    OFFLINE ? 'в офлайне путь прямой, релея нет' : 'в обычном режиме тип пути любой'
  )

  a.stop()
  b.stop()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\nитог: ${results.length - failed.length}/${results.length}`)
    process.exit(failed.length === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`\nсорвалось: ${err.message}`)
    process.exit(1)
  })
