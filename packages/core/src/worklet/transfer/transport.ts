import type { DriveChannel } from '@ruqa/drive'
import type { PeerControlMessage } from './control-channel'

export type ConnectionType = 'direct' | 'relay'

/** Минимум, который оркестратору нужен от соединения с пиром. */
export interface TransportSocket {
  destroy(err?: Error): void
}

/** Канал чанков поверх соединения: у hyperswarm это Protomux, у iroh — QUIC-стримы. */
export interface PeerDriveLike {
  readonly supported: Promise<boolean>
  session(fileId: string): DriveChannel
  serve(fileId: string, name: string, localPath: string | null): Promise<void>
  cancel(): void
  destroy(): void
}

export interface ControlChannelLike {
  send(message: PeerControlMessage): void
}

export interface TransportSession {
  socket: TransportSocket
  peerKey: string
  controlChannel: ControlChannelLike
  handshakeHash: Uint8Array | null
  drive: PeerDriveLike | null
}

export interface TransferTransportCallbacks {
  onPeerConnected: (session: TransportSession) => void
  onPeerDisconnected: (peerKey: string | null, remainingCount: number) => void
  onControlMessage: (message: PeerControlMessage, session: TransportSession) => void
  onConnectionType?: (peerKey: string, connectionType: ConnectionType) => void
}

/**
 * Транспорт передачи. `TransferSwarm` (hyperswarm) и `IrohTransport` реализуют
 * один и тот же интерфейс, `RacingTransport` их составляет.
 */
export interface TransferTransport {
  readonly name: string

  /**
   * Сгенерировать новый join-код и начать его хостить.
   *
   * Асинхронно, потому что у iroh код — это публичный ключ хоста, а он
   * известен только после подъёма Endpoint'а. Hyperswarm отдаёт случайный
   * код сразу, но интерфейс один на всех.
   */
  generateKey(): Promise<string>
  /**
   * Начать хостить уже известный код. Нужно, когда код общий для нескольких
   * транспортов (его сгенерировала другая дорожка) и при перезапуске после
   * обрыва — личность хоста при этом обязана остаться прежней.
   */
  host(topicHex: string): Promise<void>
  /** Подключиться к чужому коду. */
  join(topicHex: string): Promise<void>

  broadcast(message: PeerControlMessage): void
  sendTo(peerKey: string, message: PeerControlMessage): void
  getSession(peerKey: string): TransportSession | null
  getHandshakeHash(peerKey: string): Uint8Array | null
  hasConnectedPeers(): boolean
  readonly sessions: TransportSession[]
  readonly peerCount: number

  suspendTransport(): Promise<void>
  endSession(): Promise<void>
  destroy(): Promise<void>
}
