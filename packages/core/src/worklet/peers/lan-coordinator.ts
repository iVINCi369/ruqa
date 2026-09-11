import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { IrohBridge, type BridgeEvent } from '../transfer/iroh/bridge'
import type { DeviceIdentity, DeviceType } from '../identity/device-identity-store'
import { DEVICE_TYPES } from '../identity/device-type'
import {
  createLanInviteExpiredEvent,
  createLanInviteReceivedEvent,
  createLanPeersEvent,
  type TransferIPCMessage
} from '../rpc/events'
import { BadRequestError } from '../rpc/protocol'
import type { LanPeer } from './lan-peer'
import type { RememberedPeer } from './remembered-peer'

export type { LanPeer }

/**
 * Кому мы отвечаем на приглашения:
 *   off    — локальная сеть выключена, нас не видно и звать некому;
 *   paired — диалог открывают только уже сопряжённые устройства;
 *   all    — открыть может любой в этой сети.
 *
 * По умолчанию `paired`: в кафейном Wi-Fi открытый режим — это кнопка
 * «показать незнакомцу окно на моём экране».
 */
export type LanVisibility = 'off' | 'paired' | 'all'

/**
 * Соседи в локальной сети — то же, что AirDrop: список устройств рядом без
 * всякого кода и без предварительного сопряжения.
 *
 * Личность здесь отдельная от передачи: сайдкар держит постоянный Endpoint на
 * ключе устройства, а сессии передачи по-прежнему поднимают разовые. Иначе
 * устройство пропадало бы из списка между отправками.
 */

/** Имя сессии сайдкара; совпадает с `LAN_SESSION` в lan.rs. */
export const LAN_SESSION = 'lan'

/**
 * Ключ для iroh выводится из ключа устройства, а не берётся напрямую: один и
 * тот же секрет в двух разных протоколах — плохая идея, а разделение по метке
 * стоит один хеш.
 */
const LAN_IDENTITY_CONTEXT = b4a.from('ruqa-lan-identity-v1')

/** mDNS отдаёт не больше 245 байт полезной нагрузки — имя обрезаем заранее. */
const MAX_DISPLAY_NAME = 60

/** Сосед молчит дольше — считаем, что ушёл, даже если mDNS ещё не сказал. */
const PEER_TTL_MS = 90_000

/** Столько отказов подряд — и устройство замолкает само, без диалога. */
const DECLINES_BEFORE_MUTE = 2

/** Насколько замолкает. Перезапуск приложения счётчик тоже обнуляет. */
const MUTE_MS = 30 * 60_000

export interface LanDeps {
  deviceIdentityStore: { getOrCreate(): Promise<DeviceIdentity> }
  /** Нужен режиму `paired`: по нему решаем, свой это или чужой. */
  rememberedStore: { get(pubkeyHex: string): Promise<RememberedPeer | null> }
  irohBridgePort?: number
  emit: (event: TransferIPCMessage) => void
  now?: () => number
}

interface PendingInvite {
  endpointId: string
}

interface Advert {
  n?: unknown
  t?: unknown
  k?: unknown
}

function parseAdvert(raw: string | undefined): Advert | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Advert) : null
  } catch {
    return null
  }
}

function asDeviceType(value: unknown): DeviceType {
  return typeof value === 'string' && DEVICE_TYPES.has(value as DeviceType)
    ? (value as DeviceType)
    : 'desktop'
}

function asPubkey(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null
}

/** То, что соседи видят до всякого соединения. */
export function buildAdvert(identity: DeviceIdentity): string {
  return JSON.stringify({
    n: identity.displayName.slice(0, MAX_DISPLAY_NAME),
    t: identity.deviceType,
    k: b4a.toString(identity.publicKey, 'hex')
  })
}

export function deriveLanSecret(identity: DeviceIdentity): string {
  return b4a.toString(crypto.hash([LAN_IDENTITY_CONTEXT, identity.secretKey]), 'hex')
}

export class LanCoordinator {
  private readonly deps: LanDeps
  private readonly peers = new Map<string, LanPeer>()
  private bridge: IrohBridge | null = null
  private starting: Promise<void> | null = null
  private endpointId: string | null = null
  private sweeper: ReturnType<typeof setInterval> | null = null
  private visibility: LanVisibility = 'paired'
  /** requestId → кто позвал: без этого отказ не на кого записать. */
  private readonly pending = new Map<number, PendingInvite>()
  private readonly declines = new Map<string, number>()
  private readonly mutedUntil = new Map<string, number>()

