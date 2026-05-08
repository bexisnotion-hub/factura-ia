import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { broadcast } from '../realtime/websocket.js'
import { handleIncomingMessage } from './handlers.js'
import { db } from '../processing/validator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS_BASE = path.resolve(process.env.SESSIONS_DIR || 'auth_sessions')
const LEGACY_DIR    = path.resolve(process.env.WHATSAPP_SESSION_DIR || 'auth_info_baileys')

// ── Persistencia de sesiones ───────────────────────────────────────────────
function dbEnsureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Principal',
      phone TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

function dbSaveSession(id, name, phone) {
  const existing = db.prepare('SELECT id FROM wa_sessions WHERE id = ?').get(id)
  if (existing) {
    db.prepare('UPDATE wa_sessions SET phone = ? WHERE id = ?').run(phone || null, id)
  } else {
    db.prepare('INSERT INTO wa_sessions (id, name, phone) VALUES (?, ?, ?)').run(id, name, phone || null)
  }
}

function dbDeleteSession(id) {
  db.prepare('DELETE FROM wa_sessions WHERE id = ?').run(id)
}

function dbListSessions() {
  return db.prepare('SELECT * FROM wa_sessions ORDER BY created_at ASC').all()
}

// ── Clase de sesión individual ─────────────────────────────────────────────
class WASession {
  constructor(id, name) {
    this.id = id
    this.name = name || 'Cuenta'
    this.status = 'disconnected'
    this.qrImage = null
    this.phone = null
    this.sock = null
    this.reconnectDelay = 3000
    this.reconnectTimer = null
    this.destroyed = false
  }

  get dir() {
    return this.id === 'default' ? LEGACY_DIR : path.join(SESSIONS_BASE, this.id)
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      phone: this.phone,
      hasQR: !!this.qrImage,
    }
  }
}

// ── Session Manager ────────────────────────────────────────────────────────
class SessionManager {
  constructor() {
    this.sessions = new Map()
    this._waVersion = null
  }

  async init() {
    dbEnsureTable()

    // Migrar sesión legada si existe
    try {
      await fs.access(path.join(LEGACY_DIR, 'creds.json'))
      dbSaveSession('default', 'Principal', null)
    } catch {}

    // Reconectar todas las sesiones guardadas en DB
    const saved = dbListSessions()
    if (saved.length === 0) {
      // Primera vez: crear sesión default vacía para mostrar QR
      await this.add('default', 'Principal')
    } else {
      for (const row of saved) {
        await this.add(row.id, row.name)
      }
    }
  }

  async _getVersion() {
    if (this._waVersion) return this._waVersion
    try {
      const { version } = await fetchLatestBaileysVersion()
      this._waVersion = version
      console.log(`[WhatsApp] Protocolo: ${version.join('.')}`)
    } catch {
      this._waVersion = [2, 3000, 1020170720]
      console.log('[WhatsApp] Usando versión fallback')
    }
    return this._waVersion
  }

  async add(id, name) {
    if (this.sessions.has(id)) return this.sessions.get(id)
    const session = new WASession(id, name || 'Cuenta')
    this.sessions.set(id, session)
    dbSaveSession(id, session.name, null)
    await this._connect(session)
    return session
  }

  async remove(id) {
    const session = this.sessions.get(id)
    if (!session) return

    session.destroyed = true
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    try { session.sock?.end?.() } catch {}
    this.sessions.delete(id)
    dbDeleteSession(id)

    try { await fs.rm(session.dir, { recursive: true, force: true }) } catch {}
    broadcast('session:removed', { id })
    console.log(`[WhatsApp:${id}] Sesión eliminada.`)
  }

  get(id) { return this.sessions.get(id) }
  list() { return Array.from(this.sessions.values()).map(s => s.toJSON()) }

  getQR(id) {
    return this.sessions.get(id)?.qrImage || null
  }

  // Backward compat: estado de la sesión principal
  get botState() {
    const s = this.sessions.get('default')
    return s
      ? { status: s.status, qrImage: s.qrImage, phone: s.phone }
      : { status: 'disconnected', qrImage: null, phone: null }
  }

  // Wakes up a dead session — safe to call even if already connecting
  ensureActive(id) {
    const session = this.sessions.get(id)
    if (!session || session.destroyed) return
    if (session.status === 'connected') return
    if (session.reconnectTimer) return   // already scheduled
    if (session.sock) return             // socket exists, Baileys handles it
    console.log(`[WhatsApp:${id}] Sesión inactiva detectada — reiniciando...`)
    this._connect(session)
  }

