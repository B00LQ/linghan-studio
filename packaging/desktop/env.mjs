/**
 * 读一个 `.env` 文件进环境变量（安装版预置值用）。
 *
 * 为什么自己写而不是上 dotenv：格式只有 `KEY=VALUE` 与 `#` 注释两种，
 * 十几行就够；而服务端的承诺是"只用 Node 内置模块"，启动器也不该破这个例。
 *
 * 两条规则：
 * 1. **只填没设过的**：真实环境变量永远压得住文件里的值（运维想临时改一下，
 *    不该被安装包里的预置值顶回去）；
 * 2. **文件不存在不是错误**：绿色包（非安装版）就没有这个文件。
 */
import { existsSync, readFileSync } from 'node:fs'

/**
 * 把 `.env` 里的键值填进 `target`。
 * @param path - `.env` 的路径。
 * @param target - 填到哪（默认 `process.env`）。
 * @returns 填进去几个键。
 */
export function loadEnvFile(path, target = process.env) {
  if (!existsSync(path)) return 0
  let filled = 0
  try {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const at = line.indexOf('=')
      if (at <= 0) continue
      const key = line.slice(0, at).trim()
      let value = line.slice(at + 1).trim()
      // 去掉成对的引号：写 `KEY="有空格的值"` 的人不该得到一个带引号的值。
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      const current = target[key]
      if (current !== undefined && current !== '') continue
      target[key] = value
      filled += 1
    }
  } catch {
    // 读不了就当没有：一个坏掉的 .env 不该让应用起不来。
  }
  return filled
}
