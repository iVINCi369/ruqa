import { useMemo, useState } from 'react'
import type { DeviceType, LanPeer, RememberedPeer } from '@ruqa/core'
import { inviteLanPeer, startSendSession } from '../transfer/commands'
import { useTransferStore } from '../transfer/store'
import type { Translate } from '../i18n'

export type NearbyInviteStatus = 'idle' | 'inviting' | 'sent' | 'declined' | 'timeout'

export interface NearbyDeviceRow {
  endpointId: string
  /** Имя из списка запомненных, если устройство знакомо; иначе из объявления. */
  name: string
  isKnown: boolean
  deviceType: DeviceType
  /** Как пойдёт передача — «в этой сети», интернет не нужен. */
  transportLabel: string
  status: NearbyInviteStatus
}

export interface NearbyDevices {
  devices: NearbyDeviceRow[]
  /** Ключи сопряжённых, которые сейчас видны рядом: их не надо звать через интернет. */
  nearbyPubkeys: Set<string>
  invite: (endpointId: string) => Promise<void>
}

function nameFor(
  peer: LanPeer,
  remembered: RememberedPeer | undefined,
  t: Translate
): { name: string; isKnown: boolean } {
  if (remembered?.displayName) return { name: remembered.displayName, isKnown: true }
  if (peer.displayName) return { name: peer.displayName, isKnown: false }
  // Сосед не представился — подпись рисуем здесь: в воркл ете локалей нет.
  return { name: t('common:labels.nearbyDevice'), isKnown: false }
}

export function useNearbyDevices(t: Translate): NearbyDevices {
  const lanPeers = useTransferStore((s) => s.lanPeers)
  const rememberedPeers = useTransferStore((s) => s.peers)
  const selectedFiles = useTransferStore((s) => s.selectedFiles)
  const [statuses, setStatuses] = useState<Record<string, NearbyInviteStatus>>({})

  const rememberedByKey = useMemo(() => {
    const map = new Map<string, RememberedPeer>()
    for (const peer of rememberedPeers) map.set(peer.remoteDevicePubkey, peer)
    return map
  }, [rememberedPeers])

  const devices = useMemo(() => {
    const transportLabel = t('common:labels.onThisNetwork')
    return (
      lanPeers
        .map((peer): NearbyDeviceRow => {
          const remembered = peer.devicePubkey ? rememberedByKey.get(peer.devicePubkey) : undefined
          const { name, isKnown } = nameFor(peer, remembered, t)
          return {
            endpointId: peer.endpointId,
            name,
            isKnown,
            deviceType: peer.deviceType,
            transportLabel,
            status: statuses[peer.endpointId] ?? 'idle'
          }
        })
        // Свои — выше: их узнают по имени, а чужие в списке просто шум.
        .sort((a, b) => {
          if (a.isKnown !== b.isKnown) return a.isKnown ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    )
  }, [lanPeers, rememberedByKey, statuses, t])

  const nearbyPubkeys = useMemo(
    () =>
      new Set(
        lanPeers
          .map((peer) => peer.devicePubkey)
          .filter((key): key is string => typeof key === 'string')
      ),
    [lanPeers]
  )

  const invite = async (endpointId: string) => {
    if (statuses[endpointId] === 'inviting') return
    setStatuses((s) => ({ ...s, [endpointId]: 'inviting' }))

    const fileOffers = selectedFiles.filter((file) => file.kind !== 'text')
    const textOffers = selectedFiles.filter((file) => file.kind === 'text')

    try {
      const topic = await startSendSession()
      const response = await inviteLanPeer(endpointId, topic, {
        fileCount: fileOffers.length,
        textCount: textOffers.length,
        totalSize: fileOffers.reduce((sum, file) => sum + (file.size ?? 0), 0)
      })
      setStatuses((s) => ({
        ...s,
        [endpointId]: response === 'accepted' ? 'sent' : response
      }))
    } catch {
      setStatuses((s) => ({ ...s, [endpointId]: 'declined' }))
    }
  }

  return { devices, nearbyPubkeys, invite }
}
