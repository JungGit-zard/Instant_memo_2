if (!window.storage) {
  const databaseUrl = (import.meta.env.VITE_FIREBASE_DATABASE_URL || '').replace(/\/$/, '')
  const syncId = import.meta.env.VITE_FIREBASE_SYNC_ID || ''
  const firebaseEnabled = Boolean(databaseUrl && syncId)

  function pathForKey(key) {
    if (key.startsWith('todos:')) return `rooms/${syncId}/days/${key.slice('todos:'.length)}/items`
    if (key.startsWith('meta:')) return `rooms/${syncId}/meta/${key.slice('meta:'.length)}`
    return `rooms/${syncId}/storage/${encodeURIComponent(key)}`
  }

  async function firebaseRequest(key, init = {}) {
    const response = await fetch(`${databaseUrl}/${pathForKey(key)}.json`, init)
    if (!response.ok) throw new Error(`Firebase ${response.status}`)
    return response.json()
  }

  function toFirebaseBody(value) {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return JSON.stringify(value)
    }
  }

  window.storage = {
    async get(key) {
      if (firebaseEnabled) {
        const value = await firebaseRequest(key)
        if (value === null) {
          const localValue = localStorage.getItem(key)
          if (localValue === null) throw new Error('not found')
          await this.set(key, localValue)
          return { key, value: localValue }
        }
        return { key, value: typeof value === 'string' ? value : JSON.stringify(value) }
      }
      const value = localStorage.getItem(key)
      if (value === null) throw new Error('not found')
      return { key, value }
    },
    async set(key, value) {
      if (firebaseEnabled) {
        await firebaseRequest(key, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: toFirebaseBody(value),
        })
        return { key, value }
      }
      localStorage.setItem(key, value)
      return { key, value }
    },
    async delete(key) {
      if (firebaseEnabled) {
        await firebaseRequest(key, { method: 'DELETE' })
        return { key, deleted: true }
      }
      localStorage.removeItem(key)
      return { key, deleted: true }
    },
    async list(prefix = '') {
      if (firebaseEnabled && prefix === 'todos:') {
        const response = await fetch(`${databaseUrl}/rooms/${syncId}/days.json`)
        if (!response.ok) throw new Error(`Firebase ${response.status}`)
        const days = await response.json()
        const keys = new Set(Object.keys(days || {}).map((day) => `todos:${day}`))
        Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => keys.add(key))
        return { keys: [...keys] }
      }
      return { keys: Object.keys(localStorage).filter((key) => key.startsWith(prefix)) }
    },
  }
}
