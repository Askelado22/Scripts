// ==UserScript==
// @name         GGSEL Pricing Modifiers Applier • vibe (blocks & merged cells fixed)
// @namespace    ggsel.pricing.modifiers
// @version      1.2.0
// @description  XLSX: ID товара, Блок параметров, Параметр, Модификатор (+ число). Учитывает объединённые ячейки: протягивание блока и привязка строк без ID к единственному ID в файле. Надёжное сохранение в модалке. Автодогрузка SheetJS.
// @author       vibe
// @match        https://seller.ggsel.net/offers/edit/*/pricing
// @icon         https://ggsel.net/favicon.ico
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @connect      cdn.sheetjs.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  /******************** 0) Надёжная подгрузка SheetJS ********************/
  async function gmFetchText(url){
    return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({
        method:'GET', url, headers:{'Accept':'text/javascript,application/javascript;q=0.9,*/*;q=0.8'},
        onload:r=> (r.status>=200 && r.status<300 && r.responseText)?resolve(r.responseText):reject(new Error('HTTP '+r.status)),
        onerror:reject, ontimeout:()=>reject(new Error('Timeout')),
      });
    });
  }
  async function loadXLSXIfNeeded(){
    if (typeof XLSX !== 'undefined') return XLSX;
    if (typeof unsafeWindow!=='undefined' && unsafeWindow.XLSX) return unsafeWindow.XLSX;
    const urls=[
      'https://cdn.jsdelivr.net/npm/xlsx@0.20.2/dist/xlsx.full.min.js',
      'https://unpkg.com/xlsx@0.20.2/dist/xlsx.full.min.js',
      'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js',
    ];
    for (const u of urls){
      try{
        const code=await gmFetchText(u);
        new Function(code+'\n//# sourceURL='+JSON.stringify(u))();
        if (typeof XLSX!=='undefined') return XLSX;
        if (typeof unsafeWindow!=='undefined' && unsafeWindow.XLSX) return unsafeWindow.XLSX;
      }catch(e){ console.warn('[vibe-mod] XLSX load failed:', u, e); }
    }
    throw new Error('Не удалось загрузить SheetJS XLSX');
  }

  /************************ 1) Утилиты ************************/
  const LS_KEY='vibe.ggsel.pricing.modifiers.state';
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const norm=(s)=> (s??'').toString().replace(/\s+/g,' ').replace(/[：:]+$/,'').trim().toLowerCase();
  function isVisible(el){ if(!el) return false; const s=getComputedStyle(el); if(!s||s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false; const r=el.getBoundingClientRect(); return r&&r.width>0&&r.height>0; }
  async function waitForSelector(sel,{root=document,timeout=3e4,visible=false}={}){
    const t0=Date.now(); while(Date.now()-t0<timeout){ const el=root.querySelector(sel); if(el&&(!visible||isVisible(el))) return el; await sleep(100); } throw new Error('waitForSelector timeout: '+sel);
  }
  async function waitFor(pred,{timeout=3e4,interval=120}={}){ const t0=Date.now(); while(Date.now()-t0<timeout){ if(pred()) return true; await sleep(interval); } throw new Error('waitFor timeout'); }
  function dispatchInput(el,val){ const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'); d?.set?.call(el,val); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function realClick(el){
    if(!el) return;
    const opts={bubbles:true,cancelable:true,view:window};
    if(typeof PointerEvent!=='undefined'){
      try{ el.dispatchEvent(new PointerEvent('pointerdown',opts)); }catch{}
    }
    el.dispatchEvent(new MouseEvent('mousedown',opts));
    el.dispatchEvent(new MouseEvent('mouseup',opts));
    if(typeof PointerEvent!=='undefined'){
      try{ el.dispatchEvent(new PointerEvent('pointerup',opts)); }catch{}
    }
    el.dispatchEvent(new MouseEvent('click',opts));
  }
  function parseOfferIdFromLocation(){ const m=location.pathname.match(/\/offers\/edit\/([^\/]+)\/pricing/); return m?m[1]:null; }

  /********************* 2) Разбор XLSX (учёт объединённых) *********************/
  const HEADER_ALIASES={
    id:    ['id товара','id','offerid','productid','товар id','ид товара'],
    block: ['блок параметров','блок','группа','категория параметров'],
    param: ['параметр','вариант','название варианта','param','variant'],
    mod:   ['модификатор','modifier','sign+value','знак+число'],
    sign:  ['знак','sign'],
    value: ['значение','value','число','сумма','надбавка'],
  };
  function resolveHeaderMap(headers){
    const H=headers.map(h=>(h??'').toString().trim());
    const pick=aliases=>H.findIndex(x=>aliases.some(a=>x.toLowerCase()===a.toLowerCase()));
    const map={
      id: pick(HEADER_ALIASES.id),
      block: pick(HEADER_ALIASES.block),
      param: pick(HEADER_ALIASES.param),
      mod: pick(HEADER_ALIASES.mod),
      sign: pick(HEADER_ALIASES.sign),
      value: pick(HEADER_ALIASES.value),
    };
    if (map.id<0 || map.param<0 || (map.mod<0 && (map.sign<0 || map.value<0)))
      throw new Error('Нужны: «ID товара», «Параметр» и «Модификатор» (или «Знак»+«Значение»). Опционально: «Блок параметров».');
    return map;
  }
  function parseModifierCell(s){
    // Поддержка: "+ 1310", "-250", "0", "+0", "Нет", "1 500 ₽"
    const raw=(s??'').toString().replace(/[₽\u00A0\s]+/g,' ').trim(); // убираем валюту/неразр. пробелы
    if(!raw) return {sign:'',value:''};
    if(/^\s*нет\s*$/i.test(raw)) return {sign:'',value:''};
    const m=raw.match(/^([+-])?\s*([\d.,]+)$/);
    if(!m){
      const n=raw.match(/^([\d.,]+)$/);
      if(n) return {sign:'+', value:n[1].replace(',','.')};
      return {sign:'',value:''};
    }
    return {sign:m[1]||'+', value:(m[2]||'0').replace(',','.')};
  }
  function toArrayBuffer(file){
    return new Promise((resolve,reject)=>{
      const r=new FileReader();
      r.onload=e=>resolve(e.target.result);
      r.onerror=()=>reject(new Error('Ошибка чтения файла'));
      r.readAsArrayBuffer(file);
    });
  }
  async function parseXlsxToPlan(file,onInfo){
    const XLSX=await loadXLSXIfNeeded();
    const wb=XLSX.read(new Uint8Array(await toArrayBuffer(file)),{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true}); // массив массивов

    if(!rows.length) throw new Error('Пустой лист XLSX');
    const map=resolveHeaderMap(rows[0]);

    // 1) Соберём все ID, встречающиеся в колонке
    const idsFound=[];
    for(let i=1;i<rows.length;i++){
      const id=(rows[i]?.[map.id]??'').toString().trim();
      if(id) idsFound.push(id);
    }
    const uniqueIds=[...new Set(idsFound)];

    const byId=new Map();
    const orderIds=[];
    const pushRow=(id,obj)=>{ if(!byId.has(id)){ byId.set(id,[]); orderIds.push(id); } byId.get(id).push(obj); };

    // 2) Протягивание блока вниз, буфер строк «без ID» до ближайшего/единственного ID
    let lastBlock='';              // последний ненулевой блок
    let currentId='';              // последний встреченный ID сверху вниз
    const queueNoId=[];            // строки, встретившиеся до первого ID (в твоём файле — это как раз они)

    for(let i=1;i<rows.length;i++){
      const r=rows[i]||[];
      const idCell=(r[map.id]??'').toString().trim();
      const param=(r[map.param]??'').toString().trim();
      let block=(map.block>=0 ? (r[map.block]??'') : '').toString().trim();
      if(block) lastBlock=block; else block=lastBlock;

      let sign='', value='';
      if(map.mod>=0){ ({sign,value}=parseModifierCell(r[map.mod])); }
      else{
        sign=((r[map.sign]??'')+'').trim();
        value=((r[map.value]??'')+'').replace(/[ \u00A0]/g,'').replace(',','.');
        if(sign!=='+' && sign!=='-') sign='';
        if(!/^\d+(\.\d+)?$/.test(value)) value='';
      }

      if(!param) continue; // строка без параметра нам не нужна

      const rowObj={block, param, sign, value};

      if(idCell){
        // пришёл фактический ID → назначим его текущим и раздадим буфер очереди
        currentId=idCell;
        if(queueNoId.length){
          for(const q of queueNoId) pushRow(currentId, q);
          queueNoId.length=0;
        }
        pushRow(currentId, rowObj);
      }else{
        if(currentId){
          pushRow(currentId, rowObj);
        }else{
          // ещё не встретили ни одного ID сверху — буферим
          queueNoId.push(rowObj);
        }
      }
    }

    // 3) Хвостовые строки без ID (если вообще не встретили ID сверху)
    if(queueNoId.length){
      if(uniqueIds.length===1){
        for(const q of queueNoId) pushRow(uniqueIds[0], q);
      }else{
        // если ID несколько/нет — такие строки пропустим (и сообщим)
        console.warn('[vibe-mod] строки без ID пропущены, уникальных ID в файле:', uniqueIds.length);
      }
    }

    onInfo?.(`Строк: ${rows.length-1}, уникальных ID: ${orderIds.length}`);
    return { byId, orderIds };
  }

  /********************* 3) UI панель *********************/
  GM_addStyle(`
    .vibe-mod-panel{position:fixed;right:14px;bottom:14px;z-index:999999;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,'JetBrains Mono',monospace;}
    .vibe-card{background:#111;color:#f2d68c;border:1px solid #4a3a10;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;min-width:300px;}
    .vibe-head{padding:10px 12px;background:linear-gradient(180deg,#1b1b1b 0%,#141414 100%);border-bottom:1px solid #3a2d0d;display:flex;align-items:center;gap:8px;}
    .vibe-title{font-weight:700;font-size:14px;letter-spacing:.3px;}
    .vibe-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
    .vibe-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
    .vibe-btn{padding:6px 10px;border-radius:10px;border:1px solid #4a3a10;background:#1a1a1a;color:#f7e1a1;cursor:pointer;font-weight:600;font-size:12px;}
    .vibe-btn.primary{background:#2a2415;border-color:#7b5b1b;}
    .vibe-btn:hover{filter:brightness(1.08);}
    .vibe-file{color:#d9c18e;font-size:12px;}
    .vibe-badge{font-size:11px;padding:2px 6px;border-radius:8px;border:1px solid #4a3a10;background:#181818;color:#d0b673;}
    .vibe-log{background:#0e0e0e;border:1px dashed #4a3a10;color:#c7b07a;font-size:11px;line-height:1.4;padding:8px;border-radius:10px;max-height:200px;overflow:auto;white-space:pre-wrap;}
    .vibe-muted{opacity:.8}.vibe-ok{color:#9be28a}.vibe-warn{color:#ffd479}.vibe-err{color:#ff8b8b}.vibe-spacer{flex:1}.vibe-small{font-size:11px;}
  `);
  function createPanel(){
    const wrap=document.createElement('div');
    wrap.className='vibe-mod-panel';
    wrap.innerHTML=`
      <div class="vibe-card">
        <div class="vibe-head">
          <div class="vibe-title">Pricing Modifiers • vibe</div>
          <div class="vibe-spacer"></div>
          <div id="vibe-status" class="vibe-badge">idle</div>
        </div>
        <div class="vibe-body">
          <div class="vibe-row">
            <input id="vibe-file" type="file" accept=".xlsx,.xls" class="vibe-file">
            <button id="vibe-load" class="vibe-btn">Загрузить XLSX</button>
            <div id="vibe-fileinfo" class="vibe-small vibe-muted"></div>
          </div>
          <div class="vibe-row">
            <button id="vibe-start" class="vibe-btn primary">Старт по XLSX</button>
            <button id="vibe-stop" class="vibe-btn">Стоп</button>
            <button id="vibe-reset" class="vibe-btn">Сброс прогресса</button>
          </div>
          <div class="vibe-row vibe-small vibe-muted">
            Текущий ID: <span id="vibe-curid" class="vibe-badge">—</span>
            <span class="vibe-spacer"></span>
            <span id="vibe-progress" class="vibe-badge">0/0</span>
          </div>
          <div id="vibe-log" class="vibe-log"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap); return wrap;
  }
  const panel=createPanel();
  const $=(s)=>panel.querySelector(s); const logEl=$('#vibe-log');
  function log(msg,cls=''){ const t=new Date().toLocaleTimeString(); const line=document.createElement('div'); line.innerHTML=`<span class="vibe-muted">[${t}]</span> <span class="${cls}">${msg}</span>`; logEl.appendChild(line); logEl.scrollTop=logEl.scrollHeight; console.log('[vibe-mod]', msg); }
  function setStatus(s){ $('#vibe-status').textContent=s; } function setFileInfo(s){ $('#vibe-fileinfo').textContent=s; }
  function setProgress(i,t){ $('#vibe-progress').textContent=`${i}/${t}`; } function setCurId(id){ $('#vibe-curid').textContent=id||'—'; }

  /********************* 4) Состояние *********************/
  const state={ byId:new Map(), orderIds:[], idx:0, running:false, stopFlag:false };
  function saveState(){ const obj={orderIds:state.orderIds, idx:state.idx, running:state.running, data:Object.fromEntries(state.byId)}; localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
  function loadState(){ const raw=localStorage.getItem(LS_KEY); if(!raw) return false; try{ const o=JSON.parse(raw); state.orderIds=Array.isArray(o.orderIds)?o.orderIds:[]; state.idx=typeof o.idx==='number'?o.idx:0; state.running=!!o.running; state.byId=new Map(Object.entries(o.data||{})); return true; }catch{return false;} }
  function resetState(keep){ if(!keep) state.byId=new Map(); state.orderIds=keep?state.orderIds:[]; state.idx=0; state.running=false; state.stopFlag=false; saveState(); }
  const restored=loadState(); if(restored && state.running){ setStatus('resume'); log('Восстановление с предыдущего шага…','vibe-ok'); }

  /********************* 5) Работа со страницей *********************/
  async function ensureRuTab(){ try{ const settings=await waitForSelector('.style_settingsContainer__zPacN',{timeout:15000}); const ruBtn=settings.querySelector('.ant-tabs [data-node-key="ru"] .ant-tabs-tab-btn'); if(ruBtn){ const tab=ruBtn.closest('.ant-tabs-tab'); const isActive=tab?.querySelector('[aria-selected="true"]'); if(!isActive){ ruBtn.click(); await sleep(300); log('Переключил вкладку RU','vibe-ok'); } } }catch{} }
  function getParamBlocks(){ const ul=document.querySelector('ul.style_list__z1p_0'); return ul ? Array.from(ul.querySelectorAll('li.style_listItem___gkrR')) : []; }
  function readBlockTitle(li){ return (li.querySelector('.ant-typography')?.innerText||'').trim(); }
  function clickEditInBlock(li){ const edit=li.querySelector('[aria-label="edit"]'); if(!edit) throw new Error('Иконка редактирования не найдена'); edit.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
  async function waitForOpenModal(){ const first=await waitForSelector('.ant-modal-content',{timeout:15000}); const all=Array.from(document.querySelectorAll('.ant-modal-content')); return all[all.length-1]||first; }
  async function waitModalClosed(modalRoot){ await waitFor(()=>!document.body.contains(modalRoot) || !isVisible(modalRoot), {timeout:20000}); }

  async function waitForDropdownWithOption(text){ const t0=Date.now(); while(Date.now()-t0<8000){ const dds=Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(isVisible); for(const dd of dds){ if(findDropdownOption(dd,text)) return dd; } await sleep(80); } throw new Error('dropdown timeout'); }
  function findDropdownOption(dd,text){ let opt=Array.from(dd.querySelectorAll('.ant-select-item-option')).find(o=>(o.innerText||'').trim()===text); if(!opt){ const c=Array.from(dd.querySelectorAll('.ant-select-item-option-content')).find(n=>(n.innerText||'').trim()===text); if(c) opt=c.closest('.ant-select-item-option'); } return opt; }
  async function antSelectChoose(selectEl,optionText){
    const selBtn=selectEl.querySelector('.ant-select-selector'); if(!selBtn) throw new Error('antSelect: .ant-select-selector не найден');
    realClick(selBtn);
    const dd=await waitForDropdownWithOption(optionText); const opt=findDropdownOption(dd,optionText);
    if(!opt) throw new Error(`Опция "${optionText}" не найдена`);
    realClick(opt);
    await waitFor(()=>!isVisible(dd)||!document.body.contains(dd),{timeout:8000});
  }

  async function applyForModal(modalContentEl, rowsForBlock){
    let changes=0;
    // Группируем по названию варианта (RU)
    const needByName=new Map();
    for(const r of rowsForBlock){ const name=(r.param||'').trim(); if(!name) continue; if(!needByName.has(name)) needByName.set(name,[]); needByName.get(name).push({sign:r.sign,value:r.value}); }

    const articles=Array.from(modalContentEl.querySelectorAll('article.style_variant__eTXyL'));
    if(!articles.length){ log('В модалке нет вариантов','vibe-warn'); return 0; }

    for(const art of articles){
      const nameInput=art.querySelector('.field-lang._visible input[type="text"]');
      const varName=(nameInput?.value||'').trim();
      if(!varName) continue;
      const defaultLabel=Array.from(art.querySelectorAll('label.ant-checkbox-wrapper')).find(l=>(l.textContent||'').trim()==='По умолчанию');
      const isDefault=defaultLabel?.querySelector('input[type="checkbox"]')?.checked;
      if(isDefault){
        log(`«${varName}»: пропуск (вариант по умолчанию)`,'vibe-muted');
        continue;
      }

      const rows=needByName.get(varName);
      if(!rows?.length) continue;
      const {sign,value}=rows[rows.length-1];

      const wrapper=art.querySelector('.style_priceWrapper__HvgMK');
      const numberInput=art.querySelector('.style_priceInput__ni8vE input.ant-input-number-input');
      if(wrapper){
        const selects=Array.from(wrapper.querySelectorAll('.ant-select'));
        const signSelect = selects.find(s=>['+','-'].includes((s.querySelector('.ant-select-selection-item')?.textContent||'').trim())) || selects[0];
        try{
          if(sign && signSelect && !signSelect.classList.contains('ant-select-disabled')){
            await antSelectChoose(signSelect, sign);
            log(`«${varName}»: знак = ${sign}`,'vibe-ok'); changes++;
          }
        }catch(e){ log(`«${varName}»: не удалось выставить знак (${e.message})`,'vibe-warn'); }
      }
      if(numberInput && value!==''){
        dispatchInput(numberInput, value);
        log(`«${varName}»: значение = ${value}`,'vibe-ok'); changes++;
      }
    }

    const modalRoot=modalContentEl.closest('.ant-modal');
    // Ищем любой .ant-btn-primary в пределах модалки (текст может отличаться)
    let saveBtn = modalRoot?.querySelector('.ant-btn-primary');
    if(!saveBtn){
      saveBtn = Array.from(modalRoot?.querySelectorAll('button')||[]).find(b=>['добавить','сохранить','сохранить изменения','применить'].includes((b.innerText||'').trim().toLowerCase()));
    }

    if(changes>0 && saveBtn){
      saveBtn.click();
      await waitModalClosed(modalRoot);
      log('Изменения сохранены','vibe-ok');
    }else{
      // закрываем крестиком, даже если изменений нет
      const closeBtn=modalRoot?.querySelector('.ant-modal-close');
      if(closeBtn){ closeBtn.click(); await waitModalClosed(modalRoot); }
      log('Нет изменений — модалка закрыта','vibe-muted');
    }
    return changes;
  }

  async function processAllBlocksForId(planRows){
    await ensureRuTab();

    // сгруппируем строки по заголовку блока (нормализованному)
    const rowsByBlock=new Map();
    for(const r of planRows){ const key=norm(r.block||''); if(!rowsByBlock.has(key)) rowsByBlock.set(key,[]); rowsByBlock.get(key).push(r); }

    const ul=document.querySelector('ul.style_list__z1p_0');
    if(!ul){ log('Блок «Параметры» не найден. Пропуск ID.','vibe-warn'); return; }

    const blocks=getParamBlocks();
    log(`Найдено блоков параметров: ${blocks.length}`,'vibe-muted');

    for(let i=0;i<blocks.length;i++){
      if(state.stopFlag) return;
      const li=blocks[i];
      const titleRaw=readBlockTitle(li);
      const titleKey=norm(titleRaw);

      const rowsForThisBlock=[...(rowsByBlock.get(titleKey)||[])];
      if(!rowsForThisBlock.length){
        log(`Блок ${i+1} «${titleRaw}»: нет строк из XLSX — пропуск`,'vibe-muted');
        continue;
      }

      try{ clickEditInBlock(li); }catch(e){ log(`Блок ${i+1}: нет кнопки «Редактировать» (${e.message})`,'vibe-warn'); continue; }

      try{
        const modal=await waitForOpenModal();
        await applyForModal(modal, rowsForThisBlock);
      }catch(e){
        log(`Блок ${i+1}: ошибка применения (${e.message})`,'vibe-err');
      }
      await sleep(400);
    }
  }

  async function navigateToId(id){
    const target=`https://seller.ggsel.net/offers/edit/${encodeURIComponent(id)}/pricing`;
    if(location.href!==target){ location.assign(target); } else { await sleep(200); }
  }

  async function mainLoop(){
    if(!state.orderIds.length){ log('Нет данных. Сначала «Загрузить XLSX».','vibe-warn'); return; }
    state.running=true; state.stopFlag=false; saveState(); setStatus('run');

    const wantId=state.orderIds[state.idx];
    const curId=parseOfferIdFromLocation();
    setCurId(wantId||'—'); setProgress(state.idx, state.orderIds.length);

    if(!wantId){ log('Все ID обработаны.','vibe-ok'); setStatus('done'); state.running=false; saveState(); return; }
    if(curId!==wantId){ log(`Навигация к ID ${wantId}…`,'vibe-muted'); await navigateToId(wantId); return; }

    try{ await waitForSelector('.style_settingsContainer__zPacN',{timeout:30000}); }catch{ log('Не дождался контейнера настроек. Продолжаю.','vibe-warn'); }

    const planRows=state.byId.get(wantId)||[];
    // мини-статистика по блокам для наглядности
    const stats = planRows.reduce((m,r)=>{ const k=norm(r.block||''); m[k]=(m[k]||0)+1; return m; },{});
    log(`ID ${wantId}: строк для применения — ${planRows.length}; по блокам: ${Object.entries(stats).map(([k,v])=>`[${k||'—'}:${v}]`).join(' ')}`,'vibe-muted');

    if(planRows.length) await processAllBlocksForId(planRows);

    state.idx+=1; setProgress(state.idx,state.orderIds.length); saveState();

    if(state.idx>=state.orderIds.length){ log('Готово. Все ID обработаны.','vibe-ok'); setStatus('done'); state.running=false; saveState(); return; }
    if(state.stopFlag){ log('Остановлено пользователем.','vibe-warn'); setStatus('stopped'); state.running=false; saveState(); return; }

    const nextId=state.orderIds[state.idx]; setCurId(nextId); log(`Переход к следующему ID: ${nextId}`,'vibe-muted'); await navigateToId(nextId);
  }

  /********************* 6) Кнопки *********************/
  $('#vibe-load').addEventListener('click', async ()=>{
    const file=$('#vibe-file').files?.[0];
    if(!file){ log('Выбери XLSX файл.','vibe-warn'); return; }
    try{
      setStatus('parsing'); await loadXLSXIfNeeded();
      const parsed=await parseXlsxToPlan(file,(info)=>setFileInfo(info));
      state.byId=parsed.byId; state.orderIds=parsed.orderIds; state.idx=0; setProgress(0,state.orderIds.length); saveState();
      log('XLSX загружен и разобран.','vibe-ok'); setStatus('idle');
    }catch(e){ log(`Ошибка разбора XLSX: ${e.message}`,'vibe-err'); setStatus('idle'); }
  });

  $('#vibe-start').addEventListener('click', ()=>{
    if(!state.orderIds.length){ log('Нет данных. Сначала «Загрузить XLSX».','vibe-warn'); return; }
    if(state.running){ log('Уже запущено.','vibe-warn'); return; }
    state.running=true; state.stopFlag=false; saveState();
    mainLoop().catch(e=>{ log(`mainLoop error: ${e.message}`,'vibe-err'); setStatus('idle'); state.running=false; saveState(); });
  });

  $('#vibe-stop').addEventListener('click', ()=>{ state.stopFlag=true; saveState(); log('Запрошена остановка…','vibe-warn'); });
  $('#vibe-reset').addEventListener('click', ()=>{ resetState(false); setCurId('—'); setProgress(0,0); setFileInfo(''); log('Сброшено состояние и данные.','vibe-warn'); setStatus('idle'); });

  (async function autoResume(){
    if(state.running && !state.stopFlag){
      await sleep(400);
      mainLoop().catch(e=>{ log(`autoResume/mainLoop error: ${e.message}`,'vibe-err'); setStatus('idle'); state.running=false; saveState(); });
    }
  })();

  GM_registerMenuCommand('Старт', ()=>$('#vibe-start').click());
  GM_registerMenuCommand('Стоп', ()=>$('#vibe-stop').click());
  GM_registerMenuCommand('Сброс', ()=>$('#vibe-reset').click());
})();
