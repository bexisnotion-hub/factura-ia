import { extractWithGemini } from './gemini.js'
import { extractWithClaude } from './claude-vision.js'
import { extractWithOCR } from './ocr-fallback.js'

const EXTRACTORS = [
  { name: 'Gemini Vision', fn: extractWithGemini, enabled: () => !!process.env.GEMINI_API_KEY },
  { name: 'Claude Vision', fn: extractWithClaude, enabled: () => !!process.env.ANTHROPIC_API_KEY },
  { name: 'OCR Local', fn: extractWithOCR, enabled: () => true },
]

export async function extractInvoiceData(filePath, mimeType) {
  const errors = []

  for (const extractor of EXTRACTORS.filter((e) => e.enabled())) {
    try {
      console.log(`[Extractor] Intentando con ${extractor.name}...`)
      const result = await extractor.fn(filePath, mimeType)
      if (result && (result.total || result.vendor)) {
        console.log(`[Extractor] Éxito con ${extractor.name} (confianza: ${result.confidence})`)
        return { ...result, extractedBy: extractor.name }
      }
      errors.push({ extractor: extractor.name, error: 'Sin datos suficientes' })
    } catch (err) {
      console.warn(`[Extractor] ${extractor.name} falló:`, err.message)
      errors.push({ extractor: extractor.name, error: err.message })
    }
  }

  throw new Error(`Todos los extractores fallaron: ${errors.map((e) => `${e.extractor}(${e.error})`).join(', ')}`)
}
