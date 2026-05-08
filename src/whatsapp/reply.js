export async function sendReply(sock, to, text) {
  try {
    await sock.sendMessage(to, { text })
  } catch (err) {
    console.error('[Reply] Error enviando mensaje:', err.message)
  }
}
