import express from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { v4 as uuid } from 'uuid'
import { db, updateInvoice, getStats, processAndStore, getIncome, setIncome } from '../processing/validator.js'
import { botState, sessionManager } from '../whatsapp/bot.js'
import { extractInvoiceData } from '../extraction/extractor.js'
import { generateExcel } from './excel.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads')

// Asegura que el directorio de uploads existe antes de que multer escriba en el
mkdirSync(UPLOADS_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = { 'application/pdf': '.pdf', 'image/png': '.png' }[file.mimetype] || '.jpg'
    cb(null, `${uuid()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)
    cb(ok ? null : new Error('Formato no permitido. Usa JPG, PNG o PDF.'), ok)
  },
})

export const apiRouter = express.Router()

// Estado de WhatsApp — también asegura que la sesión esté activa
apiRouter.get('/status', (req, res) => {
  sessionManager.ensureActive('default')
  res.json({ whatsapp: botState.status, phone: botState.phone || null })
})

// ── Gestión de sesiones multi-usuario ─────────────────────────────────────

// Listar todas las sesiones
apiRouter.get('/sessions', (req, res) => {
  res.json({ sessions: sessionManager.list() })
})

// Crear nueva sesión (genera QR para vincular un nuevo número)
apiRouter.post('/sessions', (req, res) => {
  const { name } = req.body || {}
  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
    return res.status(400).json({ error: 'Nombre requerido (máx 50 caracteres)' })
  }
  const id = `session_${Date.now()}`
  sessionManager.add(id, name.trim())
  res.json({ id, name: name.trim(), status: 'disconnected' })
})

// Obtener QR de una sesión específica
apiRouter.get('/sessions/:id/qr', (req, res) => {
  const session = sessionManager.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' })
  res.json({ id: session.id, status: session.status, image: session.qrImage })
})

// Eliminar sesión (desvincula el número)
apiRouter.delete('/sessions/:id', async (req, res) => {
  if (req.params.id === 'default') {
    return res.status(400).json({ error: 'No puedes eliminar la sesión principal desde aquí' })
  }
  const session = sessionManager.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' })
  await sessionManager.remove(req.params.id)
  res.json({ success: true })
})

// QR: respuesta inmediata con estado actual. El frontend hace polling cada 2s.
apiRouter.get('/qr', (req, res) => {
  sessionManager.ensureActive('default')
  res.setHeader('Cache-Control', 'no-store')
  if (botState.qrImage) return res.json({ image: botState.qrImage, status: 'qr' })
  if (botState.status === 'connected') return res.json({ image: null, status: 'connected' })
  res.json({ image: null, status: botState.status || 'connecting' })
})

const ALLOWED_STATUS = ['pending', 'approved', 'rejected']
const ALLOWED_CURRENCIES = ['EUR', 'USD', 'DOP']
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

// Listar facturas con filtros y paginacion
apiRouter.get('/invoices', (req, res) => {
  const { status, category, vendor, from, to, search, currency } = req.query
  const limit = clampInt(req.query.limit, 100, 1, 500)
  const offset = clampInt(req.query.offset, 0, 0, 1_000_000)

  let query = 'SELECT * FROM invoices WHERE 1=1'
  const params = []

  if (status && ALLOWED_STATUS.includes(status)) { query += ' AND status = ?'; params.push(status) }
  if (category && typeof category === 'string' && category.length <= 60) { query += ' AND category = ?'; params.push(category) }
  if (vendor && typeof vendor === 'string' && vendor.length <= 120) { query += ' AND vendor LIKE ?'; params.push(`%${vendor}%`) }
  if (ALLOWED_CURRENCIES.includes(currency)) { query += ' AND currency = ?'; params.push(currency) }
  if (from && ISO_DATE_RE.test(from)) { query += ' AND (date >= ? OR (date IS NULL AND created_at >= ?))'; params.push(from, from) }
  if (to && ISO_DATE_RE.test(to)) { query += ' AND (date <= ? OR (date IS NULL AND created_at <= ?))'; params.push(to, to) }
  if (search && typeof search === 'string' && search.length <= 80) {
    query += ' AND (vendor LIKE ? OR invoice_number LIKE ? OR category LIKE ?)'
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const invoices = db.prepare(query).all(...params)
  // Count con los mismos filtros: quita ORDER BY...LIMIT...OFFSET y cambia SELECT * por COUNT(*)
  const countParams = params.slice(0, -2) // descarta limit y offset
  const countQuery = query
    .replace(/\s+ORDER BY[\s\S]*$/i, '')
    .replace('SELECT *', 'SELECT COUNT(*) as c')
  const total = db.prepare(countQuery).get(...countParams).c

  res.json({ invoices, total })
})

// Factura individual
apiRouter.get('/invoices/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id)
  if (!invoice) return res.status(404).json({ error: 'Factura no encontrada' })
  res.json({ ...invoice, line_items: JSON.parse(invoice.line_items || '[]') })
})

// Actualizar factura (edicion, aprobacion, rechazo)
apiRouter.patch('/invoices/:id', (req, res) => {
  const body = req.body || {}
  if (typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Cuerpo no valido' })
  if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
    return res.status(400).json({ error: 'Estado no valido' })
  }
  try {
    const updated = updateInvoice(req.params.id, body)
    if (!updated) return res.status(400).json({ error: 'Sin campos validos para actualizar' })
    res.json(updated)
  } catch (err) {
    console.error('[Update] Error:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// Eliminar factura
apiRouter.delete('/invoices/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM invoices WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Factura no encontrada' })
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// Estadisticas para el dashboard (filtradas por divisa si se especifica)
apiRouter.get('/stats', (req, res) => {
  const { currency } = req.query
  res.json(getStats(ALLOWED_CURRENCIES.includes(currency) ? currency : null))
})

// Subida de factura desde el panel web
apiRouter.post('/upload', (req, res, next) => {
  upload.single('invoice')(req, res, (err) => {
    if (err) {
      // Solo devolvemos mensajes controlados, sin datos internos
      const safeMsg = err.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo supera el tamano maximo permitido'
        : 'Archivo no valido'
      return res.status(400).json({ error: safeMsg })
    }
    next()
  })
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio ningun archivo' })
  try {
    const extraction = await extractInvoiceData(req.file.path, req.file.mimetype)
    const result = await processAndStore(extraction, {
      from: 'web-panel',
      originalFile: req.file.path,
      originalFilename: req.file.filename,
    })
    res.json({ success: true, ...result })
  } catch (err) {
    console.error('[Upload] Error:', err)
    res.status(500).json({ error: 'No se pudo procesar la factura' })
  }
})

// Exportar CSV
apiRouter.get('/export', (req, res) => {
  const { status, from, to } = req.query
  let query = 'SELECT * FROM invoices WHERE 1=1'
  const params = []

  if (status && ALLOWED_STATUS.includes(status)) { query += ' AND status = ?'; params.push(status) }
  if (from && ISO_DATE_RE.test(from)) { query += ' AND date >= ?'; params.push(from) }
  if (to && ISO_DATE_RE.test(to)) { query += ' AND date <= ?'; params.push(to) }
  query += ' ORDER BY date DESC, created_at DESC'

  const invoices = db.prepare(query).all(...params)

  const headers = ['id', 'invoice_number', 'vendor', 'vendor_cif', 'date', 'subtotal', 'tax_rate', 'tax_amount', 'total', 'currency', 'category', 'status', 'confidence', 'extracted_by', 'created_at']
  // Mitiga CSV-injection: si la celda empieza por =, +, -, @, tab o CR, prefijamos con apostrofe.
  const safeCell = (v) => {
    let s = (v ?? '').toString().replace(/"/g, '""')
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    return `"${s}"`
  }
  const csv = [
    headers.join(';'),
    ...invoices.map((inv) => headers.map((h) => safeCell(inv[h])).join(';')),
  ].join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="facturas-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('﻿' + csv)
})

// Ingresos del mes
apiRouter.get('/income', (req, res) => {
  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const { month = currentMonth, currency = 'DOP' } = req.query
  if (!ALLOWED_CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Divisa no valida' })
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mes no valido (formato YYYY-MM)' })

  const expensesRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM invoices
    WHERE strftime('%Y-%m', created_at) = ? AND currency = ? AND status != 'rejected'
  `).get(month, currency)

  const income = getIncome(month, currency)
  const incomeAmount = income?.amount ?? 0
  const expenses = expensesRow.total
  const net = incomeAmount - expenses

  res.json({ month, currency, income: incomeAmount, expenses, net })
})

