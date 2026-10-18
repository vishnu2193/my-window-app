import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  webContents,
  desktopCapturer,
  screen
} from 'electron'
import { join } from 'path'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

let mainWindow = null
// Survives window recreation (needed to shrink a transparent window on
// Windows, which otherwise refuses to shrink via setSize once grown).
let contentProtectionOn = false

// DevTools in a detached window keeps its own taskbar entry, so close it too.
function hideApp() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
    win.setSkipTaskbar(true)
    win.hide()
  }
}

function showApp() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.show()
  }
  mainWindow?.focus()
}

// Hides the app window, captures the whole screen behind it, restores the
// window, and returns the path to the saved PNG (app itself is never in frame).
async function captureScreen() {
  hideApp()
  await new Promise((r) => setTimeout(r, 250))
  try {
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scaleFactor),
        height: Math.round(display.size.height * scaleFactor)
      }
    })
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source available')

    const tempFile = path.join(os.tmpdir(), 'screenshot-' + Date.now() + '.png')
    fs.writeFileSync(tempFile, source.thumbnail.toPNG())
    console.log('Screenshot saved:', tempFile, fs.statSync(tempFile).size, 'bytes')
    showApp()
    return tempFile
  } catch (err) {
    console.error('Screen capture failed:', err)
    showApp()
    return null
  }
}

