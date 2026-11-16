# moth

a private, local-first desktop ai chat app. press a hotkey from anywhere, ask a question, and get an answer from a model running entirely on your own machine. no cloud, no api keys, nothing leaves your laptop.

built with **electron**, **react** and **typescript**, on top of [ollama](https://ollama.com).

<!-- add a demo gif here: docs/demo.gif -->

## features

- **summon anywhere:** `cmd/ctrl + shift + m` pops moth over any app and focuses the input. press again to hide.
- **streaming chat:** replies stream token by token from the main process to the ui over ipc, with a stop button.
- **compare mode:** send one prompt to two models at once, watch both stream side by side with live tokens/sec and time-to-first-token, then vote for the better answer.
- **chat history:** conversations are saved locally (atomic writes to the os app-data folder) and listed in a sidebar.
- **markdown rendering:** code blocks, lists, tables and bold text render properly.
- **health checks:** moth detects when ollama isn't running or a model isn't installed and tells you how to fix it.
- **cross-platform builds + auto-updates:** github actions packages mac, windows and linux builds; packaged apps update themselves from github releases.

## architecture

```
┌──────────── renderer (react) ────────────┐
│  chat ui · compare panes · history       │
│  talks only to window.api                │
└───────────────┬──────────────────────────┘
                │  preload (contextBridge)
                │  chat · stop · onChunk · onDone · onError
                │  models · loadChats · saveChats
┌───────────────┴──────────────────────────┐
│  main process (node)                      │
│  streams ollama /api/chat (ndjson)        │
│  abort controllers per request            │
│  global shortcut · auto-updater · fs      │
└───────────────┬──────────────────────────┘
                │  http://127.0.0.1:11434
           ┌────┴─────┐
           │  ollama  │  llama3.2 · qwen2.5:3b
           └──────────┘
```

**security:** context isolation on, node integration off, a strict content security policy, navigation locked to the app, and external links opened only in the system browser. the renderer can only call the handful of functions the preload exposes.

## run it locally

1. install [ollama](https://ollama.com) and pull the models:
   ```bash
   ollama pull llama3.2
   ollama pull qwen2.5:3b
   ```
2. install and start moth (node 20+):
   ```bash
   npm install
   npm run dev
   ```

## build installers

```bash
npm run build:mac     # .dmg
npm run build:win     # .exe installer
npm run build:linux   # .AppImage + .deb
```

pushing a tag like `v1.0.0` makes github actions build all three platforms and publish them as a github release, which packaged apps pick up as an auto-update.

## what i learned

- how electron splits work between the main and renderer processes, and why the preload bridge matters for security
- streaming ndjson over `fetch` and forwarding it over ipc without blocking the ui
- cold-start vs warm model latency: a model that isn't loaded yet can take several seconds to its first token, then generate faster than one that's already warm

## license

mit
