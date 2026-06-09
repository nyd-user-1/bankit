# Bank It

A quick, push-your-luck party game. Pick a category, see **20** answers, and tap the **10** you think are on the hidden list.

- **+1** for every answer that's really on the list
- **One wrong tap ends the round** — so *bank it & stop* while you're ahead
- End of round, the answers you missed flip gold and the decoys fade, so you always see what was on the list

Four boards to start: **Things NYSGPT Builds · Vending Machine Food · Kool-Aid Flavors · Christmas Things.**

## Run it

Pure static — one self-contained `index.html`, no build step, no dependencies. Open the file in a browser, or serve the folder:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Stack

Plain HTML/CSS/JS in a single file. Light/dark toggle (persisted) and a live design playground (desktop only). Fonts via Google Fonts.

## Deploy

Static. Deploys as-is to Vercel (or any static host) with no build configuration.
