import { WebSocketServer, WebSocket } from 'ws'
import { isValidToken } from '../api/auth.js'

let wss = null

export function initWebSocket(server) {
  wss = new WebSocketServer({ noServer: true })

  // Autenticar antes del upgrade — rechaza la conexión si el token no es válido.
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const token = url.searchParams.get('token') || ''
      if (!isValidToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } catch {
      try { socket.destroy() } catch {}
    }
  })

  wss.on('connection', (ws) => {
    ws.on('error', (err) => console.error('[WS] Error en cliente:', err.message))
    ws.send(JSON.stringify({ event: 'connected', data: { message: 'FacturaIA en tiempo real activo' } }))
  })

  console.log('[WS] Servidor WebSocket iniciado (auth requerida)')
  return wss
}

export function broadcast(event, data) {
  if (!wss) return
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() })
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

