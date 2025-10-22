// ==UserScript==
// @name         GGSEL Pricing Parser → XLSX (pause/resume)
// @namespace    ggsel.pricing.parser
// @version      1.0.0
// @description  Парсинг стандартной цены и модификаторов параметров, экспорт в XLSX. Поддержка паузы/резюма и прогресса.
// @author       vibe-coding
// @match        https://seller.ggsel.net/offers/edit/*/pricing
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

  /** @type {{
   *   ids: string[],
   *   currentIdIndex: number,
   *   currentParamIndex: number,
   *   running: boolean,
   *   results: Array<{offerId: string, productName: string, block: string, variantName: string, modifierText: string, finalPrice: number}>,
   *   lastUrl: string
   * } | null} */
  let state = loadState() || {
    ids: [],
    currentIdIndex: 0,
    currentParamIndex: 0,
    running: false,
    results: [],
    lastUrl: ''
  };

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

  // Ожидание селектора
  async function waitForSelector(selector, timeout = 20000, root = document) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  // Ожидание появление элемента по предикату
  async function waitFor(predicate, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const val = predicate();
      if (val) return val;
      await sleep(100);
    }
    return null;
  }

  async function waitForPricingPageReady(timeout = 45000) {
    log.info('Ожидаем загрузку формы цены и параметров.');
    const started = Date.now();
    const costInput = await waitForSelector('#offerCost', timeout);
    if (!costInput) return { costInput: null, parametersRoot: null };
    const remaining = Math.max(0, timeout - (Date.now() - started));
    const parametersRoot = await waitFor(() => document.querySelector('.style_OffersPayCostParameters__Zd4uX'), remaining) || null;
    return { costInput, parametersRoot };
  }

  // Универсальный кликер с небольшим ожиданием
  async function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(200);
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

  // Безопасное чтение числа из инпута
  function readNumberInput(input) {
    if (!input) return null;
    const v = input.value ?? input.getAttribute('value') ?? input.getAttribute('aria-valuenow');
    if (v == null) return null;
    const num = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(num) ? num : null;
  }

  function pushBasePriceRow(offerId, productName, basePrice) {
    const finalPrice = Math.round(basePrice * 100) / 100;
    state.results.push({
      offerId,
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
    saveState();
    updateUi();
    await navigateToCurrent();
  }

  function onPause() {
    log.info('Скрипт приостановлен пользователем.');
    state.running = false;
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
    state.running = true;
    saveState();
    updateUi();
    await resumeFlow();
  }

  function onReset() {
    if (!confirm('Сбросить прогресс и результаты?')) return;
    log.info('Сбрасываем состояние скрипта.');
    state = {
      ids: [],
      currentIdIndex: 0,
      currentParamIndex: 0,
      running: false,
      results: [],
      lastUrl: ''
    };
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
      log.warn('Обнаружена страница ошибки 500. Скрипт остановлен до обновления страницы.');
      state.running = false;
      saveState();
      updateUi();
      return;
    }
    if (!state.ids.length) return;           // нет задач
    if (!state.running) return;              // не в режиме запуска
    await resumeFlow();
  }

  async function resumeFlow() {
    log.info('Возобновление обработки.');
    // Если URL не на текущем ID — перейдём
    await navigateToCurrent();
    // И дождёмся окончания
    await runForCurrentPage();
  }

  function isServerErrorPage() {
    return /https:\/\/seller\.ggsel\.net\/500/.test(location.href);
  }

  async function navigateToCurrent() {
    const offerId = state.ids[state.currentIdIndex];
    if (!offerId) {
      // Всё готово — можно автоматически экспортировать (по желанию)
      log.info('Обработка завершена, новых ID нет.');
      updateUi();
      return;
    }
    const target = `https://seller.ggsel.net/offers/edit/${offerId}/pricing`;
    log.info('Переходим к офферу:', offerId);
    state.lastUrl = target;
    saveState();
    if (location.href !== target) {
      location.href = target;
      // дальше управление продолжится из autoResumeIfNeeded()
      return new Promise(() => {}); // прерываем текущий поток
    }
    return;
  }

  /**
   * Главная процедура обработки текущей страницы/товара
  */
  async function runForCurrentPage() {
    await pausePoint();

    const offerId = state.ids[state.currentIdIndex];
    if (!offerId) return; // всё сделано

    if (isServerErrorPage()) {
      log.warn('Детектирована страница 500 во время обработки. Останавливаем выполнение.');
      state.running = false;
      saveState();
      updateUi();
      return;
    }

    log.info(`Начинаем обработку оффера ${offerId}.`);

    // 1) Ждём стандартную цену
    const { costInput, parametersRoot } = await waitForPricingPageReady(45000);
    if (!costInput) {
      log.warn('Не нашли #offerCost — возможно, страница ещё не прогрузилась.');
      return; // просто оставим страницу – можно нажать «Продолжить»
    }
    const basePrice = readNumberInput(costInput);
    if (basePrice == null) {
      log.warn('Не удалось прочитать стандартную цену.');
      return;
    }
    log.info('Стандартная цена:', basePrice);

    // 2) Название товара — берём последний элемент хлебных крошек
    await pausePoint();
    const productName = await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll('.ant-breadcrumb-link'));
      return nodes.length ? nodes[nodes.length - 1].textContent.trim() : null;
    }, 15000) || '';
    log.info('Название товара:', productName || '(не найдено)');

    // 3) Список параметров (ul > li)
    await pausePoint();
    log.info('Ищем блоки параметров.');
    const ul = await waitFor(() => {
      const scope = parametersRoot || document;
      // классы у ul динамические, ищем по сигнатуре
      return scope.querySelector('ul[class*="style_list__"]');
    }, 4000);

    if (!ul) {
      log.warn('Не нашли список параметров. Сохраняем только стандартную цену.');
      pushBasePriceRow(offerId, productName, basePrice);
      saveState();
      await completeCurrentOffer();
      return;
    }

    const editButtons = ul.querySelectorAll('[aria-label="edit"]');
    if (!editButtons.length) {
      log.warn('В блоке параметров нет доступных вариантов. Сохраняем только стандартную цену.');
      pushBasePriceRow(offerId, productName, basePrice);
      saveState();
      await completeCurrentOffer();
      return;
    }

    const items = Array.from(ul.querySelectorAll('li'));
    let hasVariantRows = state.results.some(r => r.offerId === offerId && r.modifierText);
    // Продолжим с индекса, сохранённого в state.currentParamIndex
    for (let i = state.currentParamIndex; i < items.length; i++) {
      await pausePoint();
      state.currentParamIndex = i;
      saveState();

      const li = items[i];

      // подпись/название блока параметров (в строке слева)
      const blockLabel = (li.querySelector('span.ant-typography')?.textContent || '').trim();
      log.info(`Обрабатываем блок: ${blockLabel || '(без названия)'}`);

      // кнопка «карандаш»
      const editBtn = li.querySelector('[aria-label="edit"]');
      if (!editBtn) {
        log.warn('Нет кнопки редактирования у блока:', blockLabel);
        continue;
      }

      // открыть модалку
      await click(editBtn);

      // дождаться модалки
      const modal = await waitForSelector('.ant-modal-content', 15000);
      if (!modal) {
        log.warn('Модальное окно не открылось.');
        continue;
      }

      // заголовок параметра → поле «Заголовок параметра» (берём RU-вкладку, которая видима)
      const paramTitleInput = (() => {
        const labels = Array.from(modal.querySelectorAll('.field-lang._visible label'));
        const titleLabel = labels.find(l => /Заголовок параметра/i.test(l.textContent || ''));
        return titleLabel ? titleLabel.previousElementSibling : null; // инпут стоит перед label в текущей вёрстке
      })();

      const paramTitle = (paramTitleInput && paramTitleInput.value) ? String(paramTitleInput.value).trim() : blockLabel;

      // варианты
      const variantArticles = Array.from(modal.querySelectorAll('article'));
      if (!variantArticles.length) {
        log.warn('В блоке параметров не найдено вариантов с радиокнопками.');
      }
      let defaultFirst = [];
      let others = [];

      for (const art of variantArticles) {
        // 3.1) флаг «По умолчанию»
        const defaultCheckbox = art.querySelector('header .ant-checkbox-input');
        const isDefault = defaultCheckbox ? !!defaultCheckbox.checked : /ant-checkbox-wrapper-checked/.test(art.innerHTML);

        // 3.2) «Название варианта» (видимый RU-инпут)
        let variantName = '';
        const vLabels = Array.from(art.querySelectorAll('.field-lang._visible label'));
        const vLabel = vLabels.find(l => /Название варианта/i.test(l.textContent || ''));
        if (vLabel && vLabel.previousElementSibling) {
          variantName = String(vLabel.previousElementSibling.value || '').trim();
        } else {
          // запасной вариант — любой text input внутри article
          const fallback = art.querySelector('input.ant-input[type="text"]');
          if (fallback) variantName = String(fallback.value || '').trim();
        }

        // 3.3) знак +/-
        const signEl = art.querySelector('.ant-select .ant-select-selection-item');
        const signText = (signEl && signEl.textContent) ? signEl.textContent.trim() : '';

        // 3.4) значение модификатора
        const numInput = art.querySelector('input.ant-input-number-input');
        const modVal = readNumberInput(numInput);

        // 3.5) валюта (второй select с «₽») — если найдём и он не ₽, пропускаем
        const selects = Array.from(art.querySelectorAll('.ant-select .ant-select-selection-item'));
        const currency = selects.find(s => /₽/.test(s.textContent || ''))?.textContent?.trim() || '₽';

        // фильтр: должен быть корректный знак и число; валюта — ₽
        const isValidSign = signText === '+' || signText === '-';
        const hasNumber = Number.isFinite(modVal);
        const isRub = currency === '₽';

        if (!isValidSign || !hasNumber || !isRub) {
          // такие варианты пропускаем
          log.warn('Вариант пропущен из-за некорректных данных:', {
            variantName,
            signText,
            modVal,
            currency
          });
          continue;
        }

        const modifierText = `${signText} ${modVal}`;
        const delta = signText === '+' ? modVal : -modVal;
        const finalPrice = Math.round((basePrice + delta) * 100) / 100;

        const row = {
          offerId,
          productName,
          block: paramTitle || blockLabel,
          variantName,
          modifierText,
          finalPrice
        };

        if (isDefault) defaultFirst.push(row); else others.push(row);
      }

      // сохраняем: сначала «По умолчанию», затем остальные
      const variantsSaved = defaultFirst.length + others.length;
      state.results.push(...defaultFirst, ...others);
      if (variantsSaved > 0) {
        hasVariantRows = true;
      }
      log.info(`Сохранено вариантов: ${variantsSaved} (включая "По умолчанию": ${defaultFirst.length}).`);
      saveState();

      // закрыть модалку
      const closeBtn = modal.querySelector('.ant-modal-close');
      if (closeBtn) await click(closeBtn);
      await sleep(300);
    }

    if (!hasVariantRows) {
      log.info('Не найдено вариантов с радиокнопками. Сохраняем стандартную цену.');
      pushBasePriceRow(offerId, productName, basePrice);
      saveState();
    }

    // блок параметров для этого оффера пройден — сбрасываем указатель параметров
    await completeCurrentOffer();
  }

  async function completeCurrentOffer() {
    state.currentParamIndex = 0;

    // переходим к следующему ID
    state.currentIdIndex++;
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
    } else {
      log.info('Переходим к следующему офферу.');
      // переходим к следующему товару
      await navigateToCurrent();
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
          dataRows.push([
            isFirstOfferRow ? entry.offerId : '',
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
