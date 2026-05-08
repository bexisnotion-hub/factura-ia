import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { initWebSocket } from './src/realtime/websocket.js'
import { connectToWhatsApp, sessionManager, botState } from './src/whatsapp/bot.js'
import { apiRouter } from './src/api/routes.js'
import { requireAuth } from './src/api/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 3000
const IS_PROD = process.env.NODE_ENV === 'production'
const AUTH_TOKEN = process.env.API_AUTH_TOKEN || ''

// Negarse a arrancar sin token en producción (la API expone borrado/edición de datos).
if (IS_PROD && !AUTH_TOKEN) {
  console.error('[Boot] FATAL: API_AUTH_TOKEN obligatorio en producción. Abortando.')
  process.exit(1)
}
if (!AUTH_TOKEN) {
  console.warn('[Boot] AVISO: API_AUTH_TOKEN vacío — la API queda abierta. Solo válido en local (NODE_ENV != production).')
}

// Confiar en proxy directo (1 salto). Necesario para que rate-limit lea bien req.ip.
app.set('trust proxy', 1)

// Cabeceras de seguridad estándar
app.use(helmet({
  // El dashboard usa fuentes de Google Fonts y estilos en línea; relajamos CSP justo lo necesario.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}))

// CORS restringido — vacío = mismo origen únicamente. En producción nunca '*'.
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : false,
  credentials: false,
}))

app.use(express.json({ limit: '1mb' }))

// Rate limit global para mitigar abuso/brute force
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, intenta más tarde.' },
})
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas subidas, intenta más tarde.' },
})

// Estáticos protegidos: las facturas son PII — exigir auth (igual que la API).
app.use('/uploads', requireAuth, express.static(path.join(__dirname, 'uploads')))

// /api/qr — público (el QR es efímero y requiere teléfono físico; no expone datos sensibles).
// Se registra ANTES del middleware requireAuth para que funcione sin token.
// Respuesta inmediata: compatible con Vercel (sin long-poll que supere el timeout de función).
app.get('/api/qr', apiLimiter, (req, res) => {
  sessionManager.ensureActive('default')
  res.setHeader('Cache-Control', 'no-store')
  if (botState.qrImage) return res.json({ image: botState.qrImage, status: 'qr' })
  if (botState.status === 'connected') return res.json({ image: null, status: 'connected' })
  res.json({ image: null, status: botState.status || 'connecting' })
})

// Rutas de API (auth + rate limit). El login específico de cada ruta lo aplica el middleware.
app.use('/api/upload', uploadLimiter)
app.use('/api', apiLimiter, requireAuth, apiRouter)

// Frontend estático (público). HTML nunca se cachea para que el navegador siempre ejecute el JS más reciente.
app.use('/', express.static(path.join(__dirname, 'src/dashboard/public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
  },
}))

// SPA fallback — solo para rutas que NO sean /api ni /uploads
app.get(/^\/(?!api|uploads).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(__dirname, 'src/dashboard/public/index.html'))
})

// Manejador de errores: nunca filtrar internals al cliente
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[Error]', err)
  const status = err.status || 500
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor' : err.message })
})

initWebSocket(server, { authToken: AUTH_TOKEN, requireAuth: !!AUTH_TOKEN })

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗')
  console.log('║         FacturaIA — Sistema Activo      ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║  Panel:  http://localhost:${PORT}           ║`)
  console.log(`║  API:    http://localhost:${PORT}/api       ║`)
  console.log('╠════════════════════════════════════════╣')
  console.log('║  Conectando WhatsApp...                 ║')
  console.log('╚════════════════════════════════════════╝\n')
})

connectToWhatsApp()

// Mantener el proceso de Vercel activo — sin esto, el servidor se duerme
// entre visitas y Baileys tarda ~60s en reconectar al despertar.
if (IS_PROD && process.env.PUBLIC_URL && AUTH_TOKEN) {
  setInterval(() => {
    fetch(`${process.env.PUBLIC_URL}/api/status`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }).catch(() => {})
  }, 15_000)
  console.log('[KeepAlive] Auto-ping activado — el proceso no se dormirá')
}