// Drives the real Google Images "search by image" upload via DevTools
// Protocol: sets the file directly on the page's (hidden) file input, same
// as a human picking a file, so it rides the actual browser session/cookies
// instead of a hand-built API request (which Google was silently rejecting).
async function searchGoogleLensInWebview(contentsId, imagePath, notify = () => {}) {
  const wc = webContents.fromId(contentsId)
  if (!wc) throw new Error('Target browser view not found')

  // Guard every step with a timeout so a stuck CDP call can't hang the UI.
  const withTimeout = (promise, label, ms = 8000) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms))
    ])

  // Repeatedly runs checkFn until it returns truthy or timeoutMs elapses.
  const pollUntil = async (checkFn, timeoutMs, intervalMs = 400) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await checkFn()) return true
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  // Navigating away from a page that's still mid-load makes Electron reject
  // loadURL with ERR_ABORTED for the *previous* page — that's an expected
  // side effect here, not a real failure, so swallow just that error.
  const safeLoadURL = async (url) => {
    try {
      await wc.loadURL(url)
    } catch (err) {
      // errno -3 is Chromium's ERR_ABORTED — the message/code text varies,
      // so check the numeric code instead of matching strings.
      const isAborted = err?.errno === -3 || /ERR_ABORTED|\(-3\)/.test(String(err?.message))
      if (!isAborted) throw err
    }
  }

  console.log('[lens] navigating to Google Images')
  // Google sticks a previous Lens session onto images.google.com if the
  // webview still has that session/cookies loaded, redirecting straight back
  // to old results instead of the plain upload page. Clearing to about:blank
  // first breaks that continuity so each capture starts fresh.
  await withTimeout(safeLoadURL('about:blank'), 'loadURL about:blank', 5000)
  // A lingering redirect from the just-cleared page can abort this next
  // navigation too, silently leaving us on about:blank — verify it actually
  // landed and retry if not, instead of trusting a resolved promise alone.
  for (let attempt = 0; attempt < 3; attempt++) {
    await withTimeout(safeLoadURL('https://images.google.com/'), 'loadURL', 15000)
    if (wc.getURL() !== 'about:blank') break
    console.warn('[lens] navigation landed on about:blank, retrying')
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log('[lens] page loaded:', wc.getURL())

  const dbg = wc.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  try {
    await withTimeout(dbg.sendCommand('DOM.enable'), 'DOM.enable')
    await withTimeout(dbg.sendCommand('Runtime.enable'), 'Runtime.enable')

    // Runs a JS expression in the page and returns its value directly,
    // instead of callers repeatedly destructuring `{ result } => result.value`.
    const evalJS = async (expression) => {
      const { result } = await dbg.sendCommand('Runtime.evaluate', { expression })
      return result?.value
    }

    // Dispatches a full real keypress (down + optional char + up) —
    // 'rawKeyDown' (not 'keyDown') is what triggers the page's default
    // action, e.g. actually submitting a form on Enter.
    const pressKey = async (key, windowsVirtualKeyCode, { withChar = false } = {}) => {
      await dbg.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode,
        key,
        code: key
      })
      if (withChar) {
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type: 'char',
          text: '\r',
          key,
          code: key
        })
      }
      await dbg.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode,
        key,
        code: key
      })
    }

    // Click the camera / "search by image" icon so Google renders the
    // upload modal (and its file input) into the DOM.
    console.log('[lens] clicking search-by-image icon')
    await withTimeout(
      evalJS(`
          (function() {
            const el = document.querySelector('[aria-label*="image" i], [aria-label*="camera" i], div[jsaction*="drag"] svg, .nDcEnd');
            if (el) { el.click(); return true; }
            return false;
          })();
        `),
      'click search-by-image icon'
    )

    // Give the modal a moment to render its (otherwise hidden) file input.
    await new Promise((r) => setTimeout(r, 600))

    const findFileInputNodeId = async (label) => {
      const { root } = await withTimeout(
        dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }),
        `DOM.getDocument${label}`
      )
      const { nodeId } = await withTimeout(
        dbg.sendCommand('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: 'input[type="file"]'
        }),
        `DOM.querySelector${label}`
      )
      return nodeId
    }

    let nodeId = await findFileInputNodeId('')

    if (!nodeId) {
      // Likely landed on a leftover Lens results page instead of the plain
      // upload page — force a hard reload (bypassing cache/redirect) and
      // retry once before giving up.
      console.warn('[lens] upload field missing, forcing a hard reload and retrying')
      wc.reloadIgnoringCache()
      await withTimeout(
        new Promise((resolve) => wc.once('did-finish-load', resolve)),
        'hard reload',
        15000
      )
      await new Promise((r) => setTimeout(r, 600))
      nodeId = await findFileInputNodeId(' (retry)')
    }

    if (!nodeId) throw new Error('Could not find the upload field on Google Images')
    console.log('[lens] found file input, setting file')

    const startingUrl = wc.getURL()
    notify('Uploading screenshot to Google Images...')
    await withTimeout(
      dbg.sendCommand('DOM.setFileInputFiles', {
        files: [imagePath],
        nodeId
      }),
      'DOM.setFileInputFiles'
    )
    console.log('[lens] file set — Google should now search automatically')

    // --- Phase 1: let the image-only search complete on its own first. ---
    notify('Searching by image...')
    // Google's image-search transition can be a client-side (SPA) route
    // change rather than a full navigation, so poll the URL instead of
    // relying on a navigation event.
    console.log('[lens] waiting for results page URL to change...')
    await pollUntil(async () => {
      const href = await evalJS('location.href')
      return href && href !== startingUrl
    }, 12000)
    console.log('[lens] image search results loaded:', wc.getURL())

    // --- Phase 2: once image results are in, add the text query and
    // search again, combining both. ---
    notify('Adding text to the search...')
    const boxSelector =
      'textarea[aria-label*="search" i], input[aria-label*="search" i], textarea[name="q"], input[name="q"], div[contenteditable="true"][role="combobox"], div[contenteditable="true"]'
    const boxReady = await pollUntil(
      () => evalJS(`!!document.querySelector(${JSON.stringify(boxSelector)})`),
      8000
    )
    if (!boxReady) console.warn('[lens] search box never appeared, trying anyway')

    const queryText = 'answer please'
    console.log('[lens] typing query text:', queryText)
    const fillResult = await withTimeout(
      evalJS(`
          (function() {
            const box = document.querySelector(${JSON.stringify(boxSelector)});
            if (!box) return false;
            box.focus();
            if ('value' in box) {
              const proto = box.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(box, ${JSON.stringify(queryText)});
              else box.value = ${JSON.stringify(queryText)};
            } else {
              box.textContent = ${JSON.stringify(queryText)};
            }
            box.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })();
        `),
      'fill query text'
    )

    if (fillResult) {
      await pressKey('Enter', 13, { withChar: true })

      // The search box keeps focus after submitting and Google re-shows its
      // suggestion dropdown over the (already-loaded) results — blur it and
      // press Escape to force the dropdown closed.
      await new Promise((r) => setTimeout(r, 300))
      await evalJS('document.activeElement && document.activeElement.blur();')
      await pressKey('Escape', 27)

      // Nudge the page down a bit and expand the AI Overview's "Show more"
      // if it's there. Wait for Google to actually finish rendering the
      // answer first (poll for it) instead of a blind fixed delay, so we
      // don't scroll/click before the content exists yet.
      const showMoreExists = () =>
        evalJS(`
            Array.from(document.querySelectorAll('div[role="button"], button, span[role="button"]')).some(
              (el) => el.textContent.trim().toLowerCase() === 'show more'
            )
          `)
      await pollUntil(showMoreExists, 6000)
      await evalJS(`
          (function() {
            window.scrollBy({ top: 80, behavior: 'smooth' });
            const candidates = Array.from(document.querySelectorAll('div[role="button"], button, span[role="button"]'));
            const showMore = candidates.find(
              (el) => el.textContent.trim().toLowerCase() === 'show more'
            );
            if (showMore) showMore.click();
            return !!showMore;
          })();
        `)

      console.log('[lens] submitted combined image + text search')
      notify('Done')
    } else {
      console.warn('[lens] could not find the "Add to your search" box')
      notify('Could not find the search box, showing image-only results')
    }
  } finally {
    if (dbg.isAttached()) dbg.detach()
  }
}

