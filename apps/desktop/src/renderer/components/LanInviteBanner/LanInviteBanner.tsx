import {
  acceptLanInvite,
  declineLanInvite,
  formatFileSize,
  formatItemsCount,
  useTransferStore
} from '@ruqa/domain'
import { useTranslation } from '@ruqa/locales'
import { Button } from '@ruqa/components'
import { CheckIcon, CloseIcon, WifiIcon, deviceIcon } from '@ruqa/components/icons'
import { zLayer } from '../../zLayer'

/**
 * Приглашение от соседа по локальной сети. В отличие от сопряжённых устройств
 * автоприёма здесь нет и быть не должно: сосед не проходил сопряжения, и
 * единственная защита — то, что человек смотрит на этот диалог.
 */
export function LanInviteBanner() {
  const { t } = useTranslation(['common'])
  const invite = useTransferStore((s) => s.lanInvite)

  if (!invite) return null

  const Icon = deviceIcon(invite.deviceType)
  const fileCount = invite.fileCount ?? 0
  const textCount = invite.textCount ?? 0
  const hasCounts = fileCount > 0 || textCount > 0

  const fileLabel = hasCounts
    ? formatItemsCount(fileCount, textCount, t)
    : t('common:files.filesGeneric')
  const sizeLabel =
    fileCount > 0 && invite.totalSize != null ? ` · ${formatFileSize(invite.totalSize)}` : ''

  return (
    <div
      className='fixed inset-0 flex justify-center pt-4'
      style={{
        zIndex: zLayer.interrupt,
        backgroundColor: 'color-mix(in oklab, var(--as-color-scrim) 25%, transparent)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        animation: 'as-fade-in 180ms ease-out'
      }}
    >
      <div
        className='pointer-events-auto flex h-fit w-[280px] flex-col items-center gap-4 rounded-2xl border border-border-primary bg-background px-5 py-6 shadow-[0_8px_32px_color-mix(in_oklab,var(--as-color-scrim)_40%,transparent)]'
        style={{ animation: 'as-scale-in 200ms cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-surface-secondary'>
          <Icon size={22} />
        </div>

        <div className='text-center'>
          <p className='m-0 text-[14px] font-semibold leading-snug text-text-primary'>
            {invite.displayName || t('common:labels.nearbyDevice')}
          </p>
          <p className='m-0 mt-0.5 text-[12px] leading-snug text-text-secondary'>
            {t('common:status.wantsToSend', { label: fileLabel, size: sizeLabel })}
          </p>
          <p className='m-0 mt-2 flex items-center justify-center gap-1 text-[11px] leading-snug text-text-faint'>
            <WifiIcon size={12} />
            {t('common:labels.onThisNetwork')}
          </p>
        </div>

        <div className='flex w-full gap-2'>
          <Button
            icon={<CloseIcon size={12} />}
            onClick={() => declineLanInvite(invite)}
            pill
            size='sm'
            variant='danger'
            width='full'
          >
            {t('common:actions.decline')}
          </Button>
          <Button
            icon={<CheckIcon size={12} />}
            onClick={() => {
              acceptLanInvite(invite).catch((error) =>
                console.error('LanInviteBanner: acceptLanInvite failed', error)
              )
            }}
            pill
            size='sm'
            variant='success'
            width='full'
          >
            {t('common:actions.accept')}
          </Button>
        </div>
      </div>
    </div>
  )
}
