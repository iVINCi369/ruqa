import type { PeerControlMessage } from './control-channel'
import type { TransferTransport, TransferTransportCallbacks, TransportSession } from './transport'

export type TransportFactory = (callbacks: TransferTransportCallbacks) => TransferTransport

/**
 * Гонка транспортов. Дорожки стартуют одновременно, первая давшая пира
 * забирает сессию, остальные усыпляются.
 *
 * Гонять имеет смысл именно разные семейства транспортов. Стратегии поиска
 * внутри одного семейства (mDNS, DNS, релей) соревнуются сами внутри своего
 * Endpoint'а — поднимать под них отдельные дорожки нельзя, получится несколько
 * узлов с одной личностью, и стороны выберут разные пути.
 */
export class RacingTransport implements TransferTransport {
  readonly name = 'racing'

  private readonly callbacks: TransferTransportCallbacks
  private readonly lanes: TransferTransport[] = []
  private winner: TransferTransport | null = null
  private topicHex: string | null = null
  private mode: 'host' | 'guest' | null = null
  private rearming = false

  constructor(callbacks: TransferTransportCallbacks, factories: TransportFactory[]) {
    this.callbacks = callbacks
    for (const make of factories) {
      const box: { lane: TransferTransport | null } = { lane: null }
      const lane = make({
        onPeerConnected: (session) => this.onLanePeer(box.lane, session),
        onPeerDisconnected: (peerKey, count) => {
          if (!this.isActive(box.lane)) return
          this.callbacks.onPeerDisconnected(peerKey, count)
          if (count === 0) void this.rearm()
        },
        onControlMessage: (message, session) => {
          if (!this.isActive(box.lane)) return
          this.callbacks.onControlMessage(message, session)
        },
        onConnectionType: (peerKey, connectionType) => {
          if (!this.isActive(box.lane)) return
          this.callbacks.onConnectionType?.(peerKey, connectionType)
        }
      })
      box.lane = lane
      this.lanes.push(lane)
    }
  }

  private isActive(lane: TransferTransport | null): boolean {
    return lane !== null && (this.winner === null || this.winner === lane)
  }

  private onLanePeer(lane: TransferTransport | null, session: TransportSession): void {
    if (!lane) return
    if (this.winner && this.winner !== lane) return

    if (!this.winner) {
      this.winner = lane
      console.log('RacingTransport: победил транспорт', lane.name)
      for (const other of this.lanes) {
        if (other === lane) continue
        other.suspendTransport().catch((err) => {
          console.warn('RacingTransport: не усыпилась дорожка', other.name, err)
        })
      }
    }
    this.callbacks.onPeerConnected(session)
  }

  /** Победитель отвалился — снова запускаем все дорожки на тот же код. */
  private async rearm(): Promise<void> {
    if (this.rearming || !this.topicHex || !this.mode) return
    this.rearming = true
    this.winner = null
    const topicHex = this.topicHex
    const mode = this.mode
    try {
      for (const lane of this.lanes) {
        try {
          if (mode === 'host') await lane.host(topicHex)
          else await lane.join(topicHex)
        } catch (err) {
          console.warn('RacingTransport: дорожка не перезапустилась', lane.name, err)
        }
      }
    } finally {
      this.rearming = false
    }
  }

  private get active(): TransferTransport[] {
    return this.winner ? [this.winner] : this.lanes
  }

  async generateKey(): Promise<string> {
    if (this.topicHex && this.mode === 'host') return this.topicHex
    // Код генерирует первая дорожка, остальные подхватывают его же: у всех
    // транспортов один join-код, иначе пользователю пришлось бы выбирать.
    // Первой обязана стоять iroh: её код — публичный ключ хоста, чужой код
    // она хостить не может, а hyperswarm'у всё равно, что взять темой.
    const topicHex = await this.lanes[0].generateKey()
    this.topicHex = topicHex
    this.mode = 'host'
    for (const lane of this.lanes.slice(1)) {
      lane.host(topicHex).catch((err) => {
        console.warn('RacingTransport: дорожка не захостила код', lane.name, err)
      })
    }
    return topicHex
  }

  async host(topicHex: string): Promise<void> {
    this.topicHex = topicHex
    this.mode = 'host'
    await Promise.all(
      this.lanes.map((lane) =>
        lane.host(topicHex).catch((err) => {
          console.warn('RacingTransport: дорожка не захостила код', lane.name, err)
        })
      )
    )
  }

  async join(topicHex: string): Promise<void> {
    this.topicHex = topicHex
    this.mode = 'guest'
    await Promise.all(
      this.lanes.map((lane) =>
        lane.join(topicHex).catch((err) => {
          console.warn('RacingTransport: дорожка не подключилась', lane.name, err)
        })
      )
    )
  }

  broadcast(message: PeerControlMessage): void {
    for (const lane of this.active) lane.broadcast(message)
  }

  sendTo(peerKey: string, message: PeerControlMessage): void {
    for (const lane of this.active) lane.sendTo(peerKey, message)
  }

  getSession(peerKey: string): TransportSession | null {
    for (const lane of this.active) {
      const session = lane.getSession(peerKey)
      if (session) return session
    }
    return null
  }

  getHandshakeHash(peerKey: string): Uint8Array | null {
    return this.getSession(peerKey)?.handshakeHash ?? null
  }

  hasConnectedPeers(): boolean {
    return this.active.some((lane) => lane.hasConnectedPeers())
  }

  get sessions(): TransportSession[] {
    const all: TransportSession[] = []
    for (const lane of this.active) all.push(...lane.sessions)
    return all
  }

  get peerCount(): number {
    return this.active.reduce((sum, lane) => sum + lane.peerCount, 0)
  }

  async suspendTransport(): Promise<void> {
    this.winner = null
    await Promise.all(this.lanes.map((lane) => lane.suspendTransport()))
  }

  async endSession(): Promise<void> {
    this.winner = null
    this.topicHex = null
    this.mode = null
    await Promise.all(this.lanes.map((lane) => lane.endSession()))
  }

  async destroy(): Promise<void> {
    await Promise.all(this.lanes.map((lane) => lane.destroy()))
  }
}
