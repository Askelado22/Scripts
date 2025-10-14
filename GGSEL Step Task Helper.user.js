// ==UserScript==
// @name         GGSEL Step Task Helper — vibe.coding
// @namespace    https://vibe.coding/ggsel
// @version      0.3.4
// @description  Пошаговый помощник для массового обновления офферов GGSEL: список ID, навигация «Предыдущий/Следующий», отдельные этапы и режим «Сделать всё».
// @author       vibe.coding
// @match        https://seller.ggsel.net/offers
// @match        https://seller.ggsel.net/offers/create*
// @match        https://seller.ggsel.net/offers/edit/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const NS = 'vibe.ggsel.stepHelper';
  const DEFAULT_STATE = {
    idsRaw: '5140692\n5083916\n4919694\n5023639\n5107756\n5090632\n5137840\n5150184\n4924480\n5156903\n5449866\n5148216',
    lastIndex: 0,
    currentId: null
  };

  const STORAGE = {
    get(key, fallback) {
      try {
        const value = GM_getValue(`${NS}.${key}`);
        return value === undefined ? clone(fallback) : value;
      } catch (err) {
        try {
          const raw = localStorage.getItem(`${NS}.${key}`);
          return raw ? JSON.parse(raw) : clone(fallback);
        } catch {
          return clone(fallback);
        }
      }
    },
    set(key, value) {
      try {
        GM_setValue(`${NS}.${key}`, value);
      } catch {
        localStorage.setItem(`${NS}.${key}`, JSON.stringify(value));
      }
    },
    delete(key) {
      try {
        GM_deleteValue(`${NS}.${key}`);
      } catch {
        localStorage.removeItem(`${NS}.${key}`);
      }
    }
  };

  function clone(v) {
    if (v === null || typeof v !== 'object') {
      return v;
    }
    try {
      return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
    } catch {
      return Array.isArray(v) ? v.slice() : Object.assign({}, v);
    }
  }

  let state = Object.assign({}, DEFAULT_STATE, STORAGE.get('state', DEFAULT_STATE));
  let currentId = extractOfferId(location.href) ?? null;

  let panel;
  let nav;
  let textarea;
  let statusBox;
  let currentLabel;
  let withdrawButton;
  let returnButton;
  let progressFill;
  let progressValue;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function saveState() {
    STORAGE.set('state', state);
  }

  function parseIds(raw) {
    return raw
      .split(/\s+/)
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id));
  }

  function extractOfferId(url) {
    const match = /\/offers\/(?:edit|create)\/(\d+)/.exec(url);
    return match ? match[1] : null;
  }

  function buildEditUrl(id) {
    return `https://seller.ggsel.net/offers/edit/${id}`;
  }

  function goToOffer(id) {
    if (!id) return;
    const ids = parseIds(state.idsRaw);
    const idx = ids.indexOf(id);
    if (idx !== -1) {
      state.lastIndex = idx;
    }
    state.currentId = id;
    saveState();
    location.href = buildEditUrl(id);
  }

  const styles = `
    #ggsel-step-helper-panel {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 340px;
      max-width: calc(100vw - 32px);
      background: rgba(18, 18, 18, 0.88);
      color: #fff;
      font-family: 'Inter', Arial, sans-serif;
      border-radius: 12px;
      padding: 16px;
      z-index: 2147483646;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    #ggsel-step-helper-panel .ggsel-helper-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    #ggsel-step-helper-panel h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }
    #ggsel-step-helper-panel textarea {
      width: 100%;
      min-height: 120px;
      border-radius: 8px;
      border: none;
      resize: vertical;
      padding: 8px 10px;
      font-size: 14px;
      box-sizing: border-box;
      font-family: monospace;
    }
    #ggsel-step-helper-panel textarea:focus {
      outline: 2px solid #3fa9f5;
    }
    #ggsel-step-helper-panel .ggsel-helper-progress {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 12px 0 8px;
    }
    #ggsel-step-helper-panel .ggsel-helper-progress-track {
      position: relative;
      flex: 1;
      height: 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.18);
      overflow: hidden;
    }
    #ggsel-step-helper-panel .ggsel-helper-progress-fill {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 0%;
      background: #3fa9f5;
      border-radius: inherit;
      transition: width 0.2s ease;
    }
    #ggsel-step-helper-panel .ggsel-helper-progress-value {
      font-size: 13px;
      font-weight: 600;
      min-width: 60px;
      text-align: right;
    }
    #ggsel-step-helper-panel .ggsel-helper-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    #ggsel-step-helper-panel button:not(.ggsel-helper-help-btn) {
      background: #3fa9f5;
      color: #0d1017;
      border: none;
      border-radius: 8px;
      padding: 10px 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    #ggsel-step-helper-panel button:not(.ggsel-helper-help-btn):hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(63, 169, 245, 0.4);
    }
    #ggsel-step-helper-panel button:not(.ggsel-helper-help-btn):disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    #ggsel-step-helper-panel .ggsel-helper-help {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-btn {
      background: rgba(255, 255, 255, 0.18);
      color: #ffffff;
      border-radius: 50%;
      width: 26px;
      height: 26px;
      padding: 0;
      font-weight: 700;
      font-size: 15px;
      line-height: 1;
      border: 1px solid rgba(255, 255, 255, 0.25);
      cursor: help;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-btn:hover,
    #ggsel-step-helper-panel .ggsel-helper-help:focus-within .ggsel-helper-help-btn {
      background: rgba(255, 255, 255, 0.3);
    }
    #ggsel-step-helper-panel .ggsel-helper-help-tooltip {
      display: none;
      position: absolute;
      top: 36px;
      right: 0;
      width: 220px;
      padding: 12px;
      background: rgba(0, 0, 0, 0.92);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      font-size: 13px;
      line-height: 1.5;
      z-index: 10;
    }
    #ggsel-step-helper-panel .ggsel-helper-help:hover .ggsel-helper-help-tooltip,
    #ggsel-step-helper-panel .ggsel-helper-help:focus-within .ggsel-helper-help-tooltip {
      display: block;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-tooltip strong {
      display: block;
      font-weight: 600;
      margin-bottom: 6px;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-tooltip ul {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 4px;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-tooltip li {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    #ggsel-step-helper-panel .ggsel-helper-help-tooltip kbd {
      background: rgba(255, 255, 255, 0.16);
      border-radius: 4px;
      padding: 2px 6px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 12px;
      color: #fff;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer {
      margin-top: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: rgba(255,255,255,0.8);
      gap: 12px;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer button.ggsel-delete-btn {
      background: #ff6b6b;
      color: #1a0f0f;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer button.ggsel-delete-btn:hover {
      box-shadow: 0 6px 18px rgba(255, 107, 107, 0.35);
    }
    #ggsel-step-helper-panel .ggsel-helper-footer button.ggsel-return-btn {
      background: #f1b33f;
      color: #241500;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer button.ggsel-return-btn:hover {
      box-shadow: 0 6px 18px rgba(241, 179, 63, 0.35);
    }
    #ggsel-step-helper-panel .ggsel-helper-status {
      margin-top: 10px;
      font-size: 13px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(63, 169, 245, 0.14);
      border: 1px solid rgba(63, 169, 245, 0.35);
      min-height: 18px;
    }
    #ggsel-step-helper-nav {
      position: fixed;
      right: 24px;
      bottom: 24px;
      display: flex;
      gap: 12px;
      z-index: 2147483646;
    }
    #ggsel-step-helper-nav button {
      background: #00c896;
      color: #03140d;
      border: none;
      border-radius: 999px;
      padding: 12px 18px;
      font-weight: 600;
      cursor: pointer;
      min-width: 120px;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    #ggsel-step-helper-nav button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(0, 200, 150, 0.35);
    }
    #ggsel-step-helper-nav button:disabled {
      opacity: 0.4;
      transform: none;
      box-shadow: none;
      cursor: not-allowed;
    }
  `;

  function addStyle(cssText) {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(cssText);
    } else {
      const style = document.createElement('style');
      style.textContent = cssText;
      document.head.appendChild(style);
    }
  }

  function initUi() {
    if (panel || !document.body) {
      return;
    }

    addStyle(styles);

    panel = document.createElement('div');
    panel.id = 'ggsel-step-helper-panel';
    panel.innerHTML = `
      <div class="ggsel-helper-header">
        <h3>GGSEL Step Helper</h3>
        <div class="ggsel-helper-help">
          <button type="button" class="ggsel-helper-help-btn" aria-label="Подсказка по горячим клавишам">?</button>
          <div class="ggsel-helper-help-tooltip">
            <strong>Горячие клавиши</strong>
            <ul>
              <li><kbd>1</kbd><span>Этап 1</span></li>
              <li><kbd>2</kbd><span>Этап 2</span></li>
              <li><kbd>3</kbd><span>Этап 3</span></li>
              <li><kbd>4</kbd><span>Сделать всё</span></li>
              <li><kbd>A</kbd><span>Предыдущий товар</span></li>
              <li><kbd>D</kbd><span>Следующий товар</span></li>
              <li><kbd>S</kbd><span>Вернуться к товару</span></li>
              <li><kbd>W</kbd><span>Снять товар</span></li>
              <li><kbd>E</kbd><span>Сохранить прогресс</span></li>
            </ul>
          </div>
        </div>
      </div>
      <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;">ID товаров (по одному в строке)</label>
      <textarea id="ggsel-helper-ids" placeholder="Вставьте ID товаров">${state.idsRaw}</textarea>
      <div class="ggsel-helper-progress">
        <div class="ggsel-helper-progress-track" aria-hidden="true">
          <div class="ggsel-helper-progress-fill"></div>
        </div>
        <span class="ggsel-helper-progress-value" id="ggsel-helper-progress-value">0/0</span>
      </div>
      <div class="ggsel-helper-actions">
        <button data-action="stage1">Этап 1</button>
        <button data-action="stage2">Этап 2</button>
        <button data-action="stage3">Этап 3</button>
        <button data-action="runAll">Сделать всё</button>
      </div>
      <div class="ggsel-helper-status" id="ggsel-helper-status">Готово</div>
      <div class="ggsel-helper-footer">
        <div class="ggsel-helper-footer-left">
          <button data-action="return" class="ggsel-return-btn" style="display:none;">Вернуться к товару</button>
          <button data-action="withdraw" class="ggsel-delete-btn" style="display:none;">Снять товар</button>
          <span>Текущий ID:</span>
        </div>
        <strong id="ggsel-helper-current">${currentId ?? state.currentId ?? getCurrentTargetId() ?? '—'}</strong>
      </div>
    `;
    document.body.appendChild(panel);

    nav = document.createElement('div');
    nav.id = 'ggsel-step-helper-nav';
    nav.innerHTML = `
      <button data-nav="prev">Предыдущий</button>
      <button data-nav="next">Следующий</button>
    `;
    document.body.appendChild(nav);

    textarea = panel.querySelector('#ggsel-helper-ids');
    statusBox = panel.querySelector('#ggsel-helper-status');
    currentLabel = panel.querySelector('#ggsel-helper-current');
    withdrawButton = panel.querySelector('button[data-action="withdraw"]');
    returnButton = panel.querySelector('button[data-action="return"]');
    progressFill = panel.querySelector('.ggsel-helper-progress-fill');
    progressValue = panel.querySelector('#ggsel-helper-progress-value');

    textarea.addEventListener('input', () => {
      state.idsRaw = textarea.value;
      saveState();
      updateNavButtons();
    });

    panel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      runAction(action);
    });

    nav.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-nav]');
      if (!button) return;
      const direction = button.dataset.nav;
      navigate(direction === 'next' ? 1 : -1);
    });

    updateContextUi();
    if (currentId) {
      syncIndexById(currentId);
    } else {
      updateNavButtons();
      setStatus('Готово');
    }
    updateProgress();
    bindHotkeys();
  }

  function disableControls(isDisabled) {
    if (panel) {
      panel.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.disabled = isDisabled;
      });
    }
    if (nav) {
      nav.querySelectorAll('button[data-nav]').forEach((btn) => {
        btn.disabled = isDisabled;
      });
    }
  }

  function setStatus(message) {
    if (statusBox) {
      statusBox.textContent = message;
    }
  }

  function syncIndexById(id) {
    const ids = parseIds(state.idsRaw);
    const idx = ids.indexOf(id);
    if (idx !== -1) {
      state.lastIndex = idx;
    }
    state.currentId = id ?? null;
    saveState();
    updateCurrentLabel();
    updateNavButtons();
  }

  function updateNavButtons() {
    const ids = parseIds(state.idsRaw);
    if (!nav) {
      updateCurrentLabel();
      return;
    }
    const prevBtn = nav.querySelector('button[data-nav="prev"]');
    const nextBtn = nav.querySelector('button[data-nav="next"]');
    if (!ids.length) {
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      state.lastIndex = 0;
      if (currentId === null) {
        state.currentId = null;
      }
      saveState();
      updateCurrentLabel();
      updateContextUi();
      return;
    }
    if (state.lastIndex < 0) state.lastIndex = 0;
    if (state.lastIndex >= ids.length) state.lastIndex = ids.length - 1;
    if (currentId === null) {
      state.currentId = ids[state.lastIndex];
    }
    saveState();
    if (prevBtn) prevBtn.disabled = state.lastIndex <= 0;
    if (nextBtn) nextBtn.disabled = state.lastIndex >= ids.length - 1;
    updateCurrentLabel();
    updateContextUi();
  }

  function navigate(step) {
    const ids = parseIds(state.idsRaw);
    if (!ids.length) {
      setStatus('Список ID пуст');
      return;
    }
    let nextIndex = state.lastIndex + step;
    if (nextIndex < 0 || nextIndex >= ids.length) {
      setStatus('Дальше товаров нет');
      return;
    }
    state.lastIndex = nextIndex;
    const targetId = ids[nextIndex];
    state.currentId = targetId;
    saveState();
    updateNavButtons();
    setStatus(`Переход к ${targetId}...`);
    goToOffer(targetId);
  }

  function updateProgress() {
    if (!progressFill || !progressValue) return;
    const ids = parseIds(state.idsRaw);
    const total = ids.length;
    let index = -1;
    if (total) {
      const candidate = currentId ?? state.currentId ?? null;
      if (candidate) {
        index = ids.indexOf(candidate);
      }
      if (index === -1) {
        let fallback = state.lastIndex;
        if (fallback < 0) fallback = 0;
        if (fallback >= total) fallback = total - 1;
        index = total ? fallback : -1;
      }
    }
    const currentNumber = index >= 0 ? index + 1 : 0;
    const percent = total ? Math.max(0, Math.min(100, (currentNumber / total) * 100)) : 0;
    progressFill.style.width = `${percent}%`;
    progressValue.textContent = total ? `${currentNumber}/${total}` : '0/0';
  }

  async function runAll() {
    setStatus('Этап 1/3 — URL перенаправления...');
    const ok1 = await runStage1({ autoNext: true });
    if (!ok1) return;
    await waitFor(() => document.querySelector('#offerCost'), 20000);

    setStatus('Этап 2/3 — Цена и безлимит...');
    const ok2 = await runStage2({ autoNext: true });
    if (!ok2) return;
    await waitFor(() => document.querySelector('#instructions_ru'), 20000);

    setStatus('Этап 3/3 — Инструкции...');
    const ok3 = await runStage3();
    if (!ok3) return;
    setStatus('Готово!');
  }

  async function runWithdrawAction() {
    if (!isOnOffersList()) {
      setStatus('Кнопка доступна на странице со списком товаров');
      return false;
    }
    const targetId = getCurrentTargetId();
    if (!targetId) {
      setStatus('Нет выбранного ID для удаления');
      return false;
    }

    setStatus(`Ищем товар ${targetId}...`);
    const row = await findRowAcrossPages(targetId);
    if (!row) {
      setStatus(`Товар ${targetId} не найден на странице`);
      return false;
    }

    const triggers = Array.from(row.querySelectorAll('.ant-dropdown-trigger'));
    const menuTrigger = triggers.length ? triggers[triggers.length - 1] : null;
    if (!menuTrigger) {
      setStatus('Не найдена кнопка действий товара');
      return false;
    }

    realisticClick(menuTrigger);

    const withdrawItem = await waitFor(() => findDropdownItem('Снять с продажи'), 5000);
    if (!withdrawItem) {
      setStatus('Не найден пункт "Снять с продажи"');
      return false;
    }

    realisticClick(withdrawItem);
    setStatus(`Товар ${targetId} снят с продажи`);
    return true;
  }

  async function runReturnAction() {
    if (!isOnOffersList()) {
      setStatus('Кнопка доступна на странице со списком товаров');
      return false;
    }
    const targetId = state.currentId ?? getCurrentTargetId();
    if (!targetId) {
      setStatus('Нет выбранного ID для возврата');
      return false;
    }
    setStatus(`Открываем ${targetId}...`);
    goToOffer(targetId);
    return true;
  }

  async function runStage1({ autoNext = false } = {}) {
    const input = await waitFor(() => document.querySelector('#redirectUrl'), 15000);
    if (!input) {
      setStatus('Поле URL для перенаправления не найдено');
      return false;
    }
    setReactValue(input, 'https://key-steam.store/gift');
    setStatus('URL перенаправления заполнен');
    if (autoNext) {
      const nextBtn = findButtonByText('Сохранить и далее');
      if (nextBtn) {
        realisticClick(nextBtn);
        setStatus('Переходим к этапу 2...');
        await sleep(400);
      } else {
        setStatus('Не найдена кнопка "Сохранить и далее"');
        return false;
      }
    }
    return true;
  }

  async function runStage2({ autoNext = false } = {}) {
    const label = await waitFor(() => findSegmentLabel('Безлимитный'), 15000);
    if (!label) {
      setStatus('Не найден переключатель "Безлимитный"');
      return false;
    }
    if (label.getAttribute('aria-selected') !== 'true') {
      realisticClick(label);
      const selected = await waitFor(() => {
        const current = findSegmentLabel('Безлимитный');
        return current && current.getAttribute('aria-selected') === 'true';
      }, 5000);
      if (!selected) {
        setStatus('Не удалось активировать "Безлимитный"');
        return false;
      }
    }
    setStatus('"Безлимитный" активирован');
    if (autoNext) {
      const nextBtn = findButtonByText('Сохранить и далее');
      if (nextBtn) {
        realisticClick(nextBtn);
        setStatus('Переходим к этапу 3...');
        await sleep(400);
      } else {
        setStatus('Не найдена кнопка "Сохранить и далее"');
        return false;
      }
    }
    return true;
  }

  async function runStage3() {
    const ruField = await waitFor(() => document.querySelector('#instructions_ru'), 15000);
    if (!ruField) {
      setStatus('Не найдено поле инструкции RU');
      return false;
    }
    setReactValue(ruField, `Спасибо за покупку! Будем рады положительному отзыву :)`);

    const enTab = await waitFor(() => findTabByText('EN'), 5000);
    if (!enTab) {
      setStatus('Не найдена вкладка EN');
      return false;
    }
    if (enTab.getAttribute('aria-selected') !== 'true') {
      realisticClick(enTab);
      await sleep(300);
    }

    const enField = await waitFor(() => document.querySelector('#instructions_en'), 8000);
    if (!enField) {
      setStatus('Не найдено поле инструкции EN');
      return false;
    }
    setReactValue(enField, `Thank you for your purchase! We will be glad to receive a positive review :)`);
    setStatus('Инструкции обновлены');
    return true;
  }

  function waitFor(predicate, timeout = 10000, interval = 100) {
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        let result;
        try {
          result = predicate();
        } catch (err) {
          console.error('[GGSEL Step Helper] waitFor predicate error', err);
        }
        if (result) {
          resolve(result);
          return;
        }
        if (performance.now() - start >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function getCurrentTargetId() {
    const ids = parseIds(state.idsRaw);
    if (!ids.length) {
      return state.currentId ?? null;
    }
    let idx = state.lastIndex;
    if (idx < 0) idx = 0;
    if (idx >= ids.length) idx = ids.length - 1;
    return ids[idx];
  }

  function updateCurrentLabel() {
    if (!currentLabel) {
      updateProgress();
      return;
    }
    const labelId = currentId ?? state.currentId ?? getCurrentTargetId();
    currentLabel.textContent = labelId ?? '—';
    updateProgress();
  }

  function setReactValue(element, value) {
    if (!element) return;
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const lastValue = element.value;
    if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
    if (value !== lastValue) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findButtonByText(text) {
    text = text.trim().toLowerCase();
    return Array.from(document.querySelectorAll('button')).find((btn) => btn.textContent.trim().toLowerCase() === text) || null;
  }

  function findSegmentLabel(labelText) {
    return Array.from(document.querySelectorAll('.ant-segmented-item-label')).find((el) => el.textContent.trim() === labelText) || null;
  }

  function findTabByText(text) {
    return Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent.trim().toLowerCase() === text.toLowerCase()) || null;
  }

  function findDropdownItem(text) {
    const normalized = text.trim().toLowerCase();
    return Array.from(document.querySelectorAll('.ant-dropdown-menu-item'))
      .find((item) => item.textContent.trim().toLowerCase() === normalized && item.offsetParent !== null) || null;
  }

  function findOffersRow(id) {
    const link = document.querySelector(`a[href="/offers/edit/${id}"]`);
    if (!link) {
      return null;
    }
    return link.closest('tr') || link.closest('li') || link.closest('.ant-list-item') || link.closest('div');
  }

  function getActivePaginationPage() {
    const active = document.querySelector('.ant-pagination-item-active');
    return active ? active.textContent.trim() : null;
  }

  function getNextPaginationButton() {
    const nextLi = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled)');
    if (!nextLi) {
      return null;
    }
    return nextLi.querySelector('button') || nextLi;
  }

  async function findRowAcrossPages(id) {
    const visitedPages = new Set();
    let loops = 0;
    while (loops < 50) {
      const row = await waitFor(() => findOffersRow(id), 2000);
      if (row) {
        return row;
      }

      const nextBtn = getNextPaginationButton();
      if (!nextBtn) {
        return null;
      }

      const currentPage = getActivePaginationPage();
      if (currentPage) {
        visitedPages.add(currentPage);
        setStatus(`Товар не найден на странице ${currentPage}, переключаемся далее...`);
      } else {
        setStatus('Товар не найден, переключаемся далее...');
      }

      realisticClick(nextBtn);

      const changedTo = await waitFor(() => {
        const label = getActivePaginationPage();
        if (!label || label === currentPage) {
          return null;
        }
        return label;
      }, 5000);

      if (!changedTo) {
        return null;
      }

      if (visitedPages.has(changedTo)) {
        return null;
      }
      visitedPages.add(changedTo);

      await sleep(500);
      loops += 1;
    }
    return null;
  }

  function isOnOffersList() {
    return location.pathname === '/offers' || location.pathname === '/offers/';
  }

  function updateContextUi() {
    if (!withdrawButton || !returnButton) return;
    const onList = isOnOffersList();
    const activeId = state.currentId ?? getCurrentTargetId();
    const hasId = Boolean(activeId);
    withdrawButton.style.display = onList ? '' : 'none';
    returnButton.style.display = onList ? '' : 'none';
    withdrawButton.disabled = !hasId;
    returnButton.disabled = !hasId;
  }

  let hotkeysBound = false;

  function bindHotkeys() {
    if (hotkeysBound) return;
    window.addEventListener('keydown', handleHotkeys, true);
    hotkeysBound = true;
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    const editable = target.isContentEditable;
    return editable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function handleHotkeys(event) {
    if (event.defaultPrevented || event.repeat) return;
    if (isTypingTarget(event.target)) return;

    const code = event.code;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let action = null;

    switch (code) {
      case 'Digit1':
      case 'Numpad1':
        action = 'stage1';
        break;
      case 'Digit2':
      case 'Numpad2':
        action = 'stage2';
        break;
      case 'Digit3':
      case 'Numpad3':
        action = 'stage3';
        break;
      case 'Digit4':
      case 'Numpad4':
        action = 'runAll';
        break;
      case 'KeyA':
        action = 'navPrev';
        break;
      case 'KeyD':
        action = 'navNext';
        break;
      case 'KeyS':
        action = 'return';
        break;
      case 'KeyW':
        action = 'withdraw';
        break;
      case 'KeyE':
        action = 'save';
        break;
      default:
        break;
    }

    if (!action) {
      switch (key) {
        case '1':
          action = 'stage1';
          break;
        case '2':
          action = 'stage2';
          break;
        case '3':
          action = 'stage3';
          break;
        case '4':
          action = 'runAll';
          break;
        case 'a':
          action = 'navPrev';
          break;
        case 'd':
          action = 'navNext';
          break;
        case 's':
          action = 'return';
          break;
        case 'w':
          action = 'withdraw';
          break;
        case 'e':
          action = 'save';
          break;
        default:
          return;
      }
    }
    event.preventDefault();
    runAction(action);
  }

  async function runAction(action) {
    if (!action) return;
    if (action === 'navPrev') {
      navigate(-1);
      return;
    }
    if (action === 'navNext') {
      navigate(1);
      return;
    }
    disableControls(true);
    try {
      if (action === 'stage1') {
        await runStage1();
      } else if (action === 'stage2') {
        await runStage2();
      } else if (action === 'stage3') {
        await runStage3();
      } else if (action === 'runAll') {
        await runAll();
      } else if (action === 'withdraw') {
        await runWithdrawAction();
      } else if (action === 'return') {
        await runReturnAction();
      } else if (action === 'save') {
        await runSaveAction();
      }
    } catch (err) {
      setStatus(`Ошибка: ${err.message || err}`);
      console.error('[GGSEL Step Helper] Ошибка действия', err);
    } finally {
      disableControls(false);
    }
  }

  async function runSaveAction() {
    const candidates = ['Сохранить и далее', 'Сохранить и опубликовать'];
    for (const text of candidates) {
      const button = findButtonByText(text);
      if (button) {
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          setStatus(`Кнопка "${text}" недоступна`);
          return false;
        }
        realisticClick(button);
        setStatus(`Нажата кнопка "${text}"`);
        return true;
      }
    }
    setStatus('Не найдены кнопки сохранения');
    return false;
  }

  function realisticClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch {}
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width - 1, Math.max(1, rect.width / 2));
    const y = rect.top + Math.min(rect.height - 1, Math.max(1, rect.height / 2));
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch {
      el.click();
    }
  }

  function ensureUi() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUi, { once: true });
    } else {
      initUi();
    }
  }

  const observer = new MutationObserver(() => {
    const newId = extractOfferId(location.href);
    if (newId !== currentId) {
      currentId = newId;
      if (newId) {
        syncIndexById(newId);
      } else {
        updateCurrentLabel();
      }
    }
    updateContextUi();
  });

  ensureUi();

  const startObserving = () => {
    if (document.body && !observer.started) {
      observer.observe(document.body, { childList: true, subtree: true });
      observer.started = true;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  } else {
    startObserving();
  }
})();
