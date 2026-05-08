import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs/promises'

const PROMPT = `Eres un experto en contabilidad. Analiza esta factura o ticket y extrae todos los datos en JSON estricto.
Sin markdown, sin texto extra, solo el JSON. Campos nulos usa null. Incluye siempre "confidence" entre 0 y 1.

{
  "invoiceNumber": null,
  "vendor": null,
  "vendorCIF": null,
  "vendorAddress": null,
  "date": null,
  "dueDate": null,
  "currency": "EUR",
  "subtotal": null,
  "taxRate": null,
  "taxAmount": null,
  "discounts": null,
  "total": null,
  "paymentMethod": null,
  "lineItems": [],
  "category": "Otros",
  "notes": null,
  "confidence": 0.5
}`

export async function extractWithClaude(filePath, mimeType) {
  const client = new Anthropic()
  const fileData = await fs.readFile(filePath)
  const base64 = fileData.toString('base64')

  const isImage = mimeType.startsWith('image/')
  const mediaType = isImage ? mimeType : 'image/jpeg'

  if (!isImage) {
    throw new Error('Claude Vision solo acepta imágenes en este fallback')
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  })

  const text = response.content[0].text.trim()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`Sin JSON en respuesta de Claude: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(jsonMatch[0])

  if (!parsed.total && !parsed.vendor) {
    throw new Error('Claude no extrajo datos suficientes')
  }

  return parsed
}
