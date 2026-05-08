// Re-exports de compatibilidad — la lógica real está en session-manager.js
import { sessionManager } from './session-manager.js'

export { sessionManager }

// Backward compat: botState apunta a la sesión 'default'
export const botState = new Proxy({}, {
  get(_, key) { return sessionManager.botState[key] },
})

export async function connectToWhatsApp() {
  return sessionManager.init()
}
