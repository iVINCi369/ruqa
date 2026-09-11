// Своего домена у Ruqa пока нет: ruqa.app не зарегистрирован. Всё, что реально
// существует, — репозиторий, его релизы и веб-клиент на Cloudflare Pages
// (проект ruqa-web из deploy-web.yml; адрес появится после первого деплоя).
// Когда домен появится, правится только этот файл.
export const githubUrl = 'https://github.com/iVINCi369/ruqa'
export const releasesUrl = 'https://github.com/iVINCi369/ruqa/releases/latest'
export const releasesApiUrl = 'https://api.github.com/repos/iVINCi369/ruqa/releases/latest'

export const websiteUrl = githubUrl
export const downloadUrl = releasesUrl
export const webAppUrl = 'https://ruqa-web.pages.dev'
export const sponsorUrl = 'https://github.com/sponsors/iVINCi369'
export const selfHostSetupUrl = 'https://github.com/iVINCi369/ruqa/blob/main/docs/architecture.md'

// TODO: адреса без хозяина. Бэкенда аккаунтов не существует — платный раздел
// не работает; документов и почты поддержки тоже нет. Не выкидываем только
// потому, что на них завязаны экран онбординга и платный экран.
export const accountApiUrl = 'https://api.ruqa.app'
export const privacyPolicyUrl = 'https://ruqa.app/privacy'
export const termsOfServiceUrl = 'https://ruqa.app/terms'
export const supportEmail = 'hello@ruqa.app'
