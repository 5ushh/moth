import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

// the only things the ui can do. no node, no fs, no raw ipc.
const api = {
  chat: (id: string, model: string, messages: ChatMessage[]): void =>
    ipcRenderer.send('chat', { id, model, messages }),

  stop: (id: string): void => ipcRenderer.send('chat:stop', id),

  onChunk: (cb: (id: string, text: string) => void): (() => void) => {
    const l = (_e: IpcRendererEvent, id: string, text: string): void => cb(id, text)
    ipcRenderer.on('chat:chunk', l)
    return () => ipcRenderer.removeListener('chat:chunk', l)
  },

  onDone: (cb: (id: string) => void): (() => void) => {
    const l = (_e: IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('chat:done', l)
    return () => ipcRenderer.removeListener('chat:done', l)
  },

  onError: (cb: (id: string, msg: string) => void): (() => void) => {
    const l = (_e: IpcRendererEvent, id: string, msg: string): void => cb(id, msg)
    ipcRenderer.on('chat:error', l)
    return () => ipcRenderer.removeListener('chat:error', l)
  },

  models: (): Promise<string[] | null> => ipcRenderer.invoke('ollama:models'),

  loadChats: (): Promise<unknown[]> => ipcRenderer.invoke('chats:load'),

  saveChats: (chats: unknown[]): Promise<void> => ipcRenderer.invoke('chats:save', chats)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
