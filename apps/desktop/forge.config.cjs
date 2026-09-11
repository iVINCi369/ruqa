const fs = require('fs')
const path = require('path')
const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name
const { isWindows } = require('which-runtime')

/**
 * makeappx.exe из Windows SDK. Каталог версии в Windows Kits сам по себе ничего
 * не значит: остовы от старых SDK лежат годами пустыми, а MSIX-макер, получив
 * версию без тулинга, валит весь make — вместе с уже собранными Setup.exe и zip.
 * Поэтому версию возвращаем только если makeappx на месте.
 */
function getWindowsKitVersion() {
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    'C:\\Program Files (x86)',
    'C:\\Program Files'
  ].filter(Boolean)

  for (const root of roots) {
    const binDir = path.join(root, 'Windows Kits', '10', 'bin')
    let versions = []
    try {
      versions = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .reverse()
    } catch {
      continue
    }
    for (const version of versions) {
      if (fs.existsSync(path.join(binDir, version, 'x64', 'makeappx.exe'))) return version
    }
  }
  return undefined
}

/** Без сертификата maker-msix выписывает временный через pwsh.exe (PowerShell 7). */
function hasPwsh() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => fs.existsSync(path.join(dir, 'pwsh.exe')))
}

const windowsKitVersion = isWindows ? getWindowsKitVersion() : undefined
const canMakeMsix = Boolean(
  windowsKitVersion && (process.env.WINDOWS_CERTIFICATE_FILE || hasPwsh())
)
if (isWindows && !canMakeMsix) {
  console.warn(
    windowsKitVersion
      ? 'forge: нет ни сертификата (WINDOWS_CERTIFICATE_FILE), ни pwsh.exe — MSIX пропускаем, будут Setup.exe и zip'
      : 'forge: Windows SDK (makeappx.exe) не найден — MSIX пропускаем, будут Setup.exe и zip'
  )
}

async function prunePrebuilds(outputPath, platform, arch) {
  let appRoot
  if (platform === 'darwin') {
    let entries = []
    try {
      entries = await fs.promises.readdir(outputPath, { withFileTypes: true })
    } catch {}
    const appEntry = entries.find((e) => e.isDirectory() && e.name.endsWith('.app'))
    if (!appEntry) {
      console.warn(`prunePrebuilds: no .app found in ${outputPath}`)
      return
    }
    appRoot = path.join(outputPath, appEntry.name, 'Contents', 'Resources', 'app')
  } else {
    appRoot = path.join(outputPath, 'resources', 'app')
  }

  if (!fs.existsSync(path.join(appRoot, 'node_modules'))) {
    console.warn(`prunePrebuilds: node_modules not found at ${appRoot}`)
    return
  }

  const target = `${platform}-${arch}`
  const stats = { kept: 0, removed: 0, bytes: 0 }
  await pruneTree(appRoot, target, stats)

  const mb = (stats.bytes / (1024 * 1024)).toFixed(1)
  console.log(
    `prunePrebuilds: pruned ${stats.removed} dirs, kept ${stats.kept} matching '${target}'/-universal, freed ~${mb} MB`
  )
}

async function pruneTree(base, target, stats) {
  await pruneOneLevel(path.join(base, 'prebuilds'), target, stats)
  let entries = []
  try {
    entries = await fs.promises.readdir(path.join(base, 'node_modules'), { withFileTypes: true })
  } catch {}
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return
      const full = path.join(base, 'node_modules', entry.name)
      if (entry.name.startsWith('@')) {
        let subs = []
        try {
          subs = await fs.promises.readdir(full, { withFileTypes: true })
        } catch {}
        await Promise.all(
          subs.map((sub) =>
            sub.isDirectory() ? pruneTree(path.join(full, sub.name), target, stats) : null
          )
        )
      } else {
        await pruneTree(full, target, stats)
      }
    })
  )
}

async function pruneOneLevel(dir, target, stats) {
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === target || entry.name.endsWith('-universal')) {
      stats.kept++
      continue
    }
    const full = path.join(dir, entry.name)
    stats.bytes += await dirSize(full)
    await fs.promises.rm(full, { recursive: true, force: true })
    stats.removed++
  }
}

