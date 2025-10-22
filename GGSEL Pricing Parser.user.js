// ==UserScript==
// @name         GGSEL Pricing Parser → XLSX (pause/resume)
// @namespace    ggsel.pricing.parser
// @version      1.1.1
// @description  Парсинг стандартной цены и модификаторов параметров, экспорт в XLSX. Поддержка паузы/резюма и прогресса.
// @author       vibe-coding
// @match        https://seller.ggsel.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /******************************************************************
   * ВНУТРЕННЕЕ СОСТОЯНИЕ (хранится в Tampermonkey storage)
   ******************************************************************/
  const STORE_KEY = 'ggsel_pricing_parser_state_v1';

  const DEFAULT_STATE = {
    ids: [],
    currentIdIndex: 0,
    currentParamIndex: 0,
    running: false,
    results: [],
    lastProcessedId: null,
    lastStoppedId: null,
    pausedDueToError: false
  };

  /** @type {typeof DEFAULT_STATE} */
  let state = Object.assign({}, DEFAULT_STATE, loadState() || {});
  if (!Array.isArray(state.ids)) state.ids = [];
  if (!Array.isArray(state.results)) state.results = [];

  /******************************************************************
   * УТИЛИТЫ
   ******************************************************************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const LOG_PREFIX = '[GGSEL Parser]';
  const pendingLogEntries = [];

  function formatLogArg(arg) {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) return arg.message;
    try {
      return JSON.stringify(arg);
    } catch (e) {
      return String(arg);
    }
  }

  function appendLogToPanel(entry) {
    if (!ui?.log) {
      pendingLogEntries.push(entry);
      while (pendingLogEntries.length > 300) pendingLogEntries.shift();
      return;
    }
    const row = document.createElement('div');
    row.className = `ggsel-log-line ggsel-log-${entry.level}`;
    row.textContent = `[${entry.time}] ${entry.message}`;
    ui.log.appendChild(row);
    while (ui.log.children.length > 300) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function pushLog(level, args) {
    const message = args.map(formatLogArg).join(' ');
    const entry = {
      level,
      time: new Date().toLocaleTimeString(),
      message
    };
    appendLogToPanel(entry);
  }

  const log = {
    info: (...args) => {
      console.info(LOG_PREFIX, ...args);
      pushLog('info', args);
    },
    warn: (...args) => {
      console.warn(LOG_PREFIX, ...args);
      pushLog('warn', args);
    },
    error: (...args) => {
      console.error(LOG_PREFIX, ...args);
      pushLog('error', args);
    }
  };

  // Сохраняем в TM-хранилище
  function saveState() {
    try { GM_setValue(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
  }
  // Загружаем из TM-хранилища
  function loadState() {
    try {
      const raw = GM_getValue(STORE_KEY, '');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // Нормализация ID-строки
  function normalizeIds(text) {
    return (text || '')
      .split(/[\s,;]+/g)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Прогресс в процентах (по товарам)
  function getProgressPct() {
    if (!state.ids.length) return 0;
    const perItem = 100 / state.ids.length;
    return Math.min(100, Math.max(0, state.currentIdIndex * perItem));
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function formatModifierText(sign, value) {
    const absVal = Math.abs(value);
    return `${sign} ${formatNumber(absVal)}`;
  }

  function readCookie(name) {
    const cookieMatch = document.cookie?.match(new RegExp(`(?:^|; )${name.replace(/[.$?*|{}()\[\]\\\/\+^]/g, '\\$&')}=([^;]*)`));
    return cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  }

  function resolveCsrfToken() {
    const fromMeta = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"]');
    if (fromMeta?.content) return fromMeta.content;

    const nuxtToken = window.__NUXT__?.config?.csrfToken || window.__NUXT__?.state?.csrfToken;
    if (nuxtToken) return nuxtToken;

    const cookieToken = readCookie('XSRF-TOKEN') || readCookie('csrf-token');
    if (cookieToken) return cookieToken;

    return null;
  }

  function tryParseJson(value) {
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  function resolveAuthToken() {
    const storages = [];
    if (typeof window !== 'undefined') {
      if (window.localStorage) storages.push(window.localStorage);
      if (window.sessionStorage) storages.push(window.sessionStorage);
    }
    const candidateKeys = [
      'auth._token.local',
      'auth_token',
      'access_token',
      'auth.accessToken',
      'ggsel_access_token',
      'seller_access_token',
      'token',
      'user-token'
    ];

    for (const storage of storages) {
      for (const key of candidateKeys) {
        let raw = null;
        try {
          raw = storage.getItem(key);
        } catch (e) {
          raw = null;
        }
        if (!raw) continue;

        const parsed = tryParseJson(raw);
        if (typeof parsed === 'string') {
          raw = parsed;
        } else if (parsed && typeof parsed === 'object') {
          if (typeof parsed.token === 'string') {
            raw = parsed.token;
          } else if (typeof parsed.accessToken === 'string') {
            raw = parsed.accessToken;
          }
        }

        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (/^Bearer\s+/i.test(trimmed)) {
          return trimmed;
        }
        return `Bearer ${trimmed}`;
      }
    }

    const cookieToken = readCookie('access_token') || readCookie('auth_token');
    if (cookieToken) {
      return /^Bearer\s+/i.test(cookieToken) ? cookieToken : `Bearer ${cookieToken}`;
    }

    return null;
  }

  function buildAuthHeaders() {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest'
    };
    const csrf = resolveCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
      headers['X-XSRF-TOKEN'] = csrf;
    }
    const bearer = resolveAuthToken();
    if (bearer) {
      headers['Authorization'] = bearer;
    }
    return headers;
  }

  async function fetchOfferDetails(offerId) {
    const url = `https://seller.ggsel.net/api/v1/offers/${offerId}`;
    log.info('Запрашиваем данные оффера через API:', url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers: buildAuthHeaders()
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.statusText = response.statusText;
        throw error;
      }
      const payload = await response.json();
      if (payload && typeof payload === 'object' && 'data' in payload) {
        const inner = payload.data;
        if (inner && typeof inner === 'object') {
          return inner;
        }
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function pushBasePriceRow(offerId, productId, productName, basePrice) {
    const finalPrice = Math.round(basePrice * 100) / 100;
    state.results.push({
      offerId,
      productId,
      productName,
      block: '',
      variantName: '',
      modifierText: '',
      finalPrice
    });
  }

  // Пауза: если пользователь нажал «Пауза», ждём возобновления
  async function pausePoint() {
    while (!state.running) {
      updateUi();
      saveState();
      await sleep(300);
    }
  }

  /******************************************************************
   * UI-ПАНЕЛЬ: Ввод ID, кнопки управления, прогресс-бар
   ******************************************************************/
  let ui = null;

  function buildUi() {
    GM_addStyle(`
      .ggsel-parser-panel {
        position: fixed;
        bottom: 18px; right: 18px;
        width: 360px; z-index: 99999999;
        background: #111; color: #eee; border: 1px solid #333; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }
      .ggsel-header { padding: 10px 12px; font-weight: 600; font-size: 14px; border-bottom: 1px solid #222; }
      .ggsel-body { padding: 12px; }
      .ggsel-row { margin-bottom: 10px; }
      .ggsel-row label { font-size: 12px; color: #aaa; display:block; margin-bottom:4px; }
      .ggsel-row textarea {
        width: 100%; height: 90px; resize: vertical;
        background: #0b0b0b; color: #ddd; border: 1px solid #2a2a2a; border-radius: 8px; padding: 8px;
      }
      .ggsel-controls { display: flex; gap: 8px; flex-wrap: wrap; }
      .ggsel-btn {
        cursor: pointer; border: 1px solid #2a2a2a; background: #1c1c1c; color: #eee; padding: 8px 10px; border-radius: 8px; font-size: 12px;
      }
      .ggsel-btn:hover { background: #242424; }
      .ggsel-btn.primary { background: #2f6fed; border-color: #2f6fed; }
      .ggsel-btn.primary:hover { background: #2b60c9; }
      .ggsel-btn.warn { background: #8b3bff; border-color: #8b3bff; }
      .ggsel-btn.red { background: #b3261e; border-color: #b3261e; }
      .ggsel-progress {
        margin-top: 8px; height: 8px; width: 100%; background: #222; border-radius: 999px; overflow: hidden; border: 1px solid #2a2a2a;
      }
      .ggsel-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #2f6fed, #8b3bff); }
      .ggsel-small { font-size: 12px; color: #aaa; margin-top: 6px; line-height: 1.4; }
      .ggsel-kv { display:flex; justify-content: space-between; font-size:12px; color:#ccc; }
      .ggsel-muted { color:#8f8f8f; }
      .ggsel-log {
        margin-top: 12px;
        max-height: 200px;
        overflow-y: auto;
        background: #0b0b0b;
        border: 1px solid #2a2a2a;
        border-radius: 8px;
        padding: 8px;
        font-size: 12px;
        line-height: 1.4;
      }
      .ggsel-log-line { margin-bottom: 4px; }
      .ggsel-log-line:last-child { margin-bottom: 0; }
      .ggsel-log-info { color: #9bc1ff; }
      .ggsel-log-warn { color: #f3d97c; }
      .ggsel-log-error { color: #ff8c8c; }
    `);

    const panel = document.createElement('div');
    panel.className = 'ggsel-parser-panel';
    panel.innerHTML = `
      <div class="ggsel-header">GGSEL Parser → XLSX</div>
      <div class="ggsel-body">
        <div class="ggsel-row">
          <label>Список ID товаров (через пробел, запятую или с новой строки):</label>
          <textarea id="ggsel-ids"></textarea>
        </div>
        <div class="ggsel-controls">
          <button id="ggsel-start" class="ggsel-btn primary">Старт</button>
          <button id="ggsel-pause" class="ggsel-btn">Пауза</button>
          <button id="ggsel-resume" class="ggsel-btn">Продолжить</button>
          <button id="ggsel-export" class="ggsel-btn warn">Экспорт XLSX</button>
          <button id="ggsel-reset" class="ggsel-btn red">Сброс</button>
        </div>
        <div class="ggsel-progress"><div id="ggsel-bar" class="ggsel-bar"></div></div>
        <div class="ggsel-small">
          <div class="ggsel-kv"><span>Всего ID:</span><span id="ggsel-total" class="ggsel-muted">0</span></div>
          <div class="ggsel-kv"><span>Обработано:</span><span id="ggsel-done" class="ggsel-muted">0</span></div>
          <div class="ggsel-kv"><span>Текущий ID:</span><span id="ggsel-current" class="ggsel-muted">—</span></div>
          <div class="ggsel-kv"><span>Последний завершённый:</span><span id="ggsel-last-done" class="ggsel-muted">—</span></div>
          <div class="ggsel-kv"><span>Остановились на:</span><span id="ggsel-last-stop" class="ggsel-muted">—</span></div>
        </div>
        <div class="ggsel-log" id="ggsel-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    ui = {
      panel,
      ids: panel.querySelector('#ggsel-ids'),
      start: panel.querySelector('#ggsel-start'),
      pause: panel.querySelector('#ggsel-pause'),
      resume: panel.querySelector('#ggsel-resume'),
      export: panel.querySelector('#ggsel-export'),
      reset: panel.querySelector('#ggsel-reset'),
      bar: panel.querySelector('#ggsel-bar'),
      total: panel.querySelector('#ggsel-total'),
      done: panel.querySelector('#ggsel-done'),
      current: panel.querySelector('#ggsel-current'),
      lastDone: panel.querySelector('#ggsel-last-done'),
      lastStop: panel.querySelector('#ggsel-last-stop'),
      log: panel.querySelector('#ggsel-log')
    };

    if (pendingLogEntries.length) {
      const backlog = pendingLogEntries.splice(0, pendingLogEntries.length);
      backlog.forEach(entry => appendLogToPanel(entry));
    }

    ui.start.addEventListener('click', onStart);
    ui.pause.addEventListener('click', onPause);
    ui.resume.addEventListener('click', onResume);
    ui.export.addEventListener('click', onExport);
    ui.reset.addEventListener('click', onReset);

    // восстановим текст id, если они есть
    if (state.ids?.length) ui.ids.value = state.ids.join('\n');
    updateUi();
  }

  function updateUi() {
    if (!ui) return;
    const pct = getProgressPct();
    ui.bar.style.width = `${pct}%`;
    ui.total.textContent = String(state.ids?.length || 0);
    ui.done.textContent = String(state.currentIdIndex || 0);
    ui.current.textContent = state.ids?.[state.currentIdIndex] || '—';
    ui.lastDone.textContent = state.lastProcessedId || '—';
    ui.lastStop.textContent = state.lastStoppedId || '—';
  }

  async function onStart() {
    const ids = normalizeIds(ui.ids.value);
    if (!ids.length) {
      alert('Вставьте ID товаров.');
      return;
    }
    log.info('Старт обработки списка ID:', ids);
    state.ids = ids;
    state.currentIdIndex = 0;
    state.currentParamIndex = 0;
    state.results = [];
    state.running = true;
    state.lastProcessedId = null;
    state.lastStoppedId = ids[0] || null;
    state.pausedDueToError = false;
    saveState();
    updateUi();
    await resumeFlow();
  }

  function onPause() {
    log.info('Скрипт приостановлен пользователем.');
    state.running = false;
    state.lastStoppedId = state.ids[state.currentIdIndex] || null;
    state.pausedDueToError = false;
    saveState();
    updateUi();
  }

  async function onResume() {
    if (!state.ids.length) {
      const ids = normalizeIds(ui.ids.value);
      if (!ids.length) {
        alert('Нет списка ID. Вставьте ID и нажмите "Старт", либо "Продолжить" после старта.');
        return;
      }
      state.ids = ids;
      state.currentIdIndex = state.currentIdIndex || 0;
    }
    log.info('Продолжаем обработку.');
    if (state.pausedDueToError) {
      const redoPreview = state.ids.slice(state.currentIdIndex, Math.min(state.ids.length, state.currentIdIndex + 4));
      if (redoPreview.length) {
        log.info('Повторно проверим ID:', redoPreview.join(', '));
      }
    }
    state.running = true;
    state.pausedDueToError = false;
    state.lastStoppedId = state.ids[state.currentIdIndex] || null;
    saveState();
    updateUi();
    await resumeFlow();
  }

  function onReset() {
    if (!confirm('Сбросить прогресс и результаты?')) return;
    log.info('Сбрасываем состояние скрипта.');
    state = Object.assign({}, DEFAULT_STATE);
    saveState();
    if (ui) ui.ids.value = '';
    updateUi();
  }

  function onExport() {
    exportToXlsx(state.results);
  }

  /******************************************************************
   * ОСНОВНОЙ ПОТОК
   ******************************************************************/

  // Возобновление сразу после загрузки страницы (если шли в процессе)
  async function autoResumeIfNeeded() {
    buildUi();
    if (isServerErrorPage()) {
      pauseDueToServerError('Обнаружена страница ошибки 500. Скрипт приостановлен до дальнейших действий.');
      return;
    }
    if (!state.ids.length) return;           // нет задач
    if (!state.running) return;              // не в режиме запуска
    await resumeFlow();
  }

  let activeRunner = null;

  async function resumeFlow() {
    if (activeRunner) {
      return activeRunner;
    }
    activeRunner = (async () => {
      log.info('Возобновление обработки.');
      if (!state.ids.length) {
        log.warn('Список ID пуст. Нечего обрабатывать.');
        state.running = false;
        saveState();
        updateUi();
        return;
      }
      while (state.running && state.currentIdIndex < state.ids.length) {
        await runForCurrentPage();
      }
      log.info('Текущий цикл обработки завершён.');
    })().finally(() => {
      activeRunner = null;
    });
    return activeRunner;
  }

  function isServerErrorPage() {
    return /https:\/\/seller\.ggsel\.net\/500/.test(location.href);
  }

  function pauseDueToServerError(reason = 'Детектирована страница ошибки 500. Останавливаем выполнение.') {
    log.warn(reason);

    if (!state.ids.length) {
      state.running = false;
      state.pausedDueToError = true;
      state.lastStoppedId = null;
      saveState();
      updateUi();
      return;
    }

    if (!state.pausedDueToError) {
      const boundedIndex = Math.min(state.currentIdIndex, state.ids.length);
      const redoStart = Math.max(0, boundedIndex - 3);
      const redoEndExclusive = state.currentIdIndex < state.ids.length ? state.currentIdIndex + 1 : boundedIndex;
      const redoIds = new Set(state.ids.slice(redoStart, redoEndExclusive));

      if (redoIds.size) {
        state.results = state.results.filter(row => !redoIds.has(row.offerId));
      }

      const stoppedIdx = Math.min(state.currentIdIndex, state.ids.length - 1);
      state.lastStoppedId = stoppedIdx >= 0 ? state.ids[stoppedIdx] : null;
      const prevIdx = redoStart - 1;
      state.lastProcessedId = prevIdx >= 0 ? state.ids[prevIdx] : null;
      state.currentIdIndex = redoStart;
      state.currentParamIndex = 0;

      if (redoIds.size) {
        log.info('После возобновления будут перепроверены ID:', Array.from(redoIds).join(', '));
      }
    }

    state.running = false;
    state.pausedDueToError = true;
    saveState();
    updateUi();
  }

  /**
   * Главная процедура обработки текущей страницы/товара
  */
  async function runForCurrentPage() {
    const offerId = state.ids[state.currentIdIndex];
    if (!offerId) return; // всё сделано

    log.info('Переходим к офферу:', offerId);

    await pausePoint();

    state.lastStoppedId = offerId;
    saveState();

    if (isServerErrorPage()) {
      pauseDueToServerError('Детектирована страница 500 во время обработки. Останавливаем выполнение.');
      return;
    }

    log.info(`Начинаем обработку оффера ${offerId}.`);

    let offerData;
    try {
      offerData = await fetchOfferDetails(offerId);
    } catch (error) {
      if (error?.name === 'AbortError') {
        log.error('Истек таймаут ожидания ответа API. Останавливаем выполнение.');
        state.running = false;
        state.pausedDueToError = true;
        saveState();
        updateUi();
        return;
      }

      if (typeof error?.status === 'number' && error.status >= 500) {
        pauseDueToServerError(`Получен ответ ${error.status} от API. Прогресс поставлен на паузу.`);
        return;
      }

      if (error?.status === 404) {
        log.warn(`Оффер ${offerId} не найден (HTTP 404). Пропускаем и переходим к следующему.`);
        await completeCurrentOffer();
        return;
      }

      const message = `Не удалось получить данные оффера: ${error?.message || error}`;
      log.error(message);
      state.running = false;
      state.pausedDueToError = true;
      saveState();
      updateUi();
      return;
    }

    if (!offerData || typeof offerData !== 'object') {
      log.error('API вернуло некорректный ответ. Ожидался объект.');
      state.running = false;
      state.pausedDueToError = true;
      saveState();
      updateUi();
      return;
    }

    const productId = offerData.ggsel_id ?? offerId;
    const productName = (offerData.title_ru || offerData.title_en || '').trim();
    const basePrice = toNumber(offerData.price);

    if (productId != null) {
      log.info('GGSEL ID товара:', productId);
    }
    log.info('Название товара:', productName || '(не найдено)');

    if (basePrice == null) {
      log.error('Не удалось прочитать стандартную цену из API. Останавливаем выполнение.');
      state.running = false;
      state.pausedDueToError = true;
      saveState();
      updateUi();
      return;
    }
    log.info('Стандартная цена:', basePrice);

    state.results = state.results.filter(row => row.offerId !== offerId);
    state.currentParamIndex = 0;
    saveState();

    const options = Array.isArray(offerData.options) ? offerData.options : [];
    const relevantOptions = options.filter(opt => opt && (opt.kind === 'radio_button' || opt.kind === 'check_box'));

    let hasVariantRows = false;

    for (let i = state.currentParamIndex; i < relevantOptions.length; i++) {
      await pausePoint();
      state.currentParamIndex = i;
      saveState();

      const option = relevantOptions[i];
      const blockLabel = (option.title_ru || option.title_en || '').trim();
      log.info(`Обрабатываем блок: ${blockLabel || '(без названия)'}`);

      const variants = Array.isArray(option.variants) ? option.variants : [];
      if (!variants.length) {
        log.warn('В блоке отсутствуют варианты.');
        continue;
      }

      const defaultFirst = [];
      const others = [];

      for (const variant of variants) {
        await pausePoint();
        if (variant?.status && variant.status !== 'active') {
          continue;
        }

        const variantName = (variant.title_ru || variant.title_en || '').trim();
        if (!variantName) {
          log.warn('Пропуск варианта без названия.');
          continue;
        }

        const modifierRaw = toNumber(variant.price ?? 0);
        if (modifierRaw == null) {
          log.warn('Не удалось распознать модификатор для варианта:', variantName);
          continue;
        }

        const impact = variant.impact_variant === 'decrease' ? 'decrease' : 'increase';
        const sign = impact === 'decrease' ? '-' : '+';
        const modifierText = formatModifierText(sign, modifierRaw);
        const delta = impact === 'decrease' ? -modifierRaw : modifierRaw;
        const finalPrice = Math.round((basePrice + delta) * 100) / 100;

        const row = {
          offerId,
          productId,
          productName,
          block: blockLabel,
          variantName,
          modifierText,
          finalPrice
        };

        if (variant.default) defaultFirst.push(row); else others.push(row);
      }

      const variantsSaved = defaultFirst.length + others.length;
      if (variantsSaved > 0) {
        state.results.push(...defaultFirst, ...others);
        hasVariantRows = true;
        log.info(`Сохранено вариантов: ${variantsSaved} ("По умолчанию": ${defaultFirst.length}).`);
      } else {
        log.warn('Подходящих вариантов в блоке не найдено.');
      }
      saveState();
    }

    if (!hasVariantRows) {
      log.info('Не найдено подходящих вариантов. Сохраняем только стандартную цену.');
      pushBasePriceRow(offerId, productId, productName, basePrice);
      saveState();
    }

    await completeCurrentOffer();
  }

  async function completeCurrentOffer() {
    state.currentParamIndex = 0;

    const completedOfferId = state.ids[state.currentIdIndex] || null;
    state.lastProcessedId = completedOfferId;

    // переходим к следующему ID
    state.currentIdIndex++;
    state.lastStoppedId = state.ids[state.currentIdIndex] || null;
    state.pausedDueToError = false;
    saveState();
    updateUi();

    // если всё выполнено — можно экспортировать, иначе — открыть след. товар
    if (state.currentIdIndex >= state.ids.length) {
      log.info('Все офферы обработаны. Скрипт остановлен.');
      state.running = false;
      saveState();
      updateUi();
      // автоэкспорт по желанию:
      // exportToXlsx(state.results);
      return;
    }
  }

  /******************************************************************
   * ЭКСПОРТ В XLSX
   ******************************************************************/
  function exportToXlsx(rows) {
    if (!rows?.length) {
      log.warn('Нет данных для экспорта.');
      return;
    }

    const header = ['ID товара', 'Название товара', 'Блок параметров', 'Параметр', 'Модификатор', 'Итоговая цена'];

    const offers = new Map();
    for (const row of rows) {
      const key = `${row.offerId}||${row.productName}`;
      if (!offers.has(key)) {
        offers.set(key, {
          offerId: row.offerId,
          productId: row.productId ?? row.offerId,
          productName: row.productName,
          blocks: new Map()
        });
      }
      const offer = offers.get(key);
      const blockName = row.block || '';
      if (!offer.blocks.has(blockName)) {
        offer.blocks.set(blockName, []);
      }
      offer.blocks.get(blockName).push(row);
    }

    const dataRows = [];
    const merges = [];
    let rowIndex = 1; // учитываем строку заголовка

    for (const offer of offers.values()) {
      const offerRowStart = rowIndex;
      let isFirstOfferRow = true;

      for (const [blockName, entries] of offer.blocks.entries()) {
        const blockRowStart = rowIndex;
        let isFirstBlockRow = true;

        entries.forEach(entry => {
          const idCell = offer.productId ?? offer.offerId;
          dataRows.push([
            isFirstOfferRow ? idCell : '',
            isFirstOfferRow ? entry.productName : '',
            isFirstBlockRow ? blockName : '',
            entry.variantName,
            entry.modifierText,
            entry.finalPrice
          ]);

          isFirstOfferRow = false;
          isFirstBlockRow = false;
          rowIndex++;
        });

        const blockRowEnd = rowIndex - 1;
        if (entries.length > 1) {
          merges.push({ s: { r: blockRowStart, c: 2 }, e: { r: blockRowEnd, c: 2 } });
        }
      }

      const offerRowEnd = rowIndex - 1;
      const offerRowCount = offerRowEnd - offerRowStart + 1;
      if (offerRowCount > 1) {
        merges.push({ s: { r: offerRowStart, c: 0 }, e: { r: offerRowEnd, c: 0 } });
        merges.push({ s: { r: offerRowStart, c: 1 }, e: { r: offerRowEnd, c: 1 } });
      }
    }

    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    ws['!cols'] = [
      { wch: 16 },
      { wch: 60 },
      { wch: 28 },
      { wch: 28 },
      { wch: 18 },
      { wch: 18 }
    ];

    if (merges.length) {
      ws['!merges'] = merges;
    }

    const range = XLSX.utils.decode_range(ws['!ref']);
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: 'FF1F4E79' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    };
    const commonBorder = {
      style: 'thin',
      color: { rgb: 'FFD0D7E5' }
    };
    const dataStyleBase = {
      alignment: { vertical: 'center', horizontal: 'left', wrapText: true },
      border: { top: commonBorder, right: commonBorder, bottom: commonBorder, left: commonBorder }
    };

    for (let c = 0; c <= range.e.c; c++) {
      const cellRef = XLSX.utils.encode_cell({ c, r: 0 });
      const cell = ws[cellRef];
      if (cell) cell.s = headerStyle;
    }

    for (let r = 1; r <= range.e.r; r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const cellRef = XLSX.utils.encode_cell({ c, r });
        const cell = ws[cellRef];
        if (!cell) continue;
        const style = JSON.parse(JSON.stringify(dataStyleBase));
        if (c >= 3) {
          style.alignment.horizontal = 'center';
        }
        if (c === 5) {
          cell.z = '# ##0.00';
        }
        cell.s = style;
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Прайс');

    const fn = `ggsel_pricing_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fn);
  }

  /******************************************************************
   * СТАРТ
   ******************************************************************/
  // строим UI и, если нужно, автоматически продолжаем процесс
  autoResumeIfNeeded();

})();
