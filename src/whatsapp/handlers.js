import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { extractInvoiceData } from '../extraction/extractor.js'
import { processAndStore } from '../processing/validator.js'
import { sendReply } from './reply.js'
import { broadcast } from '../realtime/websocket.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import pino from 'pino'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads')
const logger = pino({ level: 'warn' })

const SUPPORTED = ['imageMessage', 'documentMessage']

function waUser(jid, pushName, payload) {
  broadcast('chat:wa', {
    role: 'user',
    jid,
    phone: jid.replace(/[^0-9]/g, '').slice(-12),
    name: pushName || null,
    ts: Date.now(),
    ...payload,
  })
}

async function waBot(sock, jid, text) {
  await sendReply(sock, jid, text)
  broadcast('chat:wa', { role: 'bot', jid, text, ts: Date.now() })
}

export async function handleIncomingMessage(sock, msg, sessionId = 'default', sessionName = null) {
  const from = msg.key.remoteJid
  const pushName = msg.pushName || null
  const msgType = Object.keys(msg.message || {})[0]

  // Texto → bienvenida
  if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '')
    waUser(from, pushName, { type: 'text', text })
    if (text.toLowerCase().includes('hola') || text.toLowerCase().includes('ayuda') ||
        text.toLowerCase().includes('help') || text.toLowerCase().includes('start')) {
      await waBot(sock, from,
        '👋 *Bienvenido a FacturaIA*\n\nEnvíame una *foto* o *PDF* de cualquier factura o ticket y lo proceso en segundos.\n\n_Formatos: JPG · PNG · PDF_'
      )
    }
    return
  }

  if (!SUPPORTED.includes(msgType)) return

  try {
    const fileId = uuid()
    await fs.mkdir(UPLOADS_DIR, { recursive: true })

    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger })
    if (!buffer || buffer.length === 0) return

    console.log(`[Handler] Archivo descargado: ${buffer.length} bytes (tipo: ${msgType})`)

    let mimeType = 'image/jpeg'
    let ext = '.jpg'

    if (msgType === 'documentMessage') {
      mimeType = msg.message.documentMessage.mimetype || 'image/jpeg'
      if (mimeType === 'application/pdf') ext = '.pdf'
      else if (mimeType === 'image/png') ext = '.png'
    } else if (msgType === 'imageMessage') {
      mimeType = msg.message.imageMessage.mimetype || 'image/jpeg'
      ext = mimeType === 'image/png' ? '.png' : '.jpg'
    }

    const filePath = path.join(UPLOADS_DIR, `${fileId}${ext}`)
    await fs.writeFile(filePath, buffer)
    console.log(`[Handler] Guardado en: ${filePath}`)

    const extraction = await extractInvoiceData(filePath, mimeType)

    // Ignorar si la IA no detecta datos de factura válidos
    const isInvoice = extraction.vendor || extraction.total != null || extraction.invoiceNumber
    if (!isInvoice) {
      console.log('[Handler] Imagen no reconocida como factura — ignorando')
      return
    }

    // Solo ahora confirmamos recepción al usuario
    waUser(from, pushName, { type: 'file', filename: `${fileId}${ext}`, mimeType, ts: Date.now() })

    const result = await processAndStore(extraction, {
      from,
      originalFile: filePath,
      originalFilename: `${fileId}${ext}`,
      sessionId,
      sessionName,
    })

    if (result.isDuplicate) {
      await waBot(sock, from, `⚠️ *Factura duplicada detectada*\n\nEsta factura ya fue registrada.\n_Motivo: ${result.duplicateReason}_`)
      return
    }

    await waBot(sock, from, formatSuccess(result))
  } catch (error) {
    console.error('[Handler] Error procesando imagen:', error.message)
  }
}

function formatSuccess({ invoice, confidence, needsReview }) {
  const inv = invoice
  const pct = Math.round((confidence || 0) * 100)
  const icon = pct >= 90 ? '✅' : pct >= 70 ? '⚠️' : '🔴'

  const lines = [
    `${icon} *Factura procesada* · Confianza: ${pct}%`,
    '',
    inv.invoice_number ? `📋 *Nº:* ${inv.invoice_number}` : null,
    inv.vendor         ? `🏢 *Proveedor:* ${inv.vendor}` : null,
    inv.date           ? `📅 *Fecha:* ${inv.date}` : null,
    inv.subtotal != null   ? `💶 *Base:* ${inv.currency || ''} ${Number(inv.subtotal).toFixed(2)}` : null,
    inv.tax_amount != null ? `📊 *ITBIS/IVA:* ${inv.currency || ''} ${Number(inv.tax_amount).toFixed(2)}` : null,
    inv.total != null      ? `💰 *Total:* ${inv.currency || ''} ${Number(inv.total).toFixed(2)}` : '💰 *Total:* No detectado',
    inv.category           ? `🏷️ *Categoría:* ${inv.category}` : null,
    '',
    needsReview ? '⚠️ _Confianza baja — revisa los datos en el panel._' : null,
    `🔗 Panel: ${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}`,
  ]

  return lines.filter(Boolean).join('\n')
}