  async _connect(session) {
    if (session.destroyed) return

    // Cancel any pending reconnect before creating a new socket
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null }

    await fs.mkdir(session.dir, { recursive: true })

    // Pre-cargar teléfono desde creds guardados
    try {
      const raw = await fs.readFile(path.join(session.dir, 'creds.json'), 'utf8')
      const creds = JSON.parse(raw)
      const rawId = creds?.me?.id || ''
      session.phone = rawId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') || null
    } catch {}

    let version
    try {
      version = await this._getVersion()
    } catch {
      version = [2, 3000, 1020170720]
    }

    let state, saveCreds
    try {
      ;({ state, saveCreds } = await useMultiFileAuthState(session.dir))
    } catch (err) {
      console.error(`[WhatsApp:${session.id}] Error cargando credenciales:`, err.message)
      session.reconnectTimer = setTimeout(() => this._connect(session), 5000)
      return
    }

    let sock
    try {
      sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 15_000,
        retryRequestDelayMs: 500,
        syncFullHistory: false,
      })
    } catch (err) {
      console.error(`[WhatsApp:${session.id}] Error creando socket:`, err.message)
      session.reconnectTimer = setTimeout(() => this._connect(session), 8000)
      return
    }

    session.sock = sock

    // Watchdog: if no QR and no connection after 90s, force restart
    const watchdog = setTimeout(async () => {
      if (session.destroyed || session.status === 'connected' || session.status === 'qr') return
      console.log(`[WhatsApp:${session.id}] Watchdog: sin actividad en 90s — reiniciando socket...`)
      try { sock.end?.() } catch {}
      session.sock = null
      session.reconnectDelay = 3000
      this._connect(session)
    }, 90_000)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (session.destroyed) return

      if (qr) {
        clearTimeout(watchdog)
        session.status = 'qr'
        session.qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2, errorCorrectionLevel: 'M' })
        session.reconnectDelay = 3000
        broadcast('session:qr', { id: session.id, name: session.name, image: session.qrImage })
        if (session.id === 'default') broadcast('qr', { image: session.qrImage })
        try {
          const t = await QRCode.toString(qr, { type: 'terminal', small: true })
          console.log(`\n[WhatsApp:${session.id}] QR listo — escanea en el panel\n${t}`)
        } catch {}
      }

      if (connection === 'open') {
        clearTimeout(watchdog)
        session.status = 'connected'
        session.qrImage = null
        session.reconnectDelay = 3000
        const rawId = sock.user?.id || ''
        session.phone = rawId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') || null
        dbSaveSession(session.id, session.name, session.phone)
        console.log(`[WhatsApp:${session.id}] ✓ Conectado como +${session.phone} (${session.name})`)
        broadcast('session:connected', { id: session.id, name: session.name, phone: session.phone })
        if (session.id === 'default') broadcast('whatsapp:connected', { phone: session.phone })
      }

      if (connection === 'close') {
        clearTimeout(watchdog)
        session.sock = null
        const err = lastDisconnect?.error
        const code = err?.output?.statusCode ?? err?.data?.statusCode ?? 0
        const isLoggedOut = code === DisconnectReason.loggedOut

        session.status = 'disconnected'
        session.qrImage = null
        broadcast('session:disconnected', { id: session.id, code })
        if (session.id === 'default') broadcast('whatsapp:disconnected', { code })

        if (!session.destroyed) {
          if (isLoggedOut) {
            // WhatsApp revoked the session — wipe credentials and reconnect to get a fresh QR
            console.log(`[WhatsApp:${session.id}] Sesión revocada por WhatsApp — limpiando credenciales y reconectando...`)
            try { await fs.rm(session.dir, { recursive: true, force: true }) } catch {}
            session.reconnectDelay = 3000
            session.reconnectTimer = setTimeout(() => this._connect(session), 2000)
          } else {
            console.log(`[WhatsApp:${session.id}] Reconectando en ${session.reconnectDelay / 1000}s (código: ${code})...`)
            session.reconnectTimer = setTimeout(() => this._connect(session), session.reconnectDelay)
            session.reconnectDelay = Math.min(session.reconnectDelay * 1.5, 30_000)
          }
        }
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const ownJid = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net'
        const isSelfChat = msg.key.remoteJid === ownJid
        if (msg.key.fromMe && !isSelfChat) continue
        if (isSelfChat) {
          const msgType = Object.keys(msg.message || {})[0]
          if (msgType !== 'imageMessage' && msgType !== 'documentMessage') continue
        }
        await handleIncomingMessage(sock, msg, session.id, session.name)
      }
    })
  }
}

export const sessionManager = new SessionManager()
