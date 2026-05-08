import { DatabaseSync as Database } from 'node:sqlite'
import { v4 as uuid } from 'uuid'
import { detectDuplicate } from './deduplicator.js'
import { categorize } from './categorizer.js'
import { broadcast } from '../realtime/websocket.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'facturas.db')

const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT,
    vendor TEXT,
    vendor_cif TEXT,
    vendor_address TEXT,
    date TEXT,
    due_date TEXT,
    subtotal REAL,
    tax_rate REAL,
    tax_amount REAL,
    discounts REAL,
    total REAL,
    currency TEXT DEFAULT 'EUR',
    category TEXT,
    payment_method TEXT,
    status TEXT DEFAULT 'pending',
    confidence REAL,
    extracted_by TEXT,
    needs_review INTEGER DEFAULT 0,
    raw_data TEXT,
    original_file TEXT,
    original_filename TEXT,
    sender_phone TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    approved_at TEXT,
    notes TEXT,
    duplicate_of TEXT,
    line_items TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
  CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
  CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor);
`);

// Migración: añadir session_id si no existe (backward compat con DBs anteriores)
try { db.exec('ALTER TABLE invoices ADD COLUMN session_id TEXT') } catch {}

db.exec(`

  CREATE TABLE IF NOT EXISTS income (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'DOP',
    amount REAL NOT NULL DEFAULT 0,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, currency)
  );
`)

export async function processAndStore(extraction, meta) {
  const duplicate = detectDuplicate(db, extraction)
  if (duplicate) {
    console.log(`[Validator] Duplicado detectado: ${duplicate.duplicateReason}`)
    return { ...duplicate, isDuplicate: true }
  }

  if (!extraction.category) {
    extraction.category = categorize(extraction)
  }

  const id = uuid()
  const confidence = typeof extraction.confidence === 'number' ? extraction.confidence : 0.5
  const needsReview = confidence < 0.7 || !extraction.total || !extraction.vendor ? 1 : 0

  db.prepare(`
    INSERT INTO invoices (
      id, invoice_number, vendor, vendor_cif, vendor_address,
      date, due_date, subtotal, tax_rate, tax_amount, discounts, total, currency,
      category, payment_method, confidence, extracted_by, needs_review,
      raw_data, original_file, original_filename, sender_phone, line_items, session_id
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    id,
    extraction.invoiceNumber || null,
    extraction.vendor || null,
    extraction.vendorCIF || null,
    extraction.vendorAddress || null,
    extraction.date || null,
    extraction.dueDate || null,
    extraction.subtotal ?? null,
    extraction.taxRate ?? null,
    extraction.taxAmount ?? null,
    extraction.discounts ?? null,
    extraction.total ?? null,
    extraction.currency || 'EUR',
    extraction.category || 'Otros',
    extraction.paymentMethod || null,
    confidence,
    extraction.extractedBy || 'unknown',
    needsReview,
    JSON.stringify(extraction),
    meta.originalFile || null,
    meta.originalFilename || null,
    meta.from || null,
    JSON.stringify(extraction.lineItems || []),
    meta.sessionId || null
  )

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id)
  const stats = getStats()

  broadcast('invoice:new', { invoice, stats })

  return { id, invoice, confidence, needsReview: !!needsReview }
}

export function updateInvoice(id, fields) {
  const allowed = ['vendor', 'date', 'total', 'tax_amount', 'tax_rate', 'subtotal', 'category', 'status', 'notes', 'invoice_number']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k))
  if (!updates.length) return null

  const setClauses = updates.map(([k]) => `${k} = ?`).join(', ')
  const values = updates.map(([, v]) => v)

  let approvedClause = ''
  if (fields.status === 'approved') {
    approvedClause = ', approved_at = ?'
    values.push(new Date().toISOString())
  }

  values.push(id)
  db.prepare(`UPDATE invoices SET ${setClauses}${approvedClause} WHERE id = ?`).run(...values)

  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id)
  broadcast('invoice:updated', { invoice: updated })
  return updated
}

export function getStats(currency = null) {
  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`

  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [currency] : []

  const monthRow = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total, COALESCE(SUM(tax_amount),0) as tax
    FROM invoices WHERE strftime('%Y-%m', created_at) = ?${cf} AND status != 'rejected'
  `).get(currentMonth, ...cp)

  const prevRow = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total
    FROM invoices WHERE strftime('%Y-%m', created_at) = ?${cf} AND status != 'rejected'
  `).get(prevMonth, ...cp)

  const pendingReview = db.prepare(`
    SELECT COUNT(*) as count FROM invoices WHERE needs_review = 1 AND status = 'pending'${cf}
  `).get(...cp)

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count, COALESCE(SUM(total),0) as amount
    FROM invoices WHERE status != 'rejected'${cf}
    GROUP BY category ORDER BY amount DESC
  `).all(...cp)

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM invoices WHERE 1=1${cf} GROUP BY status
  `).all(...cp)

  const topVendors = db.prepare(`
    SELECT vendor, COUNT(*) as count, COALESCE(SUM(total),0) as amount
    FROM invoices WHERE status != 'rejected' AND vendor IS NOT NULL${cf}
    GROUP BY vendor ORDER BY amount DESC LIMIT 5
  `).all(...cp)

  const monthlyTrend = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month,
           COUNT(*) as count,
           COALESCE(SUM(total),0) as amount
    FROM invoices WHERE status != 'rejected'${cf}
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all(...cp)

  const totalTaxRow = db.prepare(`
    SELECT COALESCE(SUM(tax_amount), 0) as tax FROM invoices WHERE status != 'rejected'${cf}
  `).get(...cp)

  return {
    currentMonth: { label: currentMonth, count: monthRow.count, total: monthRow.total, tax: monthRow.tax },
    prevMonth: { label: prevMonth, count: prevRow.count, total: prevRow.total },
    pendingReview: pendingReview.count,
    totalAccumulatedTax: totalTaxRow.tax,
    currency: currency || null,
    byCategory,
    byStatus,
    topVendors,
    monthlyTrend,
  }
}

export function getIncome(month, currency) {
  return db.prepare('SELECT * FROM income WHERE month = ? AND currency = ?').get(month, currency) || null
}

export function setIncome(month, currency, amount, notes) {
  const existing = db.prepare('SELECT id FROM income WHERE month = ? AND currency = ?').get(month, currency)
  if (existing) {
    db.prepare('UPDATE income SET amount = ?, notes = ?, updated_at = datetime(\'now\') WHERE month = ? AND currency = ?')
      .run(amount, notes || null, month, currency)
  } else {
    db.prepare('INSERT INTO income (id, month, currency, amount, notes) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), month, currency, amount, notes || null)
  }
  return db.prepare('SELECT * FROM income WHERE month = ? AND currency = ?').get(month, currency)
}

export { db }
