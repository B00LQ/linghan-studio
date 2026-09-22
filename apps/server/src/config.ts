/** Environment-driven configuration for the Studio server. */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Fully resolved server configuration. */
export interface StudioConfig {
  /** HTTP port. */
  port: number
  /** Bind host. */
  host: string
  /** Access password; empty disables the login gate (local development only). */
  password: string
  /** Directory holding the database and generated assets. */
  dataDir: string
  /** Image backend the gateway dispatches to. */
  imageDriver: 'stub' | 'comfyui' | 'ark'
  /** ComfyUI base URL, used by the `comfyui` driver. */
  comfyuiUrl: string
  /** Volcengine Ark API key, used by the `ark` driver. */
  arkApiKey: string
  /** Volcengine Ark base URL. */
  arkBaseUrl: string
  /** Ark model id for image generation. */
  arkModel: string
  /** Secret signing the session cookie. */
  cookieSecret: string
}

/** Read a positive integer environment variable. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Resolve configuration from the environment.
 * @returns the resolved configuration.
 */
export function loadConfig(): StudioConfig {
  const password = process.env.STUDIO_PASSWORD?.trim() ?? ''
  const dataDir = process.env.STUDIO_DATA_DIR?.trim()
  const driver = process.env.STUDIO_IMAGE_DRIVER?.trim()
  return {
    port: intEnv('PORT', 8080),
    host: process.env.HOST?.trim() || '0.0.0.0',
    password,
    dataDir: resolve(dataDir !== undefined && dataDir !== '' ? dataDir : join(homedir(), '.studio')),
    imageDriver: driver === 'comfyui' || driver === 'ark' ? driver : 'stub',
    comfyuiUrl: process.env.COMFYUI_URL?.trim() || 'http://127.0.0.1:8188',
    arkApiKey: process.env.ARK_API_KEY?.trim() ?? '',
    arkBaseUrl: process.env.ARK_BASE_URL?.trim() || 'https://ark.cn-beijing.volces.com/api/v3',
    arkModel: process.env.ARK_MODEL?.trim() || 'doubao-seedream-4-0-250828',
    // A per-process secret is fine for a single instance; multi-instance
    // deployments must pin STUDIO_SECRET so sessions survive a restart.
    cookieSecret: process.env.STUDIO_SECRET?.trim() || randomBytes(32).toString('base64url'),
  }
}