apiRouter.post('/income', (req, res) => {
  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const { month = currentMonth, currency = 'DOP', amount, notes } = req.body || {}
  if (!ALLOWED_CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Divisa no valida' })
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) {
    return res.status(400).json({ error: 'Importe no valido' })
  }
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mes no valido (formato YYYY-MM)' })
  const safeNotes = typeof notes === 'string' ? notes.slice(0, 500) : null

  const saved = setIncome(month, currency, amount, safeNotes)

  const expensesRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM invoices
    WHERE strftime('%Y-%m', created_at) = ? AND currency = ? AND status != 'rejected'
  `).get(month, currency)

  const expenses = expensesRow.total
  const net = amount - expenses
  res.json({ month, currency, income: saved.amount, expenses, net })
})

// Exportar Excel profesional (3 hojas)
apiRouter.get('/export/excel', async (req, res) => {
  const { currency } = req.query
  const cur = ALLOWED_CURRENCIES.includes(currency) ? currency : null
  try {
    const wb = await generateExcel(cur)
    const filename = `FacturaIA-${new Date().toISOString().slice(0, 10)}${cur ? '-' + cur : ''}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    await wb.xlsx.write(res)
    res.end()
  } catch (err) {
    console.error('[Excel] Error:', err)
    res.status(500).json({ error: 'No se pudo generar el Excel' })
  }
})
