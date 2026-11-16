import { useState, useRef, useEffect, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Message = { role: 'user' | 'assistant'; content: string }
type Chat = { id: string; title: string; model: string; messages: Message[] }
type Run = {
  id: string
  model: string
  content: string
  start: number
  firstAt?: number
  end?: number
  chunks: number
  error?: string
}

const MODELS = ['llama3.2', 'qwen2.5:3b']

// live speed stats for compare mode (each streamed chunk ≈ one token)
function stats(r: Run): string {
  if (r.error) return 'failed'
  if (!r.firstAt) return 'thinking...'
  const ttft = ((r.firstAt - r.start) / 1000).toFixed(1)
  const secs = ((r.end ?? Date.now()) - r.firstAt) / 1000
  const tps = secs > 0 ? (r.chunks / secs).toFixed(1) : '–'
  return `${tps} tok/s · first token ${ttft}s · ${r.chunks} tokens`
}

function Md({ text }: { text: string }): React.JSX.Element {
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
}

function App(): React.JSX.Element {
  const [mode, setMode] = useState<'chat' | 'compare'>('chat')
  const [savedChats, setSavedChats] = useState<Chat[]>([])
  const [ready, setReady] = useState(false)
  const [chatId, setChatId] = useState<string>(() => crypto.randomUUID())
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState(MODELS[0])
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [winner, setWinner] = useState<string | null>(null)
  const [wins, setWins] = useState<Record<string, number>>({})
  const [installed, setInstalled] = useState<string[] | null | undefined>(undefined)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const currentId = useRef<string | null>(null)

  // load saved chats, and keep checking that ollama is up
  useEffect(() => {
    window.api.loadChats().then((saved) => {
      setSavedChats(saved as Chat[])
      setReady(true)
    })
    const check = (): void => {
      window.api.models().then(setInstalled)
    }
    check()
    const timer = setInterval(check, 10000)
    return () => clearInterval(timer)
  }, [])

  // when summoned with the hotkey, jump straight into the text box
  useEffect(() => {
    const onFocus = (): void => inputRef.current?.focus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // history = saved chats, with the open conversation merged in at the top
  const chats = useMemo(() => {
    if (messages.length === 0) return savedChats
    const existing = savedChats.find((c) => c.id === chatId)
    if (existing && existing.messages === messages) return savedChats
    const title = existing?.title ?? messages[0].content.slice(0, 40)
    const current: Chat = { id: chatId, title, model, messages }
    return [current, ...savedChats.filter((c) => c.id !== chatId)]
  }, [savedChats, messages, chatId, model])

  // persist to disk whenever a reply has finished
  useEffect(() => {
    if (ready && !loading) window.api.saveChats(chats)
  }, [chats, ready, loading])

  // streaming listeners: route each chunk to the chat or to a compare pane by request id
  useEffect(() => {
    const offChunk = window.api.onChunk((id, text) => {
      if (id === currentId.current) {
        setMessages((m) => {
          const copy = [...m]
          const last = copy[copy.length - 1]
          copy[copy.length - 1] = { ...last, content: last.content + text }
          return copy
        })
        return
      }
      setRuns((rs) =>
        rs.map((r) =>
          r.id === id
            ? {
                ...r,
                content: r.content + text,
                chunks: r.chunks + 1,
                firstAt: r.firstAt ?? Date.now()
              }
            : r
        )
      )
    })
    const offDone = window.api.onDone((id) => {
      if (id === currentId.current) {
        setLoading(false)
        return
      }
      setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, end: Date.now() } : r)))
    })
    const offError = window.api.onError((id, msg) => {
      if (id === currentId.current) {
        setMessages((m) => {
          const copy = [...m]
          copy[copy.length - 1] = { role: 'assistant', content: `error: ${msg}` }
          return copy
        })
        setLoading(false)
        return
      }
      setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, error: msg, end: Date.now() } : r)))
    })
    return () => {
      offChunk()
      offDone()
      offError()
    }
  }, [])

  const comparing = runs.some((r) => !r.end)
  const busy = mode === 'chat' ? loading : comparing

  const missing = installed
    ? MODELS.filter((m) => !installed.some((n) => n === m || n === `${m}:latest`))
    : []

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')

    if (mode === 'compare') {
      const now = Date.now()
      const newRuns: Run[] = MODELS.map((m) => ({
        id: crypto.randomUUID(),
        model: m,
        content: '',
        start: now,
        chunks: 0
      }))
      setPrompt(text)
      setRuns(newRuns)
      setWinner(null)
      newRuns.forEach((r) => window.api.chat(r.id, r.model, [{ role: 'user', content: text }]))
      return
    }

    const history: Message[] = [...messages, { role: 'user', content: text }]
    const id = crypto.randomUUID()
    currentId.current = id
    setMessages([...history, { role: 'assistant', content: '' }])
    setLoading(true)
    window.api.chat(
      id,
      model,
      history.filter((m) => !m.content.startsWith('error:'))
    )
  }

  const stop = (): void => {
    if (mode === 'chat' && currentId.current) window.api.stop(currentId.current)
    if (mode === 'compare') runs.filter((r) => !r.end).forEach((r) => window.api.stop(r.id))
  }

  const pick = (m: string): void => {
    if (winner) return
    setWinner(m)
    setWins((w) => ({ ...w, [m]: (w[m] ?? 0) + 1 }))
  }

  const newChat = (): void => {
    if (busy) return
    setSavedChats(chats)
    setChatId(crypto.randomUUID())
    setMessages([])
    setMode('chat')
    inputRef.current?.focus()
  }

  const openChat = (c: Chat): void => {
    if (busy) return
    setSavedChats(chats)
    setChatId(c.id)
    setMessages(c.messages)
    setModel(c.model)
    setMode('chat')
  }

  const deleteChat = (id: string): void => {
    if (busy) return
    setSavedChats(chats.filter((c) => c.id !== id))
    if (id === chatId) {
      setChatId(crypto.randomUUID())
      setMessages([])
    }
  }

  return (
    <div className="app">
      <header className="header">
        <span className="logo">moth</span>

        <div className="tabs">
          <button
            className={mode === 'chat' ? 'active' : ''}
            disabled={busy}
            onClick={() => setMode('chat')}
          >
            chat
          </button>
          <button
            className={mode === 'compare' ? 'active' : ''}
            disabled={busy}
            onClick={() => setMode('compare')}
          >
            compare
          </button>
        </div>

        {mode === 'chat' ? (
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <span className="tally">{MODELS.map((m) => `${m}: ${wins[m] ?? 0}`).join(' · ')}</span>
        )}
      </header>

      {installed === null && (
        <div className="banner">
          ollama isn&apos;t running. open the ollama app (or run <code>ollama serve</code>) and moth
          will reconnect.
        </div>
      )}
      {missing.length > 0 && (
        <div className="banner">
          missing model{missing.length > 1 ? 's' : ''}: run{' '}
          {missing.map((m) => (
            <code key={m}>ollama pull {m}</code>
          ))}
        </div>
      )}

      <div className="body">
        {mode === 'chat' && (
          <aside className="sidebar">
            <button className="new" onClick={newChat} disabled={busy}>
              + new chat
            </button>
            {chats.map((c) => (
              <div
                key={c.id}
                className={`chat-item ${c.id === chatId ? 'active' : ''}`}
                onClick={() => openChat(c)}
                title={c.title}
              >
                <span>{c.title || 'untitled'}</span>
                <button
                  className="del"
                  aria-label="delete chat"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteChat(c.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </aside>
        )}

        <div className="main">
          <main className="messages">
            {mode === 'chat' && (
              <>
                {messages.length === 0 && (
                  <p className="empty">
                    ask moth anything. it runs entirely on your machine.
                    <br />
                    <span className="hint">
                      tip: press cmd/ctrl + shift + m from any app to summon moth
                    </span>
                  </p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role}`}>
                    <Md text={m.content || '…'} />
                  </div>
                ))}
                <div ref={bottomRef} />
              </>
            )}

            {mode === 'compare' && (
              <>
                {!prompt && (
                  <p className="empty">ask one question. both models answer side by side.</p>
                )}
                {prompt && <div className="prompt">{prompt}</div>}
                {runs.length > 0 && (
                  <div className="compare">
                    {runs.map((r) => (
                      <div key={r.id} className={`pane ${winner === r.model ? 'won' : ''}`}>
                        <div className="pane-head">
                          <span>{r.model}</span>
                          <span className="stats">{stats(r)}</span>
                        </div>
                        <div className="pane-body">
                          {r.error ? `error: ${r.error}` : <Md text={r.content || '…'} />}
                        </div>
                        <button
                          className="vote"
                          disabled={comparing || !!winner || !!r.error}
                          onClick={() => pick(r.model)}
                        >
                          {winner === r.model ? '✓ winner' : 'this one is better'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </main>

          <footer className="composer">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder={mode === 'chat' ? 'message moth...' : 'ask both models...'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button onClick={busy ? stop : send}>{busy ? 'stop' : 'send'}</button>
          </footer>
        </div>
      </div>
    </div>
  )
}

export default App
