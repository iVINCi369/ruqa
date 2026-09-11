import { useState } from 'react'
import { Button, Tabs, TabsList, TabsTrigger } from '@ruqa/components'
import { QrCodeIcon } from '@ruqa/components/icons'
import { useTranslation } from '@ruqa/locales'
import {
  clearSenderFlow,
  continueShare,
  exceedsFileCountLimit,
  formatFileSize,
  formatItemsCount,
  getSendPageCopy,
  getSendStep,
  isShareStep,
  useTransferStore,
  type SendComposeMode
} from '@ruqa/domain'
import { NearbyPanel, TransferActionGroup, TransferCardFrame } from '../../components'
import { PreparingView } from './PreparingView'
import { SelectFilesView } from './SelectFilesView'
import { ShareView } from './ShareView'

export default function SendPage() {
  const { t } = useTranslation(['send', 'common'])
  const selectedFiles = useTransferStore((s) => s.selectedFiles)
  const draftPhase = useTransferStore((s) => s.draftPhase)
  const connectionState = useTransferStore((s) => s.connectionState)
  const [mode, setMode] = useState<SendComposeMode>('files')

  const step = getSendStep({ draftPhase, isPeerConnected: connectionState === 'peer-connected' })
  const copy = getSendPageCopy(t, step)
  const hasSelectedFiles = selectedFiles.length > 0
  const showTabs = !isShareStep(step) && step !== 'preparing'

  function renderView() {
    if (isShareStep(step)) {
      return <ShareView />
    }

    // Кто рядом — рядом с выбором файлов: на широком окне колонкой справа,
    // на узком уезжает под файлы. Код и QR остаются запасным путём для тех,
    // кого поблизости нет.
    return (
      <div className='flex h-full min-h-0 flex-col gap-6 min-[1040px]:flex-row min-[1040px]:gap-8'>
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <SelectFilesView mode={showTabs ? mode : 'files'} />
        </div>
        <NearbyPanel canSend={hasSelectedFiles} />
      </div>
    )
  }

  function renderFooter() {
    if (step === 'preparing') {
      return null
    }

    if (isShareStep(step)) {
      return (
        <TransferActionGroup>
          <Button onClick={clearSenderFlow} size='sm' variant='secondary'>
            {t('common:actions.endSession')}
          </Button>
        </TransferActionGroup>
      )
    }

    if (!hasSelectedFiles) {
      return null
    }

    const fileItems = selectedFiles.filter((file) => file.kind !== 'text')
    const textItems = selectedFiles.filter((file) => file.kind === 'text')
    const totalSize = fileItems.reduce((sum, file) => sum + (file.size ?? 0), 0)
    const countLabel = formatItemsCount(fileItems.length, textItems.length, t)
    const tooManyFiles = exceedsFileCountLimit(fileItems.length)

    return (
      <div className='flex items-center justify-between gap-4'>
        <div className='flex items-baseline gap-2'>
          <span className='text-[14.5px] font-semibold text-text-primary'>{countLabel}</span>
          {tooManyFiles && (
            <span className='text-[13px] text-danger'>{t('send:files.tooMany')}</span>
          )}
          {!tooManyFiles && totalSize > 0 && (
            <span className='text-[13px] text-text-faint'>{formatFileSize(totalSize)}</span>
          )}
        </div>
        <TransferActionGroup>
          <Button onClick={clearSenderFlow} size='sm' variant='ghost'>
            {t('common:actions.clear')}
          </Button>
          {/* Главный путь теперь список рядом: туда жмут по устройству. Код и
              QR остаются для тех, кого поблизости нет, и подпись это говорит. */}
          <Button
            disabled={tooManyFiles}
            onClick={() => void continueShare(selectedFiles)}
            size='sm'
            variant='primary'
            icon={<QrCodeIcon size={14} />}
          >
            {t('send:actions.showCode')}
          </Button>
        </TransferActionGroup>
      </div>
    )
  }

  if (step === 'preparing') {
    return <PreparingView />
  }

  const headerTabs = showTabs ? (
    <Tabs size='sm' value={mode} onValueChange={(value) => setMode(value as SendComposeMode)}>
      <TabsList>
        <TabsTrigger value='files'>{t('common:files.files')}</TabsTrigger>
        <TabsTrigger value='text'>{t('common:files.text')}</TabsTrigger>
      </TabsList>
    </Tabs>
  ) : undefined

  return (
    <TransferCardFrame
      description={isShareStep(step) ? copy.description : ''}
      footer={renderFooter()}
      headerRight={headerTabs}
      title={copy.title}
    >
      <div className='h-full overflow-y-auto overflow-x-hidden'>{renderView()}</div>
    </TransferCardFrame>
  )
}
