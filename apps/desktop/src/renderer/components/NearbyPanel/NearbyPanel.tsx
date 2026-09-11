import { Button, WaitingRadar, useTheme } from '@ruqa/components'
import { SendIcon, WifiIcon, deviceIcon } from '@ruqa/components/icons'
import { useTranslation } from '@ruqa/locales'
import { useNearbyDevices, useTransferStore, type NearbyInviteStatus } from '@ruqa/domain'

/**
 * Кто рядом прямо сейчас. Список, а не круговой радар: десяток устройств в
 * общей сети превращает картинку в кашу, а строка несёт и имя, и способ связи.
 */
export function NearbyPanel({ canSend }: { canSend: boolean }) {
  const { t } = useTranslation(['send', 'common'])
  const { theme } = useTheme()
  const c = theme.colors
  const visibility = useTransferStore((s) => s.lanVisibility)
  const { devices, invite } = useNearbyDevices(t)

  const statusText = (status: NearbyInviteStatus): string | null => {
    if (status === 'sent') return t('send:nearby.accepted')
    if (status === 'declined') return t('send:nearby.declined')
    if (status === 'timeout') return t('send:nearby.noAnswer')
    return null
  }

  return (
    <aside className='flex w-full shrink-0 flex-col gap-3 min-[1040px]:w-[260px]'>
      <div className='flex items-baseline justify-between'>
        <h3 className='m-0 text-[13px] font-semibold uppercase tracking-wide text-text-muted'>
          {t('send:nearby.title')}
        </h3>
        {devices.length > 0 && (
          <span className='text-[12px] tabular-nums text-text-faint'>{devices.length}</span>
        )}
      </div>

      {visibility === 'off' ? (
        <p className='m-0 text-[13px] leading-snug text-text-faint'>{t('send:nearby.off')}</p>
      ) : devices.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-6 text-center'>
          <WaitingRadar
            icon={<WifiIcon size={18} color={c.colorInfo} />}
            color={c.colorInfo}
            pulsing
            size={88}
          />
          <p className='m-0 text-[13px] leading-snug text-text-faint'>
            {t('send:nearby.searching')}
          </p>
        </div>
      ) : (
        <ul className='m-0 flex list-none flex-col gap-1 p-0'>
          {devices.map((device) => {
            const Icon = deviceIcon(device.deviceType)
            const status = statusText(device.status)
            return (
              <li
                key={device.endpointId}
                className='flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-surface-secondary'
              >
                <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-primary'>
                  <Icon size={16} color={c.colorTextMuted} />
                </div>
                <div className='min-w-0 flex-1'>
                  <p className='m-0 truncate text-[13px] font-medium text-text-primary'>
                    {device.name}
                  </p>
                  <p className='m-0 truncate text-[11.5px] text-text-faint'>
                    {status ?? device.transportLabel}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='ghost'
                  iconOnly
                  aria-label={t('common:labels.send')}
                  tooltip={canSend ? t('common:labels.send') : t('send:nearby.selectFirst')}
                  disabled={!canSend || device.status === 'inviting'}
                  onClick={() => void invite(device.endpointId)}
                  icon={<SendIcon size={15} />}
                />
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
