// ==UserScript==
// @name         GGSEL Auto Offer Wizard — vibe.coding
// @namespace    https://vibe.coding/ggsel
// @version      1.1.0
// @description  Автозаполнение offer'а: панель справа, FSM по шагам (create → pricing → instructions), логирование, кэш, «Никнейм»/«Регион», реалистичные клики Ant Select. Гарантированное переключение RU/EN в модалках (aria-selected="true") и без зависаний FSM (планировщик + watchdog локов). Старт возможен также с sellers-office edit/{id}.
// @author       vibe.coding
// @match        https://seller.ggsel.net/offers/create*
// @match        https://seller.ggsel.net/offers/edit/*
// @match        https://sellers-office.ggsel.net/offers/edit/*
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      seller.ggsel.net
// @connect      sellers-office.ggsel.net
// ==/UserScript==

(function () {
  'use strict';

  // ==========================
  // 🔧 Состояние + утилиты
  // ==========================
  const NS = 'vibe.ggsel.autoOffer';
  const ADMIN_ORIGINS = [
    'https://seller.ggsel.net',
    'https://sellers-office.ggsel.net'
  ];
  const ADMIN_HOSTS = ADMIN_ORIGINS.map((u) => {
    try {
      return new URL(u).host;
    } catch {
      return String(u || '').replace(/^https?:\/\//, '');
    }
  });
  const DEF_STATE = {
    started: false,
    phase: 'idle',
    market: 'RU',
    gameNameRu: '',
    gameNameEn: '',
    useNick: false,
    useRegion: false,
    offerId: null,
    lastUrl: location.href,
    desc: { ru: '', en: '', kz: '', kzEn: '' },
    logs: []
  };
  const persist = {
    set(k, v) { try { GM_setValue(`${NS}.${k}`, v); } catch { localStorage.setItem(`${NS}.${k}`, JSON.stringify(v)); } },
    get(k, d) { try { const v = GM_GetValue(`${NS}.${k}`, undefined); return v === undefined ? _ls(k, d) : v; } catch { return _ls(k, d); }
      function _ls(key, def){ const raw = localStorage.getItem(`${NS}.${key}`); return raw ? JSON.parse(raw) : def; } },
    del(k) { try { GM_deleteValue(`${NS}.${k}`); } catch { localStorage.removeItem(`${NS}.${k}`); } }
  };
  function GM_GetValue(k, d){ try { return GM_getValue(k, d); } catch { return d; } }

  let state = Object.assign({}, DEF_STATE, persist.get('state', DEF_STATE));

  const REMOTE_META_DEF = { preferredOrigin: ADMIN_ORIGINS[0], csrf: {}, cache: {} };
  const storedRemoteMeta = persist.get('remoteMeta', REMOTE_META_DEF) || {};
  let remoteMeta = {
    preferredOrigin: ADMIN_ORIGINS.includes(storedRemoteMeta.preferredOrigin) ? storedRemoteMeta.preferredOrigin : ADMIN_ORIGINS[0],
    csrf: storedRemoteMeta.csrf || {},
    cache: storedRemoteMeta.cache || {}
  };
  function saveRemoteMeta(){
    persist.set('remoteMeta', {
      preferredOrigin: remoteMeta.preferredOrigin,
      csrf: remoteMeta.csrf,
      cache: remoteMeta.cache
    });
  }

  function saveState(){ persist.set('state', state); }
  function nowTs(){ return new Date().toLocaleTimeString(); }
  function log(msg){
    const line = `[${nowTs()}] ${msg}`;
    console.debug(line);
    state.logs.push(line);
    if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
    saveState();
    const box = document.querySelector('#vibe-log-box');
    if (box){ const d=document.createElement('div'); d.textContent=line; box.appendChild(d); box.scrollTop=box.scrollHeight; }
  }
  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

  async function waitForSelector(sel, { root=document, timeout=15000, mustBeVisible=true } = {}) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const el = root.querySelector(sel);
      if (el && (!mustBeVisible || isVisible(el))) return el;
      await sleep(80);
    }
    return null;
  }
  function waitFor(cond, timeout=15000){
    const t0=performance.now();
    return (async function loop(){
      while (performance.now()-t0 < timeout){
        const r = cond();
        if (r) return r;
        await sleep(80);
      }
      return null;
    })();
  }
  function isVisible(el){ const r = el.getBoundingClientRect(); return !!(el.offsetParent !== null || r.width || r.height); }

  // ✅ корректно записываем в React/AntD-поля
  function setReactValue(el, value){
    if(!el) return;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:'End' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:'End' }));
    el.blur();
  }

  function clickEl(el){
    if(!el) return;
    try{ if(typeof el.click==='function'){ el.click(); return; } }catch{}
    try{ el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true })); }
    catch{ el.dispatchEvent(new Event('click', { bubbles:true, cancelable:true })); }
  }

  // 🎯 реалистичный клик (pointer/mouse + координаты)
  function realisticClick(el){
    if(!el) return;
    try{
      el.scrollIntoView({ block:'center', inline:'center' });
      const r = el.getBoundingClientRect();
      const cx = Math.max(1, r.left + Math.min(r.width-1, r.width/2));
      const cy = Math.max(1, r.top  + Math.min(r.height-1, r.height/2));
      const opts = { bubbles:true, cancelable:true, clientX:cx, clientY:cy };
      try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.focus();
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch { clickEl(el); }
  }

  function findByText(selector, text, { root=document, exact=true } = {}){
    const items = root.querySelectorAll(selector);
    const needle = text.replace(/\s+/g,' ').trim();
    for (const el of items){
      const got = (el.textContent||'').replace(/\s+/g,' ').trim();
      if(exact ? got===needle : got.includes(needle)) return el;
    }
    return null;
  }

  function copyToClipboard(text){
    try { GM_setClipboard(text); }
    catch { navigator.clipboard?.writeText(text).catch(()=>{}); }
  }

  const REMOTE_CACHE_LIMIT = 6;

  function isAdminContext(){
    return ADMIN_HOSTS.includes(location.host);
  }

  function isAdminUiContext(){
    if (!isAdminContext()) return false;
    return /\/offers\/(create|edit)/.test(location.pathname);
  }

  function getPreferredOrigin(){
    if (remoteMeta?.preferredOrigin && ADMIN_ORIGINS.includes(remoteMeta.preferredOrigin)){
      return remoteMeta.preferredOrigin;
    }
    return ADMIN_ORIGINS[0];
  }

  function makeOriginList(originOverride){
    if (originOverride && ADMIN_ORIGINS.includes(originOverride)) return [originOverride];
    const preferred = getPreferredOrigin();
    const rest = ADMIN_ORIGINS.filter((o)=> o !== preferred);
    return [preferred, ...rest];
  }

  function absoluteAdminUrl(path, originOverride){
    const origin = originOverride || getPreferredOrigin();
    if (!path) return origin;
    if (/^https?:/i.test(path)) return path;
    const base = origin.replace(/\/$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  function headerStringToMap(str){
    const map = {};
    if (!str) return map;
    for (const line of String(str).split(/\r?\n/)){
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      if (!key) continue;
      map[key] = line.slice(idx + 1).trim();
    }
    return map;
  }

  async function requestWithRetry(factory, attempts = 3, delay = 350){
    let lastErr;
    for (let i = 0; i < attempts; i++){
      try {
        return await factory();
      } catch (err){
        lastErr = err;
        if (i < attempts - 1){ await sleep(delay * (i + 1)); }
      }
    }
    throw lastErr || new Error('Request failed');
  }

  function gmHttpRequest(opts){
    const useGM = typeof GM_xmlhttpRequest === 'function';
    if (useGM){
      return new Promise((resolve, reject)=>{
        try {
          GM_xmlhttpRequest(Object.assign({}, opts, {
            onload: (res)=> resolve(res),
            onerror: (err)=> reject(err?.error || err),
            ontimeout: ()=> reject(new Error('Timeout')),
            withCredentials: true
          }));
        } catch (err){ reject(err); }
      });
    }
    return fetch(opts.url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.data,
      credentials: 'include',
      mode: 'cors'
    }).then(async (resp)=>{
      const text = await resp.text();
      return {
        status: resp.status,
        statusText: resp.statusText,
        responseText: text,
        responseHeaders: Array.from(resp.headers.entries()).map(([k,v])=>`${k}: ${v}`).join('\n')
      };
    });
  }

  async function rawPrivilegedFetch(origin, path, options = {}){
    const { method = 'GET', headers = {}, data = undefined, responseType = 'text', retries = 2 } = options;
    const url = absoluteAdminUrl(path, origin);
    const exec = () => gmHttpRequest({ url, method, headers, data, responseType });
    const res = await requestWithRetry(exec, retries + 1);
    return { res, url };
  }

  function processResponse(res, responseType, url){
    const headersMap = headerStringToMap(res.responseHeaders);
    const rawBody = res.responseText !== undefined ? res.responseText : res.response;
    let body = rawBody;
    if (responseType === 'json' && typeof rawBody === 'string'){
      try { body = JSON.parse(rawBody); }
      catch (err){ throw new Error(`JSON parse error for ${url}: ${err?.message || err}`); }
    }
    return {
      status: res.status,
      statusText: res.statusText,
      headers: headersMap,
      body
    };
  }

  async function privilegedFetch(path, options = {}){
    const {
      method = 'GET',
      headers = {},
      data = undefined,
      responseType = 'text',
      retries = 2,
      includeCsrf = false,
      forceFreshCsrf = false,
      origin: originOverride = null
    } = options;

    const origins = makeOriginList(originOverride);
    let lastErr = null;
    for (const origin of origins){
      const hdrs = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, headers);
      if (includeCsrf){
        const token = await ensureCsrfToken(forceFreshCsrf, origin);
        if (token) hdrs['X-CSRF-TOKEN'] = token;
      }
      try {
        const { res, url } = await rawPrivilegedFetch(origin, path, { method, headers: hdrs, data, responseType, retries });
        remoteMeta.preferredOrigin = origin;
        saveRemoteMeta();
        const processed = processResponse(res, responseType, url);
        processed.url = url;
        return processed;
      } catch (err){
        lastErr = err;
      }
    }
    throw lastErr || new Error('All origins failed');
  }

  function parseRemoteHtml(html){
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function extractCsrfFromHtml(html){
    if (!html) return null;
    const doc = parseRemoteHtml(html);
    const meta = doc.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const input = doc.querySelector('input[name="_token"], input[name="csrf"]');
    if (input?.value) return input.value;
    return null;
  }

  async function ensureCsrfToken(force = false, originOverride = null){
    const origin = originOverride && ADMIN_ORIGINS.includes(originOverride) ? originOverride : getPreferredOrigin();
    if (!remoteMeta.csrf) remoteMeta.csrf = {};
    const entry = remoteMeta.csrf[origin];
    const age = entry ? Date.now() - entry.ts : Infinity;
    if (!force && entry && age < 10 * 60 * 1000) return entry.token;
    try {
      const { res, url } = await rawPrivilegedFetch(origin, '/offers/create', {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        responseType: 'text',
        retries: 1
      });
      const processed = processResponse(res, 'text', url);
      const token = extractCsrfFromHtml(processed.body);
      if (token){
        remoteMeta.csrf[origin] = { token, ts: Date.now() };
        remoteMeta.preferredOrigin = origin;
        saveRemoteMeta();
        return token;
      }
    } catch (err){
      console.warn('CSRF fetch failed', origin, err);
    }
    return entry?.token || null;
  }

  function readCache(url, maxAge){
    const cache = remoteMeta.cache || {};
    const entry = cache[url];
    if (!entry) return null;
    if (maxAge && Date.now() - entry.ts > maxAge) return null;
    return entry.body;
  }

  function findCachedPageLike(path, maxAge){
    const cache = remoteMeta.cache || {};
    if (!path) return null;
    const now = Date.now();
    let suffix = null;
    try {
      const u = new URL(path, getPreferredOrigin());
      suffix = `${u.pathname}${u.search}`;
    } catch {
      suffix = path.startsWith('/') ? path : `/${path}`;
    }
    if (!suffix) return null;
    for (const [url, entry] of Object.entries(cache)){
      if (!entry) continue;
      if (maxAge && now - (entry.ts || 0) > maxAge) continue;
      try {
        const u = new URL(url);
        const candidate = `${u.pathname}${u.search}`;
        if (candidate.endsWith(suffix)) return { url, entry };
      } catch {
        if (url.endsWith(suffix)) return { url, entry };
      }
    }
    return null;
  }

  function storeCache(url, body){
    if (!remoteMeta.cache) remoteMeta.cache = {};
    remoteMeta.cache[url] = { ts: Date.now(), body };
    const entries = Object.entries(remoteMeta.cache);
    if (entries.length > REMOTE_CACHE_LIMIT){
      entries.sort((a, b)=> a[1].ts - b[1].ts);
      while (entries.length > REMOTE_CACHE_LIMIT){
        const [key] = entries.shift();
        delete remoteMeta.cache[key];
      }
    }
    saveRemoteMeta();
  }

  async function fetchAdminPage(path, { maxAge = 120000, force = false, origin = null } = {}){
    const resolvedUrl = absoluteAdminUrl(path, origin || undefined);
    const cached = !force && readCache(resolvedUrl, maxAge);
    if (cached){
      return { url: resolvedUrl, html: cached, fromCache: true };
    }
    try {
      const res = await privilegedFetch(path, { method: 'GET', retries: 2, origin });
      const html = res.body;
      const actualUrl = res.url || resolvedUrl;
      if (typeof html === 'string'){ storeCache(actualUrl, html); }
      return { url: actualUrl, html, fromCache: false };
    } catch (err){
      const fallback = readCache(resolvedUrl, maxAge);
      if (fallback){
        return { url: resolvedUrl, html: fallback, fromCache: true, fallback: true, error: err };
      }
      const alt = findCachedPageLike(path, maxAge);
      if (alt){
        return { url: alt.url, html: alt.entry.body, fromCache: true, fallback: true, error: err };
      }
      throw err;
    }
  }

  function setupRemoteBridge(){
    const api = {
      origins: ADMIN_ORIGINS.slice(),
      async fetchPage(path, opts){ return fetchAdminPage(path, opts); },
      async fetchJson(path, opts = {}){
        const { body } = await privilegedFetch(path, Object.assign({}, opts, { responseType: 'json' }));
        return body;
      },
      async postForm(path, payload, opts = {}){
        const body = typeof payload === 'string' ? payload : new URLSearchParams(payload || {}).toString();
        return privilegedFetch(path, Object.assign({
          method: 'POST',
          data: body,
          includeCsrf: true,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        }, opts));
      },
      async ensureCsrf(payload){
        const opts = typeof payload === 'object' && payload !== null ? payload : { force: !!payload };
        const origin = opts.origin && ADMIN_ORIGINS.includes(opts.origin) ? opts.origin : getPreferredOrigin();
        const token = await ensureCsrfToken(!!opts.force, origin);
        const meta = (remoteMeta.csrf && remoteMeta.csrf[origin]) || null;
        return { token, fetchedAt: meta?.ts || null, origin };
      },
      clearCache(){
        remoteMeta.cache = {};
        saveRemoteMeta();
        return { cleared: true };
      },
      parseHtml(html){ return parseRemoteHtml(html); }
    };

    window.GGSEL_AOW = api;
    window.dispatchEvent(new CustomEvent('ggsel:aow:ready', { detail: api }));

    window.addEventListener('ggsel:aow:request', async (ev)=>{
      const detail = ev?.detail || {};
      if (!detail || !detail.id || !detail.action) return;
      const send = (status, payload) => {
        window.dispatchEvent(new CustomEvent('ggsel:aow:response', { detail: Object.assign({ id: detail.id, status }, payload) }));
      };
      try {
        const handler = api[detail.action];
        if (typeof handler !== 'function') throw new Error(`Unknown action: ${detail.action}`);
        const result = await handler(detail.payload, detail.options || {});
        send('ok', { result });
      } catch (err){
        send('error', { error: err?.message || String(err) });
      }
    });
  }

  let remoteBridgeReady = false;
  function ensureRemoteBridge(){
    if (remoteBridgeReady) return;
    remoteBridgeReady = true;
    setupRemoteBridge();
  }

  // ==========================
  // 🎛️ Панель
  // ==========================
  const css = `
#vibe-panel{position:fixed;right:16px;top:96px;width:360px;z-index:999999;background:#0d0f12;color:#e7e7e7;border:1px solid #2a2f36;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;}
#vibe-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #242933;font-weight:700;}
#vibe-panel .bd{padding:10px 12px;}
#vibe-panel .row{margin-bottom:10px;}
#vibe-panel label{display:block;font-size:12px;opacity:.9;margin-bottom:4px;}
#vibe-panel input[type="text"],#vibe-panel textarea{width:100%;background:#12161c;color:#eee;border:1px solid #2d3440;border-radius:8px;padding:8px 10px;outline:none;}
#vibe-panel input[type="text"]:focus,#vibe-panel textarea:focus{border-color:#5a9cff;}
#vibe-panel .chips{display:flex;gap:6px;flex-wrap:wrap;}
#vibe-panel .chip{padding:4px 8px;background:#151a21;border:1px solid #2d3440;border-radius:999px;cursor:pointer;user-select:none;font-size:12px;}
#vibe-panel .chip.active{border-color:#5a9cff;background:rgba(90,156,255,.15);}
#vibe-panel .btn{width:100%;padding:10px 12px;background:#0e7a29;border:1px solid #19923a;color:#fff;border-radius:10px;cursor:pointer;font-weight:700;}
#vibe-panel .btn.secondary{background:#19202a;border-color:#2e3a4a;color:#eaeef5;}
#vibe-panel .btn.warn{background:#3a1b1b;border-color:#6b2a2a;}
#vibe-panel .tabs{display:flex;gap:6px;margin-bottom:8px;}
#vibe-panel .tab{padding:6px 10px;border:1px solid #2d3440;border-radius:8px;cursor:pointer;background:#141a22;font-size:12px;}
#vibe-panel .tab.active{border-color:#9b82ff;background:rgba(155,130,255,.18);}
#vibe-log-box{height:180px;overflow:auto;border:1px solid #262c36;border-radius:8px;background:#0c0f14;padding:6px 8px;font-size:12px;line-height:1.3;}
#vibe-row-actions{display:flex;gap:8px;}
#vibe-id-badge{display:flex;gap:8px;align-items:center;}
#vibe-id{font-weight:700;color:#a8ffad;}
`;
  try { GM_addStyle(css); } catch(e){ const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st); }

  function ensurePanel(){
    if(document.querySelector('#vibe-panel')) return;
    const host=document.createElement('div');
    host.id='vibe-panel';
    host.innerHTML=`
      <div class="hd"><div>Auto Offer Wizard</div><div class="small">phase: <span id="vibe-phase">${state.phase}</span></div></div>
      <div class="bd">
        <div class="row"><label>Название игры (RU/KZ)</label><input id="vibe-game-ru" type="text" placeholder="Напр.: ARK: Survival Evolved"></div>
        <div class="row"><label>Название (EN) — опционально</label><input id="vibe-game-en" type="text" placeholder="If blank — will use RU"></div>
        <div class="row"><label>Рынок</label><div class="chips"><div class="chip" data-market="RU">RU</div><div class="chip" data-market="KZ">KZ</div></div></div>
        <div class="row">
          <label>Описание (кэшируется)</label>
          <div class="tabs"><div class="tab" data-dtab="ru">ru</div><div class="tab" data-dtab="en">en</div><div class="tab" data-dtab="kz">kz</div><div class="tab" data-dtab="kzEn">kz-eng</div></div>
          <textarea id="vibe-desc" rows="5" placeholder="Вставьте/напишите описание выбранной вкладки"></textarea>
        </div>
        <div class="row"><label>Параметры</label><div class="chips"><div class="chip" data-flag="useNick">Никнейм</div><div class="chip" data-flag="useRegion">Регион</div></div></div>
        <div class="row" id="vibe-id-badge" style="display:none;"><span class="small">Offer ID:</span><span id="vibe-id">—</span><button class="chip" id="vibe-copy-id">Копировать</button></div>
        <div class="row" id="vibe-row-actions"><button class="btn" id="vibe-run">Заполнить</button><button class="btn secondary" id="vibe-continue">Продолжить</button><button class="btn warn" id="vibe-reset">Сбросить кэш</button></div>
        <div class="row"><label>Логи</label><div id="vibe-log-box"></div></div>
      </div>`;
    document.body.appendChild(host);

    const gameRu = host.querySelector('#vibe-game-ru');
    const gameEn = host.querySelector('#vibe-game-en');
    const descArea = host.querySelector('#vibe-desc');
    const tabs=[...host.querySelectorAll('.tab')];
    const chipsMarket=[...host.querySelectorAll('.chip[data-market]')];
    const chipsFlags=[...host.querySelectorAll('.chip[data-flag]')];

    gameRu.value=state.gameNameRu||'';
    gameEn.value=state.gameNameEn||'';

    let activeDTab = persist.get('activeDTab','ru');
    function renderDescTab(){ tabs.forEach(t=>t.classList.toggle('active', t.getAttribute('data-dtab')===activeDTab)); descArea.value = state.desc[activeDTab] || ''; }
    function renderMarket(){ chipsMarket.forEach(c=>c.classList.toggle('active', c.getAttribute('data-market')===state.market)); }
    function renderFlags(){ chipsFlags.forEach(c=>c.classList.toggle('active', !!state[c.getAttribute('data-flag')])); }

    gameRu.addEventListener('input', ()=>{ state.gameNameRu=gameRu.value; saveState(); });
    gameEn.addEventListener('input', ()=>{ state.gameNameEn=gameEn.value; saveState(); });
    descArea.addEventListener('input', ()=>{ state.desc[activeDTab]=descArea.value; saveState(); });
    tabs.forEach(t=>t.addEventListener('click', ()=>{ activeDTab=t.getAttribute('data-dtab'); persist.set('activeDTab', activeDTab); renderDescTab(); }));
    chipsMarket.forEach(c=>c.addEventListener('click', ()=>{ state.market=c.getAttribute('data-market'); saveState(); renderMarket(); log(`Рынок переключен на ${state.market}`); }));
    chipsFlags.forEach(c=>c.addEventListener('click', ()=>{ const k=c.getAttribute('data-flag'); state[k]=!state[k]; saveState(); renderFlags(); log(`Флаг ${k} = ${state[k]?'ON':'OFF'}`); }));

    host.querySelector('#vibe-run').addEventListener('click', onRun);
    host.querySelector('#vibe-continue').addEventListener('click', ()=> scheduleNext(50));
    host.querySelector('#vibe-reset').addEventListener('click', ()=>{
      state = Object.assign({}, DEF_STATE, { logs:[] });
      saveState(); renderMarket(); renderFlags(); renderDescTab();
      gameRu.value=''; gameEn.value='';
      host.querySelector('#vibe-phase').textContent = state.phase;
      host.querySelector('#vibe-log-box').innerHTML='';
      document.querySelector('#vibe-id-badge').style.display='none';
      log('Кэш и состояние сброшены.');
    });
    host.querySelector('#vibe-copy-id').addEventListener('click', ()=>{ if(state.offerId){ copyToClipboard(state.offerId); log(`ID ${state.offerId} скопирован.`); } });

    (state.logs||[]).forEach(l=>{ const d=document.createElement('div'); d.textContent=l; host.querySelector('#vibe-log-box').appendChild(d); });
    renderMarket(); renderFlags(); renderDescTab(); refreshIdBadge();
  }

  function refreshPhase(){ const el=document.querySelector('#vibe-phase'); if(el) el.textContent=state.phase; }
  function refreshIdBadge(){ const wrap=document.querySelector('#vibe-id-badge'); const idEl=document.querySelector('#vibe-id'); if(!wrap) return; if(state.offerId){ wrap.style.display=''; if(idEl) idEl.textContent=state.offerId; } else wrap.style.display='none'; }

  function onRun(){
    if (!state.gameNameRu?.trim() && isCreatePage()) { log('❗ Введите «Название игры (RU/KZ)»'); return; }
    state.started=true;
    if (isCreatePage()) state.phase='fill_general';
    else if (isPricingPage()) state.phase='pricing_price';
    else if (isInstructionsPage()) state.phase='instructions_ru';
    else state.phase='pricing_price';
    saveState(); refreshPhase();
    scheduleNext(50);
  }

  // ==========================
  // 📍 Распознавание страниц
  // ==========================
  function isCreatePage(){
    const hdr = findByText('.style_OffersCreationTitleWithHint__fa4kw h5, h5', 'Категория размещения', { exact:true });
    return !!hdr || location.pathname.includes('/offers/create');
  }
  function isPricingPage(){
    const hdr = findByText('h5', 'Цена товара', { exact:true });
    return !!hdr || location.pathname.includes('/pricing');
  }
  function isInstructionsPage(){
    const hdr = findByText('.style_OffersCreationTitleWithHint__fa4kw h5, h5', 'Инструкция для покупателя', { exact:true });
    return !!hdr || location.pathname.includes('/instructions');
  }
  function extractOfferIdFromUrl(){
    const m = location.pathname.match(/\/offers\/edit\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  // ==========================
  // 🚦 Планировщик + FSM
  // ==========================
  let nextTimer = null;
  function scheduleNext(ms=250){
    if (nextTimer) { clearTimeout(nextTimer); nextTimer=null; }
    nextTimer = setTimeout(()=>{ nextTimer=null; resumeFlow(); }, ms);
  }

  let phaseRunning = false;
  let phaseLockAt  = 0;

  async function resumeFlow(){
    // watchdog лока > 15s
    if (phaseRunning){
      const age = performance.now() - phaseLockAt;
      if (age > 15000){
        phaseRunning = false;
        log('🧯 Снял зависший лок фазы (>15s). Продолжаю.');
      } else return;
    }
    phaseRunning = true; phaseLockAt = performance.now();
    refreshPhase();

    try{
      if (!state.started) return;

      const oid = extractOfferIdFromUrl();
      if (oid && oid !== state.offerId){ state.offerId=oid; saveState(); refreshIdBadge(); log(`Обнаружен Offer ID: ${oid}`); }

      switch(state.phase){
        case 'fill_general': await phaseFillGeneral(); break;
        case 'fill_en': await phaseFillEN(); break;
        case 'goto_pricing': await phaseGotoPricing(); break;
        case 'pricing_price': await phasePricingPrice(); break;
        case 'pricing_add_nick': await phasePricingAddNick(); break;
        case 'pricing_add_region': await phasePricingAddRegion(); break;
        case 'pricing_next': await phasePricingNext(); break;
        case 'instructions_ru': await phaseInstructionsRU(); break;
        case 'instructions_en': await phaseInstructionsEN(); break;
        case 'done': break;
        default: log(`Неизвестная фаза: ${state.phase}`); break;
      }
    } catch(err){
      log(`❌ Ошибка: ${err?.message||err}`);
      console.error(err);
    } finally {
      phaseRunning = false;
    }
  }

  // ==========================
  // 🧠 Языковые табы в модалке
  // ==========================
  /**
   * Гарантированно активирует нужный таб языка внутри модалки и дожидается aria-selected="true".
   * @param {Element} modal  — корень модалки
   * @param {'ru'|'en'} lang — нужный язык
   * @returns {Promise<boolean>} true, если получилось активировать
   */
  async function ensureModalLang(modal, lang){
    const LC = String(lang).toLowerCase();
    const UC = LC.toUpperCase();

    // Находим саму кнопку таба по тексту ("RU"/"EN")
    const findBtn = () =>
      findByText('.ant-tabs-tab .ant-tabs-tab-btn, .ant-tabs-tab[role="tab"] .ant-tabs-tab-btn', UC, { root: modal, exact:true });

    let btn = findBtn();
    if (!btn) { log(`❗ Не найден таб ${UC} в модалке`); return false; }

    // Если уже выбран — ок
    if (btn.getAttribute('aria-selected') === 'true') return true;

    // Пытаемся кликнуть и ждём aria-selected="true" или .ant-tabs-tab-active
    realisticClick(btn);
    const ok = !!(await waitFor(() => {
      const b = findBtn();
      if (!b) return false;
      const sel = b.getAttribute('aria-selected') === 'true';
      const active = b.closest('.ant-tabs-tab')?.classList.contains('ant-tabs-tab-active');
      return sel || active;
    }, 2000));

    if (!ok) log(`⚠️ Не удалось активировать таб ${UC}`);
    return ok;
  }

  // ==========================
  // 🧩 Фазы (без рекурсий — через scheduleNext)
  // ==========================

  // CREATE: RU
  async function phaseFillGeneral(){
    if(!isCreatePage()){ log('Ожидание «Категория размещения»...'); scheduleNext(500); return; }
    log('Фаза: Заполнение RU полей.');
    const marker = await waitFor(()=>findByText('.style_OffersCreationTitleWithHint__fa4kw h5, h5', 'Категория размещения', { exact:true }), 15000);
    if(!marker){ log('❗ Не найден заголовок «Категория размещения».'); scheduleNext(500); return; }

    const titleRu = await waitForSelector('#titleRu');
    if(!titleRu){ log('❗ Не найдено поле #titleRu'); scheduleNext(500); return; }
    const ruTitle = `${state.gameNameRu.trim()} — Steam — ${state.market} — авто`;
    setReactValue(titleRu, ruTitle); log(`Название RU → ${ruTitle}`);

    const descRuEl = await waitForSelector('#descriptionRu');
    if(!descRuEl){ log('❗ Не найдено поле #descriptionRu'); scheduleNext(500); return; }
    const ruDesc = state.market==='RU' ? (state.desc.ru||'') : (state.desc.kz||'');
    setReactValue(descRuEl, ruDesc); log(`Описание RU заполнено (${ruDesc.length} симв.).`);

    state.phase='fill_en'; saveState(); refreshPhase();
    scheduleNext(200);
  }

  // CREATE: EN
  async function phaseFillEN(){
    if(!isCreatePage()){ scheduleNext(500); return; }
    log('Фаза: Заполнение EN вкладки.');

    let enTab =
      findByText('.ant-tabs-tab .ant-tabs-tab-btn, .ant-tabs-tab[role="tab"] .ant-tabs-tab-btn', 'EN', { exact:true }) ||
      document.querySelector('[data-node-key="en"] .ant-tabs-tab-btn, [data-node-key="en"]') ||
      document.querySelector('[id^="rc-tabs-"][id$="-tab-en"]');
    if(!enTab){ await sleep(200);
      enTab =
        findByText('.ant-tabs-tab .ant-tabs-tab-btn, .ant-tabs-tab[role="tab"] .ant-tabs-tab-btn', 'EN', { exact:true }) ||
        document.querySelector('[data-node-key="en"] .ant-tabs-tab-btn, [data-node-key="en"]') ||
        document.querySelector('[id^="rc-tabs-"][id$="-tab-en"]'); }
    if(!enTab){ log('❗ Не найдена вкладка EN'); scheduleNext(500); return; }
    realisticClick(enTab); await sleep(250);

    let titleEn = await waitForSelector('#titleEn');
    let descEnEl = await waitForSelector('#descriptionEn');
    if(!titleEn || !descEnEl){ realisticClick(enTab); await sleep(250); titleEn = await waitForSelector('#titleEn'); descEnEl = await waitForSelector('#descriptionEn'); }
    if(!titleEn || !descEnEl){ log('❗ Не найдены EN поля (#titleEn / #descriptionEn)'); scheduleNext(500); return; }

    const gameEn = state.gameNameEn?.trim() || state.gameNameRu?.trim();
    const enTitle = `${gameEn} – Steam – ${state.market} – auto`;
    setReactValue(titleEn, enTitle); log(`Название EN → ${enTitle}`);

    const enDesc = state.market==='RU' ? (state.desc.en||'') : ((state.desc.kzEn&&state.desc.kzEn.trim())?state.desc.kzEn:(state.desc.en||''));
    setReactValue(descEnEl, enDesc); log(`Описание EN заполнено (${enDesc.length} симв.).`);

    const nextBtn = await waitFor(()=> findByText('button span', 'Далее', { exact:true })?.closest('button'), 10000);
    if(!nextBtn){ log('❗ Кнопка «Далее» не найдена. Нажмите её вручную и затем «Продолжить».'); state.phase='goto_pricing'; saveState(); refreshPhase(); scheduleNext(600); return; }
    realisticClick(nextBtn); log('Нажата «Далее» → Pricing...');
    state.phase='goto_pricing'; saveState(); refreshPhase();
    scheduleNext(800);
  }

  // PRICING: переход
  async function phaseGotoPricing(){
    if(!isPricingPage()){
      const ok = await waitFor(()=>isPricingPage(), 15000);
      if(!ok){ log('❗ Не видна страница «Цена товара».'); scheduleNext(800); return; }
    }
    log('Фаза: Pricing → установка цены.');
    state.offerId = extractOfferIdFromUrl() || state.offerId; saveState(); refreshIdBadge();
    state.phase='pricing_price'; saveState(); refreshPhase();
    scheduleNext(200);
  }

  // PRICING: цена и режим
  async function phasePricingPrice(){
    if(!isPricingPage()){ scheduleNext(600); return; }
    log('Фаза: Установка цены и режима.');

    const priceInput = await waitForSelector('#offerCost');
    if(!priceInput){ log('❗ Поле #offerCost не найдено'); scheduleNext(600); return; }
    setReactValue(priceInput, '1'); log('Цена установлена: 1');

    const unl = await waitFor(()=> findByText('.ant-segmented-item .ant-segmented-item-label', 'Безлимитный', { exact:true }), 5000);
    if (unl){ realisticClick(unl); log('Выбран режим: Безлимитный'); await sleep(150); }
    else { log('⚠️ Не найден переключатель «Безлимитный». Пропускаю.'); }

    if (state.useNick) state.phase='pricing_add_nick';
    else if (state.useRegion) state.phase='pricing_add_region';
    else state.phase='pricing_next';
    saveState(); refreshPhase();
    scheduleNext(200);
  }

  // helper: модал «Добавление параметра»
  async function openAddParamModal(){
    let addBtn = [...document.querySelectorAll('button')].find(b=>/Добавить/i.test(b.textContent));
    if(!addBtn){ log('❗ Кнопка «Добавить» для параметра не найдена'); return null; }
    realisticClick(addBtn);
    log('Открываю модал «Добавление параметра»...');
    const modal = await waitForSelector('.ant-modal-content');
    return modal;
  }

  // helper: открыть выпадашку типов
  async function openTypeDropdown(modal){
    const selector = modal.querySelector('.ant-select-selector');
    if (!selector){ log('❗ В модале не найден .ant-select-selector'); return null; }
    for (let i=1; i<=3; i++){
      realisticClick(selector);
      await sleep(120);
      const wrap = selector.querySelector('.ant-select-selection-wrap') || selector;
      realisticClick(wrap);
      await sleep(120);
      const combo = modal.querySelector('.ant-select-selection-search-input[role="combobox"]');
      if (combo){
        combo.focus();
        const hadRO = combo.hasAttribute('readonly');
        if (hadRO) combo.removeAttribute('readonly');
        combo.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:'Enter' }));
        combo.dispatchEvent(new KeyboardEvent('keyup',   { bubbles:true, key:'Enter' }));
        combo.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:' ' }));
        combo.dispatchEvent(new KeyboardEvent('keyup',   { bubbles:true, key:' ' }));
        combo.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:'ArrowDown' }));
        combo.dispatchEvent(new KeyboardEvent('keyup',   { bubbles:true, key:'ArrowDown' }));
        if (hadRO) combo.setAttribute('readonly','');
        await sleep(80);
      }
      const dd = [...document.querySelectorAll('.ant-select-dropdown')].find(d=>!d.classList.contains('ant-select-dropdown-hidden'));
      if (dd) return dd;
      log(`Попытка открыть список типов #${i} не удалась — пробую ещё...`);
      await sleep(150);
    }
    return null;
  }

  function findOptionInDropdown(dd, labels){
    for (const lbl of labels){
      const node = findByText('.ant-select-item .ant-select-item-option-content', lbl, { root: dd, exact:true });
      if (node) return node.closest('.ant-select-item');
    }
    for (const lbl of labels){
      const aria = [...dd.querySelectorAll('[role="option"]')].find(o=>{
        const a = (o.getAttribute('aria-label')||'').trim();
        const t = (o.textContent||'').trim();
        return a===lbl || t===lbl;
      });
      if (aria) return aria;
    }
    return null;
  }

  async function chooseParamType(modal, labels){
    const dd = await openTypeDropdown(modal);
    if (!dd){ log('❗ Выпадающий список типов не открылся'); return false; }
    const opt = findOptionInDropdown(dd, labels);
    if (!opt){ log(`❗ В списке не найден тип: ${labels.join(' / ')}`); return false; }
    realisticClick(opt);
    log(`Выбран тип параметра: ${(opt.textContent||'').trim()}`);
    await sleep(120);
    return true;
  }

  // PRICING: «Никнейм»
  async function phasePricingAddNick(){
    if(!isPricingPage()){ scheduleNext(600); return; }
    log('Фаза: Добавляю параметр «Никнейм».');

    const modal = await openAddParamModal();
    if(!modal){ scheduleNext(600); return; }

    const okType = await chooseParamType(modal, ['Текстовое поле', 'TextField']);
    if (!okType){ scheduleNext(400); return; }

    // ✅ гарантируем RU перед вводом RU-полей
    await ensureModalLang(modal, 'ru');

    const reqLabel = findByText('.ant-checkbox-wrapper .ant-checkbox-label', 'Обязательный параметр', { root: modal, exact:true })?.closest('.ant-checkbox-wrapper');
    if (reqLabel){ realisticClick(reqLabel); log('Отмечен чекбокс «Обязательный параметр».'); await sleep(80); }

    const ruParamTitle = await waitForSelector('.field-lang._visible .styles_Input__U2Hd0 input', { root: modal });
    if (!ruParamTitle){ log('❗ Не найдено поле RU «Заголовок параметра»'); scheduleNext(400); return; }
    const RU_NICK = 'ССЫЛКА НА STEAM ПРОФИЛЬ (Пример: https://steamcommunity.com/id/nickname/)';
    setReactValue(ruParamTitle, RU_NICK); log('RU заголовок для Никнейма установлен.');

    // → EN
    await ensureModalLang(modal, 'en');

    const enParamTitle = modal.querySelector('.field-lang._visible .styles_Input__U2Hd0 input') || modal.querySelector('.styles_Input__U2Hd0 input');
    if (!enParamTitle){ log('❗ Не найдено поле EN «Заголовок параметра»'); scheduleNext(400); return; }
    setReactValue(enParamTitle, 'LINK ON STEAM PROFILE'); log('EN заголовок для Никнейма установлен.');

    const addBtn = findByText('.ant-modal-footer button span', 'Добавить', { root: modal, exact:true })?.closest('button');
    if (!addBtn){ log('❗ В модале не найдена кнопка «Добавить»'); scheduleNext(400); return; }
    realisticClick(addBtn); log('Параметр «Никнейм» добавлен.');
    await sleep(300);

    state.phase = state.useRegion ? 'pricing_add_region' : 'pricing_next';
    saveState(); refreshPhase();
    scheduleNext(250);
  }

  // PRICING: «Регион»
  async function phasePricingAddRegion(){
    if(!isPricingPage()){ scheduleNext(600); return; }
    log('Фаза: Добавляю параметр «Регион».');

    const modal = await openAddParamModal();
    if(!modal){ scheduleNext(600); return; }

    const okType = await chooseParamType(modal, ['Радио кнопки', 'RadioButton', 'Radio', 'RadioButtons']);
    if (!okType){ scheduleNext(400); return; }

    // ✅ здесь модал часто открывается на EN — принудительно включаем RU
    const ruOk = await ensureModalLang(modal, 'ru');
    if (!ruOk) log('⚠️ Не удалось подтвердить активный RU (aria-selected). Пробую заполнить видимые RU-поля.');

    const ruTitle = await waitForSelector('.styles_Input__U2Hd0 input', { root: modal });
    if (!ruTitle){ log('❗ Нет RU поля «Заголовок параметра»'); scheduleNext(400); return; }
    setReactValue(ruTitle, 'РЕГИОН АККАУНТА'); log('RU: Заголовок параметра = «РЕГИОН АККАУНТА».');

    const ruVariant = modal.querySelector('.style_inputVariant__J5kH1.field-lang._visible input') || modal.querySelector('.style_inputVariant__J5kH1 input');
    if (!ruVariant){ log('❗ Нет RU поля «Название варианта»'); scheduleNext(400); return; }
    const optRU = state.market==='RU' ? 'Россия' : 'Казахстан';
    setReactValue(ruVariant, optRU); log(`RU: Название варианта = «${optRU}».`);

    // → EN
    await ensureModalLang(modal, 'en');

    const enTitle = modal.querySelector('.field-lang._visible .styles_Input__U2Hd0 input') || modal.querySelector('.styles_Input__U2Hd0 input');
    if (!enTitle){ log('❗ Нет EN поля «Заголовок параметра»'); scheduleNext(400); return; }
    setReactValue(enTitle, 'REGION ACCOUNT'); log('EN: Заголовок параметра = «REGION ACCOUNT».');

    const enVariant = modal.querySelector('.style_inputVariant__J5kH1.field-lang._visible input') || modal.querySelector('.style_inputVariant__J5kH1 input');
    if (!enVariant){ log('❗ Нет EN поля «Название варианта»'); scheduleNext(400); return; }
    const optEN = state.market==='RU' ? 'Russia' : 'Kazakhstan';
    setReactValue(enVariant, optEN); log(`EN: Название варианта = «${optEN}».`);

    const addBtn = findByText('.ant-modal-footer button span', 'Добавить', { root: modal, exact:true })?.closest('button');
    if (!addBtn){ log('❗ В модале не найдена кнопка «Добавить»'); scheduleNext(400); return; }
    realisticClick(addBtn); log('Параметр «Регион» добавлен.');
    await sleep(300);

    state.phase='pricing_next'; saveState(); refreshPhase();
    scheduleNext(250);
  }

  // PRICING → NEXT
  async function phasePricingNext(){
    if(!isPricingPage()){ scheduleNext(600); return; }
    log('Фаза: Переход к «Инструкция для покупателя».');

    const nextBtn = await waitFor(()=> findByText('button span', 'Далее', { exact:true })?.closest('button'), 10000);
    if (!nextBtn){ log('❗ Кнопка «Далее» не найдена на Pricing. Нажмите её вручную и жмите «Продолжить».'); scheduleNext(800); return; }
    realisticClick(nextBtn); log('Нажата «Далее» → инструкции.');
    state.phase='instructions_ru'; saveState(); refreshPhase();
    scheduleNext(900);
  }

  // INSTRUCTIONS: RU
  async function phaseInstructionsRU(){
    if(!isInstructionsPage()){
      const ok = await waitFor(()=>isInstructionsPage(), 15000);
      if(!ok){ log('❗ Не видна вкладка «Инструкция для покупателя».'); scheduleNext(800); return; }
    }
    log('Фаза: Инструкция RU.');
    const marker = await waitFor(()=> findByText('.style_OffersCreationTitleWithHint__fa4kw h5, h5', 'Инструкция для покупателя', { exact:true }), 12000);
    if(!marker){ log('❗ Маркер «Инструкция для покупателя» не найден.'); scheduleNext(600); return; }

    const ruArea = await waitForSelector('#instructions_ru');
    if(!ruArea){ log('❗ Поле #instructions_ru не найдено'); scheduleNext(600); return; }
    const RU_TXT = `Спасибо за покупку!\n\nПри возникновении проблем, обращайтесь к нашей поддержке.`;
    setReactValue(ruArea, RU_TXT); log('Инструкция RU заполнена.');

    state.phase='instructions_en'; saveState(); refreshPhase();
    scheduleNext(250);
  }

  // INSTRUCTIONS: EN
  async function phaseInstructionsEN(){
    if(!isInstructionsPage()){ scheduleNext(600); return; }
    log('Фаза: Инструкция EN.');

    let enTab = findByText('.ant-tabs-tab .ant-tabs-tab-btn, .ant-tabs-tab[role="tab"] .ant-tabs-tab-btn', 'EN', { exact:true }) ||
                document.querySelector('[data-node-key="en"] .ant-tabs-tab-btn, [data-node-key="en"]');
    if(!enTab){ log('❗ Вкладка EN для инструкций не найдена'); scheduleNext(600); return; }
    realisticClick(enTab); await sleep(180);

    const enArea = await waitForSelector('#instructions_en');
    if(!enArea){ log('❗ Поле #instructions_en не найдено'); scheduleNext(600); return; }
    const EN_TXT = `Thank you for your purchase!\n\nIf you have any problems, please contact our support team.`;
    setReactValue(enArea, EN_TXT); log('Инструкция EN заполнена.');

    const oid = extractOfferIdFromUrl();
    if (oid){ state.offerId=oid; saveState(); refreshIdBadge(); log(`✅ Завершено. Offer ID: ${oid}`); }
    else { log('⚠️ ID не распознан в URL.'); }
    state.phase='done'; saveState(); refreshPhase();
  }

  // ==========================
  // 🚀 Bootstrap + URL watch
  // ==========================
  function bootAdmin(){
    ensurePanel();
    if (state.started && state.phase && state.phase!=='done'){ log(`Восстанавливаю фазу: ${state.phase}`); scheduleNext(50); }
    setInterval(()=>{
      if (location.href !== state.lastUrl){
        const prev = state.lastUrl; state.lastUrl = location.href; saveState();
        log(`URL изменился: ${prev} → ${state.lastUrl}`);
        const oid = extractOfferIdFromUrl();
        if (oid && oid !== state.offerId){ state.offerId=oid; saveState(); refreshIdBadge(); log(`Offer ID: ${oid}`); }
        scheduleNext(200);
      }
    }, 500);
  }

  function bootRemote(){
    ensureRemoteBridge();
  }

  function boot(){
    ensureRemoteBridge();
    if (isAdminUiContext()) bootAdmin();
    else if (!isAdminContext()) bootRemote();
  }
  boot();

})();
