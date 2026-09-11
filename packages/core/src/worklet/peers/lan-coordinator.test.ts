import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'hypercore-crypto'
import type { BridgeEvent } from '../transfer/iroh/bridge'
import type { DeviceIdentity } from '../identity/device-identity-store'
import type { RememberedPeer } from './remembered-peer'
import type { TransferIPCMessage } from '../rpc/events'

interface BridgeRequest {
  op: string
  requestId?: number
  response?: string
  [key: string]: unknown
}

const requests: BridgeRequest[] = []
let emitBridgeEvent: (event: BridgeEvent) => void = () => {}

vi.mock('../transfer/iroh/bridge', () => ({
  IrohBridge: class {
    connectEvents(): Promise<void> {
      return Promise.resolve()
    }
    onEvent(cb: (event: BridgeEvent) => void): void {
      emitBridgeEvent = cb
    }
    request(payload: BridgeRequest): Promise<Record<string, unknown>> {
      requests.push(payload)
      return Promise.resolve(payload.op === 'lan-start' ? { endpointId: 'self' } : {})
    }
    command(): Promise<void> {
      return Promise.resolve()
    }
    close(): void {}
  }
}))

const { LanCoordinator } = await import('./lan-coordinator')

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeIdentity(): DeviceIdentity {
  const kp = crypto.keyPair()
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    displayName: 'Mine',
    deviceType: 'laptop',
    createdAt: 0
  }
}

function remembered(pubkey: string, overrides: Partial<RememberedPeer> = {}): RememberedPeer {
  return {
    remoteDevicePubkey: pubkey,
    rendezvousTopic: 'a'.repeat(64),
    displayName: 'Known',
    deviceType: 'phone',
    isMine: false,
    autoAccept: false,
    blocked: false,
    pairedAt: 0,
    lastSeenAt: 0,
    ...overrides
  }
}

const STRANGER = 'b'.repeat(64)
const FRIEND = 'c'.repeat(64)

function setup(known: Record<string, RememberedPeer> = {}) {
  const events: TransferIPCMessage[] = []
  const coordinator = new LanCoordinator({
    deviceIdentityStore: { getOrCreate: () => Promise.resolve(makeIdentity()) },
    rememberedStore: { get: (key: string) => Promise.resolve(known[key] ?? null) },
    irohBridgePort: 7777,
    emit: (event) => events.push(event)
  })
  return { coordinator, events }
}

/** Сосед объявился по mDNS, потом позвал. */
async function announceAndInvite(endpointId: string, devicePubkey: string, requestId: number) {
  emitBridgeEvent({
    event: 'lan-peer',
    endpointId,
    userData: JSON.stringify({ n: 'Peer', t: 'phone', k: devicePubkey }),
    addrs: []
  } as unknown as BridgeEvent)
  emitBridgeEvent({
    event: 'lan-invite',
    requestId,
    endpointId,
    topic: 'd'.repeat(64)
  } as unknown as BridgeEvent)
  await flush()
}

const declinesOf = (endpointRequestId: number) =>
  requests.filter((r) => r.op === 'lan-respond' && r.requestId === endpointRequestId)

describe('LanCoordinator: видимость', () => {
  beforeEach(() => {
    requests.length = 0
  })

  it('в режиме paired незнакомец не доходит до диалога', async () => {
    const { coordinator, events } = setup()
    await coordinator.start()

    await announceAndInvite('stranger', STRANGER, 1)

    expect(events.some((e) => e.type === 'lan-invite-received')).toBe(false)
    expect(declinesOf(1)).toEqual([{ op: 'lan-respond', requestId: 1, response: 'declined' }])
  })

  it('в режиме paired сопряжённое устройство спрашивает', async () => {
    const { coordinator, events } = setup({ [FRIEND]: remembered(FRIEND) })
    await coordinator.start()

    await announceAndInvite('friend', FRIEND, 2)

    expect(events.some((e) => e.type === 'lan-invite-received')).toBe(true)
    expect(declinesOf(2)).toEqual([])
  })

  it('в режиме all спрашивает любой', async () => {
    const { coordinator, events } = setup()
    await coordinator.setVisibility('all')

    await announceAndInvite('stranger', STRANGER, 3)

    expect(events.some((e) => e.type === 'lan-invite-received')).toBe(true)
  })

  it('заблокированное устройство не спрашивает даже в режиме all', async () => {
    const { coordinator, events } = setup({ [FRIEND]: remembered(FRIEND, { blocked: true }) })
    await coordinator.setVisibility('all')

    await announceAndInvite('friend', FRIEND, 4)

    expect(events.some((e) => e.type === 'lan-invite-received')).toBe(false)
    expect(declinesOf(4)).toHaveLength(1)
  })

  it('выключенная локальная сеть гасит сессию и очищает список', async () => {
    const { coordinator, events } = setup()
    await coordinator.start()
    emitBridgeEvent({
      event: 'lan-peer',
      endpointId: 'someone',
      userData: JSON.stringify({ n: 'Peer', t: 'phone', k: STRANGER }),
      addrs: []
    } as unknown as BridgeEvent)

    expect(coordinator.list()).toHaveLength(1)

    await coordinator.setVisibility('off')

    expect(coordinator.list()).toHaveLength(0)
    expect(coordinator.currentVisibility()).toBe('off')
    const last = events.at(-1)
    expect(last?.type).toBe('lan-peers')
  })
})

describe('LanCoordinator: блокировка после отказов', () => {
  beforeEach(() => {
    requests.length = 0
  })

  it('после двух отказов сосед перестаёт спрашивать', async () => {
    const { coordinator, events } = setup()
    await coordinator.setVisibility('all')

    await announceAndInvite('pest', STRANGER, 10)
    await coordinator.respond(10, 'declined')
    await announceAndInvite('pest', STRANGER, 11)
    await coordinator.respond(11, 'declined')

    const before = events.filter((e) => e.type === 'lan-invite-received').length
    await announceAndInvite('pest', STRANGER, 12)
    const after = events.filter((e) => e.type === 'lan-invite-received').length

    expect(before).toBe(2)
    expect(after).toBe(2)
    expect(declinesOf(12)).toHaveLength(1)
  })

  it('согласие обнуляет счётчик отказов', async () => {
    const { coordinator, events } = setup()
    await coordinator.setVisibility('all')

    await announceAndInvite('guest', STRANGER, 20)
    await coordinator.respond(20, 'declined')
    await announceAndInvite('guest', STRANGER, 21)
    await coordinator.respond(21, 'accepted')
    await announceAndInvite('guest', STRANGER, 22)
    await coordinator.respond(22, 'declined')
    await announceAndInvite('guest', STRANGER, 23)

    expect(events.filter((e) => e.type === 'lan-invite-received')).toHaveLength(4)
  })
})
