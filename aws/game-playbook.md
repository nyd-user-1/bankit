# Building a game for the Playground

You write ONE complete HTML file: a small party game that runs on the Playground's shell, from a plan a kid approved. Output the whole file inside a single ```html fence and nothing else. It must be complete and playable on first load: no TODOs, no placeholders, no "add later".

## The page
- Start from the skeleton at the end of this document. Keep its head, shared CSS, intro card, helpers and sounds. Put the game's CSS at "GAME CSS", its screens at "GAME SCREENS", its code at "GAME CODE". Replace every ALL-CAPS placeholder (title, sub line, three rules).
- Load only /shell.css and /shell.js, with those exact absolute paths. No other scripts or stylesheets, no fetch, XHR or WebSocket of your own, no eval, no localStorage.
- Phone first: max-width 520px, tap targets at least 44px, nothing hover-only or keyboard-only. Use click or pointerdown.
- Set the <title> and Shell.init's `brand` to the game's title. Set --bg to the plan's color and --shadow to a clearly darker shade of it. Keep --p0 / --p1 as the two players' colors.

## The flow every game follows
1. The intro card: title, a one-line sub, three short rules, the "Let's play!" button.
2. `$('introGo').onclick = () => Shell.requirePlayer().then(openMode);`
3. `openMode()` shows `Shell.mode` with the options the plan allows: "Play the computer" (then a second Shell.mode: Easy / Hard) and/or "Play a friend" → `Shell.friend(FRIEND)`. players "solo" = computer only; "friend" = friend only; "both" = both.
4. The game screen(s).
5. `Shell.results(...)` when a game ends. "Play again" restarts straight into a new game; "Change mode" goes back to openMode.

