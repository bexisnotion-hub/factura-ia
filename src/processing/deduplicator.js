export function detectDuplicate(db, extraction) {
  if (!extraction.total || !extraction.vendor) return null

  // Buscar por número de factura exacto del mismo proveedor
  if (extraction.invoiceNumber) {
    const byNumber = db.prepare(`
      SELECT * FROM invoices
      WHERE invoice_number = ? AND vendor = ? AND status != 'rejected'
      LIMIT 1
    `).get(extraction.invoiceNumber, extraction.vendor)
    if (byNumber) {
      return { ...byNumber, isDuplicate: true, duplicateReason: 'Mismo número de factura y proveedor' }
    }
  }

  // Buscar por importe + proveedor + fecha en ventana de ±2 días
  if (extraction.date) {
    const byAmount = db.prepare(`
      SELECT * FROM invoices
      WHERE vendor = ?
        AND total = ?
        AND date(date) BETWEEN date(?, '-2 days') AND date(?, '+2 days')
        AND status != 'rejected'
      LIMIT 1
    `).get(extraction.vendor, extraction.total, extraction.date, extraction.date)
    if (byAmount) {
      return { ...byAmount, isDuplicate: true, duplicateReason: 'Mismo proveedor, importe y fecha similar' }
    }
  }

  return null
}
