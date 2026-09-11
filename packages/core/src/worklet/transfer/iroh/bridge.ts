import b4a from 'b4a'
import { createConnection } from 'bare-tcp'

/**
 * Клиент локального моста iroh-bridge.
 *
 * Сам iroh живёт в отдельном процессе: Bare не поддерживает Node-API, поэтому
 * napi-биндинги `@number0/iroh` в воркл ет не загрузить. Хост-процесс поднимает
 * сайдкар и передаёт сюда порт; одно TCP-соединение с сайдкаром = один QUIC-стрим.
 */

export interface BridgeSocket {
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: () => void): unknown
  on(event: 'drain', cb: () => void): unknown
  once(event: 'drain', cb: () => void): unknown
  write(data: Uint8Array | string): boolean
  end(): unknown
  destroy(err?: Error): void
}

export interface BridgeStream {
  socket: BridgeSocket
  /** Байты, прочитанные вместе со строкой ответа и ещё не разобранные. */
  rest: Uint8Array
  /** Разобранная строка ответа: у части операций в ней есть результат. */
  reply: Record<string, unknown>
}

export interface BridgeEvent {
  event: string
  /** Имя сессии сайдкара; события чужих сессий отбрасываются. */
  session?: string
  id?: number
  endpointId?: string
  direction?: string
  binding?: string
  path?: string
  message?: string
  /** conn-type: каким путём реально идут данные — 'direct' или 'relay'. */
  connectionType?: string
  /** Соседи в локальной сети: lan-peer / lan-peer-gone / lan-invite. */
  requestId?: number
  userData?: string
  addrs?: string[]
  topic?: string
  displayName?: string
  deviceType?: string
  fileCount?: number
  textCount?: number
  totalSize?: number
}

const NEWLINE = 0x0a

function indexOfNewline(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) return i
  }
  return -1
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

export class IrohBridge {
  private readonly port: number
  private readonly session: string
  private controlSocket: BridgeSocket | null = null
  private readonly handlers: ((event: BridgeEvent) => void)[] = []
  private readonly history: BridgeEvent[] = []
  private destroyed = false

  /**
   * `session` разводит независимые Endpoint'ы в одном сайдкаре: передача файлов
   * и сопряжение устройств идут одновременно, и join одного не должен закрывать
   * другой. Канал событий у сайдкара общий, поэтому чужие события отбрасываем.
   */
  constructor(port: number, session = 'default') {
    this.port = port
    this.session = session
  }

  /** Открыть соединение с мостом и прочитать однострочный ответ. */
  private dial(op: Record<string, unknown>): Promise<BridgeStream> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.port, '127.0.0.1') as unknown as BridgeSocket
      const request = { session: this.session, ...op }
      let buf: Uint8Array = b4a.alloc(0)
      let settled = false

      const onData = (chunk: Uint8Array): void => {
        if (settled) return
        buf = b4a.concat([buf, chunk])
        const nl = indexOfNewline(buf)
        if (nl === -1) return
        settled = true
        const reply = parseJson(b4a.toString(buf.subarray(0, nl)))
        const rest = buf.subarray(nl + 1)
        if (!reply || reply.ok !== true) {
          socket.destroy()
          reject(new Error('iroh-bridge отказал: ' + b4a.toString(buf.subarray(0, nl))))
          return
        }
        resolve({ socket, rest, reply })
      }

      socket.on('data', onData)
      socket.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      socket.write(JSON.stringify(request) + '\n')
    })
  }

  /** Команда без потока данных: join / leave. */
  async command(op: Record<string, unknown>): Promise<void> {
    const stream = await this.dial(op)
    stream.socket.end()
  }

  /**
   * Команда, у которой важен ответ, а не поток: lan-invite возвращает решение
   * соседа по тому же соединению, отдельного события ждать не нужно.
   */
  async request(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    const stream = await this.dial(op)
    stream.socket.end()
    return stream.reply
  }

  /** Новый исходящий QUIC-стрим; первая строка говорит, зачем он открыт. */
  async open(header: Record<string, unknown>): Promise<BridgeStream> {
    const stream = await this.dial({ op: 'open' })
    stream.socket.write(JSON.stringify(header) + '\n')
    return stream
  }

  /** Забрать входящий стрим, о котором сообщило событие `stream`. */
  attach(id: number): Promise<BridgeStream> {
    return this.dial({ op: 'attach', id })
  }

  /**
   * Канал событий сайдкара. История копится: подписчик, пришедший позже,
   * получает всё, что уже произошло, иначе теряется первый входящий стрим.
   */
  async connectEvents(): Promise<void> {
    if (this.controlSocket) return
    const { socket, rest } = await this.dial({ op: 'control' })
    this.controlSocket = socket
    let buf = rest

    const flush = (): void => {
      for (;;) {
        const nl = indexOfNewline(buf)
        if (nl === -1) return
        const line = b4a.toString(buf.subarray(0, nl)).trim()
        buf = buf.subarray(nl + 1)
        if (!line) continue
        const parsed = parseJson(line)
        if (!parsed || typeof parsed.event !== 'string') continue
        if (typeof parsed.session === 'string' && parsed.session !== this.session) continue
        const event = parsed as unknown as BridgeEvent
        this.history.push(event)
        for (const handler of this.handlers) handler(event)
      }
    }

    socket.on('data', (chunk: Uint8Array) => {
      buf = b4a.concat([buf, chunk])
      flush()
    })
    socket.on('close', () => {
      this.controlSocket = null
    })
    flush()
  }

  onEvent(handler: (event: BridgeEvent) => void): void {
    for (const event of this.history) handler(event)
    this.handlers.push(handler)
  }

  forgetHistory(): void {
    this.history.length = 0
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.handlers.length = 0
    try {
      this.controlSocket?.destroy()
    } catch {}
    this.controlSocket = null
  }
}

/**
 * Прочитать первую строку стрима — заголовок, объясняющий, зачем он открыт.
 * Часть строки могла приехать вместе с ответом моста, поэтому сначала смотрим `rest`.
 */
export function readHeader(
  stream: BridgeStream
): Promise<{ header: Record<string, unknown>; rest: Uint8Array }> {
  const immediate = indexOfNewline(stream.rest)
  if (immediate !== -1) {
    const header = parseJson(b4a.toString(stream.rest.subarray(0, immediate)))
    if (header) {
      return Promise.resolve({ header, rest: stream.rest.subarray(immediate + 1) })
    }
  }

  return new Promise((resolve, reject) => {
    let buf = stream.rest
    let settled = false
    const onData = (chunk: Uint8Array): void => {
      if (settled) return
      buf = b4a.concat([buf, chunk])
      const nl = indexOfNewline(buf)
      if (nl === -1) return
      const header = parseJson(b4a.toString(buf.subarray(0, nl)))
      if (!header) {
        settled = true
        reject(new Error('iroh-bridge: битый заголовок стрима'))
        return
      }
      settled = true
      resolve({ header, rest: buf.subarray(nl + 1) })
    }
    stream.socket.on('data', onData)
    stream.socket.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}
