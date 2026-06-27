// src/utils/lichessAuth.js

export function authenticateWithLichess(workerUrl) {
  return new Promise((resolve, reject) => {
    const width = 600
    const height = 700
    const left = (window.screen.width - width) / 2
    const top = (window.screen.height - height) / 2

    const popup = window.open(
      `${workerUrl}/authorize`,
      'Lichess Login',
      `width=${width},height=${height},left=${left},top=${top}`
    )

    const messageHandler = (event) => {
      if (event.data.type === 'lichess_auth') {
        window.removeEventListener('message', messageHandler)
        resolve(event.data.token)
      }
    }

    window.addEventListener('message', messageHandler)

    // Check if popup was blocked
    if (!popup || popup.closed) {
      reject(new Error('Popup blocked'))
    }

    // Check if popup was closed
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed)
        window.removeEventListener('message', messageHandler)
        reject(new Error('Authentication cancelled'))
      }
    }, 1000)
  })
}
