import { useMemo, useState } from 'react'
import { LinkCard, RadioGroup, RelaySettingsCard } from '@ruqa/components'
import type { LanVisibility } from '@ruqa/core'
import { useTranslation } from '@ruqa/locales'
import {
  applyLanVisibility,
  relayErrorText,
  relaySettingsLabels,
  relayTestText,
  selfHostSetupUrl,
  useRelaySettings
} from '@ruqa/domain'
import { bridgeApi } from '../../../api/bridgeApi'
import { relayStoragePort } from '../../../lifecycle/relayStorage'
import { getLanVisibility, saveLanVisibility } from '../../../lifecycle/lanVisibilityStorage'
import { SectionShell } from './SectionShell'

export function ConnectionSection() {
  const { t } = useTranslation(['settings'])
  const form = useRelaySettings({
    storage: relayStoragePort,
    send: (input) => bridgeApi.worker.setRelayConfig(input),
    testConnection: () => bridgeApi.worker.testCustomRelay()
  })

  const labels = useMemo(() => relaySettingsLabels(t), [t])
  const [lanVisibility, setLanVisibility] = useState<LanVisibility>(getLanVisibility)

  const lanOptions = useMemo(
    () =>
      [
        { value: 'off', label: t('settings:lan.off'), description: t('settings:lan.offHint') },
        {
          value: 'paired',
          label: t('settings:lan.paired'),
          description: t('settings:lan.pairedHint')
        },
        { value: 'all', label: t('settings:lan.all'), description: t('settings:lan.allHint') }
      ] as const,
    [t]
  )

  const changeLanVisibility = (visibility: LanVisibility) => {
    setLanVisibility(visibility)
    saveLanVisibility(visibility)
    void applyLanVisibility(visibility)
  }

  return (
    <SectionShell title={t('settings:rows.connection')}>
      <div className='mb-5 flex flex-col gap-2.5'>
        <h3 className='m-0 text-[16px] font-semibold text-text-primary'>
          {t('settings:lan.title')}
        </h3>
        <LinkCard>
          <RadioGroup
            options={lanOptions}
            value={lanVisibility}
            onChange={changeLanVisibility}
            aria-label={t('settings:lan.title')}
          />
        </LinkCard>
      </div>

      <RelaySettingsCard
        form={form}
        labels={labels}
        errorText={relayErrorText(t, form.error)}
        successText={relayTestText(t, form.testState, form.testMs)}
        onOpenSetupGuide={() => {
          bridgeApi.openExternalUrl(selfHostSetupUrl).catch((err: unknown) => {
            console.warn('[relay] could not open setup guide', err)
          })
        }}
      />
    </SectionShell>
  )
}
