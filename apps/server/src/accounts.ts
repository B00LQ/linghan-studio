/**
 * 账号与会话（`cloud` 模式的那一层）。
 *
 * 三条设计原则，都是为了「不引入依赖 + 不留下可被拖库利用的东西」：
 *
 * 1. **密码用 `scrypt`**（`node:crypto`，零依赖）。存的是 `scrypt$N$r$p$salt$hash`，
 *    参数跟着哈希一起存，所以以后调参也能继续验老密码。
 * 2. **令牌只存哈希**（sha256）。访问令牌、刷新令牌、邮箱验证/重置令牌，
 *    数据库里全部是哈希 —— 库被拖走也不能拿去登录。明文只在它该出现的地方出现一次
 *    （HTTP 响应里、或邮件里）。
 * 3. **不泄露「邮箱是否存在」**：登录失败与邮箱不存在的错误信息**完全一样**；
 *    忘记密码接口对任何邮箱都回同样的「已发送」（真存在才真发）。
 *
 * 邮件走一个 `Mailer` 接口：默认把邮件**打到日志**（开发/测试够用，不需要任何外部服务），
 * 配了 webhook 就 POST 给你自己的转发服务。真实服务商（阿里云邮件推送 / SES / SMTP）
 * 留到 M4 再接 —— 那时才有真凭据可测。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { StudioStore, StudioUser } from './store.ts'

/** 一次会话的两把令牌。 */
export interface SessionTokens {
  /** 短命令牌，放在 `Authorization: Bearer` 里。 */
  accessToken: string
  /** 长命令牌，只用来换新的一对。 */
  refreshToken: string
  /** 访问令牌还有多少秒过期。 */
  expiresInSeconds: number
}

/** 账号操作失败的原因（对外只暴露 code 与一句人话）。 */
export interface AccountFailure {
  /** HTTP 状态码。 */
  status: number
  /** 一句给人看的话。 */
  message: string
}

/** 邮件发送接口。 */
export interface Mailer {
  /**
   * 发一封纯文本邮件。
   * @param message - 收件人、主题、正文。
   */
  send: (message: { to: string; subject: string; text: string }) => Promise<void>
}

/** 账号层需要的依赖。 */
export interface AccountDeps {
  /** 存储层。 */
  store: StudioStore
  /** 邮件发送。 */
  mailer: Mailer
  /** 对外地址（拼验证/重置链接）。 */
  publicUrl: string
  /** 诊断输出。 */
  log: (message: string) => void
}

/** 访问令牌寿命（12 小时：桌面端一天用下来够，短到泄露也不久）。 */
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000
/** 刷新令牌寿命（90 天：桌面端不该天天让人重新登录）。 */
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** 邮箱验证 / 重置密码令牌寿命。 */
const ACTION_TTL_MS = 60 * 60 * 1000

/** 密码最短长度。短于这个就是「不设防」——而这是对外发布的账号。 */
export const MIN_PASSWORD_LENGTH = 8

/** 一个够用的邮箱形状检查（真正的验证靠那封邮件）。 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** 令牌的哈希（存库、比对都用它）。 */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** 生成一把随机令牌，返回明文与它的哈希。 */
function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

/**
 * 把密码哈希成可入库的字符串。
 * @param password - 用户输入的明文。
 * @returns `scrypt$N$r$p$salt$hash`（base64url）。
 */
export function hashPassword(password: string): string {
  const N = 16384
  const r = 8
  const p = 1
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 32, { N, r, p })
  return `scrypt$${String(N)}$${String(r)}$${String(p)}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

/**
 * 校验密码。
 * @param password - 用户输入。
 * @param stored - 库里那一串。
 * @returns 是否匹配。**参数看不懂时返回 false**（坏数据不该变成"通过"）。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number.parseInt(parts[1] as string, 10)
  const r = Number.parseInt(parts[2] as string, 10)
  const p = Number.parseInt(parts[3] as string, 10)
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  const salt = Buffer.from(parts[4] as string, 'base64url')
  const expected = Buffer.from(parts[5] as string, 'base64url')
  const derived = scryptSync(password, salt, expected.length, { N, r, p })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** 把邮件打印到日志里的 Mailer（默认；开发与测试用）。 */
export function createConsoleMailer(log: (message: string) => void): Mailer {
  return {
    async send(message) {
      // 一行能被测试解析的格式：`[mail] to=… subject=…` 后面跟正文。
      log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`)
    },
  }
}

