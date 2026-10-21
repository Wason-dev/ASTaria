// Start non-rendering integrations after Electron has a first painted window.
// Each callback remains independent so one failed integration cannot block the
// others; disposal before first paint prevents new background work on quit.
function createStartupServices({ startSync, initializeReminders, onError = () => {} }) {
  let started = false, closed = false
  return {
    start() {
      if (started || closed) return
      started = true
      for (const task of [startSync, initializeReminders]) {
        try { Promise.resolve(task?.()).catch(onError) } catch (error) { onError(error) }
      }
    },
    close() { closed = true },
  }
}
module.exports = { createStartupServices }
