import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type { PeerControlMessage } from '../control-channel'
import type { TransferTransport, TransferTransportCallbacks, TransportSession } from '../transport'
import { IrohBridge, readHeader, type BridgeEvent, type BridgeStream } from './bridge'
import { IrohControlChannel } from './control-channel'
import { IrohDrive } from './drive'

export interface IrohTransportOptions {
  /** Порт локального моста; сайдкар поднимает хост-процесс и сообщает порт воркл ету. */
  bridgePort: number
  /** Имя сессии в сайдкаре: у передачи и сопряжения они разные. */
  session?: string
  drive?: boolean
}

interface IrohSession extends TransportSession {
  controlChannel: IrohControlChannel
  drive: IrohDrive | null
}

/**
 * Транспорт поверх iroh. Отличия от hyperswarm-варианта:
 * — обнаружение делает сам Endpoint в сайдкаре (mDNS, DNS/pkarr, релей),
 *   гонять стратегии руками не нужно и нельзя: это был бы второй Endpoint
 *   с той же личностью;
 * — на файл открывается отдельный QUIC-стрим, поэтому файлы не толкаются
 *   в одной очереди.
 *
 * Ограничение текущей версии: один пир на сессию.
 */
export class IrohTransport implements TransferTransport {
  readonly name = 'iroh'

  private readonly callbacks: TransferTransportCallbacks
  private readonly driveEnabled: boolean
  private readonly bridgePort: number
  /** Имя сессии в сайдкаре, не путать с `session` — активным пиром. */
  private readonly sessionName: string

  private bridge: IrohBridge | null = null
  private session: IrohSession | null = null
  private hostedTopicHex: string | null = null
  private role: 'host' | 'guest' | null = null
  private subscribed = false

  constructor(callbacks: TransferTransportCallbacks, options: IrohTransportOptions) {
    this.callbacks = callbacks
    this.driveEnabled = options.drive ?? false
    this.bridgePort = options.bridgePort
    this.sessionName = options.session ?? 'default'
  }

  private ensureBridge(): IrohBridge {
    if (!this.bridge) {
      this.bridge = new IrohBridge(this.bridgePort, this.sessionName)
    }
    return this.bridge
  }

  private async start(topicHex: string, role: 'host' | 'guest'): Promise<void> {
    const bridge = this.ensureBridge()
    this.role = role
    await bridge.connectEvents()
    // Подписываемся один раз: onEvent проигрывает историю новому подписчику, и
    // вторая подписка заставила бы attach'ить стримы, уже разобранные первой.
    if (!this.subscribed) {
      bridge.onEvent((event) => this.onBridgeEvent(event))
      this.subscribed = true
    }
    // История прошлой сессии больше не нужна, а её id стримов уже мертвы.
    bridge.forgetHistory()
    await bridge.command({ op: 'join', topic: topicHex, role })
  }

  private onBridgeEvent(event: BridgeEvent): void {
    if (event.event === 'peer') {
      this.onPeer(event)
      return
    }
    if (event.event === 'stream' && typeof event.id === 'number') {
      void this.onStream(event.id)
      return
    }
    if (event.event === 'conn-type') {
      this.onConnectionType(event)
      return
    }
    if (event.event === 'closed' || event.event === 'error') {
      this.dropSession()
    }
  }

  private onPeer(event: BridgeEvent): void {
    if (this.session) return
    const bridge = this.ensureBridge()
    const peerKey = event.endpointId ?? ''

    const controlChannel = new IrohControlChannel((message) => {
      const session = this.session
      if (!session) return
      try {
        this.callbacks.onControlMessage(message, session)
      } catch (err) {
        console.error('IrohTransport: onControlMessage handler threw', err)
      }
    })

    const session: IrohSession = {
      socket: { destroy: () => this.dropSession() },
      peerKey,
      controlChannel,
      // iroh даёт эквивалент handshakeHash через экспортируемый keying material
      handshakeHash: event.binding ? b4a.from(event.binding, 'hex') : null,
      drive: this.driveEnabled ? new IrohDrive(bridge) : null
    }
    this.session = session

    // Управляющий стрим открывает та сторона, которая набирала: у принимающей
    // он придёт событием `stream` и привяжется в onStream.
    if (this.role === 'guest') {
      bridge
        .open({ stream: 'control' })
        .then((stream) => controlChannel.bind(stream))
        .catch((err) => console.error('IrohTransport: не открылся управляющий стрим', err))
    }

    this.callbacks.onPeerConnected(session)
    // Тип соединения не угадываем: сайдкар пришлёт conn-type, когда выберется
    // путь, и ещё раз, если соединение переедет с релея на прямой.
  }

  private onConnectionType(event: BridgeEvent): void {
    const peerKey = event.endpointId ?? this.session?.peerKey
    if (!peerKey) return
    if (event.connectionType !== 'direct' && event.connectionType !== 'relay') return
    this.callbacks.onConnectionType?.(peerKey, event.connectionType)
  }

  private async onStream(id: number): Promise<void> {
    const bridge = this.ensureBridge()
    try {
      const stream: BridgeStream = await bridge.attach(id)
      const { header, rest } = await readHeader(stream)
      const bound: BridgeStream = { socket: stream.socket, rest, reply: stream.reply }

      if (header.stream === 'control') {
        this.session?.controlChannel.bind(bound)
        return
      }
      if (header.stream === 'file' && typeof header.fileId === 'string') {
        this.session?.drive?.attachStream(header.fileId, bound)
        return
      }
      stream.socket.destroy()
    } catch (err) {
      console.warn('IrohTransport: не удалось принять стрим', err)
    }
  }

  private dropSession(): void {
    const session = this.session
    if (!session) return
    this.session = null
    session.drive?.destroy()
    session.controlChannel.close()
    this.callbacks.onPeerDisconnected(session.peerKey, 0)
  }

  generateKey(): string {
    if (this.hostedTopicHex) return this.hostedTopicHex
    const topicHex = b4a.toString(crypto.randomBytes(32), 'hex')
    this.hostedTopicHex = topicHex
    void this.host(topicHex)
    return topicHex
  }

  async host(topicHex: string): Promise<void> {
    this.hostedTopicHex = topicHex
    await this.start(topicHex, 'host')
  }

  async join(topicHex: string): Promise<void> {
    await this.start(topicHex, 'guest')
  }

  broadcast(message: PeerControlMessage): void {
    this.session?.controlChannel.send(message)
  }

  sendTo(peerKey: string, message: PeerControlMessage): void {
    if (this.session?.peerKey === peerKey) this.session.controlChannel.send(message)
  }

  getSession(peerKey: string): TransportSession | null {
    return this.session?.peerKey === peerKey ? this.session : null
  }

  getHandshakeHash(peerKey: string): Uint8Array | null {
    return this.getSession(peerKey)?.handshakeHash ?? null
  }

  hasConnectedPeers(): boolean {
    return this.session !== null
  }

  get sessions(): TransportSession[] {
    return this.session ? [this.session] : []
  }

  get peerCount(): number {
    return this.session ? 1 : 0
  }

  async suspendTransport(): Promise<void> {
    this.dropSession()
    if (this.bridge) {
      try {
        await this.bridge.command({ op: 'leave' })
      } catch (err) {
        console.warn('IrohTransport: leave не прошёл', err)
      }
      this.bridge.forgetHistory()
    }
  }

  async endSession(): Promise<void> {
    this.hostedTopicHex = null
    this.role = null
    await this.suspendTransport()
  }

  async destroy(): Promise<void> {
    await this.endSession()
    this.bridge?.close()
    this.bridge = null
    this.subscribed = false
  }
}