/** 把邮件 POST 给一个转发服务的 Mailer。 */
export function createWebhookMailer(url: string, log: (message: string) => void): Mailer {
  return {
    async send(message) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
        })
        if (!response.ok) log(`[mail] 转发失败：HTTP ${String(response.status)}`)
      } catch (error) {
        // 发信失败不该让注册流程崩掉：账号已经建好了，用户可以重发验证邮件。
        log(`[mail] 转发异常：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** 账号层的对外接口。 */
export interface Accounts {
  /** 注册（第一个账号自动是 admin）。 */
  register: (input: { email: string; password: string; displayName?: string }) => Promise<{ user: StudioUser } | AccountFailure>
  /** 登录（重发验证邮件由 resend 负责）。 */
  login: (input: { email: string; password: string; label?: string }) => Promise<{ user: StudioUser; tokens: SessionTokens } | AccountFailure>
  /** 用刷新令牌换新的一对（刷新即轮换）。 */
  refresh: (refreshToken: string) => Promise<{ user: StudioUser; tokens: SessionTokens } | AccountFailure>
  /** 用访问令牌读当前用户（顺带记一次 last_seen）。 */
  me: (accessToken: string) => StudioUser | undefined
  /** 登出（撤销这把令牌所在的会话）。 */
  logout: (token: string) => void
  /** 验证邮箱。 */
  verifyEmail: (token: string) => Promise<StudioUser | AccountFailure>
  /** 重新发验证邮件（对任何邮箱都回成功）。 */
  resendVerification: (email: string) => Promise<void>
  /** 请求重置密码（对任何邮箱都回成功）。 */
  requestPasswordReset: (email: string) => Promise<void>
  /** 用重置令牌改密码（改完撤销全部会话）。 */
  resetPassword: (token: string, newPassword: string) => Promise<StudioUser | AccountFailure>
  /** 自己的设备列表。 */
  listSessions: (userId: string) => ReturnType<StudioStore['listSessions']>
  /** 撤销自己的某个会话。 */
  revokeSession: (userId: string, sessionId: string) => boolean
}

/** 校验邮箱形状与密码强度，返回一句人话或 undefined。 */
function validateCredentials(email: string, password: string): string | undefined {
  if (!EMAIL_SHAPE.test(email.trim())) return '邮箱格式不对'
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${String(MIN_PASSWORD_LENGTH)} 位`
  return undefined
}

/**
 * 建账号层。
 * @param deps - 存储、邮件、对外地址、诊断。
 * @returns the accounts API.
 */
export function createAccounts(deps: AccountDeps): Accounts {
  const { store, mailer, log } = deps
  const base = (): string => (deps.publicUrl !== '' ? deps.publicUrl.replace(/\/+$/u, '') : 'http://127.0.0.1:8080')

  /** 写一条一次性令牌，并把链接交给邮件。 */
  const issueActionToken = async (user: StudioUser, kind: 'verify_email' | 'reset_password'): Promise<void> => {
    const { token, hash } = newToken()
    store.createAuthToken({
      userId: user.id,
      kind,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + ACTION_TTL_MS).toISOString(),
    })
    const path = kind === 'verify_email' ? '/verify-email' : '/reset-password'
    const link = `${base()}${path}?token=${encodeURIComponent(token)}`
    const name = user.displayName !== '' ? user.displayName : (user.email.split('@')[0] ?? '')
    await mailer.send(kind === 'verify_email'
      ? {
        to: user.email,
        subject: '验证你的邮箱 · LINGHAN Studio',
        // 链接有效 1 小时：够用，又不至于长期躺在邮箱里可被利用。
        text: `${name} 你好：\n\n点这个链接验证邮箱（1 小时内有效）：\n${link}\n\n如果不是你注册的，忽略这封邮件即可。`,
      }
      : {
        to: user.email,
        subject: '重置密码 · LINGHAN Studio',
        text: `${name} 你好：\n\n点这个链接设置新密码（1 小时内有效）：\n${link}\n\n如果不是你本人操作，忽略这封邮件；你的密码不会被改动。`,
      })
  }

  /** 造一对令牌并落一个会话。 */
  const openSession = (user: StudioUser, label: string): SessionTokens => {
    const access = newToken()
    const refresh = newToken()
    const stamp = Date.now()
    store.createSession({
      userId: user.id,
      accessHash: access.hash,
      refreshHash: refresh.hash,
      label,
      accessExpiresAt: new Date(stamp + ACCESS_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(stamp + REFRESH_TTL_MS).toISOString(),
    })
    return { accessToken: access.token, refreshToken: refresh.token, expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000) }
  }

  /** 会话还能用吗（被撤销、过期都算不能）。 */
  const liveSession = (session: { revokedAt: string; accessExpiresAt: string; refreshExpiresAt: string }, which: 'access' | 'refresh'): boolean => {
    if (session.revokedAt !== '') return false
    const deadline = which === 'access' ? session.accessExpiresAt : session.refreshExpiresAt
    return deadline > new Date().toISOString()
  }

  return {
    async register(input) {
      const email = input.email.trim().toLowerCase()
      const problem = validateCredentials(email, input.password)
      if (problem !== undefined) return { status: 400, message: problem }
      if (store.getUserByEmail(email) !== undefined) {
        // 注册这里**必须**说「已注册」：不然人会一直重试。
        // 登录那里则相反（见下），因为登录是探测邮箱存不存在的地方。
        return { status: 409, message: '这个邮箱已经注册过了，直接登录或走「忘记密码」' }
      }
      // 第一个注册的人是管理员：服务器刚搭起来时，总得有人能进后台。
      const user = store.createUser({
        email,
        passwordHash: hashPassword(input.password),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        role: store.countUsers() === 0 ? 'admin' : 'user',
      })
      await issueActionToken(user, 'verify_email')
      log(`[accounts] 注册：${email}（${user.role}）`)
      return { user }
    },

    async login(input) {
      const email = input.email.trim().toLowerCase()
      const user = store.getUserByEmail(email)
      // 用户不存在 / 密码错 / 被停用：对外**同一句话**。
      // 「这个邮箱没注册过」是免费的情报，不该由登录接口送出去。
      const mismatch = user === undefined || !verifyPassword(input.password, store.getUserPasswordHash(user.id) ?? '')
      if (mismatch || user === undefined || user.status === 'banned') {
        // 密码错时也跑一次哈希：不然「有没有这个邮箱」能靠响应时间看出来。
        if (user === undefined) hashPassword('dummy-password-for-timing')
        return { status: 401, message: '邮箱或密码不对' }
      }
      store.touchUserLogin(user.id)
      const tokens = openSession(user, input.label ?? '')
      log(`[accounts] 登录：${email}`)
      return { user, tokens }
    },

    async refresh(refreshToken) {
      const session = store.findSessionByRefresh(hashToken(refreshToken))
      if (session === undefined || !liveSession(session, 'refresh')) return { status: 401, message: '登录已过期，请重新登录' }
      const user = store.getUserById(session.userId)
      if (user === undefined || user.status === 'banned') return { status: 401, message: '登录已过期，请重新登录' }
      const access = newToken()
      const refresh = newToken()
      const stamp = Date.now()
      store.rotateSession(session.id, {
        accessHash: access.hash,
        refreshHash: refresh.hash,
        accessExpiresAt: new Date(stamp + ACCESS_TTL_MS).toISOString(),
        refreshExpiresAt: new Date(stamp + REFRESH_TTL_MS).toISOString(),
      })
      return {
        user,
        tokens: { accessToken: access.token, refreshToken: refresh.token, expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000) },
      }
    },

    me(accessToken) {
      const session = store.findSessionByAccess(hashToken(accessToken))
      if (session === undefined || !liveSession(session, 'access')) return undefined
      const user = store.getUserById(session.userId)
      if (user === undefined || user.status === 'banned') return undefined
      store.touchSession(session.id, new Date().toISOString())
      return user
    },

    logout(token) {
      const hash = hashToken(token)
      const session = store.findSessionByAccess(hash) ?? store.findSessionByRefresh(hash)
      if (session !== undefined) store.revokeSession(session.id, new Date().toISOString())
    },

    async verifyEmail(token) {
      const found = store.findAuthToken('verify_email', hashToken(token), new Date().toISOString())
      if (found === undefined) return { status: 400, message: '这个验证链接无效或已经用过了' }
      const user = store.getUserById(found.userId)
      if (user === undefined) return { status: 400, message: '这个验证链接无效或已经用过了' }
      store.consumeAuthToken(found.id, new Date().toISOString())
      store.markEmailVerified(user.id, new Date().toISOString())
      return { ...user, emailVerifiedAt: new Date().toISOString() }
    },

    async resendVerification(email) {
      const user = store.getUserByEmail(email)
      // 已注册但没验证才真发；其它情况**什么都不说**（否则又成了一个探测接口）。
      if (user !== undefined && user.emailVerifiedAt === '') await issueActionToken(user, 'verify_email')
    },

    async requestPasswordReset(email) {
      const user = store.getUserByEmail(email)
      if (user !== undefined && user.status === 'active') await issueActionToken(user, 'reset_password')
    },

    async resetPassword(token, newPassword) {
      if (newPassword.length < MIN_PASSWORD_LENGTH) return { status: 400, message: `密码至少 ${String(MIN_PASSWORD_LENGTH)} 位` }
      const found = store.findAuthToken('reset_password', hashToken(token), new Date().toISOString())
      if (found === undefined) return { status: 400, message: '这个重置链接无效或已经用过了' }
      const user = store.getUserById(found.userId)
      if (user === undefined) return { status: 400, message: '这个重置链接无效或已经用过了' }
      const stamp = new Date().toISOString()
      store.consumeAuthToken(found.id, stamp)
      store.setUserPassword(user.id, hashPassword(newPassword))
      // 改密码之后**所有设备都得重新登录**：这正是「我怀疑号被盗了」时要的效果。
      store.revokeUserSessions(user.id, stamp)
      log(`[accounts] 重置密码并撤销全部会话：${user.email}`)
      return user
    },

    listSessions(userId) {
      return store.listSessions(userId)
    },

    revokeSession(userId, sessionId) {
      const session = store.listSessions(userId).find((item) => item.id === sessionId)
      if (session === undefined) return false
      store.revokeSession(sessionId, new Date().toISOString())
      return true
    },
  }
}