async function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      const full = path.join(d, e.name)
      try {
        if (e.isDirectory()) stack.push(full)
        else {
          const s = await fs.promises.stat(full)
          total += (s.blocks ?? 0) * 512 || s.size
        }
      } catch {}
    }
  }
  return total
}

/**
 * Сайдкар второго транспорта. В упакованном приложении его ищут в
 * `process.resourcesPath` — без этой копии iroh в сборке мёртв целиком:
 * ни соседей по локальной сети, ни второго транспорта.
 *
 * Путь можно задать через IROH_BRIDGE_BIN (в CI бинарник кладут отдельно для
 * каждой платформы). Файла нет — собираем без него, но громко предупреждаем.
 */
function irohBridgeResource() {
  const fromEnv = process.env.IROH_BRIDGE_BIN
  const binary = isWindows ? 'iroh-bridge.exe' : 'iroh-bridge'
  const candidate =
    fromEnv || path.join(__dirname, '../../native/iroh-bridge/target/release', binary)

  if (fs.existsSync(candidate)) return [candidate]

  console.warn(
    `forge: сайдкар не найден по пути ${candidate} — в сборке не будет ни соседей, ни iroh-транспорта`
  )
  return []
}

/**
 * Packager копирует apps/desktop как есть и не умеет в hoisting npm workspaces,
 * поэтому перед сборкой зеркалим корневой node_modules ссылками, а после —
 * снимаем их. Список пишем на диск: если forge упадёт, следующий запуск
 * подчистит хвост сам (иначе ссылки копятся сотнями).
 */
const SYMLINK_MANIFEST = path.join(__dirname, 'out', '.forge-symlinks.json')

function removeLink(target) {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return
  } catch {
    return
  }
  // на Windows симлинк на папку снимается только rmdir, unlink даёт EPERM
  try {
    fs.unlinkSync(target)
  } catch {
    try {
      fs.rmdirSync(target)
    } catch {}
  }
}

function cleanupForgeSymlinks() {
  let manifest = { links: [], dirs: [] }
  try {
    manifest = JSON.parse(fs.readFileSync(SYMLINK_MANIFEST, 'utf-8'))
  } catch {}
  for (const link of manifest.links ?? []) removeLink(link)
  for (const dir of manifest.dirs ?? []) {
    try {
      fs.rmdirSync(dir)
    } catch {}
  }
  try {
    fs.rmSync(SYMLINK_MANIFEST, { force: true })
  } catch {}
}

let packagerConfig = {
  icon: path.join(__dirname, 'build/icon'),
  extraResource: irohBridgeResource(),
  protocols: [{ name: appName, schemes: ['ruqa'] }],
  extendInfo: {
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'All files',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.item']
      }
    ]
  },
  derefSymlinks: true,
  ignore: [
    // npm заводит симлинк на каждый пакет workspace, включая сам apps/desktop:
    // node_modules/@ruqa/desktop указывает на корень приложения. Вместе с
    // derefSymlinks это бесконечная рекурсия при копировании — packager молча
    // умирает на «Finalizing package», не оставив ни ошибки, ни папки out.
    // Соседние приложения в десктопной сборке тоже не нужны.
    /(^|\/)node_modules\/@ruqa\/desktop(\/|$)/,
    /(^|\/)node_modules\/@ruqa\/mobile(\/|$)/,
    /(^|\/)node_modules\/@ruqa\/web(\/|$)/,
    /(^|\/)node_modules\/react-native[^/]*(\/|$)/,
    /(^|\/)node_modules\/@react-native(\/|$)/,
    /(^|\/)node_modules\/@expo(\/|$)/,
    /(^|\/)node_modules\/expo-[^/]+(\/|$)/,
    // Build-only tools
    /(^|\/)node_modules\/@babel(\/|$)/,
    /(^|\/)node_modules\/@types(\/|$)/,
    /(^|\/)node_modules\/@stylexjs(\/|$)/,
    /(^|\/)node_modules\/@jridgewell(\/|$)/,
    /(^|\/)node_modules\/caniuse-lite(\/|$)/,
    /(^|\/)node_modules\/acorn(\/|$)/,
    /(^|\/)node_modules\/fast-glob(\/|$)/,
    /(^|\/)node_modules\/@nodelib(\/|$)/,
    /(^|\/)node_modules\/baseline-browser-mapping(\/|$)/,
    // Renderer-only packages — bundled by Vite into dist/renderer, not loaded at runtime
    /(^|\/)node_modules\/lucide-react(\/|$)/,
    /(^|\/)node_modules\/react-dom(\/|$)/,
    /(^|\/)node_modules\/react-strict-dom(\/|$)/,
    // Source and config files not needed in production
    /^\/src(\/|$)/,
    /^\/scripts(\/|$)/,
    /^\/e2e($|\/)/,
    /^\/docs($|\/)/,
    /^\/babel\.config\.cjs$/,
    /^\/postcss\.config\.mjs$/,
    /^\/vite\.config\.ts$/,
    /^\/tsconfig\.json$/,
    /^\/CHANGELOG\.md$/,
    /^\/README\.md$/,
    /^\/forge\.config\.cjs$/
  ]
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    }
  }
}

