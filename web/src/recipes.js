import { highlight } from './claim.js'
import { trackEvent } from './analytics.js'

const owner = { github: 'you' }

const RECIPES = [
  {
    label: 'GitHub Pages', name: 'pomodoro',
    doc: { owner, description: 'A focus timer', records: { CNAME: 'you.github.io' } },
    note: 'In your repo, open Settings, then Pages, and set the custom domain to <code>pomodoro.is-my.app</code>. GitHub issues the certificate.',
  },
  {
    label: 'Vercel', name: 'habits',
    doc: { owner, description: 'A tiny habit tracker', records: { CNAME: 'cname.vercel-dns.com' }, vercel: 'vc-domain-verify=habits.is-my.app,<code>' },
    note: 'Add <code>habits.is-my.app</code> under Settings, Domains in your Vercel project, and use the CNAME target it shows if it differs. Paste the value Vercel asks for at <code>_vercel.is-my.app</code> into <code>"vercel"</code>.',
  },
  {
    label: 'Netlify', name: 'weather',
    doc: { owner, description: 'Weather at a glance', records: { CNAME: 'your-site.netlify.app' } },
    note: 'Add <code>weather.is-my.app</code> as a domain you already own under Domain management in Netlify.',
  },
  {
    label: 'Your server', name: 'chess',
    doc: { owner, description: 'Multiplayer chess', records: { A: ['203.0.113.10'], AAAA: ['2001:db8::10'] }, proxied: true },
    note: '<code>"proxied": true</code> puts Cloudflare in front of your box, so you get HTTPS without running certbot. Drop it to serve TLS yourself.',
  },
  {
    label: 'Vite or React', name: 'snake',
    doc: { owner, description: 'Snake, but fast', deploy: { repo: 'you/snake', build: 'npm ci && npm run build', output: 'dist' } },
    note: 'No host needed. We build it in a clean <code>node:22</code> container with no secrets and serve the output from the edge. Push to <code>main</code> and it redeploys.',
  },
  {
    label: 'Plain HTML', name: 'tetris',
    doc: { owner: { github: 'jn-aman' }, description: 'Tetris in the browser', deploy: { repo: 'jn-aman/tetris', branch: 'master', build: 'mkdir -p dist && cp *.html *.css *.js dist/', output: 'dist' } },
    note: 'This one is real. <a href="https://tetris.is-my.app" target="_blank" rel="noopener">tetris.is-my.app</a> went live from exactly this file.',
  },
]

export function initRecipes(root) {
  const tabs = root.querySelector('[data-recipe-tabs]')
  const code = root.querySelector('[data-recipe-code]')
  const file = root.querySelector('[data-recipe-file]')
  const note = root.querySelector('[data-recipe-note]')
  const copy = root.querySelector('[data-recipe-copy]')
  let json = ''

  tabs.innerHTML = RECIPES.map((r, i) =>
    `<button type="button" role="tab" id="recipe-${i}" aria-selected="false" tabindex="-1">${r.label}<small>${r.name}</small></button>`,
  ).join('')
  const buttons = [...tabs.children]

  function select(i, focus = false) {
    const r = RECIPES[i]
    buttons.forEach((b, j) => {
      b.setAttribute('aria-selected', String(i === j))
      b.tabIndex = i === j ? 0 : -1
    })
    if (focus) buttons[i].focus()
    json = JSON.stringify(r.doc, null, 2) + '\n'
    code.innerHTML = highlight(json)
    code.setAttribute('aria-labelledby', `recipe-${i}`)
    file.textContent = r.name
    note.innerHTML = r.note
  }

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (b) {
      const index = buttons.indexOf(b)
      select(index)
      trackEvent('Recipe selected', { label: RECIPES[index].label, name: RECIPES[index].name })
    }
  })
  tabs.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const i = buttons.indexOf(document.activeElement)
    const next = (i + step + buttons.length) % buttons.length
    select(next, true)
    trackEvent('Recipe selected', { label: RECIPES[next].label, name: RECIPES[next].name })
  })
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(json)
      copy.textContent = 'copied'
      trackEvent('Recipe code copied', { recipe: file.textContent || 'unknown' })
    } catch {
      copy.textContent = 'failed'
      trackEvent('Recipe code copy failed', { recipe: file.textContent || 'unknown' })
    }
    setTimeout(() => (copy.textContent = 'copy'), 1600)
  })
  select(0)
}
