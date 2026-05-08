import { GoogleGenerativeAI } from '@google/generative-ai'
import fs from 'fs/promises'

const PROMPT = `Analiza esta imagen o PDF de factura/ticket y extrae TODOS los datos contables disponibles.
Devuelve ÚNICAMENTE un objeto JSON válido, sin markdown, sin explicaciones, sin texto previo ni posterior.
Si un campo no existe o no es legible, usa null.

REGLA DE IMPUESTOS: Extrae únicamente el IVA/ITBIS/TAX que aparezca explícitamente en la factura.
Si no aparece ninguna línea de impuesto, usa null — un producto puede ser exento de impuesto y eso es válido.
No calcules ni estimes impuestos que no estén escritos en el documento.

{
  "invoiceNumber": "número de factura o ticket",
  "vendor": "nombre del proveedor o comercio",
  "vendorCIF": "CIF o NIF del proveedor",
  "vendorAddress": "dirección del proveedor",
  "date": "fecha en formato YYYY-MM-DD",
  "dueDate": "fecha de vencimiento YYYY-MM-DD",
  "currency": "moneda detectada en la factura: EUR | USD | DOP",
  "subtotal": 0.00,
  "taxRate": null,
  "taxAmount": null,
  "discounts": null,
  "total": 0.00,
  "paymentMethod": null,
  "lineItems": [],
  "category": "Suministros Médicos | Medicamentos | Equipos Médicos | Laboratorio | Mantenimiento | Higiene y Limpieza | Suministros | Tecnología | Servicios Profesionales | Material Oficina | Transporte | Alimentación | Marketing | Alojamiento | Otros",
  "notes": null,
  "confidence": 0.95
}`

const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']

export async function extractWithGemini(filePath, mimeType) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada')

  const fileData = await fs.readFile(filePath)
  const base64 = fileData.toString('base64')
  console.log(`[Gemini] Enviando ${Math.round(fileData.length / 1024)}KB (${mimeType})...`)

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  let lastError

  for (const modelName of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName })
        const result = await model.generateContent([
          { text: PROMPT },
          { inlineData: { data: base64, mimeType } },
        ])

        const text = result.response.text().trim()
        console.log(`[Gemini] ✓ ${modelName} — respuesta: ${text.slice(0, 120)}`)

        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error(`Sin JSON en respuesta: ${text.slice(0, 200)}`)

        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.total == null && !parsed.vendor) throw new Error('Datos insuficientes')

        return parsed
      } catch (err) {
        lastError = err
        const is503 = err.message?.includes('503') || err.status === 503
        const is429 = err.message?.includes('429') || err.status === 429
        if ((is503 || is429) && attempt === 1) {
          console.log(`[Gemini] ${modelName} ocupado (${is503 ? 503 : 429}), reintentando en 4s...`)
          await new Promise(r => setTimeout(r, 4000))
        } else {
          console.log(`[Gemini] ${modelName} falló: ${err.message?.slice(0, 80)}`)
          break
        }
      }
    }
  }

  throw lastError || new Error('Todos los modelos de Gemini fallaron')
}
