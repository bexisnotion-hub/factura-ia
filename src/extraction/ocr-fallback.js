import { createWorker } from 'tesseract.js'

export async function extractWithOCR(filePath, mimeType) {
  if (!mimeType.startsWith('image/')) {
    throw new Error('OCR solo soporta imágenes, no PDFs')
  }

  const worker = await createWorker('spa+eng', 1, { logger: () => {} })
  const { data } = await worker.recognize(filePath)
  await worker.terminate()

  const text = data.text
  const confidence = data.confidence / 100

  // Extrae el importe más grande etiquetado como total
  const totalMatch = text.match(
    /(?:total general|total a pagar|importe total|grand total|total)[^0-9\n]{0,10}([\d]{1,3}(?:[,.][\d]{3})*[,.][\d]{2})/i
  )
  // Fallback: número más grande en la factura con formato de precio
  const allAmounts = [...text.matchAll(/([\d]{1,3}(?:[,.][\d]{3})*[,.][\d]{2})/g)]
    .map(m => parseAmount(m[1]))
    .filter(n => n != null && n > 0)
    .sort((a, b) => b - a)

  const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/)
  const invoiceMatch = text.match(/(?:factura|invoice|nº|nro|ref|ticket|no\.?)[:\s#]*([A-Z0-9\-\/]{3,20})/i)
  const ivaMatch = text.match(/(?:iva|vat|itbis|impuesto)[^0-9\n]{0,10}([\d]{1,3}(?:[,.][\d]{3})*[,.][\d]{2})/i)
  const vendorMatch = text.split('\n').find(l => l.trim().length > 4 && l.trim().length < 60)

  const total = totalMatch ? parseAmount(totalMatch[1]) : (allAmounts[0] || null)
  const taxAmount = ivaMatch ? parseAmount(ivaMatch[1]) : null

  // Normalizar fecha a YYYY-MM-DD
  let date = null
  if (dateMatch) {
    const [, d, m, y] = dateMatch
    const year = y.length === 2 ? `20${y}` : y
    date = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  return {
    invoiceNumber: invoiceMatch?.[1] || null,
    vendor: vendorMatch?.trim() || null,
    vendorCIF: null,
    date,
    total,
    taxAmount,
    subtotal: total && taxAmount ? +(total - taxAmount).toFixed(2) : null,
    currency: 'EUR',
    lineItems: [],
    category: 'Otros',
    rawText: text,
    confidence: Math.min(confidence * 0.7, 0.6),
    needsReview: true,
  }
}

function parseAmount(str) {
  if (!str) return null
  const s = str.trim()
  // Detectar si la coma es separador de miles o decimal
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  let normalized
  if (lastComma > lastDot) {
    // Formato europeo: 1.234,56 → decimal es la coma
    normalized = s.replace(/\./g, '').replace(',', '.')
  } else {
    // Formato americano/dominicano: 1,234.56 → decimal es el punto
    normalized = s.replace(/,/g, '')
  }
  const n = parseFloat(normalized)
  return isNaN(n) ? null : n
}
