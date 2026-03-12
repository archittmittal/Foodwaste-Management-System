// Lightweight client-side validators used across the app
export function isValidEmailFormat(email){
  if(!email || typeof email !== 'string') return false
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

export function isGmailAddress(email){
  if(!email) return false
  const lower = email.toLowerCase().trim()
  return lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')
}

export function isStrongPassword(pwd){
  if(!pwd || typeof pwd !== 'string') return false
  // at least 8 chars, one uppercase, one lowercase, one digit, one special char
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/
  return re.test(pwd)
}