module.exports = {
  packagerConfig,

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: appName,
        authors: pkg.author || appName,
        description: pkg.description || appName,
        ...(process.env.WINDOWS_CERTIFICATE_FILE
          ? {
              certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
              certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
            }
          : {})
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
      config: {}
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: canMakeMsix ? ['win32'] : [],
      config: {
        appManifest: path.join(__dirname, 'out', 'manifest', 'AppxManifest.xml'),
        packageAssets: path.join(__dirname, 'build', 'msix-assets'),
        windowsKitVersion,
        ...(process.env.WINDOWS_CERTIFICATE_FILE
          ? {
              windowsSignOptions: {
                certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
                certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
              }
            }
          : {})
      }
    }
  ],

  hooks: {
    prePackage: async () => {
      cleanupForgeSymlinks()
      const rootNM = path.join(__dirname, '..', '..', 'node_modules')
      const localNM = path.join(__dirname, 'node_modules')
      const links = []
      const dirs = []

      for (const entry of fs.readdirSync(rootNM)) {
        if (entry.startsWith('.') || entry === '@ruqa') continue
        const localPath = path.join(localNM, entry)
        if (fs.existsSync(localPath)) continue
        fs.symlinkSync(path.join(rootNM, entry), localPath, 'junction')
        links.push(localPath)
      }

      // @ruqa нельзя линковать целиком: npm держит там и сам apps/desktop,
      // и ссылка node_modules/@ruqa/desktop замыкает обход на корень приложения.
      // Кладём только те пакеты, что нужны десктопу в рантайме.
      const scopeDir = path.join(localNM, '@ruqa')
      if (!fs.existsSync(scopeDir)) {
        fs.mkdirSync(scopeDir, { recursive: true })
        dirs.push(scopeDir)
      }
      for (const name of ['components', 'core', 'domain', 'drive', 'locales']) {
        const source = path.join(rootNM, '@ruqa', name)
        const localPath = path.join(scopeDir, name)
        if (!fs.existsSync(source) || fs.existsSync(localPath)) continue
        fs.symlinkSync(source, localPath, 'junction')
        links.push(localPath)
      }

      fs.mkdirSync(path.dirname(SYMLINK_MANIFEST), { recursive: true })
      fs.writeFileSync(SYMLINK_MANIFEST, JSON.stringify({ links, dirs }))
    },
    postPackage: async (_config, { platform, arch, outputPaths }) => {
      cleanupForgeSymlinks()
      await Promise.all(outputPaths.map((p) => prunePrebuilds(p, platform, arch)))
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })

      const sourceManifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const outManifest = path.join(__dirname, 'out', 'manifest', 'AppxManifest.xml')
      const baseVersion = String(pkg.version).split('-')[0]
      if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
        throw new Error(
          `Invalid pkg.version "${pkg.version}" — MSIX needs MAJOR.MINOR.PATCH (with optional -tag)`
        )
      }
      const msixVersion = `${baseVersion}.0`
      const xml = fs.readFileSync(sourceManifest, 'utf-8')
      fs.mkdirSync(path.dirname(outManifest), { recursive: true })
      fs.writeFileSync(outManifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
      // Keep out/make — Squirrel's Setup.exe + nupkg + RELEASES live there and must survive for upload
    }
  },

  plugins: []
}
