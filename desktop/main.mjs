import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { hostOptions } from './options.mjs'
import { startStandalone } from '../lib/standalone.js'

let host
let window
let stopping = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (!host) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    host.stop().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
  })
  app.whenReady().then(async () => {
    const windowKey = randomUUID()
    const argv = process.argv.slice(process.defaultApp ? 2 : 1).filter(arg => !arg.startsWith('-psn_') && !/^--(?:inspect|remote-debugging-port)=/.test(arg))
    host = await startStandalone({ ...hostOptions(argv), windowKey })
    const origin = `http://127.0.0.1:${host.host.http.port}`
    const panel = session.fromPartition('superagent-panel')
    panel.webRequest.onBeforeSendHeaders((details, done) => {
      if (new URL(details.url).origin !== origin) return done({ cancel: true })
      done({ requestHeaders: { ...details.requestHeaders, 'x-superagent-window': windowKey } })
    })
    const canCopy = (permission, requestingUrl, isMainFrame) =>
      permission === 'clipboard-sanitized-write' && isMainFrame && URL.parse(requestingUrl ?? '')?.origin === origin
    panel.setPermissionRequestHandler((_contents, permission, done, details) => {
      done(canCopy(permission, details.requestingUrl, details.isMainFrame))
    })
    panel.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
      canCopy(permission, requestingOrigin, details.isMainFrame))
    window = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, title: 'GlorySuperAgent',
      webPreferences: { session: panel, sandbox: true, nodeIntegration: false, contextIsolation: true } })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url).catch(console.error)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', event => { if (new URL(event.url).origin !== origin) event.preventDefault() })
    await window.loadURL(origin)
  }).catch(error => { dialog.showErrorBox('GlorySuperAgent could not start', error.message); app.quit() })
}
