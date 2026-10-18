import { useState, useEffect, useRef } from 'react'

function App() {
  // When ON, this window is excluded from screen capture/sharing (Teams, Zoom, Meet).
  // Also removes the taskbar button so no trace appears during a share.
  const [protectedFromCapture, setProtectedFromCapture] = useState(false)

  // Hide the entire app window and taskbar icon. Restore with Ctrl + Shift + H.
  const hideHandle = () => window.api.hideWindow()

  // Toggle screen-share invisibility and taskbar visibility.
  const toggleCaptureHandle = async () => {
    const next = !protectedFromCapture
    await window.api.setContentProtection(next)
    setProtectedFromCapture(next)
  }

  // While invisible to screen share, tint the app's own background with a
  // semi-transparent black (buttons/text stay fully visible) so you can
  // still make out what's behind it — the window is created with
  // transparent: true in main.js to make this possible.
  useEffect(() => {
    document.body.style.background = protectedFromCapture
      ? 'rgba(0, 0, 0, 0.55)'
      : 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)'
  }, [protectedFromCapture])

  const [activeTab, setActiveTab] = useState('home')
  const [capturedImage, setCapturedImage] = useState(null)
  const [searchStatus, setSearchStatus] = useState(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const webviewRef = useRef(null)

  // The webview renders pages in a separate process, so our own CSS can't
  // reach it — force the plain arrow cursor inside it too, on every page it loads.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const forceArrowCursor = () => {
      wv.insertCSS('*, *:hover { cursor: default !important; }').catch(() => {})
    }
    wv.addEventListener('dom-ready', forceArrowCursor)
    return () => wv.removeEventListener('dom-ready', forceArrowCursor)
  }, [])

  // The main process reports progress through each async phase (image-only
  // search, then adding text and searching again) via this event.
  useEffect(() => {
    const handler = (_event, status) => setSearchStatus(status)
    window.electron.ipcRenderer.on('lens-progress', handler)
    return () => window.electron.ipcRenderer.removeListener('lens-progress', handler)
  }, [])

  const captureAndSearch = async () => {
    if (isCapturing) return // ignore clicks while a capture/search is already running
    setIsCapturing(true)
    try {
      // Single guarded main-process call: capture (app hides itself during
      // this, so it's never in frame) → upload → search, all under one lock
      // so an overlapping trigger can't interleave with it.
      setSearchStatus('Capturing screen...')
      const contentsId = webviewRef.current?.getWebContentsId()
      const result = await window.electron.ipcRenderer.invoke('capture-and-search', contentsId)
      if (result?.base64) setCapturedImage('data:image/png;base64,' + result.base64)
      setSearchStatus(result?.error ? 'error: ' + result.error : null)
    } catch (error) {
      console.error('Screenshot capture failed:', error)
    } finally {
      setIsCapturing(false)
    }
  }

  // The main process detects a quick double-tap of "S" globally and asks us
  // to run the same flow as clicking the button. A ref avoids re-subscribing
  // (and avoids a stale closure over isCapturing) on every render. The ref is
  // updated in an effect, not during render, per the rules of hooks.
  const captureAndSearchRef = useRef(captureAndSearch)
  useEffect(() => {
    captureAndSearchRef.current = captureAndSearch
  })
  useEffect(() => {
    const handler = () => captureAndSearchRef.current()
    window.electron.ipcRenderer.on('trigger-capture', handler)
    return () => window.electron.ipcRenderer.removeListener('trigger-capture', handler)
  }, [])

  return (
    <div
      style={{
        padding: '18px 22px',
        width: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif'
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '18px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '9px',
              background: 'linear-gradient(135deg, #3b82f6, #10b981)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '15px',
              boxShadow: '0 2px 10px rgba(59, 130, 246, 0.35)'
            }}
          >
            🛡️
          </div>
          <span
            style={{
              fontSize: '16px',
              fontWeight: '700',
              color: '#f1f5f9',
              letterSpacing: '0.2px'
            }}
          >
            Privacy Shield
          </span>
        </div>

        {/* Pill tab switcher */}
        <div
          style={{
            display: 'flex',
            gap: '4px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '10px',
            padding: '4px'
          }}
        >
          {[
            { id: 'home', label: '🏠 Home' },
            { id: 'settings', label: '⚙️ Settings' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '7px 14px',
                borderRadius: '7px',
                border: 'none',
                fontSize: '13px',
                fontWeight: '600',
                color: activeTab === tab.id ? '#ffffff' : '#94a3b8',
                background: activeTab === tab.id ? '#3b82f6' : 'transparent',
                boxShadow: activeTab === tab.id ? '0 2px 8px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s ease'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Home tab */}
      {activeTab === 'home' && (
        <div style={{ flex: 1, overflow: 'auto', width: '100%', minHeight: 0 }}>
          <div style={{ display: 'flex', height: '100%', gap: '14px', minHeight: 0 }}>
            {/* Left sidebar: small action buttons, each with its shortcut shown below */}
            <div
              style={{
                width: '160px',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}
            >
              <Panel>
                <SidebarButton
                  onClick={captureAndSearch}
                  disabled={isCapturing}
                  color="#10b981"
                  hoverColor="#059669"
                  icon={isCapturing ? '⏳' : '📸'}
                  label={isCapturing ? 'Working...' : 'Capture'}
                  shortcut="Ctrl+Alt+S"
                />
              </Panel>

              {capturedImage && (
                <Panel title="Last capture">
                  <img
                    src={capturedImage}
                    alt="Last capture"
                    style={{
                      display: 'block',
                      width: '100%',
                      borderRadius: '8px',
                      border: '1px solid rgba(255,255,255,0.1)'
                    }}
                  />
                </Panel>
              )}

              {searchStatus && (
                <Panel>
                  <div
                    style={{
                      fontSize: '12px',
                      lineHeight: '1.4',
                      color: searchStatus.toLowerCase().startsWith('error') ? '#f87171' : '#93c5fd',
                      fontWeight: '600'
                    }}
                  >
                    {searchStatus}
                  </div>
                </Panel>
              )}
            </div>

            <webview
              ref={webviewRef}
              src="https://www.google.com"
              style={{
                flex: 1,
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                minHeight: 0,
                boxShadow: '0 4px 20px rgba(0,0,0,0.25)'
              }}
            />
          </div>
        </div>
      )}

      {/* Settings tab */}
      {activeTab === 'settings' && (
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            maxWidth: '360px'
          }}
        >
          <Section title="Privacy" description="Control how this app behaves during screen shares.">
            <SidebarButton
              onClick={toggleCaptureHandle}
              color={protectedFromCapture ? '#10b981' : '#3b82f6'}
              hoverColor={protectedFromCapture ? '#059669' : '#2563eb'}
              icon={protectedFromCapture ? '🙈' : '👁️'}
              label={`Invisible to share: ${protectedFromCapture ? 'ON' : 'OFF'}`}
              fullWidth
            />
            <SidebarButton
              onClick={hideHandle}
              color="#ef4444"
              hoverColor="#dc2626"
              icon="🫥"
              label="Hide"
              shortcut="Ctrl+Shift+H"
              fullWidth
            />
          </Section>

          <Section title="Shortcuts" description="Work globally, even when the app isn't focused.">
            <SidebarButton
              icon="📸"
              label="Capture Screen"
              shortcut="Ctrl+Alt+S"
              disabled
              fullWidth
            />
            <SidebarButton
              icon="🧭"
              label="Move window"
              shortcut="Ctrl+Arrow keys"
              disabled
              fullWidth
            />
          </Section>

          <Section
            title="Window size"
            description="Transparent windows can't be drag-resized, so use these instead."
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              <SidebarButton
                onClick={() => window.api.resizeBy(-80, -60)}
                color="#475569"
                hoverColor="#334155"
                icon="➖"
                label="Smaller"
              />
              <SidebarButton
                onClick={() => window.api.resizeBy(80, 60)}
                color="#475569"
                hoverColor="#334155"
                icon="➕"
                label="Larger"
              />
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}

// Grouped settings card with a title and short description above its content.
// eslint-disable-next-line react/prop-types -- no prop-types dependency in this small app
function Section({ title, description, children }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
      }}
    >
      <div>
        <div style={{ fontSize: '13px', fontWeight: '700', color: '#f1f5f9' }}>{title}</div>
        {description && (
          <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
    </div>
  )
}

// Small translucent card used in the Home sidebar for the capture button,
// last-capture thumbnail, and status line.
// eslint-disable-next-line react/prop-types -- no prop-types dependency in this small app
function Panel({ title, children }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px',
        padding: '10px'
      }}
    >
      {title && (
        <div style={{ fontSize: '11px', fontWeight: '600', color: '#cbd5e1', marginBottom: '6px' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

// Compact button with an icon + label on top and its global shortcut (if
// any) shown as a small badge below it.
// eslint-disable-next-line react/prop-types -- no prop-types dependency in this small app
function SidebarButton({ onClick, icon, label, shortcut, color, hoverColor, disabled, fullWidth }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 12px',
        backgroundColor: color,
        color: '#ffffff',
        border: 'none',
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: '600',
        textAlign: 'left',
        opacity: disabled ? 0.55 : 1,
        width: fullWidth ? '100%' : 'auto',
        flex: fullWidth ? undefined : 1,
        transition: 'background-color 0.2s ease, transform 0.1s ease'
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = hoverColor
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = color
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {icon && <span>{icon}</span>}
        <span>{label}</span>
      </div>
      {shortcut && (
        <span
          style={{
            display: 'inline-block',
            marginTop: '5px',
            fontSize: '10px',
            fontWeight: '600',
            padding: '1px 6px',
            borderRadius: '5px',
            background: 'rgba(0,0,0,0.25)',
            opacity: 0.85
          }}
        >
          {shortcut}
        </span>
      )}
    </button>
  )
}

export default App
