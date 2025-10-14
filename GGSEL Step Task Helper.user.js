// ==UserScript==
// @name         GGSEL Step Task Helper — vibe.coding
// @namespace    https://vibe.coding/ggsel
// @version      0.1.1
// @description  Пошаговый помощник для массового обновления офферов GGSEL: список ID, навигация «Предыдущий/Следующий», отдельные этапы и режим «Сделать всё».
// @author       vibe.coding
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
    lastIndex: 0
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
  let currentId = extractOfferId(location.href);

  let panel;
  let nav;
  let textarea;
  let statusBox;
  let currentLabel;

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
    const idx = parseIds(state.idsRaw).indexOf(id);
    if (idx !== -1) {
      state.lastIndex = idx;
      saveState();
    }
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
    #ggsel-step-helper-panel h3 {
      margin: 0 0 12px;
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
    #ggsel-step-helper-panel .ggsel-helper-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    #ggsel-step-helper-panel button {
      background: #3fa9f5;
      color: #0d1017;
      border: none;
      border-radius: 8px;
      padding: 10px 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    #ggsel-step-helper-panel button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(63, 169, 245, 0.4);
    }
    #ggsel-step-helper-panel button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    #ggsel-step-helper-panel .ggsel-helper-footer {
      margin-top: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: rgba(255,255,255,0.8);
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
      <h3>GGSEL Step Helper</h3>
      <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;">ID товаров (по одному в строке)</label>
      <textarea id="ggsel-helper-ids" placeholder="Вставьте ID товаров">${state.idsRaw}</textarea>
      <div class="ggsel-helper-actions">
        <button data-action="stage1">Этап 1</button>
        <button data-action="stage2">Этап 2</button>
        <button data-action="stage3">Этап 3</button>
        <button data-action="runAll">Сделать всё</button>
      </div>
      <div class="ggsel-helper-status" id="ggsel-helper-status">Готово</div>
      <div class="ggsel-helper-footer">
        <span>Текущий ID:</span>
        <strong id="ggsel-helper-current">${currentId ?? '—'}</strong>
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

    textarea.addEventListener('input', () => {
      state.idsRaw = textarea.value;
      saveState();
      updateNavButtons();
    });

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
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
        }
      } catch (err) {
        setStatus(`Ошибка: ${err.message || err}`);
        console.error('[GGSEL Step Helper] Ошибка действия', err);
      } finally {
        disableControls(false);
      }
    });

    nav.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-nav]');
      if (!button) return;
      const direction = button.dataset.nav;
      navigate(direction === 'next' ? 1 : -1);
    });

    if (currentId) {
      syncIndexById(currentId);
    } else {
      updateNavButtons();
      setStatus('Готово');
    }
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
      saveState();
    }
    if (currentLabel) {
      currentLabel.textContent = id ?? '—';
    }
    updateNavButtons();
  }

  function updateNavButtons() {
    const ids = parseIds(state.idsRaw);
    if (!nav) return;
    const prevBtn = nav.querySelector('button[data-nav="prev"]');
    const nextBtn = nav.querySelector('button[data-nav="next"]');
    if (!ids.length) {
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      state.lastIndex = 0;
      saveState();
      return;
    }
    if (state.lastIndex < 0) state.lastIndex = 0;
    if (state.lastIndex >= ids.length) state.lastIndex = ids.length - 1;
    saveState();
    if (prevBtn) prevBtn.disabled = state.lastIndex <= 0;
    if (nextBtn) nextBtn.disabled = state.lastIndex >= ids.length - 1;
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
    saveState();
    const targetId = ids[nextIndex];
    setStatus(`Переход к ${targetId}...`);
    goToOffer(targetId);
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
    setReactValue(ruField, `Спасибо за покупку! Будем рады положительному отзыву :)\n\nНажмите кнопку "Получить товар"`);

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
    setReactValue(enField, `Thank you for your purchase! We will be glad to receive a positive review :)\n\nClick the "Get the product" button`);
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
    if (newId && newId !== currentId) {
      currentId = newId;
      syncIndexById(newId);
    }
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
