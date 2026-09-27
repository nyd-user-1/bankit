// ===== shell.js — the frame every game shares =====
// Shell.init({...}) adds the top bar (menu · wordmark · theme), the context menu (this
// game's items on top, then Games / High Scores / Settings), and the design playground.
// It also owns what every game has in common:
//   Shell.player() / requirePlayer()  one identity (name + avatar) across all games
//   Shell.mode({...})                 the "how do you want to play?" screen
//   Shell.friend({...})               Play a friend: host / join → lobby → start (relay /ws)
//   Shell.results({...})              the standard end-of-game card
//   Shell.postScore(game, score)      one row on that game's leaderboard
//   Shell.soundOn()                   the Settings sound switch
(function(){
  // every page lives inside the app frame (index.html), which holds the chat panel so it
  // survives navigation. Opened on its own (a bookmark, an invite link)? Hop into the frame
  // and stop this copy before any game code runs.
  if (window.top === window && !/^\/(index\.html)?$/.test(location.pathname)){
    location.replace('/?p=' + encodeURIComponent(location.pathname.replace(/^\//,'') + location.search + location.hash));
    document.write('<plaintext style="display:none">');   // the rest of this page never runs
    return;
  }
  const USER_KEY = 'bankit-user-v1';
  const AVATARS = ['🎯','🦊','🐙','🐝','🐸','🐼','🦄','🐲','🦅','🐯','👾','🤖'];
  const root = document.documentElement;
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const el = html => { const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstElementChild; };
  let CFG = { theme:{ key:'nysgpt-theme-f3', darkDefault:false } };
  const BACK = '<button class="sh-back" type="button" aria-label="Back" title="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg></button>';
  // the back arrow, top-left of a card: Shell.addBack('#scPick .card', () => …)
  function addBack(target, fn){
    const card = typeof target==='string' ? document.querySelector(target) : target;
    if (!card || card.querySelector(':scope > .sh-back')) return;
    card.classList.add('sh-has-back');
    const b = el(BACK); b.onclick = e => { e.stopPropagation(); fn(); };
    card.prepend(b);
  }

  //// ---- identity: the same player in every game ----
  function player(){ try{ const u=JSON.parse(localStorage.getItem(USER_KEY)||'null'); return u && u.name ? u : null; }catch(e){ return null; } }
  function setPlayer(p){ localStorage.setItem(USER_KEY, JSON.stringify({ name:p.name, avatar:p.avatar||AVATARS[0] })); }
  function signOut(){ localStorage.removeItem(USER_KEY); }
  function requirePlayer(){
    const p = player(); if (p) return Promise.resolve(p);
    return new Promise(done => {
      let av = AVATARS[Math.floor(Math.random()*AVATARS.length)];
      show(`<div class="sh-card"><h2>Who's playing?</h2>
        <label class="sh-lbl" for="shName">Your name</label>
        <input class="sh-input" id="shName" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Name" style="margin-bottom:18px" />
        <label class="sh-lbl">Your avatar</label>
        <div class="sh-avs" id="shAvs">${AVATARS.map(a=>`<button type="button" class="${a===av?'on':''}">${a}</button>`).join('')}</div>
        <button class="sh-btn" id="shGo">Play</button><div class="sh-err" id="shErr"></div></div>`);
      const box=document.getElementById('shAvs');
      box.querySelectorAll('button').forEach(b => b.onclick=()=>{ box.querySelectorAll('button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); av=b.textContent; });
      const go=()=>{
        const name=document.getElementById('shName').value.trim().replace(/\s+/g,' ');
        if (name.length<2){ document.getElementById('shErr').textContent='Type your name (2+ letters).'; return; }
        setPlayer({ name, avatar:av }); hide(); done(player());
      };
      document.getElementById('shGo').onclick=go;
      document.getElementById('shName').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
      setTimeout(()=>document.getElementById('shName').focus(), 60);
    });
  }

  //// ---- settings shared by every game ----
  const soundOn = () => localStorage.getItem('bankit-sound')!=='off';
  const setSound = on => localStorage.setItem('bankit-sound', on?'on':'off');
  function isDark(){ const t=CFG.theme; return t.darkDefault ? root.getAttribute('data-theme')!=='light' : root.getAttribute('data-theme')==='dark'; }
  function setDark(d){
    const t=CFG.theme;
    if (t.darkDefault){ if (d) root.removeAttribute('data-theme'); else root.setAttribute('data-theme','light'); }
    else { if (d) root.setAttribute('data-theme','dark'); else root.removeAttribute('data-theme'); }
    try{ localStorage.setItem(t.key, d?'dark':'light'); }catch(e){}
    syncTheme();
  }
  function syncTheme(){
    root.classList.toggle('sh-dark', isDark());
    const ic=document.getElementById('shThemeIc'), lb=document.getElementById('shThemeLb');
    if (ic){ ic.textContent = isDark() ? '☀️' : '🌙'; lb.textContent = isDark() ? 'Light mode' : 'Dark mode'; }
    if (CFG.onTheme) CFG.onTheme(isDark());
  }

  //// ---- navigation between games / hub pages ----
  function nav(target){
    if (CFG.beforeLeave && !CFG.beforeLeave(target)) return;
    if (CFG.onNav && CFG.onNav(target)) return;
    location.href = 'games.html#/' + target;
  }

  //// ---- the layer that holds the standard screens ----
  let LAYER;
  function show(html){ LAYER.innerHTML = html; LAYER.classList.add('on'); LAYER.scrollTop = 0; }
  function hide(){ LAYER.classList.remove('on'); LAYER.innerHTML=''; }
  let toastT;
  function toast(t){ const e=document.getElementById('shToast'); e.textContent=t; e.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>e.classList.remove('show'),2600); }

  //// ---- init: top bar, menu, playground ----
  function init(cfg){
    CFG = Object.assign({ theme:{ key:'nysgpt-theme-f3', darkDefault:false }, gameMenu:[], playground:{} }, cfg);
    const bar = el(`<div class="sh-topbar">
      <div class="sh-brand"><button class="sh-menu-btn" id="shMenuBtn" type="button" aria-label="Open menu" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h14"/></svg></button><span>${CFG.brand||'Bank&nbsp;It'}</span></div>
      <div class="sh-ctrl" id="shCtrl"><button class="sh-iconbtn" id="shTheme" title="Toggle theme" aria-label="Toggle theme">
        <svg class="sh-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        <svg class="sh-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button></div></div>`);
    document.body.prepend(bar);
    (CFG.topExtra||[]).forEach(x => { const n = typeof x==='string' ? document.getElementById(x) : x; if (n) document.getElementById('shCtrl').prepend(n); });

    // menu: this game's items, then the platform's
    const items = CFG.gameMenu.map((m,i) => `<button class="sh-mi c${m.c??i}" data-g="${i}"><span class="ic">${m.ic}</span><span class="lb">${m.label}</span></button>`).join('');
    const menu = el(`<div class="sh-menu" id="shMenu" role="menu" aria-label="Menu">${items}${items?'<div class="sh-sep"></div>':''}
      <button class="sh-mi c3" data-nav="games"><span class="ic">🕹️</span><span class="lb">Games</span></button>
      <button class="sh-mi c2" data-nav="highscores"><span class="ic">🏆</span><span class="lb">High Scores</span></button>
      <button class="sh-mi c4" data-nav="settings"><span class="ic">⚙️</span><span class="lb">Settings</span></button>
      <button class="sh-mi c5 sh-theme" id="shThemeRow"><span class="ic" id="shThemeIc">🌙</span><span class="lb" id="shThemeLb">Dark mode</span></button></div>`);
    document.body.appendChild(menu);
    const btn=document.getElementById('shMenuBtn');
    const setOpen=on=>{ menu.classList.toggle('open',on); btn.setAttribute('aria-expanded',on?'true':'false'); };
    btn.onclick=e=>{ e.stopPropagation(); setOpen(!menu.classList.contains('open')); };
    document.addEventListener('click',e=>{ if(!menu.contains(e.target) && !btn.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') setOpen(false); });
    menu.querySelectorAll('[data-g]').forEach(b => b.onclick=()=>{ setOpen(false); CFG.gameMenu[+b.dataset.g].onClick(); });
    menu.querySelectorAll('[data-nav]').forEach(b => b.onclick=()=>{ setOpen(false); nav(b.dataset.nav); });
    document.getElementById('shTheme').onclick=()=>setDark(!isDark());
    document.getElementById('shThemeRow').onclick=()=>setDark(!isDark());

    LAYER = el(`<div class="sh-layer" id="shLayer"></div>`); document.body.appendChild(LAYER);
    document.body.appendChild(el(`<div class="sh-toast" id="shToast"></div>`));
    buildPlayground(CFG.playground);
    syncTheme();
    // invite links: #/join/1234 → sign in if needed, then straight into the room
    const m = location.hash.match(/^#\/join\/(\d{4})/);
    if (m && CFG.onJoinLink){ history.replaceState(null,'',location.pathname); requirePlayer().then(()=>CFG.onJoinLink(m[1])); }
  }

  function buildPlayground(pg){
    const rs = root.style, sw = pg.swatches || [];
    const fonts = [['"Luckiest Guy", cursive','Luckiest','font-family:"Luckiest Guy"'],['"Fredoka", sans-serif','Fredoka','font-family:Fredoka;font-weight:700'],
                   ['"Nunito", sans-serif','Nunito','font-family:Nunito;font-weight:900'],['system-ui, sans-serif','System','font-family:system-ui;font-weight:800']];
    const launch = el(`<button class="sh-iconbtn sh-pg-launch" id="shPgLaunch" type="button" aria-label="Palette" title="Palette"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="6" cy="11" r="2.5"/><circle cx="17.5" cy="13" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M13.5 9v3M8 12.5l2.5 1M15 15l-3 1.7"/></svg></button>`);
    const panel = el(`<div class="sh-pg" id="shPg" role="dialog" aria-label="Palette">
      <div class="sh-pg-head"><span class="sh-pg-title">🎨 Palette</span><button class="sh-pg-reset" id="shPgReset">Reset</button></div>
      ${sw.length ? `<div class="sh-pg-grp"><label>Stage color</label><div class="sh-pg-sw" id="shPgSw">${sw.map((c,i)=>`<i class="${i?'':'on'}" style="background:${c.bg}"></i>`).join('')}</div></div>` : ''}
      <div class="sh-pg-grp"><label>Display font</label><div class="sh-pg-fonts" id="shPgFont">${fonts.map((f,i)=>`<button class="sh-pg-font${i?'':' on'}" style='${f[2]}'>${f[1]}</button>`).join('')}</div></div>
      <div class="sh-pg-grp"><label>Depth <span class="v" id="shPopV">1.0×</span></label><input type="range" class="sh-range" id="shPop" min="0.3" max="2" step="0.1" value="1" /></div>
      ${(pg.extras||[]).map((x,i)=>`<div class="sh-pg-grp" data-x="${i}">${x.html}</div>`).join('')}</div>`);
    document.getElementById('shCtrl').appendChild(launch); document.body.appendChild(panel);
    launch.onclick=e=>{ e.stopPropagation(); panel.classList.toggle('open'); };
    document.addEventListener('click',e=>{ if(!panel.contains(e.target) && !launch.contains(e.target)) panel.classList.remove('open'); });
    const touched = new Set();
    const setVar=(k,v)=>{ rs.setProperty(k,v); touched.add(k); };
    if (sw.length) panel.querySelectorAll('#shPgSw i').forEach((i,n) => i.onclick=()=>{
      panel.querySelectorAll('#shPgSw i').forEach(x=>x.classList.remove('on')); i.classList.add('on');
      if (n===0){ Object.keys(sw[1]?.vars||{}).concat(Object.keys(sw[0].vars||{})).forEach(k=>rs.removeProperty(k)); }
      else Object.entries(sw[n].vars||{ '--bg':sw[n].bg }).forEach(([k,v])=>setVar(k,v));
    });
    panel.querySelectorAll('#shPgFont .sh-pg-font').forEach((b,n) => b.onclick=()=>{
      panel.querySelectorAll('#shPgFont .sh-pg-font').forEach(x=>x.classList.remove('on')); b.classList.add('on');
      if (n===0) rs.removeProperty('--font-display'); else setVar('--font-display', fonts[n][0]);
    });
    document.getElementById('shPop').oninput=e=>{ setVar('--pop', e.target.value); document.getElementById('shPopV').textContent=(+e.target.value).toFixed(1)+'×'; };
    (pg.extras||[]).forEach((x,i)=>{ if (x.init) x.init(panel.querySelector(`[data-x="${i}"]`), setVar); });
    document.getElementById('shPgReset').onclick=()=>{
      touched.forEach(k=>rs.removeProperty(k)); touched.clear();
      sw.forEach(c=>Object.keys(c.vars||{'--bg':1}).forEach(k=>rs.removeProperty(k)));
      panel.querySelectorAll('#shPgSw i,#shPgFont .sh-pg-font').forEach((x,n,all)=>x.classList.toggle('on', x===all[0] || (x.parentElement.id==='shPgFont' && x===x.parentElement.firstElementChild)));
      document.getElementById('shPop').value=1; document.getElementById('shPopV').textContent='1.0×';
      (pg.extras||[]).forEach((x,i)=>{ if (x.reset) x.reset(panel.querySelector(`[data-x="${i}"]`)); });
    };
  }

  //// ---- the mode screen: "how do you want to play?" ----
  function mode(o){
    show(`<div class="sh-card"><h2>${o.title||'How do you want to play?'}</h2>
      ${o.options.map((x,i)=>`${i===1 && o.options.length===2 ? '<div class="sh-or">or</div>' : ''}<button class="sh-btn ${x.kind||''}" data-i="${i}">${x.label}</button>`).join('')}</div>`);
    LAYER.querySelectorAll('[data-i]').forEach(b => b.onclick=()=>o.options[+b.dataset.i].onClick());
    if (o.onBack) addBack(LAYER.querySelector('.sh-card'), ()=>{ hide(); o.onBack(); });
  }

  //// ---- Play a friend: host / join → lobby → start, over the relay ----
  const CID = sessionStorage.getItem('sh-cid') || (()=>{ const c=Math.random().toString(36).slice(2,12); sessionStorage.setItem('sh-cid',c); return c; })();
  let F = null;   // { opts, ws, room }
  function friend(opts){ F = { opts, ws:null, room:null }; hostJoin(); }
  function hostJoin(joining, code){
    show(`<div class="sh-card"><h2>Play a friend</h2>
      <div id="shChoose"${joining?' style="display:none"':''}><button class="sh-btn" id="shHost">Host</button><div class="sh-or">or</div><button class="sh-btn b" id="shJoinOpen">Join</button></div>
      <div id="shJoin"${joining?'':' style="display:none"'}><input class="sh-input code" id="shCode" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="0000" aria-label="Room code" value="${code||''}" />
        <button class="sh-btn b" id="shJoinGo">Join now</button></div>
      <div class="sh-err" id="shErr"></div></div>`);
    document.getElementById('shHost').onclick=()=>open({ t:'create' });
    document.getElementById('shJoinOpen').onclick=()=>{ document.getElementById('shChoose').style.display='none'; document.getElementById('shJoin').style.display=''; document.getElementById('shCode').focus(); };
    const joinGo=()=>{ const c=document.getElementById('shCode').value.trim(); if(!/^\d{4}$/.test(c)){ document.getElementById('shErr').textContent='Enter the 4-digit room code.'; return; } open({ t:'join', room:c }); };
    document.getElementById('shJoinGo').onclick=joinGo;
    document.getElementById('shCode').addEventListener('keydown', e=>{ if(e.key==='Enter') joinGo(); });
    addBack(LAYER.querySelector('.sh-card'), ()=>{
      if (document.getElementById('shJoin').style.display!=='none' && !joining){ document.getElementById('shJoin').style.display='none'; document.getElementById('shChoose').style.display=''; document.getElementById('shErr').textContent=''; return; }
      closeWs(); hide(); if (F && F.opts.onBack) F.opts.onBack();
    });
  }
  // local dev: the dev server's /ws and /chat; anywhere else: the API Gateway WebSocket (aws/ws-handler.js)
  const WS_PROD = 'wss://ymusg32gv4.execute-api.us-east-1.amazonaws.com/prod';
  function wsUrl(ch, q){
    if (/^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname)) return (location.protocol==='https:'?'wss':'ws')+'://'+location.host+(ch==='chat'?'/chat':'/ws')+(q?'?'+q:'');
    return WS_PROD+'?ch='+ch+(q?'&'+q:'');
  }
  // API Gateway drops a socket after 10 idle minutes
  function keepAlive(ws){ const t=setInterval(() => { if (ws.readyState===1) ws.send('{"t":"ping"}'); else clearInterval(t); }, 240000); }
  function closeWs(){ if (F && F.ws){ const w=F.ws; F.ws=null; try{ w.close(); }catch(e){} } if (F) F.room=null; }
  function open(first){
    closeWs();
    const ws = new WebSocket(wsUrl('relay', 'cid='+CID));
    F.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify(first)); keepAlive(ws); };
    ws.onerror = () => { const e=document.getElementById('shErr'); if (e) e.textContent='Could not reach the game server.'; };
    ws.onclose = () => { if (F && F.ws===ws && F.room && F.room.started){ F.room.other=null; toast('Disconnected from the room'); if (F.opts.onLeft) F.opts.onLeft(); } };
    ws.onmessage = e => { let m; try{ m=JSON.parse(e.data); }catch(_){ return; } onMsg(m); };
  }
  const wsSend = m => { if (F && F.ws && F.ws.readyState===1) F.ws.send(JSON.stringify(m)); };
  function onMsg(m){
    const me = player() || { name:'Player', avatar:'🎯' };
    if (m.t==='created' || m.t==='joined'){
      F.room = { code:m.room, isHost:m.t==='created', started:false, me:{ id:CID, name:me.name, avatar:me.avatar }, other:null,
                 send: x => wsSend(x), leave: () => { closeWs(); } };
      wsSend({ t:'sh-hi', name:me.name, avatar:me.avatar, game:F.opts.game });
      return lobby();
    }
    if (m.t==='error'){ const e=document.getElementById('shErr'); if (e) e.textContent=m.error; return; }
    const R = F.room; if (!R || m.from===CID) return;
    if (m.t==='sh-hi'){
      if (m.game && m.game!==F.opts.game){ closeWs(); hostJoin(); document.getElementById('shErr').textContent='That code is for a different game.'; return; }
      if (R.other && R.other.id!==m.from) return;                       // two players per room
      const fresh = !R.other; R.other = { id:m.from, name:m.name||'Friend', avatar:m.avatar||'🎯' };
      if (fresh) wsSend({ t:'sh-hi', name:R.me.name, avatar:R.me.avatar, game:F.opts.game });
      if (!R.started) lobby(); else if (fresh){ toast(`${R.other.name} is back`); if (F.opts.onRejoin) F.opts.onRejoin(R); }
      return;
    }
    if (!R.other || m.from!==R.other.id){ if (m.t!=='host-left') return; }
    if (m.t==='left' || m.t==='host-left'){
      const nm = R.other ? R.other.name : 'Your friend'; R.other=null;
      if (!R.started) lobby(); else { toast(`${nm} left`); if (F.opts.onLeft) F.opts.onLeft(R); }
      return;
    }
    if (m.t==='sh-start'){ R.started=true; hide(); F.opts.onStart(R, m.data); return; }
    if (R.started && F.opts.onMessage) F.opts.onMessage(m, R);
  }
  function lobby(){
    const R = F.room;
    const link = `${location.origin}${location.pathname}#/join/${R.code}`;
    show(`<div class="sh-card"><h2>${R.other ? 'Ready to play!' : 'Invite a friend'}</h2>
      <div class="sh-code">${R.code}</div>
      <button class="sh-btn b sh-invite" id="shInvite">Invite link 🔗</button>
      <div class="sh-players">
        <div class="sh-p"><span class="av">${esc(R.me.avatar)}</span><span class="nm">${esc(R.me.name)} (you)</span>${R.isHost?'<span class="tag">HOST</span>':''}</div>
        <div class="sh-p${R.other?'':' empty'}"><span class="av">${R.other?esc(R.other.avatar):'⏳'}</span><span class="nm">${R.other?esc(R.other.name):'Waiting for a friend…'}</span>${!R.isHost && R.other?'<span class="tag">HOST</span>':''}</div>
      </div>
      ${R.isHost ? `<button class="sh-btn" id="shStart"${R.other?'':' disabled'}>Start</button>` : `<div class="sh-sub" style="margin:0">Waiting for ${R.other?esc(R.other.name):'the host'} to start…</div>`}
      </div>`);
    document.getElementById('shInvite').onclick = async () => {
      if (navigator.share && matchMedia('(pointer:coarse)').matches){ try{ await navigator.share({ title:document.title, url:link }); return; }catch(e){ if (e.name==='AbortError') return; } }
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }catch(e){ prompt('Copy this invite link:', link); }
    };
    const st=document.getElementById('shStart');
    if (st) st.onclick=()=>{ if (!R.other) return; const data = F.opts.startData ? F.opts.startData(R) : null; wsSend({ t:'sh-start', data }); R.started=true; hide(); F.opts.onStart(R, data); };
    addBack(LAYER.querySelector('.sh-card'), ()=>{ closeWs(); hostJoin(); });
  }
  function joinCode(opts, code){ F = { opts, ws:null, room:null }; hostJoin(true, code); open({ t:'join', room:code }); }
  function leaveRoom(){ closeWs(); }

  //// ---- the standard results card ----
  function results(o){
    show(`<div class="sh-card sh-res">
      ${o.em ? `<div class="em">${o.em}</div>` : ''}<h2 style="margin-bottom:6px">${o.title}</h2>
      ${o.big!=null ? `<div class="big">${o.big}</div>` : ''}${o.sub ? `<div class="rsub">${o.sub}</div>` : '<div style="height:16px"></div>'}
      <div class="sh-row">${o.again ? `<button class="sh-btn" id="shAgain">${o.again.label||'Play again'}</button>` : ''}${o.change ? `<button class="sh-btn ghost" id="shChange">${o.change.label||'Change mode'}</button>` : ''}</div>
      <button class="sh-link" id="shGames" type="button">Games</button></div>`);
    if (o.again) document.getElementById('shAgain').onclick=()=>{ hide(); o.again.onClick(); };
    if (o.change) document.getElementById('shChange').onclick=()=>{ hide(); o.change.onClick(); };
    document.getElementById('shGames').onclick=()=>nav('games');
  }

  //// ---- scores ----
  function postScore(game, score, meta){
    const p = player(); if (!p) return Promise.resolve(null);
    return fetch('/api/game-scores', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ game, name:p.name, avatar:p.avatar, score, meta:meta||null }) }).catch(()=>null);
  }

  window.Shell = { wsUrl, keepAlive, addBack, init, player, setPlayer, signOut, requirePlayer, AVATARS, soundOn, setSound, isDark, setDark,
                   nav, show, hide, toast, mode, friend, joinCode, leaveRoom, results, postScore, esc };
})();