  constructor(deps: LanDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** Свой endpointId — чтобы не показывать самого себя, если mDNS вернёт эхо. */
  ownEndpointId(): string | null {
    return this.endpointId
  }

  currentVisibility(): LanVisibility {
    return this.visibility
  }

  /** Смена режима: `off` гасит сессию целиком, остальные её поднимают. */
  async setVisibility(visibility: LanVisibility): Promise<void> {
    if (visibility !== 'off' && visibility !== 'paired' && visibility !== 'all') {
      throw new BadRequestError('setLanVisibility: unknown visibility')
    }
    if (this.visibility === visibility) {
      // Тот же режим — но при запуске приложения это первый вызов вообще,
      // и сессию всё равно надо поднять.
      if (visibility !== 'off') await this.start()
      return
    }
    this.visibility = visibility

    if (visibility === 'off') {
      await this.stop()
      this.publish()
      return
    }
    await this.start()
  }

  start(): Promise<void> {
    if (this.visibility === 'off') return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.doStart().catch((err) => {
      this.starting = null
      console.warn('LanCoordinator: start failed', err)
    })
    return this.starting
  }

  private async doStart(): Promise<void> {
    const port = this.deps.irohBridgePort
    if (!port) return
    if (this.bridge) return

    const identity = await this.deps.deviceIdentityStore.getOrCreate()
    const bridge = new IrohBridge(port, LAN_SESSION)
    await bridge.connectEvents()
    bridge.onEvent((event) => this.onBridgeEvent(event))
    this.bridge = bridge

    const reply = await bridge.request({
      op: 'lan-start',
      secret: deriveLanSecret(identity),
      userData: buildAdvert(identity)
    })
    this.endpointId = typeof reply.endpointId === 'string' ? reply.endpointId : null

    // mDNS сообщает об уходе не всегда — устройство могли просто унести.
    this.sweeper = setInterval(() => this.sweep(), PEER_TTL_MS / 3)
  }

  list(): LanPeer[] {
    return [...this.peers.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /** Позвать соседа. Возвращает его решение — ждать отдельного события не нужно. */
  async invite(
    endpointId: string,
    topic: string,
    counts: { fileCount?: number; textCount?: number; totalSize?: number } = {}
  ): Promise<{ response: 'accepted' | 'declined' | 'timeout' }> {
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      throw new BadRequestError('lanInvite: endpointId required')
    }
    if (typeof topic !== 'string' || topic.length === 0) {
      throw new BadRequestError('lanInvite: topic required')
    }
    await this.start()
    const bridge = this.bridge
    if (!bridge) throw new BadRequestError('lanInvite: локальная сеть выключена')

    const identity = await this.deps.deviceIdentityStore.getOrCreate()
    const peer = this.peers.get(endpointId)
    const reply = await bridge.request({
      op: 'lan-invite',
      endpointId,
      addrs: peer?.addrs ?? [],
      topic,
      displayName: identity.displayName.slice(0, MAX_DISPLAY_NAME),
      deviceType: identity.deviceType,
      ...counts
    })
    const response = reply.response
    return {
      response:
        response === 'accepted' || response === 'declined' || response === 'timeout'
          ? response
          : 'declined'
    }
  }

  async respond(requestId: number, response: 'accepted' | 'declined'): Promise<void> {
    if (!Number.isInteger(requestId)) {
      throw new BadRequestError('respondToLanInvite: requestId required')
    }
    const bridge = this.bridge
    if (!bridge) throw new BadRequestError('respondToLanInvite: локальная сеть выключена')

    const invite = this.pending.get(requestId)
    this.pending.delete(requestId)
    if (invite) {
      if (response === 'declined') this.noteDecline(invite.endpointId)
      else this.forgetDeclines(invite.endpointId)
    }

    await bridge.request({ op: 'lan-respond', requestId, response })
  }

  private noteDecline(endpointId: string): void {
    const count = (this.declines.get(endpointId) ?? 0) + 1
    this.declines.set(endpointId, count)
    if (count >= DECLINES_BEFORE_MUTE) {
      this.declines.delete(endpointId)
      this.mutedUntil.set(endpointId, this.now() + MUTE_MS)
    }
  }

  private forgetDeclines(endpointId: string): void {
    this.declines.delete(endpointId)
    this.mutedUntil.delete(endpointId)
  }

  private isMuted(endpointId: string): boolean {
    const until = this.mutedUntil.get(endpointId)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.mutedUntil.delete(endpointId)
    return false
  }

  async stop(): Promise<void> {
    this.starting = null
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    const bridge = this.bridge
    this.bridge = null
    this.endpointId = null
    this.peers.clear()
    this.pending.clear()
    if (!bridge) return
    try {
      await bridge.command({ op: 'lan-stop' })
    } catch (err) {
      console.warn('LanCoordinator: lan-stop failed', err)
    }
    bridge.close()
  }

  private onBridgeEvent(event: BridgeEvent): void {
    if (event.event === 'lan-peer') this.upsertPeer(event)
    else if (event.event === 'lan-peer-gone') this.dropPeer(event.endpointId)
    else if (event.event === 'lan-invite') void this.onInvite(event)
    else if (event.event === 'lan-invite-expired' && typeof event.requestId === 'number') {
      this.pending.delete(event.requestId)
      this.deps.emit(createLanInviteExpiredEvent(event.requestId))
    }
  }

  private upsertPeer(event: BridgeEvent): void {
    const endpointId = event.endpointId
    if (!endpointId || endpointId === this.endpointId) return
    const advert = parseAdvert(event.userData)
    // Подпись безымянному соседу рисует интерфейс: локалей в воркл ете нет.
    const displayName = typeof advert?.n === 'string' ? advert.n : ''

    this.peers.set(endpointId, {
      endpointId,
      displayName,
      deviceType: asDeviceType(advert?.t),
      devicePubkey: asPubkey(advert?.k),
      addrs: Array.isArray(event.addrs) ? event.addrs : [],
      lastSeenAt: this.now()
    })
    this.publish()
  }

  private dropPeer(endpointId: string | undefined): void {
    if (!endpointId) return
    if (this.peers.delete(endpointId)) this.publish()
  }

  private sweep(): void {
    const cutoff = this.now() - PEER_TTL_MS
    let changed = false
    for (const [id, peer] of this.peers) {
      if (peer.lastSeenAt < cutoff) {
        this.peers.delete(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  private async onInvite(event: BridgeEvent): Promise<void> {
    if (typeof event.requestId !== 'number' || !event.endpointId || !event.topic) return
    const known = this.peers.get(event.endpointId)
    const requestId = event.requestId
    const endpointId = event.endpointId
    const devicePubkey = known?.devicePubkey ?? null

    if (!(await this.mayAsk(endpointId, devicePubkey))) {
      // Молча отклоняем: показать диалог — значит дать чужому устройству
      // распоряжаться чужим экраном, а это и есть то, от чего мы защищаемся.
      await this.autoDecline(requestId)
      return
    }

    this.pending.set(requestId, { endpointId })
    this.deps.emit(
      createLanInviteReceivedEvent({
        requestId,
        endpointId,
        // Имя из mDNS честнее того, что прислали в приглашении: его видно всем
        // в сети, а значит, подмена сразу заметна.
        displayName: known?.displayName ?? event.displayName ?? '',
        deviceType: known?.deviceType ?? asDeviceType(event.deviceType),
        devicePubkey,
        topic: event.topic,
        ...(typeof event.fileCount === 'number' ? { fileCount: event.fileCount } : {}),
        ...(typeof event.textCount === 'number' ? { textCount: event.textCount } : {}),
        ...(typeof event.totalSize === 'number' ? { totalSize: event.totalSize } : {})
      })
    )
  }

  /** Пускать ли этого соседа к диалогу — единственное место, где это решается. */
  private async mayAsk(endpointId: string, devicePubkey: string | null): Promise<boolean> {
    if (this.visibility === 'off') return false
    if (this.isMuted(endpointId)) return false

    // Заблокированное устройство не спрашивает ни в каком режиме.
    const remembered = devicePubkey ? await this.safeRemembered(devicePubkey) : null
    if (remembered?.blocked) return false

    if (this.visibility === 'all') return true
    return remembered !== null
  }

  private async safeRemembered(devicePubkey: string): Promise<RememberedPeer | null> {
    try {
      return await this.deps.rememberedStore.get(devicePubkey)
    } catch (err) {
      // База не открылась — считаем устройство незнакомым: в режиме `paired`
      // это отказ, что безопаснее случайного разрешения.
      console.warn('LanCoordinator: remembered lookup failed', err)
      return null
    }
  }

  private async autoDecline(requestId: number): Promise<void> {
    const bridge = this.bridge
    if (!bridge) return
    try {
      await bridge.request({ op: 'lan-respond', requestId, response: 'declined' })
    } catch (err) {
      console.warn('LanCoordinator: auto-decline failed', err)
    }
  }

  private publish(): void {
    this.deps.emit(createLanPeersEvent(this.list()))
  }
}
