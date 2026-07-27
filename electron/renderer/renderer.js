'use strict'

const $ = id => document.getElementById(id)

// The only fields the user sets. Everything else is a fixed default in main.js.
// tm: time-only field — the user picks a time of day; the date is assumed to be today.
const FIELDS = {
  itemUrl: {el: 'itemUrl'},
  areaItemNo: {el: 'sku'},
  openIso: {el: 'openIso', tm: true},
  endIso: {el: 'endIso', tm: true},
}

const el = {
  status: $('status'),
  countdown: $('countdown'),
  token: $('token'),
  logbox: $('logbox'),
  setup: $('setup'),
  watch: $('watch'),
  setupMsg: $('setupMsg'),
  itemUrl: $('itemUrl'),
  sku: $('sku'),
  openIso: $('openIso'),
  endIso: $('endIso'),
}

let lastLookupUrl = '' // avoid re-looking-up the same URL on every blur

function fillForm(cfg) {
  for (const [key, f] of Object.entries(FIELDS)) {
    if (f.tm) continue // time fields always default to local current time, never the saved value
    const node = $(f.el)
    if (node && cfg[key] != null) node.value = cfg[key]
  }
}

function readForm() {
  const out = {}
  for (const [key, f] of Object.entries(FIELDS)) {
    if (!f.tm) out[key] = ($(f.el).value || '').trim()
  }
  // Time-only fields are pinned to TODAY's local date. If end lands at/before the drop
  // (e.g. a time just after midnight), roll it to the next day so the window stays valid.
  const open = timeToDate(el.openIso.value)
  let end = timeToDate(el.endIso.value)
  if (open && end && end <= open) end = new Date(end.getTime() + 86400000)
  out.openIso = open ? localIso(open) : ''
  out.endIso = end ? localIso(end) : ''
  return out
}

function setupMsg(text) {
  el.setupMsg.textContent = text || ''
}

function appendLog(line) {
  el.logbox.textContent += (el.logbox.textContent ? '\n' : '') + line
  el.logbox.parentElement.scrollTop = el.logbox.parentElement.scrollHeight
}

