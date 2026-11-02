import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (path) => {
    if (path && !out.includes(path)) out.push(path)
  }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const name of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', name, 'node_modules', '@deepseek-ai'))
      }
    } catch {
      /* 没有就算了 */
    }
  }

  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch {
    /* 没有就算了 */
  }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : dot?.import || dot?.default || pkg.module || pkg.main
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      return await import(url)
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

function localDefineTool(options) {
  return options
}

/** 从宿主树里取 defineTool；拿不到就用本地直通实现 */
export async function loadHostDeps() {
  let defineTool = null
  const mod = await fromHostTree('dsh-tools')
  if (mod?.defineTool) defineTool = mod.defineTool
  return { defineTool: defineTool || localDefineTool }
}
