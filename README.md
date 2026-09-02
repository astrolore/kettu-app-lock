# Kettu App Lock

A PIN lock for Kettu, built against Kettu's actual plugin loader (verified by
reading `Kettu-github` source, not assumed). See the chat writeup for the
full source citations; short version below.

## How Kettu plugins actually work (verified)

Kettu supports two plugin systems. The "+ icon, paste a URL" flow you
described uses the **Vendetta-compatible** plugin manager
(`VdPluginManager` in `src/core/vendetta/plugins.ts`), not the core-plugin
repo system. Concretely:

- You install by pasting a URL that **ends in `/`**. Kettu fetches
  `manifest.json` from that URL, then fetches the file named in
  `manifest.main` (defaults to `index.js`) from the same URL.
- That JS file is loaded with `eval` as:
  `(vendetta => { return <your file's exact source> })(vendettaObject)`
  then, if the result is a function, it's called **with zero arguments**.
  That means the plugin file must evaluate directly to an object shaped
  like `{ onLoad, onUnload, settings }` — `settings` is a React component
  shown on the plugin's card in the Plugins list. This file is written as
  an IIFE that captures the ambient `vendetta` itself for exactly this
  reason (I hit this bug during testing and fixed it — see comment at the
  top of `index.js`).
- Plugins get a `vendetta` object exposing: patching (`vendetta.patcher`),
  metro module finding (`vendetta.metro.findByProps`, etc.), a curated set
  of RN/Discord bits (`vendetta.metro.common.React`,
  `.ReactNative` — the real `react-native` package, so `AppState`,
  `BackHandler`, `Modal` etc. are all there), Discord's alert system
  (`vendetta.ui.alerts.*`), toasts, Discord's semantic color tokens
  (`vendetta.ui.semanticColors`), and **persistent per-plugin storage**
  (`vendetta.plugin.storage`) — a plain JSON object, auto-saved to a file
  in the app's private storage on every write. That's what backs the PIN,
  recovery password, and lockout state, so they survive killing/restarting
  Kettu, per your requirement.

I did not need any additional files from you — the client repo you
uploaded contains the full plugin-loading and API surface.

## What I built

- `manifest.json` + `index.js` — no build step. It's plain JS (no JSX, no
  imports) using `React.createElement` directly, so you can install it
  straight from your phone without a bundler.

Covers: first-run setup (PIN + recovery password), lock on cold start,
lock on foreground return past a configurable grace period
(Immediately/15s/30s/1m/5m/15m/Never, default 30s), custom PIN-pad lock
screen, escalating lockouts (every 5 fails: 30s → 1m → 2m → 4m → 8m →
16m → capped at 30m, persisted so restarting Kettu doesn't reset it),
forgot-PIN recovery via the recovery password, change PIN / change
recovery password / grace period / lock now / reset PIN, all in the
plugin's settings card.

## Honest limitations (please read)

1. **Full-screen coverage.** There's no way to verify from Kettu's own
   repo what Discord's internal root component is called — Discord's UI
   code isn't in this repo, it's proprietary and only exists on your
   device at runtime. So instead of guessing a component name to patch
   (which could be wrong or break on a Discord update), the lock screen
   is rendered through Discord's own alert/overlay system
   (`vendetta.ui.alerts.showCustomAlert`, the same mechanism Kettu uses
   for its own dialogs) inside a fully-opaque `react-native` `Modal`.
   This reliably covers the screen in normal use. I also block the
   Android hardware back button while locked and re-show the lock screen
   if it's ever dismissed unexpectedly. I can't 100% guarantee no exotic
   dismiss path exists (e.g. multi-window/split-screen edge cases) —
   flagging this rather than claiming it's airtight.
2. **Plaintext storage.** Per your instructions, the PIN and recovery
   password are stored in plaintext in the plugin's storage file. On a
   non-rooted phone this isn't casually readable by another person picking
   up your unlocked phone (it's in the app's private storage), but it's
   not protected against someone with file-system access (e.g. a backup
   extraction tool, or a future root). Same caveat applies to the lockout
   counters — they resist casual bypass (kill/reopen app, navigate away)
   but aren't cryptographically tamper-proof.
3. **Colors.** Discord's semantic color token *names* have changed across
   app versions (Kettu's own source has comments about this). I used the
   commonly-stable ones with a dark-theme fallback baked in, so it'll
   look Discord-ish even if a token name doesn't resolve, but it's not
   guaranteed pixel-perfect on every Discord version.

## Hosting it

Put `manifest.json` and `index.js` in the same folder of any static host
reachable by URL — e.g. a public GitHub repo (raw.githubusercontent.com
path), a GitHub Gist, Cloudflare Pages, etc. Then in Kettu: **Plugins → +
→ paste the folder URL ending in `/`** (e.g.
`https://raw.githubusercontent.com/you/kettu-app-lock/main/`).

## Testing note

I don't have a Kettu/Discord Android runtime to execute this on, so I
validated it the ways I could from this environment: replicated Kettu's
exact `eval` loading string against this file with a stubbed `vendetta`
object to confirm it loads and returns the right shape, and exercised
`onLoad`/`settings()`/`onUnload` against that stub to catch runtime
errors. Please test on-device and tell me what breaks — some of the
Discord component/color lookups can only be confirmed live.