function fmtCountdown(ms) {
  if (ms == null || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = String(s % 60).padStart(2, '0')
  return `${m}:${sec} to open`
}

// Times are entered as a local time of day (today's date is assumed). For storage/arming we
// expand to full ISO8601 with the local offset so Date.parse in main reads the right instant.
function localIso(date) {
  const p = n => String(n).padStart(2, '0')
  const tz = -date.getTimezoneOffset() // minutes east of UTC, e.g. -300 for US Central (CDT)
  const sign = tz < 0 ? '-' : '+'
  const abs = Math.abs(tz)
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

// A Date's local time of day as "HH:MM:SS" — the value format of an <input type="time">.
function timeInputValue(date) {
  const p = n => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

// "HH:MM[:SS]" → a Date at that time on TODAY's local date (null if blank).
function timeToDate(timeStr) {
  if (!timeStr) return null
  const [h, m, s] = timeStr.split(':').map(Number)
  const d = new Date()
  d.setHours(h || 0, m || 0, s || 0, 0)
  return d
}

function showScreen(name) {
  const watch = name === 'watch'
  el.watch.classList.toggle('hidden', !watch)
  el.setup.classList.toggle('hidden', watch)
  window.api.setMode(watch ? 'watch' : 'setup') // main hides/shows the native browser view
}

// ── Item lookup: read the real areaItemNo from the loaded item page ──
async function lookup(url) {
  if (!url) {
    setupMsg('enter the item URL first')
    return
  }
  lastLookupUrl = url
  setupMsg('looking up item number…')
  const d = await window.api.lookupItem(url)
  if (!d || d.status === -1) {
    setupMsg('lookup failed — check the URL, or type the item number by hand')
    return
  }
  const parts = []
  if (d.skus && d.skus.length) {
    el.sku.value = d.skus[d.skus.length - 1] // the areaItemNo the cart API wants
    parts.push(`item number → ${el.sku.value}`)
  } else {
    parts.push('no item number found on the page — type it by hand')
  }
  if (d.iso && d.iso.length) {
    // Show the page's schedule for reference only — do NOT touch the time fields. They stay at
    // the current-time default you can adjust; auto-filling them was overwriting it.
    parts.push(`page drop time(s), local: ${d.iso.map(z => localIso(new Date(z))).join(', ')}`)
  }
  setupMsg(parts.join(' · '))
}

// Auto-lookup once the URL field settles (blur after an edit), and on demand.
el.itemUrl.addEventListener('change', () => {
  const url = el.itemUrl.value.trim()
  if (url && url !== lastLookupUrl) lookup(url)
})
$('lookup').addEventListener('click', () => lookup(el.itemUrl.value.trim()))

// ── Save & Start ──────────────────────────────────────────────
$('startBtn').addEventListener('click', async () => {
  const cfg = readForm()
  if (!cfg.areaItemNo) {
    setupMsg('an item number is required — click Look up or type it in')
    return
  }
  const saved = await window.api.saveConfig(cfg) // merges in the hidden defaults (qty, poll…)
  showScreen('watch')
  appendLog('config saved — arming…')
  window.api.arm(saved)
})

// ── Log in / browse — both just open the embedded browser (no arming) ──
$('loginBtn').addEventListener('click', () => showScreen('watch'))
$('browseBtn').addEventListener('click', () => showScreen('watch'))

// ── Watch screen ──────────────────────────────────────────────
$('backToSetup').addEventListener('click', () => {
  window.api.stop()
  showScreen('setup')
})
$('arm').addEventListener('click', async () => window.api.arm(await window.api.saveConfig(readForm())))
$('stop').addEventListener('click', () => window.api.stop())

// ── Embedded browser toolbar ──────────────────────────────────
const addr = $('addr')
$('navBack').addEventListener('click', () => window.api.navBack())
$('navFwd').addEventListener('click', () => window.api.navForward())
$('navReload').addEventListener('click', () => window.api.navReload())
$('navHome').addEventListener('click', () => window.api.navHome())
$('navGo').addEventListener('click', () => window.api.navGo(addr.value.trim()))
addr.addEventListener('keydown', e => {
  if (e.key === 'Enter') window.api.navGo(addr.value.trim())
})
$('useUrl').addEventListener('click', async () => {
  const url = await window.api.getUrl()
  if (!url) return
  el.itemUrl.value = url
  showScreen('setup')
  lookup(url) // pull the areaItemNo from the page you picked (times stay at the default)
})
window.api.onNavState(s => {
  if (!s) return
  if (document.activeElement !== addr) addr.value = s.url || ''
  $('navBack').disabled = !s.canBack
  $('navFwd').disabled = !s.canForward
})

// ── Live updates from main ────────────────────────────────────
window.api.onLog(appendLog)
window.api.onStatus(s => {
  if (!s) return
  el.status.className = 'status ' + s.state
  el.status.textContent = s.state.replace('_', ' ')
  el.countdown.textContent = s.state === 'waiting' ? fmtCountdown(s.remainingMs) : ''
  if (s.tokenReady != null) el.token.textContent = s.tokenReady ? 'token: ready' : 'token: —'
})

// ── Boot: load saved config into the form, land on setup ──────
;(async () => {
  const cfg = await window.api.loadConfig()
  if (cfg) {
    fillForm(cfg)
    lastLookupUrl = cfg.itemUrl || '' // don't clobber a saved item number on first blur
  }
  // Time fields always start at the current local time (drop) and one hour later (end).
  // We intentionally do NOT restore them from the saved config — just use local "now".
  const base = new Date()
  base.setSeconds(0, 0)
  el.openIso.value = timeInputValue(base)
  el.endIso.value = timeInputValue(new Date(base.getTime() + 60 * 60000))
  showScreen('setup')
})()
