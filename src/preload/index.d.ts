import { ElectronAPI } from '@electron-toolkit/preload'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      chat: (id: string, model: string, messages: ChatMessage[]) => void
      stop: (id: string) => void
      onChunk: (cb: (id: string, text: string) => void) => () => void
      onDone: (cb: (id: string) => void) => () => void
      onError: (cb: (id: string, msg: string) => void) => () => void
      models: () => Promise<string[] | null>
      loadChats: () => Promise<unknown[]>
      saveChats: (chats: unknown[]) => Promise<void>
    }
  }
}
