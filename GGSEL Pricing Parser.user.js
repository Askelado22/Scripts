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
      current: panel.querySelector('#ggsel-current')
    };

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
    state.running = true;
    saveState();
    updateUi();
    await resumeFlow();
  }

  function onReset() {
    if (!confirm('Сбросить прогресс и результаты?')) return;
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
    if (!state.ids.length) return;           // нет задач
    if (!state.running) return;              // не в режиме запуска
    await resumeFlow();
  }

  async function resumeFlow() {
    // Если URL не на текущем ID — перейдём
    await navigateToCurrent();
    // И дождёмся окончания
    await runForCurrentPage();
  }

  async function navigateToCurrent() {
    const offerId = state.ids[state.currentIdIndex];
    if (!offerId) {
      // Всё готово — можно автоматически экспортировать (по желанию)
      updateUi();
      return;
    }
    const target = `https://seller.ggsel.net/offers/edit/${offerId}/pricing`;
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

    // 1) Ждём стандартную цену
    const costInput = await waitForSelector('#offerCost', 25000);
    if (!costInput) {
      console.warn('Не нашли #offerCost — возможно, страница ещё не прогрузилась.');
      return; // просто оставим страницу – можно нажать «Продолжить»
    }
    const basePrice = readNumberInput(costInput);
    if (basePrice == null) {
      console.warn('Не удалось прочитать стандартную цену.');
      return;
    }

    // 2) Название товара — берём последний элемент хлебных крошек
    await pausePoint();
    const productName = await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll('.ant-breadcrumb-link'));
      return nodes.length ? nodes[nodes.length - 1].textContent.trim() : null;
    }, 15000) || '';

    // 3) Список параметров (ul > li)
    await pausePoint();
    const ul = await waitFor(() => {
      // классы у ul динамические, ищем по сигнатуре
      return document.querySelector('ul[class*="style_list__"]');
    }, 20000);

    if (!ul) {
      console.warn('Не нашли список параметров.');
      return;
    }

    const items = Array.from(ul.querySelectorAll('li'));
    // Продолжим с индекса, сохранённого в state.currentParamIndex
    for (let i = state.currentParamIndex; i < items.length; i++) {
      await pausePoint();
      state.currentParamIndex = i;
      saveState();

      const li = items[i];

      // подпись/название блока параметров (в строке слева)
      const blockLabel = (li.querySelector('span.ant-typography')?.textContent || '').trim();

      // кнопка «карандаш»
      const editBtn = li.querySelector('[aria-label="edit"]');
      if (!editBtn) {
        console.log('Нет кнопки редактирования у блока:', blockLabel);
        continue;
      }

      // открыть модалку
      await click(editBtn);

      // дождаться модалки
      const modal = await waitForSelector('.ant-modal-content', 15000);
      if (!modal) {
        console.warn('Модальное окно не открылось.');
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
      state.results.push(...defaultFirst, ...others);
      saveState();

      // закрыть модалку
      const closeBtn = modal.querySelector('.ant-modal-close');
      if (closeBtn) await click(closeBtn);
      await sleep(300);
    }

    // блок параметров для этого оффера пройден — сбрасываем указатель параметров
    state.currentParamIndex = 0;

    // переходим к следующему ID
    state.currentIdIndex++;
    saveState();
    updateUi();

    // если всё выполнено — можно экспортировать, иначе — открыть след. товар
    if (state.currentIdIndex >= state.ids.length) {
      state.running = false;
      saveState();
      updateUi();
      // автоэкспорт по желанию:
      // exportToXlsx(state.results);
      return;
    } else {
      // переходим к следующему товару
      await navigateToCurrent();
    }
  }

  /******************************************************************
   * ЭКСПОРТ В XLSX
   ******************************************************************/
  function exportToXlsx(rows) {
    // формируем таблицу в нужной структуре
    const header = ['Название товара', 'Блок параметров', 'Параметр', 'Модификатор', 'Итоговая цена'];
    const data = rows.map(r => [r.productName, r.block, r.variantName, r.modifierText, r.finalPrice]);

    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    // немного ширины колонок
    ws['!cols'] = [
      { wch: 50 }, // Название товара
      { wch: 20 }, // Блок параметров
      { wch: 20 }, // Параметр
      { wch: 14 }, // Модификатор
      { wch: 16 }  // Итоговая цена
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Прайс');

    const fn = `ggsel_pricing_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, fn);
  }

  /******************************************************************
   * СТАРТ
   ******************************************************************/
  // строим UI и, если нужно, автоматически продолжаем процесс
  autoResumeIfNeeded();

})();
