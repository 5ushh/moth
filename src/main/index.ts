import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'

const OLLAMA_URL = 'http://127.0.0.1:11434'
const SUMMON_SHORTCUT = 'CommandOrControl+Shift+M'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'moth',
    backgroundColor: '#111114',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // security: only open http(s) links, and always in the user's browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // security: never let the window navigate away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!(is.dev && devUrl && url.startsWith(devUrl))) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    createWindow()
    return
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    win.show()
    win.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sush.moth')

  // F12 opens devtools in development, cmd/ctrl+R is ignored in production
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // summon anywhere
  if (!globalShortcut.register(SUMMON_SHORTCUT, toggleWindow)) {
    console.warn(`moth: could not register ${SUMMON_SHORTCUT}, another app is using it`)
  }

  // auto-updates (only in packaged builds; reads releases from github)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('moth: update check failed', err)
    })
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ---------------------------------------------------------------------------
// chat streaming: renderer -> main -> ollama, chunks streamed back over ipc
// ---------------------------------------------------------------------------

const inflight = new Map<string, AbortController>()

ipcMain.on('chat', async (event, { id, model, messages }) => {
  const controller = new AbortController()
  inflight.set(id, controller)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`ollama error ${res.status}${detail ? `: ${detail}` : ''}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const data = JSON.parse(line)
        if (data.error) throw new Error(data.error)
        if (data.message?.content && !event.sender.isDestroyed()) {
          event.sender.send('chat:chunk', id, data.message.content)
        }
      }
    }
    if (!event.sender.isDestroyed()) event.sender.send('chat:done', id)
  } catch (err) {
    if (event.sender.isDestroyed()) return
    if ((err as Error).name === 'AbortError') {
      event.sender.send('chat:done', id)
    } else {
      event.sender.send('chat:error', id, (err as Error).message)
    }
  } finally {
    inflight.delete(id)
  }
})

ipcMain.on('chat:stop', (_event, id: string) => {
  inflight.get(id)?.abort()
})

// which models are installed? returns null when ollama isn't reachable
ipcMain.handle('ollama:models', async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return null
  }
})

// ---------------------------------------------------------------------------
// chat history: saved as json in the os app-data folder, never leaves the machine
// ---------------------------------------------------------------------------

const chatsFile = (): string => join(app.getPath('userData'), 'chats.json')

ipcMain.handle('chats:load', async () => {
  try {
    return JSON.parse(await readFile(chatsFile(), 'utf8'))
  } catch {
    return []
  }
})

ipcMain.handle('chats:save', async (_event, chats: unknown) => {
  if (!Array.isArray(chats)) return
  const tmp = `${chatsFile()}.tmp`
  await writeFile(tmp, JSON.stringify(chats), 'utf8')
  await rename(tmp, chatsFile()) // atomic replace, so a crash can't corrupt history
})
