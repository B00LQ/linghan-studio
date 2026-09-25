/**
 * 端口探测（启动器与 Electron 外壳共用）。
 *
 * **为什么不能用「绑一下试试」**：这台机器上 Docker 把容器端口转发到 0.0.0.0:8080，
 * 而我们去绑 127.0.0.1:8080 —— Windows 上**能绑成功**（实测），于是探测说「空闲」，
 * 可浏览器/窗口连过去时，连接却可能落到容器那个服务上（两个服务争同一个端口，
 * 谁接到连接是不确定的）。表现会很吓人：桌面应用里看到的是另一个程序。
 *
 * 所以判据是**先连一下**：连得上就是有人在听，直接跳过这个端口。
 * 绑定检测保留为第二道（防「有人在听但拒绝连接」这种少见情况）。
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'

/** 有人在 127.0.0.1:port 上听着吗。 */
export function portTaken(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (taken) => { socket.destroy(); resolve(taken) }
    socket.setTimeout(timeoutMs, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/** 绑得住吗（通配地址，另加一道）。 */
function bindable(port, host) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.once('listening', () => { probe.close(() => { resolve(true) }) })
    probe.listen(port, host)
  })
}

/**
 * 从 `preferred` 开始找一个真的空闲的端口。
 * @param preferred - 想用的端口（默认 8080）。
 * @param tries - 最多往后试多少个。
 * @returns 可用的端口号。
 */
export async function freePort(preferred = 8080, tries = 120) {
  for (let port = preferred; port < preferred + tries; port += 1) {
    if (await portTaken(port)) continue
    if (!(await bindable(port, '127.0.0.1'))) continue
    return port
  }
  return preferred
}
