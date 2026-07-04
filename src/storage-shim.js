if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key)
      if (value === null) throw new Error('not found')
      return { key, value }
    },
    async set(key, value) {
      localStorage.setItem(key, value)
      return { key, value }
    },
    async delete(key) {
      localStorage.removeItem(key)
      return { key, deleted: true }
    },
    async list(prefix = '') {
      return { keys: Object.keys(localStorage).filter((key) => key.startsWith(prefix)) }
    },
  }
}
