// ==UserScript==
// @name         GGSEL → CSV/TSV/XLSX — TURBO (Shards + Filters + Crumbs Cleaner + Retry Errors + Detail Log) — blackgold
// @namespace    ggsel.finder.csv.turbo
// @version      1.5.0
// @description  Супер-быстрый сбор (url,name,description) с GGSEL: шардинг по вкладкам, фильтр «битых», живой лог ошибок (статус/ETA/скорость/длительность/шард/попытка), повторный прогон ошибок с подменой на исходных позициях, CSV/TSV/XLSX, очистка «крошек» по успешным товарам.
// @author       vibe
// @icon         https://ggsel.net/favicon.ico
// @match        https://ggsel.net/*
// @match        https://docs.google.com/spreadsheets/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      ggsel.net
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /** =======================
   *  Быстрые настройки
   *  ======================= */
  const DEFAULT_SHARDS = 8;     // вкладок-воркеров
  const DEFAULT_POOL   = 24;    // параллельных запросов на воркер
  const BETWEEN_MS     = 60;    // мягкая задержка между стартами в пуле (мс)
  const CSV_SEP        = ',';   // в RU-Excel можно ';'
  const XLSX_CDN       = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  const FILENAME_CSV    = () => `ggsel_export_${fmtDate(new Date())}.csv`;
  const FILENAME_XLSX   = () => `ggsel_export_${fmtDate(new Date())}.xlsx`;
  const FILENAME_ERR    = () => `ggsel_errors_${fmtDate(new Date())}.csv`;
  const FILENAME_ERRDET = () => `ggsel_errors_detail_${fmtDate(new Date())}.csv`;
  const FILENAME_CRMB   = () => `ggsel_crumbs_clean_${fmtDate(new Date())}.csv`;

  /** =======================
   *  Общие хелперы
   *  ======================= */
  const isGGSEL = location.host.includes('ggsel.net');

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const pad2 = (n)=>String(n).padStart(2,'0');
  function fmtDate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; }

  function decodeHTML(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = String(html || '');
    return txt.value;
  }
  function htmlToText(html) {
    const stripped = String(html || '').replace(/<[^>]+>/g, ' ');
    return decodeHTML(stripped).replace(/\s+/g, ' ').trim();
  }
  function csvEscape(v) {
    const s = String(v ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  }

  function parseLinksFromText(text) {
    const s = String(text || '');
    const urls = Array.from(s.matchAll(/https?:\/\/(?:www\.)?ggsel\.net\/catalog\/product\/(\d+)/gi))
      .map(m => `https://ggsel.net/catalog/product/${m[1]}`);
    const ids  = Array.from(s.matchAll(/(^|[^0-9])(\d{5,12})(?!\d)/g))
      .map(m => m[2]).map(id => `https://ggsel.net/catalog/product/${id}`);
    return [...urls, ...ids].filter((v,i,a)=>a.indexOf(v)===i);
  }
  function collectProductLinksFromDOM() {
    const anchors = Array.from(document.querySelectorAll('a[href^="/catalog/product/"]'));
    return anchors
      .map(a => a.getAttribute('href'))
      .filter(Boolean)
      .map(href => href.startsWith('http') ? href : ('https://ggsel.net' + href.split('?')[0]))
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  /** =======================
   *  Сетевой парсер страницы
   *  ======================= */
  function fetchGGselRow(url) {
    const started = performance.now();
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache',
        },
        onload: function (response) {
          const durationMs = Math.round(performance.now() - started);
          const html = response.responseText || '';
          const status = response.status|0;
          const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
          if (!jsonMatch) {
            return resolve({ url, name: '', description: '', error: 'Нет __NEXT_DATA__', _meta:{status,durationMs} });
          }
          try {
            const json = JSON.parse(jsonMatch[1]);
            const pd = json?.props?.pageProps?.productData;
            const name = (pd?.name || '').trim();
            const descHtml = (pd?.info || '');
            const description = htmlToText(descHtml);
            resolve({ url, name, description, error: '', _meta:{status,durationMs} });
          } catch (e) {
            resolve({ url, name: '', description: '', error: 'JSON: ' + e.message, _meta:{status,durationMs} });
          }
        },
        onerror: function () {
          const durationMs = Math.round(performance.now() - started);
          resolve({ url, name: '', description: '', error: 'Ошибка загрузки', _meta:{status:0,durationMs} });
        },
        timeout: 30000,
        ontimeout: function () {
          const durationMs = Math.round(performance.now() - started);
          resolve({ url, name: '', description: '', error: 'Таймаут', _meta:{status:0,durationMs} });
        }
      });
    });
  }

  /** =======================
   *  Генераторы форматов
   *  ======================= */
  function rowsToCSV(rows) {
    const header = ['url','name','description'].map(csvEscape).join(CSV_SEP);
    const lines = rows.map(r => {
      const url = r.url || '';
      const name = r.name || '';
      const description = r.description || '';
      return [url, name, description].map(csvEscape).join(CSV_SEP);
    });
    return '\uFEFF' + [header, ...lines].join('\r\n'); // BOM для Excel
  }
  function rowsToTSV(rows) {
    const header = 'url\tname\tdescription';
    const lines = rows.map(r => {
      const url = (r.url||'').replace(/\t|\r|\n/g,' ');
      const name = (r.name||'').replace(/\t|\r|\n/g,' ');
      const description = (r.description||'').replace(/\t|\r|\n/g,' ');
      return `${url}\t${name}\t${description}`;
    });
    return [header, ...lines].join('\n');
  }
  function errorsToCSV(errors) {
    // краткий (как раньше)
    const header = ['url','reason'].map(csvEscape).join(CSV_SEP);
    const lines = errors.map(e => [e.url||'', e.reason||''].map(csvEscape).join(CSV_SEP));
    return '\uFEFF' + [header, ...lines].join('\r\n');
  }
  function errorsDetailToCSV(errors) {
    // детальный: timestamp,attempt,shard,status,duration_ms,reason,url
    const header = ['timestamp','attempt','shard','status','duration_ms','reason','url'].map(csvEscape).join(CSV_SEP);
    const lines = errors.map(e => [
      new Date(e.when).toISOString(),
      String(e.attempt||1),
      String(e.shardIdx ?? ''),
      String(e.status ?? ''),
      String(e.durationMs ?? ''),
      e.reason || '',
      e.url || ''
    ].map(csvEscape).join(CSV_SEP));
    return '\uFEFF' + [header, ...lines].join('\r\n');
  }

  let _sheetJsLoading = null;
  function ensureSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_sheetJsLoading) return _sheetJsLoading;
    _sheetJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_CDN;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('Не удалось загрузить SheetJS'));
      document.head.appendChild(s);
    });
    return _sheetJsLoading;
  }
  function buildAOA(rows) {
    return [
      ['url','name','description'],
      ...rows.map(r => [r.url || '', r.name || '', r.description || '']),
    ];
  }
  async function downloadXLSX(rows, filename) {
    const XLSX = await ensureSheetJS();
    const aoa = buildAOA(rows);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{wch:60},{wch:48},{wch:120}];
    XLSX.utils.book_append_sheet(wb, ws, 'GGSEL');
    const blob = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function downloadTextAsCSV(text, filename) {
    downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), filename);
  }

  /** =======================
   *  GM storage helpers
   *  ======================= */
  function gmGet(key, def) {
    try { return Promise.resolve(GM_getValue(key, def)); }
    catch { return Promise.resolve(def); }
  }
  function gmSet(key, val) {
    try { return Promise.resolve(GM_setValue(key, val)); }
    catch { return Promise.resolve(); }
  }

  /** =======================
   *  Worker-mode (вкладка-воркер)
   *  ======================= */
  const workerInfo = parseWorkerHash();
  if (workerInfo) {
    runWorker(workerInfo).finally(() => { try { window.close(); } catch (e) {} });
    return;
  }
  function parseWorkerHash() {
    const m = location.hash.match(/#ggsel-csv-worker=([^&]+)&shard=(\d+)&total=(\d+)/);
    if (!m) return null;
    return { jobId: m[1], shardIdx: Number(m[2]), totalShards: Number(m[3]) };
  }

  async function runWorker({ jobId, shardIdx, totalShards }) {
    const cfg   = await gmGet(`job:${jobId}:config`, null);
    const items = await gmGet(`job:${jobId}:items`, []); // [{url, idx}]
    if (!cfg || !Array.isArray(items) || items.length === 0) return;

    const { pool = DEFAULT_POOL, betweenMs = BETWEEN_MS, attempt = 1 } = cfg;

    // Режем на свой шард по позиции в items
    const myItems = items.filter((_, i) => (i % totalShards) === shardIdx);

    // Инициализация прогресса и ошибок
    await gmSet(`job:${jobId}:progress:${shardIdx}`, { done: 0, total: myItems.length });
    await gmSet(`job:${jobId}:errors:${shardIdx}`, []); // детальные ошибки

    const results = new Array(myItems.length); // [{row:{...}, idx}]
    let next = 0, active = 0, done = 0;

    // Флаг аборта
    async function aborted() { return !!(await gmGet(`job:${jobId}:abort`, false)); }

    await new Promise((resolve) => {
      const kick = async () => {
        while (active < pool && next < myItems.length) {
          if (await aborted()) { resolve(); return; }
          const myPos = next++;
          const { url, idx } = myItems[myPos];

          active++;
          await wait(betweenMs * (myPos % Math.max(1,pool)));
          fetchGGselRow(url).then(row => {
            // Локальная проверка «битости»
            const bad = row.error || !row.name || !row.description;
            if (bad) {
              pushShardError(jobId, shardIdx, {
                url,
                reason: row.error || (!row.name ? 'Нет name' : 'Нет description'),
                status: row._meta?.status ?? '',
                durationMs: row._meta?.durationMs ?? '',
                attempt,
                shardIdx,
                when: Date.now()
              });
            }
            results[myPos] = { row, idx };
          }).catch(() => {
            const row = { url, name: '', description: '', error: 'Unknown', _meta:{status:'',durationMs:''} };
            pushShardError(jobId, shardIdx, {
              url, reason: row.error, status:'', durationMs:'', attempt, shardIdx, when: Date.now()
            });
            results[myPos] = { row, idx };
          }).finally(async () => {
            active--; done++;
            await gmSet(`job:${jobId}:progress:${shardIdx}`, { done, total: myItems.length });
            if (next >= myItems.length && active === 0) resolve(); else kick();
          });
        }
      };
      kick();
    });

    await gmSet(`job:${jobId}:shard:${shardIdx}:rows`, results); // с индексами
    await gmSet(`job:${jobId}:done:${shardIdx}`, true);
  }

  async function pushShardError(jobId, shardIdx, errDetail) {
    const arr = await gmGet(`job:${jobId}:errors:${shardIdx}`, []);
    arr.push(errDetail);
    await gmSet(`job:${jobId}:errors:${shardIdx}`, arr);
  }

  /** =======================
   *  Master UI
   *  ======================= */
  addStyles();
  addFab();

  function addFab() {
    if (document.getElementById('ggselturbo-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'ggselturbo-fab';
    btn.title = 'GGSEL TURBO CSV/TSV/XLSX';
    btn.textContent = '⚡';
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  function openModal() {
    if (document.getElementById('ggselturbo-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ggselturbo-modal';
    modal.innerHTML = `
      <button class="csv-close" title="Закрыть">✕</button>
      <div class="csv-title" id="csv-title">GGSEL TURBO • CSV / TSV / XLSX</div>

      <div class="csv-field">
        <label>Ссылки или ID (по одному в строке). Можно вставлять «сырой» текст — извлечём product-URL.</label>
        <textarea id="csv-links" placeholder="https://ggsel.net/catalog/product/1234567
https://ggsel.net/catalog/product/7654321
1234567"></textarea>
      </div>

      <div class="csv-row">
        <div class="csv-field tiny">
          <label>Shards</label>
          <input type="number" id="csv-shards" min="1" max="24" value="${DEFAULT_SHARDS}">
        </div>
        <div class="csv-field tiny">
          <label>Пул/воркер</label>
          <input type="number" id="csv-pool" min="1" max="128" value="${DEFAULT_POOL}">
        </div>
        <div class="csv-field tiny">
          <label>Delay (ms)</label>
          <input type="number" id="csv-delay" min="0" max="500" value="${BETWEEN_MS}">
        </div>
        <div class="csv-field tiny">
          <label>Фильтр «битых»</label>
          <input type="checkbox" id="csv-filter-bad" checked>
        </div>
        <div class="csv-buttons">
          ${isGGSEL ? `<button class="csv-btn ghost" id="csv-grab">Подхватить со страницы</button>` : ''}
          <button class="csv-btn" id="csv-run">Собрать (TURBO)</button>
          <button class="csv-btn danger" id="csv-stop" disabled>Стоп</button>
          <button class="csv-btn ghost" id="csv-retry" disabled>Повторить ошибки</button>
          <button class="csv-btn ghost" id="csv-copy" disabled>Копировать CSV</button>
          <button class="csv-btn ghost" id="csv-copy-tsv" disabled>Копировать TSV</button>
          <button class="csv-btn ghost" id="csv-save" disabled>Скачать CSV</button>
          <button class="csv-btn ghost" id="csv-save-xlsx" disabled>Скачать XLSX</button>
          <button class="csv-btn ghost" id="csv-save-errors" disabled>Скачать ошибки (кратко)</button>
          <button class="csv-btn ghost" id="csv-save-errors-detail" disabled>Скачать ошибки (детально)</button>
        </div>

        <div class="csv-field csv-params">
          <label>Параметры (модификаторы):</label>
          <div class="csv-param-buttons">
            <button class="csv-btn ghost" id="csv-copy-mod-plus" disabled>Копировать модификаторы (+1%)</button>
            <button class="csv-btn ghost" id="csv-copy-mod-base" disabled>Копировать модификаторы (стандарт)</button>
            <button class="csv-btn ghost" id="csv-copy-mod-base-names" disabled>Названия и станд. моды</button>
          </div>
          <div class="csv-param-status" id="csv-params-status">Сначала соберите данные.</div>
        </div>
      </div>

      <div class="csv-metrics" id="csv-metrics">⏱ 0:00 • ETA — • 0.0/с</div>
      <div class="csv-progress"><div id="csv-bar"></div></div>
      <div class="csv-status" id="csv-status"></div>

      <details id="csv-errors-box" class="csv-errors">
        <summary>Ошибки: <span id="csv-errors-count">0</span> (раскрыть) • <span id="csv-errors-agg"></span></summary>
        <div id="csv-errors-list"></div>
      </details>

      <div class="csv-field">
        <label>Предпросмотр CSV (после фильтрации, если включена):</label>
        <textarea id="csv-output" placeholder="Здесь появится CSV" readonly></textarea>
      </div>

      <div class="csv-crumbs">
        <div class="csv-crumbs-title">Очистка «крошек» (CSV/TSV) по результатам парсинга</div>
        <div class="csv-crumbs-row">
          <input type="file" id="crumbs-file" accept=".csv,.tsv,.txt">
          <button class="csv-btn ghost" id="crumbs-clean" disabled>Очистить крошки</button>
          <button class="csv-btn ghost" id="crumbs-save" disabled>Скачать очищенные крошки</button>
          <span id="crumbs-status" class="crumbs-status"></span>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    restoreModalPosition(modal);
    window.addEventListener('resize', () => clampToViewport(modal), { passive: true });

    modal.querySelector('.csv-close').addEventListener('click', () => modal.remove());
    enableDrag(modal, modal.querySelector('.csv-title'));

    // Элементы
    const taLinks      = document.getElementById('csv-links');
    const inShards     = document.getElementById('csv-shards');
    const inPool       = document.getElementById('csv-pool');
    const inDelay      = document.getElementById('csv-delay');
    const cbFilterBad  = document.getElementById('csv-filter-bad');
    const btnGrab      = document.getElementById('csv-grab');
    const btnRun       = document.getElementById('csv-run');
    const btnStop      = document.getElementById('csv-stop');
    const btnRetry     = document.getElementById('csv-retry');
    const btnCopy      = document.getElementById('csv-copy');
    const btnCopyTSV   = document.getElementById('csv-copy-tsv');
    const btnCopyModPlus = document.getElementById('csv-copy-mod-plus');
    const btnCopyModBase = document.getElementById('csv-copy-mod-base');
    const btnCopyModBaseNames = document.getElementById('csv-copy-mod-base-names');
    const btnSave      = document.getElementById('csv-save');
    const btnSaveX     = document.getElementById('csv-save-xlsx');
    const btnSaveErr   = document.getElementById('csv-save-errors');
    const btnSaveErrD  = document.getElementById('csv-save-errors-detail');
    const taOut        = document.getElementById('csv-output');
    const bar          = document.getElementById('csv-bar');
    const status       = document.getElementById('csv-status');
    const metrics      = document.getElementById('csv-metrics');

    const paramsStatus = document.getElementById('csv-params-status');

    const errorsBox    = document.getElementById('csv-errors-box');
    const errorsCount  = document.getElementById('csv-errors-count');
    const errorsAgg    = document.getElementById('csv-errors-agg');
    const errorsList   = document.getElementById('csv-errors-list');

    const crumbsFile   = document.getElementById('crumbs-file');
    const btnCrClean   = document.getElementById('crumbs-clean');
    const btnCrSave    = document.getElementById('crumbs-save');
    const crumbsStatus = document.getElementById('crumbs-status');

    // Состояние мастера
    let currentJobId = null;
    let pollTimer = null;
    let startTs = 0;
    let lastAttempt = 1;

    // Храним массив результатов в порядке ИНДЕКСОВ
    let inputItems = [];             // [{url, idx}]
    let rowsByIndex = [];            // индексированный массив: rowsByIndex[idx] = {url,name,description,error,_meta}
    let lastRowsGood = [];           // отфильтрованные «хорошие»
    let lastErrorsDetail = [];       // детальные ошибки текущего запуска (или повтора)
    let renderedErrLens = {};        // сколько ошибок уже показали по шартам
    let crumbsParsed = null;
    let lastParamModifiers = [];     // модификаторы из описаний

    if (btnGrab) {
      btnGrab.addEventListener('click', () => {
        const urls = collectProductLinksFromDOM();
        if (!urls.length) { setStatus(status, 'Не найдено ссылок на товары на этой странице.'); return; }
        const prev = parseLinksFromText(taLinks.value);
        const merged = [...prev, ...urls].filter((v,i,a)=>a.indexOf(v)===i);
        taLinks.value = merged.join('\n');
        setStatus(status, `Подхвачено со страницы: ${urls.length}. Всего: ${merged.length}.`);
      });
    }

    btnRun.addEventListener('click', async () => {
      const urls = parseLinksFromText(taLinks.value);
      if (!urls.length) { setStatus(status, 'Добавьте ссылки или ID товаров.'); return; }

      // формируем items с индексами (порядок = оригинальный)
      inputItems = urls.map((url, idx) => ({ url, idx }));
      rowsByIndex = new Array(inputItems.length);
      lastAttempt = 1;

      await runMasterJob(inputItems, { attempt: lastAttempt });
    });

    btnRetry.addEventListener('click', async () => {
      // Собираем ошибки по текущему состоянию rowsByIndex
      const badIdx = [];
      for (let i = 0; i < rowsByIndex.length; i++) {
        const r = rowsByIndex[i];
        if (!r || r.error || !r.name || !r.description) badIdx.push(i);
      }
      if (!badIdx.length) { setStatus(status, 'Повтор не требуется: ошибок нет.'); return; }

      // Готовим items «только ошибки»
      const items = badIdx.map(idx => ({ url: rowsByIndex[idx]?.url || inputItems[idx].url, idx }));
      lastAttempt += 1;

      // очистим UI-лог ошибок и значения в GM для нового прогона
      errorsList.textContent = '';
      errorsCount.textContent = '0';
      errorsAgg.textContent = '';
      lastErrorsDetail = [];
      renderedErrLens = {};

      await runMasterJob(items, { attempt: lastAttempt, resumeIntoExistingArray: true });
    });

    async function runMasterJob(items, opts) {
      const { attempt = 1, resumeIntoExistingArray = false } = opts || {};
      const shards = clamp(Number(inShards.value) || DEFAULT_SHARDS, 1, 24);
      const pool   = clamp(Number(inPool.value)   || DEFAULT_POOL,   1, 128);
      const delay  = clamp(Number(inDelay.value)  || BETWEEN_MS,     0, 500);
      const filterBad = !!cbFilterBad.checked;

      // Создаём джобу
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      currentJobId = jobId;

      taOut.value = '';
      btnRun.disabled = true;
      btnStop.disabled = true;
      btnRetry.disabled = true;
      btnCopy.disabled = btnCopyTSV.disabled = btnSave.disabled = btnSaveX.disabled = btnSaveErr.disabled = btnSaveErrD.disabled = true;
      if (btnCopyModPlus) btnCopyModPlus.disabled = true;
      if (btnCopyModBase) btnCopyModBase.disabled = true;
      if (btnCopyModBaseNames) btnCopyModBaseNames.disabled = true;
      lastParamModifiers = [];
      if (paramsStatus) setStatus(paramsStatus, 'Модификаторы появятся после завершения сбора.');
      setProgress(0); setMetrics(0, 0, 0);

      if (!resumeIntoExistingArray) {
        // новый прогон по полному набору
        rowsByIndex = new Array(items.length);
      }

      setStatus(status, `${attempt===1?'Старт':'Повтор'} TURBO: ${items.length} ссылок • shards=${shards} • pool=${pool} • delay=${delay}ms • фильтр=${filterBad?'ON':'OFF'} • попытка=${attempt}`);

      await gmSet(`job:${jobId}:abort`, false);
      await gmSet(`job:${jobId}:config`, { pool, betweenMs: delay, attempt });
      await gmSet(`job:${jobId}:items`, items); // [{url,idx}]
      for (let i=0;i<shards;i++){
        await gmSet(`job:${jobId}:done:${i}`, false);
        await gmSet(`job:${jobId}:progress:${i}`, { done: 0, total: 0 });
        await gmSet(`job:${jobId}:errors:${i}`, []);
        await gmSet(`job:${jobId}:merged:${i}`, false);
      }

      // Открываем воркеров
      for (let i=0;i<shards;i++){
        window.open(`https://ggsel.net/#ggsel-csv-worker=${jobId}&shard=${i}&total=${shards}`, '_blank', 'noopener');
        await wait(30);
      }
      btnStop.disabled = false;
      startTs = Date.now();

      // Поллинг прогресса/ошибок и сбор результатов
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      pollTimer = setInterval(async () => {
        let totalAll = 0, doneAll = 0, finishedShards = 0;

        // прогресс и новые ошибки
        for (let i=0;i<shards;i++){
          const pr = await gmGet(`job:${jobId}:progress:${i}`, {done:0,total:0});
          doneAll  += pr.done|0;
          totalAll += pr.total|0;

          // новые ошибки с деталями
          const errs = await gmGet(`job:${jobId}:errors:${i}`, []);
          const already = renderedErrLens[i] || 0;
          if (errs.length > already) {
            const chunk = errs.slice(already);
            appendErrors(chunk);
            renderedErrLens[i] = errs.length;
          }

          const isDone = await gmGet(`job:${jobId}:done:${i}`, false);
          if (isDone) finishedShards++;
        }

        const elapsed = (Date.now() - startTs) / 1000;
        const speed = elapsed > 0 ? (doneAll / elapsed) : 0;
        const eta = (speed > 0 && totalAll>0) ? Math.max(0, (totalAll - doneAll) / speed) : 0;
        setMetrics(elapsed, eta, speed);

        const pct = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0;
        setProgress(pct);
        setStatus(status, `Прогресс: ${doneAll}/${totalAll} (${pct}%) • Готовых шардов: ${finishedShards}/${shards} • Ошибок: ${lastErrorsDetail.length}`);

        // Мержим результаты готовых шардов по индексам
        for (let i=0;i<shards;i++){
          const alreadyMerged = await gmGet(`job:${jobId}:merged:${i}`, false);
          const isDone = await gmGet(`job:${jobId}:done:${i}`, false);
          if (isDone && !alreadyMerged){
            const rowsIdx = await gmGet(`job:${jobId}:shard:${i}:rows`, []); // [{row, idx}]
            for (const ri of rowsIdx) {
              if (!ri) continue;
              rowsByIndex[ri.idx] = ri.row;
            }
            await gmSet(`job:${jobId}:merged:${i}`, true);
          }
        }

        // Финиш
        if (finishedShards === shards) {
          clearInterval(pollTimer); pollTimer = null;

          const good = filterGood(rowsByIndex);
          lastRowsGood = cbFilterBad.checked ? good : rowsByIndex.slice();

          // CSV предпросмотр
          const csv = rowsToCSV(lastRowsGood.filter(Boolean));
          taOut.value = csv;

          btnCopy.disabled = btnCopyTSV.disabled = btnSave.disabled = btnSaveX.disabled = false;
          btnSaveErr.disabled = (lastErrorsDetail.length === 0);
          btnSaveErrD.disabled = (lastErrorsDetail.length === 0);
          updateParameterModifiers();
          btnRun.disabled = false;
          btnStop.disabled = true;
          btnRetry.disabled = (getCurrentBadCount() === 0);

          const ok = lastRowsGood.filter(r => r && !r.error).length;
          const bad = getCurrentBadCount();
          setProgress(100);
          setStatus(status, `${attempt===1?'Готово':'Повтор завершён'}: всего=${rowsByIndex.length}, норм=${ok}, битых=${bad}.${bad? ' Можно нажать «Повторить ошибки».':''}`);
          crumbsMaybeEnable();
          updateErrorsAggregation();
        }
      }, 400);
    }

    function getCurrentBadCount() {
      let bad = 0;
      for (const r of rowsByIndex) {
        if (!r || r.error || !r.name || !r.description) bad++;
      }
      return bad;
    }

    function appendErrors(chunk) {
      for (const e of chunk) {
        lastErrorsDetail.push(e);
        const div = document.createElement('div');
        div.className = 'err-row';
        div.textContent = `[${new Date(e.when).toLocaleTimeString()}] #${e.attempt ?? 1} sh${e.shardIdx ?? ''} s=${e.status ?? ''} ${e.durationMs? e.durationMs+'ms':''} — ${e.reason} — ${e.url}`;
        errorsList.appendChild(div);
      }
      errorsCount.textContent = String(lastErrorsDetail.length);
      updateErrorsAggregation();
    }

    function updateErrorsAggregation() {
      if (!lastErrorsDetail.length) { errorsAgg.textContent = ''; return; }
      const byReason = {};
      for (const e of lastErrorsDetail) {
        const k = e.reason || 'unknown';
        byReason[k] = (byReason[k]||0)+1;
      }
      const top = Object.entries(byReason).sort((a,b)=>b[1]-a[1]).slice(0,5)
        .map(([k,v])=>`${k}:${v}`).join(' • ');
      errorsAgg.textContent = top;
    }

    btnStop.addEventListener('click', async () => {
      if (!currentJobId) return;
      await gmSet(`job:${currentJobId}:abort`, true);
      setStatus(status, 'Стоп: воркеры завершаются…');
      btnStop.disabled = true;
    });

    btnRetry.addEventListener('click', () => {}); // обработчик назначен выше в btnRetry.addEventListener

    btnCopy.addEventListener('click', () => {
      const text = taOut.value.trim();
      if (!text) return;
      GM_setClipboard(text);
      setStatus(status, 'CSV скопирован в буфер обмена.');
    });

    btnCopyTSV.addEventListener('click', () => {
      const rows = cbFilterBad.checked ? lastRowsGood.filter(Boolean) : rowsByIndex.filter(Boolean);
      if (!rows.length) { setStatus(status, 'Сначала соберите данные.'); return; }
      GM_setClipboard(rowsToTSV(rows));
      setStatus(status, 'TSV скопирован — вставляйте в Google Sheets.');
    });

    if (btnCopyModPlus) {
      btnCopyModPlus.addEventListener('click', () => {
        if (!lastParamModifiers.length) { setStatus(paramsStatus, 'Модификаторы не найдены.'); return; }
        const text = formatParameterModsForClipboard(lastParamModifiers, { mode: 'plus' });
        GM_setClipboard(text);
        setStatus(paramsStatus, `Модификаторы (+1%) скопированы: ${lastParamModifiers.length}.`);
        setStatus(status, 'Модификаторы (+1%) скопированы в буфер.');
      });
    }

    if (btnCopyModBase) {
      btnCopyModBase.addEventListener('click', () => {
        if (!lastParamModifiers.length) { setStatus(paramsStatus, 'Модификаторы не найдены.'); return; }
        const text = formatParameterModsForClipboard(lastParamModifiers, { mode: 'base' });
        GM_setClipboard(text);
        setStatus(paramsStatus, `Стандартные модификаторы скопированы: ${lastParamModifiers.length}.`);
        setStatus(status, 'Стандартные модификаторы скопированы в буфер.');
      });
    }

    if (btnCopyModBaseNames) {
      btnCopyModBaseNames.addEventListener('click', () => {
        if (!lastParamModifiers.length) { setStatus(paramsStatus, 'Модификаторы не найдены.'); return; }
        const text = formatParameterModsForClipboard(lastParamModifiers, { mode: 'base', includeNames: true });
        GM_setClipboard(text);
        setStatus(paramsStatus, `Названия и стандартные модификаторы скопированы: ${lastParamModifiers.length}.`);
        setStatus(status, 'Названия и стандартные модификаторы скопированы в буфер.');
      });
    }

    btnSave.addEventListener('click', () => {
      const text = taOut.value.trim();
      if (!text) return;
      downloadTextAsCSV(text, FILENAME_CSV());
      setStatus(status, 'CSV скачан.');
    });

    btnSaveX.addEventListener('click', async () => {
      const rows = cbFilterBad.checked ? lastRowsGood.filter(Boolean) : rowsByIndex.filter(Boolean);
      if (!rows.length) { setStatus(status, 'Сначала соберите данные.'); return; }
      setStatus(status, 'Готовлю Excel (.xlsx)…');
      try {
        await downloadXLSX(rows, FILENAME_XLSX());
        setStatus(status, 'Excel (.xlsx) скачан.');
      } catch (e) {
        setStatus(status, 'Не удалось собрать XLSX: ' + e.message);
      }
    });

    btnSaveErr.addEventListener('click', () => {
      if (!lastErrorsDetail.length) { setStatus(status, 'Ошибок нет.'); return; }
      const brief = lastErrorsDetail.map(e => ({url:e.url, reason:e.reason}));
      const csv = errorsToCSV(brief);
      downloadTextAsCSV(csv, FILENAME_ERR());
      setStatus(status, 'Файл кратких ошибок скачан.');
    });

    btnSaveErrD.addEventListener('click', () => {
      if (!lastErrorsDetail.length) { setStatus(status, 'Ошибок нет.'); return; }
      const csv = errorsDetailToCSV(lastErrorsDetail);
      downloadTextAsCSV(csv, FILENAME_ERRDET());
      setStatus(status, 'Файл детального лога ошибок скачан.');
    });

    if (cbFilterBad) {
      cbFilterBad.addEventListener('change', () => {
        updateParameterModifiers();
      });
    }

    // ===== Крошки (очистка) =====
    crumbsFile.addEventListener('change', async () => {
      crumbsParsed = null; btnCrClean.disabled = true; btnCrSave.disabled = true;
      crumbsStatus.textContent = '';
      const file = crumbsFile.files && crumbsFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        crumbsParsed = parseGenericTable(text);
        crumbsStatus.textContent = `Файл загружен: строк (с заголовком) — ${crumbsParsed.rows.length + 1}`;
        crumbsMaybeEnable();
      } catch (e) {
        crumbsStatus.textContent = 'Не удалось прочитать файл: ' + e.message;
      }
    });

    btnCrClean.addEventListener('click', () => {
      if (!crumbsParsed) { crumbsStatus.textContent = 'Сначала загрузите файл крошек.'; return; }
      const rowsOk = (cbFilterBad.checked ? rowsByIndex.filter(r=>r && !r.error && r.name && r.description) : rowsByIndex.filter(r=>r));
      const goodSet = new Set(rowsOk.map(r => r.url));
      if (goodSet.size === 0) { crumbsStatus.textContent = 'Нет результатов парсинга для фильтрации.'; return; }

      const { delimiter, header, rows, urlColIdx } = crumbsParsed;
      if (urlColIdx < 0) { crumbsStatus.textContent = 'Не удалось определить колонку URL в крошках.'; return; }

      const keep = rows.filter(r => goodSet.has(r[urlColIdx]));
      crumbsParsed.cleaned = { header, rows: keep, delimiter, urlColIdx };
      btnCrSave.disabled = false;
      const removed = rows.length - keep.length;
      crumbsStatus.textContent = `Крошки очищены: оставлено ${keep.length} строк, удалено ${removed}.`;
    });

    btnCrSave.addEventListener('click', () => {
      if (!crumbsParsed || !crumbsParsed.cleaned) { crumbsStatus.textContent = 'Сначала очистите крошки.'; return; }
      const { header, rows, delimiter } = crumbsParsed.cleaned;
      const csv = aoaToCSV([header, ...rows], delimiter);
      downloadTextAsCSV(csv, FILENAME_CRMB());
      crumbsStatus.textContent = 'Очищенные крошки скачаны.';
    });

    function crumbsMaybeEnable() {
      const hasRows = (cbFilterBad.checked ? rowsByIndex.filter(r=>r && !r.error && r.name && r.description).length : rowsByIndex.filter(Boolean).length) > 0;
      btnCrClean.disabled = !(hasRows && crumbsParsed);
    }

    // ===== Вспомогалки UI =====
    function updateParameterModifiers() {
      if (!paramsStatus) return;
      const rows = cbFilterBad.checked ? filterGood(rowsByIndex).filter(Boolean) : rowsByIndex.filter(Boolean);
      if (!rows.length) {
        lastParamModifiers = [];
        if (btnCopyModPlus) btnCopyModPlus.disabled = true;
        if (btnCopyModBase) btnCopyModBase.disabled = true;
        if (btnCopyModBaseNames) btnCopyModBaseNames.disabled = true;
        setStatus(paramsStatus, 'Сначала соберите данные.');
        return;
      }

      lastParamModifiers = extractParameterModifiers(rows);
      const hasMods = lastParamModifiers.length > 0;
      if (btnCopyModPlus) btnCopyModPlus.disabled = !hasMods;
      if (btnCopyModBase) btnCopyModBase.disabled = !hasMods;
      if (btnCopyModBaseNames) btnCopyModBaseNames.disabled = !hasMods;
      setStatus(paramsStatus, hasMods
        ? `Найдено модификаторов: ${lastParamModifiers.length}.`
        : 'Модификаторы не найдены в текущем наборе описаний.');
    }

    function setProgress(pct) { bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
    function setMetrics(elapsedSec, etaSec, speedPerSec) {
      const fmt = (s)=> {
        s = Math.max(0, Math.round(s));
        const m = Math.floor(s/60), ss = s%60;
        return `${m}:${String(ss).padStart(2,'0')}`;
      };
      const sp = speedPerSec.toFixed(1);
      metrics.textContent = `⏱ ${fmt(elapsedSec)} • ETA ${etaSec ? fmt(etaSec) : '—'} • ${sp}/с`;
    }
    function setStatus(el, text) { if (el) el.textContent = text || ''; }
  }

  /** =======================
   *  Фильтр «хороших» строк
   *  ======================= */
  function filterGood(rowsByIndex) {
    return rowsByIndex.filter(r => r && !r.error && r.name && r.description);
  }

  /** =======================
   *  Парсинг модификаторов из описаний
   *  ======================= */
  function extractParameterModifiers(rows) {
    const mods = [];
    for (const row of rows) {
      if (!row || !row.description) continue;
      const name = row.name || '';
      const lines = String(row.description).split(/\n+/);
      for (const raw of lines) {
        const line = raw.replace(/\u2212/g, '-').trim();
        if (!line || !/\bmod\b/i.test(line)) continue;
        const match = line.match(/\bmod\b[^\d+-]*([+-]?\d[\d\s.,]*)/i);
        if (!match) continue;
        const modPlus = parseModifierNumber(match[1]);
        if (!Number.isFinite(modPlus)) continue;
        const base = computeBaseModifier(modPlus);
        const plus = Math.round(base * 1.01);
        const label = line.replace(/\bmod\b[\s\S]*$/i, '').trim() || name || 'Модификатор';
        mods.push({ label, base, plus, source: name });
      }
    }
    return mods;
  }

  function parseModifierNumber(raw) {
    if (!raw) return NaN;
    const cleaned = raw
      .replace(/[\u2212−]/g, '-')
      .replace(/[\s\u00A0₽рР$]/g, '')
      .replace(',', '.')
      .trim();
    if (!cleaned || /^[+-]?$/.test(cleaned)) return NaN;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : NaN;
  }

  function computeBaseModifier(modPlus) {
    if (!Number.isFinite(modPlus)) return modPlus;
    return Math.round(modPlus / 1.01);
  }

  function formatModifierValue(value) {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.round(value);
    if (rounded > 0) return '+' + String(rounded);
    if (rounded < 0) return '-' + String(Math.abs(rounded));
    return '0';
  }

  function formatParameterModsForClipboard(mods, opts) {
    const mode = (opts && opts.mode) === 'base' ? 'base' : 'plus';
    const includeNames = !!(opts && opts.includeNames);
    return mods.map(mod => {
      const value = formatModifierValue(mode === 'base' ? mod.base : mod.plus);
      if (!includeNames) return value;
      const label = (mod.label || mod.source || '').trim() || 'Модификатор';
      return `${label}\t${value}`;
    }).join('\n');
  }

  /** =======================
   *  Парсинг «крошек»
   *  ======================= */
  function parseGenericTable(text) {
    const lines = String(text||'').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (!lines.length) return { delimiter:',', header:[], rows:[], urlColIdx:-1 };

    const first = lines[0];
    const guessDelims = ['\t','; ',','];
    let delimiter = ',', bestCount = -1;
    for (const d of guessDelims) {
      const cnt = (first.match(new RegExp(escapeRegExp(d), 'g'))||[]).length;
      if (cnt > bestCount) { bestCount = cnt; delimiter = d; }
    }

    const parseLine = (line) => {
      const arr = [];
      let cur = '', inQ = false;
      for (let i=0;i<line.length;i++){
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i+1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (!inQ && line.substr(i, delimiter.length) === delimiter) {
          arr.push(cur); cur = ''; i += delimiter.length - 1;
        } else cur += ch;
      }
      arr.push(cur);
      return arr.map(v => v.replace(/^"(.*)"$/s, '$1'));
    };

    const header = parseLine(first);
    const rows = [];
    for (let i=1;i<lines.length;i++){
      const ln = lines[i];
      if (!ln.trim()) continue;
      rows.push(parseLine(ln));
    }

    let urlColIdx = header.findIndex(h => /^(url|link|product[_\s-]?url)$/i.test(h.trim()));
    if (urlColIdx < 0) {
      const score = new Array(header.length).fill(0);
      for (const r of rows) {
        for (let c=0;c<header.length;c++){
          const v = r[c] || '';
          if (/ggsel\.net\/catalog\/product\/\d+/.test(v)) score[c]++;
        }
      }
      urlColIdx = score.indexOf(Math.max(...score));
      if (score[urlColIdx] === 0) urlColIdx = -1;
    }

    return { delimiter, header, rows, urlColIdx };
  }

  function aoaToCSV(aoa, delimiter=',') {
    const esc = (v)=> `"${String(v??'').replace(/"/g,'""')}"`;
    const csv = aoa.map(row => row.map(esc).join(delimiter)).join('\r\n');
    return '\uFEFF' + csv;
  }

  /** =======================
   *  Utils
   *  ======================= */
  function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  /** =======================
   *  Drag + position + styles
   *  ======================= */
  function enableDrag(modal, handle) {
    let isDragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = modal.getBoundingClientRect();
      isDragging = true;
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    function onMove(e) {
      if (!isDragging) return;
      modal.style.top  = (e.clientY - offsetY) + 'px';
      modal.style.left = (e.clientX - offsetX) + 'px';
      clampToViewport(modal);
    }
    function onUp() {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = '';
      saveModalPosition(modal);
    }
  }
  function clampToViewport(el) {
    const rect = el.getBoundingClientRect();
    let top = parseInt(el.style.top || rect.top);
    let left = parseInt(el.style.left || rect.left);
    const maxTop  = Math.max(0, window.innerHeight - rect.height);
    const maxLeft = Math.max(0, window.innerWidth  - rect.width);
    if (!Number.isFinite(top))  top = 0;
    if (!Number.isFinite(left)) left = 0;
    top  = Math.min(Math.max(0, top),  maxTop);
    left = Math.min(Math.max(0, left), maxLeft);
    el.style.top  = top + 'px';
    el.style.left = left + 'px';
  }
  function saveModalPosition(modal) {
    const top  = parseInt(modal.style.top)  || modal.getBoundingClientRect().top;
    const left = parseInt(modal.style.left) || modal.getBoundingClientRect().left;
    localStorage.setItem('ggselTurboPos', JSON.stringify({ top, left }));
  }
  function restoreModalPosition(modal) {
    const saved = JSON.parse(localStorage.getItem('ggselTurboPos') || 'null');
    if (saved && Number.isFinite(saved.top) && Number.isFinite(saved.left)) {
      modal.style.top = saved.top + 'px';
      modal.style.left = saved.left + 'px';
      clampToViewport(modal);
    }
  }

  function addStyles() {
    GM_addStyle(`
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;900&display=swap');

      #ggselturbo-fab{
        position:fixed;right:26px;bottom:26px;z-index:999999;width:72px;height:72px;border-radius:22px;
        background:linear-gradient(135deg,#ffe37a 60%,#181920 180%);color:#181920;border:none;
        box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 4px #ffe37a55;font-weight:900;font-size:26px;
        display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:'JetBrains Mono',monospace;
        transition:transform .15s ease, box-shadow .15s ease, opacity .15s ease;
      }
      #ggselturbo-fab:hover{transform:translateY(-1px);box-shadow:0 16px 40px rgba(0,0,0,.55),0 0 0 4px #ffe37a88}

      #ggselturbo-modal{
        position:fixed;top:64px;left:48px;width:860px;max-width:96vw;background:#181920;color:#ffe37a;
        border:3px solid #ffe37a;border-radius:16px;z-index:1000000;padding:22px 22px 16px;font-family:'JetBrains Mono',monospace;
        box-shadow:0 16px 64px rgba(0,0,0,.6), 0 0 0 8px #ffde5c22;
      }
      #ggselturbo-modal .csv-title{font-size:20px;font-weight:900;margin-bottom:10px;cursor:move}
      #ggselturbo-modal .csv-close{
        position:absolute;top:10px;right:14px;background:transparent;border:none;color:#ffe37a;font-weight:900;font-size:24px;cursor:pointer;
      }
      #ggselturbo-modal .csv-field{display:flex;flex-direction:column;margin:10px 0}
      #ggselturbo-modal .csv-field.tiny{width:140px}
      #ggselturbo-modal label{font-size:13px;color:#fffbe3;opacity:.95;margin-bottom:6px}
      #ggselturbo-modal textarea, #ggselturbo-modal input{
        background:#232324;color:#ffe37a;border:1.6px solid #ffe37a7а;border-radius:10px;padding:9px 10px;font-family:inherit;font-size:14px;
        transition:border-color .15s, background .15s; box-shadow:0 2px 0 #ffe37a20;
      }
      #ggselturbo-modal textarea:focus, #ggselturbo-modal input:focus{border-color:#ffe37a;background:#1a1b21;outline:none}
      #ggselturbo-modal textarea#csv-links{min-height:160px;resize:vertical}
      #ggselturbo-modal textarea#csv-output{min-height:160px;resize:vertical}

      #ggselturbo-modal .csv-row{display:flex;gap:10px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
      #ggselturbo-modal .csv-buttons{display:flex;gap:8px;flex-wrap:wrap}
      #ggselturbo-modal .csv-field.csv-params{margin-top:6px}
      #ggselturbo-modal .csv-param-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
      #ggselturbo-modal .csv-param-status{font-size:12px;color:#fffbe3;opacity:.85;margin-top:4px}
      #ggselturbo-modal .csv-btn{
        background:linear-gradient(90deg,#ffe37a,#181920 150%);color:#181920;font-weight:900;border:none;border-radius:10px;
        padding:10px 12px;cursor:pointer;letter-spacing:.02em;box-shadow:0 3px 0 #ffe37a33; font-size:14px;
      }
      #ggselturbo-modal .csv-btn:hover{background:linear-gradient(90deg,#fffbe3,#ffe37a 120%)}
      #ggselturbo-modal .csv-btn.ghost{background:#1d1e24;color:#ffe37a;border:1.5px solid #ffe37a77}
      #ggselturbo-modal .csv-btn.ghost:hover{background:#24252b;border-color:#ffe37a}
      #ggselturbo-modal .csv-btn.danger{background:#2b1b1b;color:#ffe37a;border:1.5px solid #c55}
      #ggselturbo-modal .csv-btn.danger:hover{background:#3a2121;border-color:#f77}
      #ggselturbo-modal .csv-btn:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.3)}

      #ggselturbo-modal .csv-metrics{font-size:12px;color:#fffbe3;opacity:.9;margin:4px 0 6px}
      #ggselturbo-modal .csv-progress{height:10px;background:#22232a;border:1px solid #ffe37a44;border-radius:8px;margin:6px 0 8px;width:100%}
      #ggselturbo-modal #csv-bar{height:100%;width:0%;background:#ffe37a;border-radius:8px;transition:width .15s ease}

      #ggselturbo-modal .csv-status{min-height:22px;font-size:13px;color:#ffe37a;opacity:.95}

      #ggselturbo-modal .csv-errors{margin-top:8px;border:1px dashed #ffe37a55;border-radius:10px;padding:8px}
      #ggselturbo-modal .csv-errors summary{cursor:pointer}
      #ggselturbo-modal #csv-errors-list{max-height:160px;overflow:auto;font-size:12px;line-height:1.4;margin-top:6px}
      #ggselturbo-modal .err-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0;border-bottom:1px dotted #ffe37a22}

      #ggselturbo-modal .csv-crumbs{margin-top:14px;padding-top:10px;border-top:1px solid #ffe37a33}
      #ggselturbo-modal .csv-crumbs-title{font-weight:900;margin-bottom:8px}
      #ggselturbo-modal .csv-crumbs-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      #ggselturbo-modal .crumbs-status{font-size:12px;color:#fffbe3;opacity:.9}
    `.replace('ffe37a7а','ffe37a7a'));
  }

})();
