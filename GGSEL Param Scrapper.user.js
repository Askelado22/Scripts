// ==UserScript==
// @name         GGSEL Param Scrapper RU/EN (v1.2) — EN через таб, первый RU без цены
// @namespace    vibe.coding.ggsel.param-filler
// @version      1.2.0
// @description  RU: заголовок + пары (имя/модификатор), где первый вариант без модификатора. EN: переключаем вкладку EN и заполняем заголовок+имена без модификаторов.
// @author       vibe
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------
  // БАЗОВЫЕ УТИЛИТЫ
  // ------------------------------

  async function copyText(text) {
    if (!text && text !== 0) return false;
    const value = String(text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (err) {
      console.warn('[GGSEL Param Scrapper] Clipboard API недоступен', err);
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let success = false;
    try {
      success = document.execCommand('copy');
    } catch (err) {
      console.warn('[GGSEL Param Scrapper] Не удалось скопировать текст', err);
    }
    document.body.removeChild(textarea);
    return success;
  }

  /** Безопасная установка значения в input (корректно для React/AntD) */
  function setReactInputValue(input, value) {
    if (!input) return;
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = desc && desc.set ? desc.set : null;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Подождать N мс */
  function wait(ms = 50) {
    return new Promise((res) => setTimeout(res, ms));
  }

  /** Найти модалку «Добавление параметра» */
  function findParamModal() {
    const modals = Array.from(document.querySelectorAll('.ant-modal'));
    for (let i = modals.length - 1; i >= 0; i--) {
      const m = modals[i];
      const titleNode = m.querySelector('.ant-modal-title, .style_UIModal__title__W_wVz');
      const titleText = titleNode ? titleNode.textContent.trim() : '';
      if (/Добавление параметра/i.test(titleText)) return m;
    }
    return null;
  }

  // ------------------------------
  // РАБОТА С ТАБАМИ RU/EN
  // ------------------------------

  /** Текущая активная вкладка языка: 'ru' | 'en' | null */
  function getActiveLang(modal) {
    const activeTabBtn = modal.querySelector('.ant-tabs .ant-tabs-tab.ant-tabs-tab-active .ant-tabs-tab-btn');
    const text = activeTabBtn ? activeTabBtn.textContent.trim().toLowerCase() : '';
    if (text === 'ru' || text === 'en') return text;
    return null;
  }

  /** Переключить вкладку на нужный язык и дождаться перерисовки полей */
  async function switchToLang(modal, lang /* 'ru' | 'en' */) {
    lang = (lang || '').toLowerCase();
    if (!['ru', 'en'].includes(lang)) return;
    if (getActiveLang(modal) === lang) return;

    // Ищем таб по data-node-key или по тексту
    let tab = modal.querySelector(`.ant-tabs .ant-tabs-tab [id^="rc-tabs-"][id$="-tab-${lang}"]`);
    if (!tab) {
      const tabs = Array.from(modal.querySelectorAll('.ant-tabs .ant-tabs-tab .ant-tabs-tab-btn'));
      tab = tabs.find((b) => (b.textContent || '').trim().toLowerCase() === lang) || null;
    }
    if (!tab) return;

    // Кликаем по кнопке таба
    tab.click();

    // Ждём пока активный таб станет нужным + классы _visible/_hidden обновятся
    for (let i = 0; i < 40; i++) {
      await wait(50);
      if (getActiveLang(modal) === lang) break;
    }
    // Небольшая пауза на перестройку DOM
    await wait(80);
  }

  // ------------------------------
  // ПОИСК ПОЛЕЙ С УЧЁТОМ АКТИВНОЙ ВКЛАДКИ
  // ------------------------------

  /** Найти инпут «Заголовок параметра» для языка lang
   *  Логика: если активная вкладка == lang → берём .field-lang._visible; иначе ._hidden
   */
  function findTitleInputForLang(modal, lang /* 'ru' | 'en' */) {
    const active = getActiveLang(modal);
    const needVisible = active === lang; // какой блок будет видим для нужного языка
    const fields = Array.from(modal.querySelectorAll('.field-lang'));
    for (const fld of fields) {
      const label = fld.querySelector('label');
      const input = fld.querySelector('input.ant-input');
      if (!label || !input) continue;
      if (!/Заголовок параметра/i.test(label.textContent)) continue;
      const isVisible = fld.classList.contains('_visible');
      if (isVisible === needVisible) return input;
    }
    return null;
  }

  /** Найти инпут «Название варианта» внутри блока варианта для языка lang
   *  Аналогично: ориентируемся на _visible/_hidden исходя из активной вкладки
   */
  function findVariantNameInputForLang(variantEl, lang /* 'ru' | 'en' */, active /* 'ru'|'en'|null */) {
    const needVisible = active === lang;
    const groups = Array.from(variantEl.querySelectorAll('.field-lang'));
    for (const g of groups) {
      const label = g.querySelector('label');
      const input = g.querySelector('input.ant-input');
      if (!label || !input) continue;
      if (!/Название варианта/i.test(label.textContent)) continue;
      const isVisible = g.classList.contains('_visible');
      if (isVisible === needVisible) return input;
    }
    return null;
  }

  /** Инпут модификатора внутри варианта (ant-input-number-input) */
  function findVariantModifierInput(variantEl) {
    const all = Array.from(variantEl.querySelectorAll('input.ant-input-number-input'));
    const active = all.find((i) => !i.disabled);
    return active || all[0] || null;
  }

  /** Все блоки вариантов */
  function getVariantBlocks(modal) {
    return Array.from(modal.querySelectorAll('.style_variants__LzQLe .style_variant__eTXyL, .style_variant__eTXyL'));
  }

  const PARAM_SECTION_KEYWORDS = ['Параметры и модификаторы цены', 'Parameters and price modifiers'];
  let cachedParametersSection = null;

  function findParametersSectionRoot() {
    const headingSelectors = 'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="header" i]';
    const headings = Array.from(document.querySelectorAll(headingSelectors));
    for (const node of headings) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (PARAM_SECTION_KEYWORDS.some((key) => text.toLowerCase().includes(key.toLowerCase()))) {
        const container = node.closest('section, article, div') || node.parentElement;
        if (container) return container;
      }
    }

    const allBlocks = Array.from(document.querySelectorAll('section, article, div'));
    for (const block of allBlocks) {
      const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (PARAM_SECTION_KEYWORDS.some((key) => text.toLowerCase().includes(key.toLowerCase()))) {
        return block;
      }
    }
    return null;
  }

  function getParametersSection() {
    if (cachedParametersSection && cachedParametersSection.isConnected) return cachedParametersSection;
    const section = findParametersSectionRoot();
    cachedParametersSection = section || null;
    return section;
  }

  function isParameterContainer(el) {
    if (!(el instanceof HTMLElement)) return false;
    const classMatch = Array.from(el.classList || []).some((cls) => /param|variant|option|price|item|row/i.test(cls));
    if (classMatch) return true;
    const dataValues = Object.values(el.dataset || {});
    if (dataValues.some((value) => /param|variant|option|price/i.test(String(value)))) return true;
    const dataKeys = Object.keys(el.dataset || {});
    if (dataKeys.some((key) => /param|variant|option|price/i.test(key))) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && /row/i.test(role)) return true;
    return false;
  }

  function findParameterCard(node, boundary) {
    if (!(node instanceof HTMLElement)) return null;
    let current = node;
    let fallback = null;
    let depth = 0;
    const limit = 10;
    while (current && current !== document.body && current !== boundary && depth < limit) {
      if (!fallback && current.children && current.children.length > 1) fallback = current;
      if (isParameterContainer(current)) return current;
      current = current.parentElement;
      depth += 1;
    }
    if (current && (current === boundary || current === document.body)) return fallback;
    return fallback;
  }

  function findStandardNode(card) {
    if (!(card instanceof HTMLElement)) return null;
    const selectors = ['[data-qa*="standard" i]', '[class*="standard" i]'];
    for (const selector of selectors) {
      const node = card.querySelector(selector);
      if (node && /Стандарт|Standard/i.test(node.textContent || '')) return node;
    }
    const nodes = Array.from(card.querySelectorAll('*'));
    for (const node of nodes) {
      if (/Стандарт\s*:|Standard\s*:/i.test((node.textContent || '').replace(/\s+/g, ' '))) return node;
    }
    return null;
  }

  function findGreenishNode(root) {
    if (!(root instanceof HTMLElement)) return null;
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const styles = getComputedStyle(node);
      if (isGreenColor(styles.color) || isGreenColor(styles.backgroundColor)) return node;
    }
    return null;
  }

  function extractStandardValue(card) {
    const standardNode = findStandardNode(card);
    if (!standardNode) return '';
    const valueNode = findGreenishNode(standardNode) || standardNode;
    let text = (valueNode.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const match = text.match(/-?\d[\d\s]*(?:[.,]\d+)?/);
    if (!match) return '';
    const value = match[0].replace(/\s+/g, '').replace(',', '.');
    return value;
  }

  function extractParameterName(card) {
    if (!(card instanceof HTMLElement)) return '';
    const selectors = [
      '[data-qa*="name" i]',
      '[class*="name" i]',
      '[class*="title" i]',
      'h3, h4, h5, h6',
      'strong',
    ];
    for (const selector of selectors) {
      const node = card.querySelector(selector);
      if (!node) continue;
      const text = (node.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/Стандарт|Standard/i.test(text)) continue;
      return text;
    }

    const lines = (card.textContent || '')
      .split(/\n+/)
      .map((s) => s.replace(/\u00A0/g, ' ').trim())
      .filter(Boolean);
    for (const line of lines) {
      if (/^(Стандарт|Standard)\b/i.test(line)) continue;
      if (/mod\b/i.test(line) || /мод\b/i.test(line)) continue;
      if (/^(\+|-)?\d[\d\s]*(?:[.,]\d+)?\s*(₽|руб|rub|coins|coin|usd|eur|грн|uah|тг|kzt|сом|byn|₴|₸|₽|р\.?)/i.test(line)) continue;
      if (/^(\+|-)?\d[\d\s]*(?:[.,]\d+)?$/i.test(line)) continue;
      return line;
    }
    return '';
  }

  function collectStandardParameters() {
    const section = getParametersSection();
    if (!section) return { items: [], reason: 'section' };

    const standardNodes = Array.from(section.querySelectorAll('[data-qa*="standard" i], [class*="standard" i]'));
    if (!standardNodes.length) {
      standardNodes.push(
        ...Array.from(section.querySelectorAll('*')).filter((node) =>
          /Стандарт\s*:|Standard\s*:/i.test((node.textContent || '').replace(/\s+/g, ' '))
        )
      );
    }

    const cards = new Set();
    for (const node of standardNodes) {
      const card = findParameterCard(node, section);
      if (card) cards.add(card);
    }

    const items = [];
    for (const card of cards) {
      const name = extractParameterName(card);
      const value = extractStandardValue(card);
      if (!name || !value) continue;
      items.push({ name, value });
    }
    return { items, reason: items.length ? '' : 'data' };
  }

  function getStandardNotFoundMessage(reason) {
    return reason === 'section'
      ? 'Блок «Параметры и модификаторы цены» не найден'
      : 'Не удалось найти стандартные значения';
  }

  async function copyStandardParametersToClipboard(btn) {
    if (!btn || btn.disabled) return;
    const { items, reason } = collectStandardParameters();
    if (!items.length) {
      alert(getStandardNotFoundMessage(reason));
      return;
    }
    const payload = items.map((item) => `${item.name}\n${item.value}`).join('\n');
    const ok = await copyText(payload);
    if (!ok) {
      alert('Не удалось скопировать данные');
      return;
    }
    const original = btn.textContent;
    btn.textContent = 'Скопировано!';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1600);
  }

  function findParametersButtonsContainer(section) {
    if (!(section instanceof HTMLElement)) return null;
    const candidates = Array.from(section.querySelectorAll('button, a'));
    for (const candidate of candidates) {
      const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text) continue;
      if (
        /скопировать названия/i.test(text) ||
        /скачать параметры/i.test(text) ||
        /parameters/i.test(text) ||
        /csv/i.test(text)
      ) {
        return candidate.parentElement || section;
      }
    }
    return section;
  }

  function createStandardButtonElement(template) {
    const button = document.createElement('button');
    button.type = 'button';
    if (template instanceof HTMLElement) {
      button.className = template.className;
      const style = template.getAttribute('style');
      if (style) button.setAttribute('style', style);
    } else {
      button.className = 'ant-btn ant-btn-default';
    }
    button.dataset.vcStandardCopyBtn = '1';
    button.textContent = 'Скопировать названия и Standard';
    button.addEventListener('click', () => copyStandardParametersToClipboard(button));
    return button;
  }

  function ensureStandardCopyButton() {
    const section = getParametersSection();
    if (!section) return;
    if (section.querySelector('[data-vc-standard-copy-btn]')) return;
    const container = findParametersButtonsContainer(section);
    if (!container) return;
    const template = container.querySelector('button, a');
    const button = createStandardButtonElement(template);
    container.appendChild(button);
  }

  /** Кнопка «Добавить вариант» */
  function findAddVariantButton(modal) {
    const btns = Array.from(modal.querySelectorAll('button'));
    return btns.find((b) => /Добавить вариант/i.test(b.textContent || '')) || null;
  }

  /** Первый вариант с пустым RU названием (когда заполняем RU, полезно переиспользовать пустой) */
  function findFirstEmptyVariantRU(modal) {
    const active = getActiveLang(modal);
    const variants = getVariantBlocks(modal);
    for (const v of variants) {
      const ruName = findVariantNameInputForLang(v, 'ru', active);
      if (ruName && !ruName.value.trim()) return v;
    }
    return null;
  }

  /** Добавить вариант и вернуть созданный блок */
  async function addVariant(modal) {
    const before = getVariantBlocks(modal);
    const addBtn = findAddVariantButton(modal);
    if (!addBtn) return null;
    addBtn.click();
    for (let i = 0; i < 30; i++) {
      await wait(50);
      const after = getVariantBlocks(modal);
      if (after.length > before.length) return after[after.length - 1];
    }
    return null;
  }

  /** Установка целочисленного значения в AntD NumberInput */
  function setNumberInput(input, value) {
    if (!input) return;
    if (input.disabled) return; // по ТЗ не трогаем disabled (например, первый вариант)
    let v = String(value ?? '').replace(/\s+/g, '');
    if (!/^-?\d+$/.test(v)) {
      const m = v.match(/-?\d+/);
      v = m ? m[0] : '0';
    }
    setReactInputValue(input, v);
  }

  // ------------------------------
  // ПОПОВЕРЫ
  // ------------------------------

  let stylesInjected = false;
  function injectStylesOnce() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .vc-toolbar{display:inline-flex;gap:8px;align-items:center;margin-left:12px}
      .vc-param-btn{all:unset;font:inherit;cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.25);color:inherit;line-height:1.4}
      .vc-param-btn:hover{background:rgba(255,255,255,0.06)}
      .vc-popover{display:none;position:fixed;z-index:999999;background:rgba(22,22,26,0.98);border:1px solid rgba(255,255,255,0.08);border-radius:12px;box-shadow:0 10px 26px rgba(0,0,0,0.35);padding:10px;width:420px}
      .vc-popover.is-open{display:block}
      .vc-popover-inner{display:grid;gap:8px}
      .vc-popover-row{display:flex;align-items:center;gap:8px}
      .vc-textarea{width:100%;min-height:150px;resize:vertical;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45}
      .vc-file{padding:4px}
      .vc-hint{opacity:.75;font-size:12px}
      .vc-popover-actions{display:flex;gap:8px;justify-content:flex-end}
      .vc-action{all:unset;font:inherit;cursor:pointer;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.25)}
      .vc-action:hover{background:rgba(255,255,255,0.06)}
      .vc-action[disabled]{opacity:0.55;cursor:default}
      .vc-modifier-copied{outline:1px dashed rgba(82,196,26,0.45);outline-offset:2px}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function createPopoverButton(text /* 'RU' | 'EN' */) {
    injectStylesOnce();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.className = 'vc-param-btn';

    const panel = document.createElement('div');
    panel.className = 'vc-popover';
    panel.innerHTML = `
      <div class="vc-popover-inner">
        <div class="vc-popover-row">
          <textarea class="vc-textarea" placeholder="${text === 'RU'
            ? '1-я строка: заголовок RU\nДалее: пары строк (Название варианта → Модификатор целое). Первый вариант — только название.'
            : '1-я строка: заголовок EN\nДалее: названия вариантов EN построчно (без модификаторов).'}"></textarea>
        </div>
        ${text === 'RU' ? `<div class="vc-popover-row"><input class="vc-file" type="file" accept=".txt,.csv"/><span class="vc-hint">или выберите файл .txt/.csv</span></div>` : ``}
        <div class="vc-popover-actions">
          ${text === 'RU' ? `<button type="button" class="vc-action vc-copy-standard">Скопировать названия и Standard</button>` : ``}
          <button type="button" class="vc-action vc-fill">Заполнить</button>
          <button type="button" class="vc-action vc-clear">Очистить</button>
          <button type="button" class="vc-action vc-close">Закрыть</button>
        </div>
      </div>
    `;

    const textarea = panel.querySelector('.vc-textarea');
    const fillBtn = panel.querySelector('.vc-fill');
    const clearBtn = panel.querySelector('.vc-clear');
    const closeBtn = panel.querySelector('.vc-close');
    const fileInput = panel.querySelector('.vc-file');
    const copyStandardBtn = panel.querySelector('.vc-copy-standard');

    clearBtn.addEventListener('click', () => (textarea.value = ''));
    closeBtn.addEventListener('click', () => panel.classList.remove('is-open'));
    document.addEventListener('keydown', (e) => {
      if (panel.classList.contains('is-open') && e.key === 'Escape') panel.classList.remove('is-open');
    });
    document.addEventListener('mousedown', (e) => {
      if (!panel.contains(e.target) && e.target !== btn) panel.classList.remove('is-open');
    });

    function openUnderButton() {
      const r = btn.getBoundingClientRect();
      const gap = 6, width = 420, approxH = 260;
      let left = r.left;
      let top = r.bottom + gap;
      if (left + width + 8 > innerWidth) left = Math.max(8, innerWidth - width - 8);
      if (left < 8) left = 8;
      if (top + approxH + 8 > innerHeight) top = Math.max(8, r.top - approxH - gap);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.classList.add('is-open');
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      panel.classList.toggle('is-open');
      if (panel.classList.contains('is-open')) openUnderButton();
    });

    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try { textarea.value = await f.text(); }
        catch { alert('Не удалось прочитать файл'); }
      });
    }

    return { button: btn, panel, textarea, fillBtn, copyStandardBtn };
  }

  // ------------------------------
  // ПАРСЕРЫ
  // ------------------------------

  function parseRU(raw) {
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return { blockTitle: '', items: [] };
    const blockTitle = lines.shift();
    const items = [];
    for (let i = 0; i < lines.length; i += 2) {
      const name = lines[i] || '';
      const modLine = (i + 1 < lines.length ? lines[i + 1] : '0') + '';
      const modifier = (modLine.match(/-?\d+/) || ['0'])[0];
      items.push({ name, modifier });
    }
    return { blockTitle, items };
  }

  function parseEN(raw) {
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return { blockTitle: '', names: [] };
    const blockTitle = lines.shift();
    return { blockTitle, names: lines };
  }

  // ------------------------------
  // ЗАПОЛНЕНИЕ
  // ------------------------------

  /** Вернуть блок N-го варианта; если не хватает — берём пустой или создаём новый */
  async function getOrCreateVariantForIndex(modal, index /* 0-based */) {
    let variants = getVariantBlocks(modal);
    if (variants[index]) return variants[index];
    const emptyRU = findFirstEmptyVariantRU(modal);
    if (emptyRU) return emptyRU;
    return await addVariant(modal);
  }

  /** RU: первый вариант — только название, цену не трогаем */
  async function fillRU(raw) {
    const modal = findParamModal();
    if (!modal) return alert('Модалка «Добавление параметра» не найдена');

    const { blockTitle, items } = parseRU(raw);
    if (!blockTitle && !items.length) return alert('Пустые данные');

    // На RU вкладку переключаться не обязательно, но сделаем для корректной видимости
    await switchToLang(modal, 'ru');

    const ruTitle = findTitleInputForLang(modal, 'ru');
    if (ruTitle) setReactInputValue(ruTitle, blockTitle || '');

    if (!items.length) return;

    // Первый вариант — только название
    let v0 = await getOrCreateVariantForIndex(modal, 0);
    const active = getActiveLang(modal); // сейчас 'ru'
    if (v0) {
      const ruName0 = findVariantNameInputForLang(v0, 'ru', active);
      if (ruName0) setReactInputValue(ruName0, items[0].name);
      // модификатор умышленно не трогаем
    }

    // Остальные варианты: имя + модификатор
    for (let i = 1; i < items.length; i++) {
      const block = await getOrCreateVariantForIndex(modal, i);
      if (!block) continue;
      const ruName = findVariantNameInputForLang(block, 'ru', active);
      const modInput = findVariantModifierInput(block);
      if (ruName) setReactInputValue(ruName, items[i].name);
      if (modInput) setNumberInput(modInput, items[i].modifier);
      await wait(20);
    }
  }

  /** EN: переключаем вкладку EN, затем заполняем заголовок и имена (без модификаторов) */
  async function fillEN(raw) {
    const modal = findParamModal();
    if (!modal) return alert('Модалка «Добавление параметра» не найдена');

    const { blockTitle, names } = parseEN(raw);
    if (!blockTitle && !names.length) return alert('Пустые данные');

    // ВАЖНО: поля EN появляются только после переключения вкладки
    await switchToLang(modal, 'en');
    const active = getActiveLang(modal); // сейчас 'en'

    const enTitle = findTitleInputForLang(modal, 'en');
    if (enTitle) setReactInputValue(enTitle, blockTitle || '');

    for (let i = 0; i < names.length; i++) {
      const block = await getOrCreateVariantForIndex(modal, i);
      if (!block) continue;
      const enName = findVariantNameInputForLang(block, 'en', active);
      if (enName) setReactInputValue(enName, names[i]);
      await wait(10);
    }
  }

  // ------------------------------
  // МОНТАЖ КНОПОК
  // ------------------------------

  function mountToolbar(modal) {
    if (!modal) return;
    if (modal.querySelector('.vc-toolbar')) return;

    const header = modal.querySelector('.ant-modal-header');
    if (!header) return;

    const bar = document.createElement('div');
    bar.className = 'vc-toolbar';

    const RU = createPopoverButton('RU');
    const EN = createPopoverButton('EN');

    RU.fillBtn.addEventListener('click', async () => {
      const txt = RU.textarea.value.trim();
      if (!txt) return alert('Вставьте данные для RU');
      await fillRU(txt);
      RU.panel.classList.remove('is-open');
    });

    if (RU.copyStandardBtn) {
      RU.copyStandardBtn.addEventListener('click', () => copyStandardParametersToClipboard(RU.copyStandardBtn));
    }

    EN.fillBtn.addEventListener('click', async () => {
      const txt = EN.textarea.value.trim();
      if (!txt) return alert('Вставьте данные для EN');
      await fillEN(txt);
      EN.panel.classList.remove('is-open');
    });

    bar.appendChild(RU.button);
    bar.appendChild(EN.button);
    header.appendChild(bar);

    document.body.appendChild(RU.panel);
    document.body.appendChild(EN.panel);
  }

  const obs = new MutationObserver(() => {
    const modal = findParamModal();
    if (modal) mountToolbar(modal);
    ensureStandardCopyButton();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(() => {
    const modal = findParamModal();
    if (modal) mountToolbar(modal);
    ensureStandardCopyButton();
  }, 500);

  ensureStandardCopyButton();

  function isGreenColor(color) {
    if (!color) return false;
    const normalized = color.replace(/\s+/g, '').toLowerCase();
    return (
      normalized.includes('82,196,26') ||
      normalized.includes('46,204,113') ||
      normalized.includes('43,158,0') ||
      normalized.includes('2ea043') ||
      normalized.includes('#52c41a') ||
      normalized.includes('#2ea043') ||
      normalized.includes('50,205,50')
    );
  }

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest('span, div, p, button');
      if (!el || el.closest('.vc-popover')) return;
      const text = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
      if (!text || !/\d/.test(text)) return;
      const styles = getComputedStyle(el);
      if (!isGreenColor(styles.color) && !isGreenColor(styles.backgroundColor)) return;
      const match = text.replace(/\s+/g, ' ').match(/[+-]?\d[\d\s]*(?:[.,]\d+)?/);
      if (!match) return;
      let value = match[0].replace(/\s+/g, '').replace(',', '.');
      if (value.startsWith('+')) value = value.slice(1);
      if (!value) return;
      copyText(value);
      el.classList.add('vc-modifier-copied');
      setTimeout(() => el.classList.remove('vc-modifier-copied'), 1200);
    },
    true
  );

})();
