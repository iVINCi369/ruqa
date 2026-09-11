import { Image, Linking, StyleSheet, View } from 'react-native'
import Constants from 'expo-constants'
import { MenuGroup, MenuItem, useTheme } from '@ruqa/components'
import {
  ArrowUpRightIcon,
  FileTextIcon,
  GithubIcon,
  GlobeIcon,
  HeartIcon,
  LockIcon
} from '@ruqa/components/icons'
import type { IconComponent } from '@ruqa/components/icons'
import { aboutLinkGroups, type AboutLinkKey } from '@ruqa/domain'
import { useTranslation } from '@ruqa/locales'
import { Layout } from '@/src/components'
import { Text } from '@/src/components/ThemedText'
import brandLogo from '@/assets/images/brand-logo.png'

const linkIcons: Record<AboutLinkKey, IconComponent> = {
  website: GlobeIcon,
  github: GithubIcon,
  sponsor: HeartIcon,
  privacy: LockIcon,
  terms: FileTextIcon
}

export default function AboutScreen() {
  const { t } = useTranslation(['settings', 'common'])
  const { theme } = useTheme()
  const c = theme.colors
  const version = Constants.expoConfig?.version ?? '0.0.0'

  const openUrl = (url: string) => {
    Linking.openURL(url).catch((error: unknown) => {
      console.error('Failed to open external url', error)
    })
  }

  return (
    <Layout hasNativeHeader>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Image source={brandLogo} style={styles.brandLogo} resizeMode='contain' />
          <Text style={[styles.brandName, { color: c.colorTextPrimary }]}>Ruqa</Text>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: c.colorBackgroundSubtle, borderColor: c.colorBorderPrimary }
          ]}
        >
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: c.colorTextPrimary }]}>
              {t('common:labels.version')}
            </Text>
            <Text style={[styles.infoValue, { color: c.colorTextMuted }]}>v{version}</Text>
          </View>
        </View>

        {aboutLinkGroups.map((group) => (
          <MenuGroup key={group[0].key}>
            {group.map(({ key, labelKey, url }, index) => {
              const Icon = linkIcons[key]
              return (
                <MenuItem
                  key={key}
                  label={t(labelKey)}
                  icon={<Icon size={19} color={c.colorTextSecondary} />}
                  trailing={<ArrowUpRightIcon size={15} color={c.colorTextMuted} />}
                  onPress={() => openUrl(url)}
                  isLast={index === group.length - 1}
                />
              )
            })}
          </MenuGroup>
        ))}

        <Text style={[styles.footer, { color: c.colorTextFaint }]}>
          © {new Date().getFullYear()} Ruqa
        </Text>
      </View>
    </Layout>
  )
}

const styles = StyleSheet.create({
  content: {
    gap: 20
  },
  brand: {
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingBottom: 4
  },
  brandLogo: {
    width: 60,
    height: 60,
    marginBottom: 4
  },
  brandName: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700'
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    paddingHorizontal: 16
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    gap: 12
  },
  infoLabel: {
    fontSize: 15,
    fontWeight: '500'
  },
  infoValue: {
    fontSize: 15
  },
  footer: {
    fontSize: 12,
    textAlign: 'center',
    paddingTop: 4
  }
})
