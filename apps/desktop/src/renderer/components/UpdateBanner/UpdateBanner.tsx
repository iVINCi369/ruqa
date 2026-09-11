import { useState } from 'react'
import { Button, Modal } from '@ruqa/components'
import { useTranslation } from '@ruqa/locales'
import { releasesUrl } from '@ruqa/domain'
import { bridgeApi } from '../../api/bridgeApi'
import updateSvg from '../../../../../../assets/update.svg'

interface UpdateBannerProps {
  // OTA доложили, что новая сборка уже скачана — остаётся перезапустить.
  ready: boolean
  // Проверка релизов нашла версию новее собранной — ведём на страницу релизов.
  available?: boolean
  onDismissAvailable?: () => void
}

export function UpdateBanner({ ready, available = false, onDismissAvailable }: UpdateBannerProps) {
  const { t } = useTranslation(['common'])
  const [dismissed, setDismissed] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)

  const restart = async () => {
    setRestartFailed(false)
    try {
      await bridgeApi.appRestart()
    } catch (err) {
      console.error('Failed to restart for update', err)
      setRestartFailed(true)
    }
  }

  const openReleases = () => {
    dismissAvailable()
    bridgeApi.openExternalUrl(releasesUrl).catch((err: unknown) => {
      console.error('Failed to open releases page', err)
    })
  }

  const dismissAvailable = () => {
    setDismissed(true)
    onDismissAvailable?.()
  }

  // Готовое OTA-обновление важнее найденного релиза: показываем что-то одно.
  const mode = ready ? 'ready' : available ? 'available' : null

  return (
    <Modal
      closeLabel={t('common:actions.close')}
      open={mode !== null && !dismissed}
      size='sm'
      onClose={() => (mode === 'available' ? dismissAvailable() : setDismissed(true))}
    >
      <div className='flex flex-col items-center px-6 pb-1 pt-6 text-center'>
        <img src={updateSvg} alt='' aria-hidden className='mb-4 w-[168px]' />
        <h2 className='m-0 text-[20px] font-bold text-text-primary'>
          {mode === 'available' ? t('common:update.available') : t('common:update.ready')}
        </h2>
        <p className='m-0 mt-2 max-w-[320px] text-[14px] leading-relaxed text-text-muted'>
          {t('common:update.description')}
        </p>
        {restartFailed && (
          <p className='m-0 mt-3 text-[13px] text-danger'>{t('common:update.restartFailed')}</p>
        )}
      </div>

      <div className='flex flex-col gap-2 px-6 pb-6 pt-5'>
        {mode === 'available' ? (
          <Button variant='primary' size='md' width='full' onClick={openReleases}>
            {t('common:update.updateNow')}
          </Button>
        ) : (
          <Button variant='primary' size='md' width='full' onClick={() => void restart()}>
            {t('common:update.restart')}
          </Button>
        )}
        <Button
          variant='ghost'
          size='md'
          width='full'
          onClick={() => (mode === 'available' ? dismissAvailable() : setDismissed(true))}
        >
          {t('common:update.notNow')}
        </Button>
      </div>
    </Modal>
  )
}
