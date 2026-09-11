import type { DeviceType } from '../identity/device-type'

/** Устройство, найденное в локальной сети по mDNS. */
export interface LanPeer {
  endpointId: string
  displayName: string
  deviceType: DeviceType
  /**
   * Ключ устройства в терминах сопряжения. Есть у всех своих; по нему сосед
   * сверяется со списком запомненных, чтобы показать привычное имя.
   */
  devicePubkey: string | null
  addrs: string[]
  lastSeenAt: number
}
