'use strict'

// Runs in the embedded p-bandai.com page's MAIN world (contextIsolation:false) BEFORE the site's
// own scripts. Scrubs the Electron fingerprints Akamai's bot sensor reads directly in JS — the
// header-level UA/Sec-CH-UA edits in main.js can't reach these. No Node is used or exposed here.
//
// Everything is derived from the browser's REAL values, so it's correct on macOS, Windows, and
// Linux alike — we only swap the "Electron" brand for "Google Chrome" and never touch the real
// platform/architecture/version (hardcoding those would mismatch the OS and look MORE suspicious).
;(() => {
  const define = (prop, value) => {
    try {
      Object.defineProperty(navigator, prop, { get: () => value, configurable: true })
    } catch {}
  }

  // Automation tell (Electron already reports false, but pin it).
  define('webdriver', false)

  // Match the Accept-Language header main.js sets.
  define('languages', Object.freeze(['en-US', 'en']))

  // Drop the "Electron" brand and ensure a "Google Chrome" entry exists at the same version as
  // Chromium (real Chrome exposes both). Preserves order and every real version string.
  const scrubBrands = list => {
    const arr = (list || []).filter(b => b && !/electron/i.test(b.brand))
    const chromium = arr.find(b => /chromium/i.test(b.brand))
    if (chromium && !arr.some(b => /google chrome/i.test(b.brand))) {
      arr.splice(arr.indexOf(chromium) + 1, 0, {
        brand: 'Google Chrome',
        version: chromium.version,
      })
    }
    return arr
  }

  // navigator.userAgentData: keep the REAL platform/architecture/version — only fix the brands.
  const orig = navigator.userAgentData
  if (orig) {
    const brands = scrubBrands(orig.brands)
    define('userAgentData', {
      brands,
      mobile: orig.mobile,
      platform: orig.platform,
      getHighEntropyValues(hints) {
        if (typeof orig.getHighEntropyValues !== 'function') {
          return Promise.resolve({ brands, mobile: orig.mobile, platform: orig.platform })
        }
        return orig.getHighEntropyValues(hints).then(v => {
          const out = { ...v }
          if (out.brands) out.brands = scrubBrands(out.brands)
          if (out.fullVersionList) out.fullVersionList = scrubBrands(out.fullVersionList)
          return out
        })
      },
      toJSON() {
        return { brands, mobile: orig.mobile, platform: orig.platform }
      },
    })
  }

  // Real Chrome exposes window.chrome; some sensors check for it.
  if (!('chrome' in window)) {
    try {
      window.chrome = { runtime: {} }
    } catch {}
  }
})()
