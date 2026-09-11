import { githubUrl, privacyPolicyUrl, sponsorUrl, termsOfServiceUrl, websiteUrl } from './links'

export type AboutLinkKey = 'website' | 'github' | 'sponsor' | 'privacy' | 'terms'

export interface AboutLink {
  key: AboutLinkKey
  labelKey: string
  url: string
}

export const aboutLinkGroups: AboutLink[][] = [
  [
    { key: 'website', labelKey: 'settings:rows.website', url: websiteUrl },
    { key: 'github', labelKey: 'settings:rows.github', url: githubUrl },
    { key: 'sponsor', labelKey: 'settings:rows.sponsor', url: sponsorUrl }
  ],
  [
    { key: 'privacy', labelKey: 'settings:rows.privacyPolicy', url: privacyPolicyUrl },
    { key: 'terms', labelKey: 'settings:rows.terms', url: termsOfServiceUrl }
  ]
]
