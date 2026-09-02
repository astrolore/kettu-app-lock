# Kettu App Lock

## What I verified before writing this (from the Kettu source you uploaded)

- Plugins are the **Vendetta/polymanifest** format: a `manifest.json` (with a
  `main` field) plus a JS file, fetched from a URL you give the "+ install a
  plugin" flow (`src/core/vendetta/plugins.ts`, `fetchPlugin`/`installPlugin`).
- Your plugin's JS is `eval`'d as `vendetta => { return <your code> }` and
  handed a `window.vendetta`-shaped object (`src/core/vendetta/api.tsx`) with
  `patcher`, `metro`, `storage`, `ui.components.Forms`, `ui.alerts`,
  `ui.semanticColors`, `plugin.storage` (a JSON file auto-persisted per
  plugin, see `createMMKVBackend`), etc. Everything this plugin uses comes
  from that object — nothing was assumed.
- Installing from an arbitrary self-hosted URL (not the official plugin
  proxy) requires **Developer Settings** enabled first: Discord → Kettu
  Settings → General → enable Developer Settings, then the Plugins page will
  let the "+" URL field accept your own URL without complaint.

## Files

- `manifest.json` — plugin manifest.
- `index.js` — the whole plugin, hand-written as plain JS (no JSX, no
  build step) so it runs as-is with no bundler — I don't have network access
  in this environment to install esbuild, and you're on an unrooted phone
  with no dev toolchain, so a build step would just be friction for no
  benefit here.

## How to install it

Kettu fetches plugins over HTTP(S) from a URL ending in `/`, expecting
`manifest.json` and `index.js` at that URL. You need to host these two files
somewhere reachable from your phone. Easiest options:

1. **GitHub/Codeberg Pages or a gist raw URL** — push this folder to a repo,
   enable Pages, and use `https://yourname.github.io/kettu-app-lock/` as the
   install URL.
2. **On-device**: install Termux, run a static file server (e.g.
   `python3 -m http.server` or `npx http-server`) inside the folder, and
   install from `http://127.0.0.1:<port>/`.

Then in Kettu: Settings → Plugins → "+" → paste the URL → Install.

If you ever edit `index.js`, bump the `"hash"` value in `manifest.json` (any
different string) — that's what `fetchPlugin` checks to decide whether to
re-download your JS on update.

## What it does

- First enable → setup screen: create a PIN (≥4 digits) + confirm, then a
  recovery password + confirm.
- Locks on cold start (locking is memory-only state, so any fresh JS load —
  app fully killed and reopened — always starts locked when enabled; this
  gives you "lock when Kettu is opened" for free, no extra plumbing needed).
- Locks on returning from background after your configured grace period
  (Immediately / 15s / 30s / 1m / 5m / 15m / Never), via React Native's
  `AppState`.
- Escalating lockout: 5 wrong PINs → 30s lockout, then doubles every further
  5 wrong attempts, capped at 30 minutes. Persisted in `plugin.storage` (disk
  file), so closing/reopening/killing Kettu does not reset or skip it.
- Settings page (shown the same place every other plugin's settings show):
  App Lock toggle, Change PIN, Grace period, Change recovery password, Lock
  now, Reset PIN (via recovery password), version.
- PIN and recovery password are stored **in plaintext** in the plugin's
  local storage file, as you asked for simplicity. That file lives in
  Discord's private app storage (not readable by other apps on a normal,
  unrooted phone), but it is not encrypted at rest.

## Real limitations (please read)

Kettu's plugin API has no "block everything else" primitive, so I built the
strongest version possible with what's actually there:

- **The overlay technique**: I patch `NavigationContainer` — Discord's own
  navigation root, which Kettu itself re-exports (`metro.common.
  NavigationNative`) — and render the lock screen as an absolutely
  positioned layer on top of whatever it renders, plus a `BackHandler`
  listener that swallows the Android back button while locked. This stops
  touch and navigation into Discord while locked. It's the same approach
  other lock-style plugins in this ecosystem use.
- **App switcher preview**: a plugin cannot set Android's `FLAG_SECURE`.
  That's a native/root-level flag; nothing in Kettu's JS plugin API exposes
  it. So if someone opens the Android recent-apps switcher, they could see a
  frozen screenshot of whatever was on screen when you backgrounded Kettu.
  Locking still keeps them from *interacting* with your account, but if this
  matters to you, minimize/lock your phone itself before switching away, or
  ask in Kettu's community whether a future core (not plugin) feature could
  add `FLAG_SECURE`.
- **Instant force-kill**: storage writes to disk happen essentially
  immediately, but there is no OS-level guarantee against a write being cut
  off if the process is killed at the exact wrong instant. In practice this
  only risks losing the *very last* lockout-counter update, not bypassing
  the PIN itself.
- **Custom alert sheets can't be force-closed**: Kettu's plugin API exposes
  `showCustomAlert` but not a matching "close this alert" function, so the
  Change PIN / Grace period / Change recovery password sheets stay open
  after you save — swipe down (or back-gesture, sheets aren't part of the
  locked overlay) to dismiss them. Everything still saves correctly; it's
  a UX rough edge, not a security or functional gap.

If you hit an error when this actually loads on your device (e.g. a
semantic-color key or Forms sub-component name has changed in your Discord
version — the Kettu source itself warns these shift between app versions),
paste me the exact error/stack and I'll adjust; I can't fully verify runtime
component names without your device's console output.
