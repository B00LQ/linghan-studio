/**
 * Access gate: one deployment password, exchanged for a signed session cookie.
 *
 * The cookie carries only an expiry and an HMAC over it, so no credential ever
 * round-trips and nothing user-specific needs storage. Login is rate limited per
 * client address, matching what a public self-hosted deployment needs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Cookie name holding the session. */
export const SESSION_COOKIE = 'studio_session'

/** Session lifetime in milliseconds. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Failed attempts allowed per address inside the window. */
const MAX_ATTEMPTS = 10

/** Rate-limit window in milliseconds. */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000

/** Login throttle state, keyed by client address. */
const attempts = new Map<string, { count: number; resetAt: number }>()

/** Sign one expiry timestamp. */
function sign(secret: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(String(expiresAt)).digest('base64url')
}

/** Constant-time string comparison that tolerates length mismatch. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Read one cookie value out of the request. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

/**
 * Whether the request carries a valid session.
 * @param req - incoming request.
 * @param secret - cookie signing secret.
 * @returns true when the session is present and unexpired.
 */
export function hasSession(req: IncomingMessage, secret: string): boolean {
  const raw = readCookie(req, SESSION_COOKIE)
  if (raw === undefined) return false
  const index = raw.lastIndexOf('.')
  if (index <= 0) return false
  const expiresAt = Number.parseInt(raw.slice(0, index), 10)
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false
  return equals(raw.slice(index + 1), sign(secret, expiresAt))
}

/**
 * Record one failed attempt and report whether the address is now throttled.
 * @param address - client address.
 * @returns true when the caller must wait.
 */
export function throttle(address: string): boolean {
  const now = Date.now()
  const entry = attempts.get(address)
  if (entry === undefined || entry.resetAt < now) {
    attempts.set(address, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > MAX_ATTEMPTS
}

/** Clear throttle state after a successful login. */
export function clearThrottle(address: string): void {
  attempts.delete(address)
}

/**
 * Verify a submitted password.
 * @param submitted - password from the login form.
 * @param expected - configured password.
 * @returns true when they match.
 */
export function passwordMatches(submitted: string, expected: string): boolean {
  return expected !== '' && equals(submitted, expected)
}

/**
 * Issue a session cookie.
 * @param res - response receiving the header.
 * @param secret - cookie signing secret.
 * @param secure - whether to mark the cookie Secure (production behind TLS).
 */
export function issueSession(res: ServerResponse, secret: string, secure: boolean): void {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const value = `${String(expiresAt)}.${sign(secret, expiresAt)}`
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${String(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`)
}

/** Clear the session cookie. */
export function clearSession(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`)
}