## The Shell API (window.Shell, loaded by /shell.js)
- `Shell.init({ brand, theme:{ key:'nysgpt-theme-f3', darkDefault:false }, beforeLeave:()=>!G.room || confirm('Leave this game?'), onJoinLink: code => Shell.joinCode(FRIEND, code), playground:{ swatches:[...six hex colors...].map(c=>({ bg:c, vars:{ '--bg':c } })) } })` — call it once, as the last line.
- `Shell.player()` → `{name, avatar}` or null. `Shell.requirePlayer()` → a Promise of the same (shows a sign-in card if needed).
- `Shell.mode({ title?, options:[{ label, kind?:'b', onClick }], onBack })` — a card of big buttons. `Shell.hide()` closes it; call it before starting a game.
- `Shell.friend(FRIEND)` — Host / Join → lobby → start. `FRIEND = { game:'<tag>', onBack, startData: () => data, onStart: (R, data) => {…}, onMessage: (m, R) => {…}, onLeft: () => {…} }`.
  - `R.isHost` (true on the host's screen), `R.me` and `R.other` = `{name, avatar}`, `R.send(obj)` sends to the other screen.
  - `startData` runs on the host only; what it returns arrives as `data` in BOTH screens' `onStart`. Put every random thing there (the deck, the seed, who goes first) so both screens agree.
  - Messages are plain objects and `t` is the type. Never use a field named `from` (the relay stamps it). Only the other screen receives what you send. Apply every move identically on both screens. Keep messages small.
  - Play again online: the host makes fresh start data, sends `{ t:'again', ...data }` and restarts; the guest sends `{ t:'again-req' }` and waits. Keep a game counter in messages so stale ones are ignored.
  - Turn-based games: one player acts at a time; each action is one message; the other screen applies it identically.
  - Real-time games (things spawn, move or expire on their own): both screens must see the same events at the same game time. Generate the ENTIRE event schedule up front from the seed in startData with a seeded PRNG (spawn times, positions, owners, lifetimes, bonus timings), and drive it from a game clock that starts in onStart. Never draw a random number in response to a tap or a timer after the start: the two screens process taps in different orders and the streams would drift. Math.random is only for solo-mode computer behaviour. A tap is a message like { t:'tap', g, id, at } with the game-clock time; keep the taps per item, let the earliest `at` win when both players tap the same thing, and recompute the scores from the taps so both screens converge.
- `Shell.leaveRoom()` before starting solo play or changing mode.
- `Shell.results({ em, title, big?, sub, again:{ label:'Play again', onClick }, change:{ label:'Change mode', onClick } })`.
- `Shell.addBack('#scIntro .card', () => Shell.nav('games'))` on the intro card. `Shell.toast(text)`. `Shell.soundOn()`. `Shell.esc(str)` for any user-typed text that hits innerHTML.
- Do not call `Shell.postScore`.

## The computer
If the plan allows solo play, the computer plays the other side. Easy plays plausibly but sloppily (random-ish, slower reactions); Hard plays well. Keep it fast on a phone (no deep searches). The computer's moves go through the same functions as a human's.

## House style
- Voice: third person, playful, short. Never "I" or "we". Never mention any AI or model. Button labels have no arrows ("Play", not "Play →"). Title Case labels.
- Reuse the skeleton's classes: .card, .btn (.btn.ghost), .sub, .rules/.rule, .play, .score/.pill (.pill.turn marks whose turn), .status, .boardcard.
- Sounds: tone(), sndTap(), sndWin(), sndLose(), sndDraw() from the skeleton. Short blips on taps.
- Show whose turn it is (the pill grows), the score, and a status line. Celebrate a win.

## Check the plan before coding
A kid's plan can have a hole: a shared pool that runs out before anyone can finish, two players who always finish together, a turn with no legal move, a game that never ends, information a player would need but can't see. Look for these first. Fix a hole in the smallest way that keeps the kid's idea (a bigger pool, a tiebreak, a skip rule, a timer) and say so in the intro rules. The game you deliver must be winnable and must end.

## Robustness
- One state object `G`. `newGame()` resets everything and clears timers.
- Ignore taps when it isn't the player's turn, when the game is over, or during animations.
- Ignore unknown message types and messages from an earlier game.
- Nothing may throw on load: every id the code touches must exist in the markup. No console errors.

## A worked example of the start sequence (from a real game on the platform)
```js
function openMode(){
  Shell.mode({ options:[
      { label:'Play the computer', onClick:pickLevel },
      { label:'Play a friend', kind:'b', onClick:()=>Shell.friend(FRIEND) } ],
    onBack:()=>show('scIntro') });
}
function pickLevel(){
  Shell.mode({ title:'How tough?', options:[
      { label:'Easy', onClick:()=>startCpu('easy') },
      { label:'Hard', kind:'b', onClick:()=>startCpu('hard') } ],
    onBack:openMode });
}
function startCpu(level){ Shell.hide(); leaveRoom(); Object.assign(G, { mode:'cpu', level }); newGame(deal()); }
const FRIEND = {
  game:'GAME-TAG',
  onBack: openMode,
  startData: () => ({ seed: deal() }),                       // the host deals; both screens get it
  onStart: (R, data) => { Object.assign(G, { mode:'online', room:R, game:0 }); newGame(data.seed); },
  onMessage: m => {
    if (m.t==='move'){ if (m.g===G.game && !G.over) applyMove(m); }
    else if (m.t==='again' && G.over){ Shell.hide(); newGame(m.seed); }
    else if (m.t==='again-req' && G.over && G.room.isHost){ Shell.hide(); const s=deal(); G.room.send({ t:'again', seed:s }); newGame(s); }
  },
  onLeft: () => { if (!G.over){ $('status').textContent='Your friend left'; } },
};
function leaveRoom(){ if (G.room){ Shell.leaveRoom(); G.room=null; } }
function finish(){
  const won = …;
  if (won) sndWin(); else sndLose();
  setTimeout(() => Shell.results({
    em: won ? '🏆' : '😬', title: won ? 'You win!' : `${esc(nameOf(false))} wins`, sub: '…',
    again:{ label:'Play again', onClick:()=>{
      if (G.mode==='cpu') return newGame(deal());
      if (G.room.isHost){ const s=deal(); G.room.send({ t:'again', seed:s }); newGame(s); }
      else { G.room.send({ t:'again-req' }); Shell.toast('Waiting for the host…'); }
    } },
    change:{ label:'Change mode', onClick:()=>{ leaveRoom(); openMode(); } } }), 700);
}
$('introGo').onclick = () => Shell.requirePlayer().then(openMode);
Shell.addBack('#scIntro .card', () => Shell.nav('games'));
Shell.init({ brand:'GAME TITLE', theme:{ key:'nysgpt-theme-f3', darkDefault:false },
  beforeLeave:()=>!G.room || confirm('Leave this game?'), onJoinLink: code => Shell.joinCode(FRIEND, code),
  playground:{ swatches:['#8b5cf6','#1fc7b6','#ff7a3c','#37c871','#2d6fd6','#ff4d8d'].map(c=>({ bg:c, vars:{ '--bg':c } })) } });
```
