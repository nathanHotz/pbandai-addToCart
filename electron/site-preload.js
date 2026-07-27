'use strict'

// Runs in the embedded p-bandai.com page's MAIN world (contextIsolation:false) BEFORE the
// site's own scripts. Scrubs the Electron fingerprints Akamai's bot sensor reads directly in
// JS — the header-level UA/Sec-CH-UA edits in main.js can't reach these. No Node is used or
// exposed here, so the third-party page gains nothing beyond a plain-Chrome-looking navigator.
;(() => {
  const define = (prop, value) => {
    try {
      Object.defineProperty(navigator, prop, { get: () => value, configurable: true })
    } catch {}
  }

  // Automation tell (Electron already reports false, but pin it).
  define('webdriver', false)

  // Keep languages consistent with the Accept-Language header main.js sets.
  define('languages', Object.freeze(['en-US', 'en']))

  // navigator.userAgentData still advertises the "Electron" brand — the biggest client-side
  // giveaway. Replace it with a plain Chrome brand set (matching the spoofed UA's Chrome 130).
  const brands = [
    { brand: 'Chromium', version: '130' },
    { brand: 'Google Chrome', version: '130' },
    { brand: 'Not?A_Brand', version: '99' },
  ]
  const fullVersionList = [
    { brand: 'Chromium', version: '130.0.6723.191' },
    { brand: 'Google Chrome', version: '130.0.6723.191' },
    { brand: 'Not?A_Brand', version: '99.0.0.0' },
  ]
  const uaData = {
    brands,
    mobile: false,
    platform: 'macOS',
    getHighEntropyValues(hints) {
      const all = {
        architecture: 'arm',
        bitness: '64',
        brands,
        fullVersionList,
        mobile: false,
        model: '',
        platform: 'macOS',
        platformVersion: '15.0.0',
        uaFullVersion: '130.0.6723.191',
        wow64: false,
      }
      const out = { brands, mobile: false, platform: 'macOS' }
      if (Array.isArray(hints)) for (const h of hints) if (h in all) out[h] = all[h]
      return Promise.resolve(out)
    },
    toJSON() {
      return { brands, mobile: false, platform: 'macOS' }
    },
  }
  define('userAgentData', uaData)

  // Real Chrome exposes window.chrome; some sensors check for it.
  if (!('chrome' in window)) {
    try {
      window.chrome = { runtime: {} }
    } catch {}
  }
})()