function createWindow(bounds) {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 900,
    height: bounds?.height ?? 670,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    resizable: true,
    // Lets the renderer make its background crisply see-through when
    // "Invisible to screen share" is on — must be set here, can't be
    // toggled afterwards. Trade-off: Windows drops drag-to-resize AND
    // refuses to shrink a transparent window via setSize at all once it's
    // grown (confirmed: getSize() still reports the larger size after a
    // shrink attempt) — so shrinking is done by recreating the window
    // instead (see window:resize-by below).
    transparent: true,
    backgroundColor: '#00000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  // Off by default; the renderer's "Invisible to screen share" toggle turns
  // this (and setSkipTaskbar) on via window:set-content-protection.
  mainWindow.setContentProtection(contentProtectionOn)
  mainWindow.setSkipTaskbar(contentProtectionOn)
  const thisWindow = mainWindow
  thisWindow.on('ready-to-show', () => {
    thisWindow.show()
  })

  // Guarded by identity: when shrinking recreates the window, the *old*
  // window's closed event must not null out the *new* mainWindow reference.
  thisWindow.on('closed', () => {
    if (mainWindow === thisWindow) mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.on('window:hide', () => {
    hideApp()
  })

  // Guards against overlapping capture/search runs regardless of trigger
  // source (button click vs. global shortcut racing each other). This spans
  // the *entire* capture → upload → search lifecycle in one lock, since two
  // overlapping Lens searches on the same webview can interleave requests
  // and Google rejects the result as a malformed request.
  let captureBusy = false

  // Combined capture + upload + search, all under one lock, so a second
  // trigger while the first is still running is rejected outright instead
  // of starting a second navigation on the same webview concurrently.
  ipcMain.handle('capture-and-search', async (event, contentsId) => {
    if (captureBusy) return { error: 'Already capturing — please wait' }
    if (typeof contentsId !== 'number') return { error: 'No target browser view' }
    captureBusy = true
    try {
      const tempFilePath = await captureScreen()
      if (!tempFilePath) return { error: 'Screen capture failed' }

      const base64 = fs.readFileSync(tempFilePath).toString('base64')
      const notify = (status) => event.sender.send('lens-progress', status)
      await searchGoogleLensInWebview(contentsId, tempFilePath, notify)
      return { ok: true, base64 }
    } catch (error) {
      console.error('Google Lens search failed:', error)
      return { error: error.message }
    } finally {
      captureBusy = false
    }
  })

  ipcMain.handle('window:set-content-protection', (_event, enabled) => {
    const on = Boolean(enabled)
    contentProtectionOn = on
    for (const win of BrowserWindow.getAllWindows()) {
      win.setContentProtection(on)
      // The taskbar is itself captured during a share, so drop the button too.
      win.setSkipTaskbar(on)
    }
    return on
  })

  // Compensates for losing drag-to-resize on the transparent window.
  // Growing works fine via setSize, but Windows refuses to shrink a
  // transparent window at all once it's grown (confirmed via testing —
  // getSize() keeps reporting the larger size) — so shrinking recreates
  // the window instead, which is the only way that actually works.
  ipcMain.on('window:resize-by', (_event, dw, dh) => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    const targetW = Math.max(300, bounds.width + dw)
    const targetH = Math.max(200, bounds.height + dh)

    if (dw >= 0 && dh >= 0) {
      mainWindow.setSize(targetW, targetH)
      return
    }

    const wasVisible = mainWindow.isVisible()
    const oldWindow = mainWindow
    createWindow({ x: bounds.x, y: bounds.y, width: targetW, height: targetH })
    if (wasVisible) {
      mainWindow.once('ready-to-show', () => oldWindow.close())
    } else {
      oldWindow.close()
    }
  })

  createWindow()

  // register() returns false (without throwing) if the combo is already
  // claimed by the OS or another app — log it so a silent failure is visible.
  const registerShortcut = (accelerator, handler) => {
    const ok = globalShortcut.register(accelerator, handler)
    console.log(
      ok
        ? `[shortcut] registered ${accelerator}`
        : `[shortcut] FAILED to register ${accelerator} (already in use?)`
    )
    return ok
  }

  // Bring the window back after it has been hidden.
  registerShortcut('CommandOrControl+Shift+H', () => {
    if (!mainWindow) return createWindow()
    if (mainWindow.isVisible()) {
      hideApp()
    } else {
      showApp()
    }
  })

  // Trigger Capture Screen from anywhere, even if the app isn't focused.
  // Windows fires key-repeat events while the combo is held, which would
  // otherwise invoke this multiple times for a single press — debounce it.
  let lastCaptureTriggerAt = 0
  registerShortcut('CommandOrControl+Alt+S', () => {
    const now = Date.now()
    if (now - lastCaptureTriggerAt < 1500) return
    lastCaptureTriggerAt = now
    mainWindow?.webContents.send('trigger-capture')
  })

  // Nudge the window around the screen with Ctrl + Arrow keys.
  const STEP = 40
  const moveWindow = (dx, dy) => {
    if (!mainWindow) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + dx, y + dy)
  }
  registerShortcut('CommandOrControl+Left', () => moveWindow(-STEP, 0))
  registerShortcut('CommandOrControl+Right', () => moveWindow(STEP, 0))
  registerShortcut('CommandOrControl+Up', () => moveWindow(0, -STEP))
  registerShortcut('CommandOrControl+Down', () => moveWindow(0, STEP))

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
