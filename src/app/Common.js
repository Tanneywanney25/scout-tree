// src/app/Common.js

export function parseTimeControl(tc) {
  if (!tc) return null
  const parts = tc.split('+')
  const base = parseInt(parts[0], 10)
  const increment = parts.length > 1 ? parseInt(parts[1], 10) : 0
  
  const total = base + (40 * increment)
  
  if (total < 30) return 'ultraBullet'
  if (total < 180) return 'bullet'
  if (total < 480) return 'blitz'
  if (total < 1500) return 'rapid'
  if (total < 21600) return 'classical'
  return 'correspondence'
}

export function normalizeUsername(username) {
  return username?.toLowerCase().trim() || ''
}

export function sanitizeHeaders(headers) {
  const sanitized = {}
  Object.keys(headers).forEach(key => {
    sanitized[key] = headers[key]?.trim() || ''
  })
  return sanitized
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
