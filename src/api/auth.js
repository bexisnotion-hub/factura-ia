import crypto from 'crypto'

// Compara dos strings en tiempo constante para evitar timing attacks.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Middleware de autenticación por token Bearer.
 * Acepta "Authorization: Bearer <token>" o ?token=<token> (para WS/img).
 * Si API_AUTH_TOKEN está vacío y NODE_ENV != production, deja pasar (modo dev local).
 */
export function requireAuth(req, res, next) {
  const expected = process.env.API_AUTH_TOKEN || ''
  const isProd = process.env.NODE_ENV === 'production'

  if (!expected) {
    if (isProd) {
      return res.status(503).json({ error: 'Servicio no configurado' })
    }
    return next()
  }

  const header = req.headers['authorization'] || ''
  const tokenFromHeader = header.startsWith('Bearer ') ? header.slice(7) : ''
  const tokenFromQuery = typeof req.query?.token === 'string' ? req.query.token : ''
  const provided = tokenFromHeader || tokenFromQuery

  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  next()
}

export function isValidToken(provided) {
  const expected = process.env.API_AUTH_TOKEN || ''
  if (!expected) return process.env.NODE_ENV !== 'production'
  if (!provided) return false
  return safeEqual(provided, expected)
}
