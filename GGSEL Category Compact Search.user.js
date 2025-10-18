// ==UserScript==
// @name         GGSEL Category Compact Search
// @namespace    https://ggsel.com/
// @version      1.0.0
// @description  Сверхкомпактный поиск продуктовых категорий GGSEL с раскрытием дочерних узлов и поповерами статистики.
// @author       OpenAI Assistant
// @match        https://back-office.staging.ggsel.com/admin/categories*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

/*
 * Весь код написан на чистом JavaScript (ES2020+) без сторонних библиотек.
 * Комментарии на русском языке поясняют ключевую логику: парсинг страниц, кэширование, очередь запросов и работу UI.
 */

(function () {
    'use strict';

    // =============================
    // Константы и конфигурация
    // =============================

    const HOVER_DELAY_MS = 400;
    const MAX_PAGES = 10;
    const PREFETCH_CONCURRENCY = 3;
    const PANEL_WIDTH_PX = 380;
    const ROW_HEIGHT_PX = 30;

    const SELECTORS = {
        listTable: 'table.table',
        breadcrumbCell: 'td:last-child',
        listLink: 'a[href^="/admin/categories/"]',
    };

    const STAT_LABELS = {
        id: ['ID', 'Id'],
        status: ['Статус', 'Status'],
        kind: ['Тип', 'Kind'],
        contentType: ['Content type', 'Content Type', 'Контент'],
        digiCatalog: ['digi_catalog', 'Digi catalog', 'Digi_catalog'],
        createdAt: ['Создано', 'Created at', 'Created'],
        updatedAt: ['Обновлено', 'Updated at', 'Updated'],
    };

    const CATEGORY_URL_PREFIX = '/admin/categories/';

    // =============================
    // Утилиты
    // =============================

    /**
     * Удаляет повторяющиеся пробелы и приводит строки к компактному виду.
     */
    function normalizeText(text) {
        return (text || '')
            .replace(/\s+/g, ' ')
            .replace(/\u00a0/g, ' ')
            .trim();
    }

    /**
     * Создаёт задержку (используем в дебаунсах и плавных подкачках).
     */
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Проверяет, что строка состоит только из цифр.
     */
    function isNumericQuery(value) {
        return /^\d+$/.test(value.trim());
    }

    /**
     * Выбирает ближайший элемент по цепочке предыдущих соседей, удовлетворяющий предикату.
     */
    function findPreviousByPredicate(el, predicate, depth = 5) {
        let current = el;
        let steps = depth;
        while (current && steps-- > 0) {
            current = current.previousElementSibling;
            if (current && predicate(current)) {
                return current;
            }
        }
        return null;
    }

    /**
     * Извлекает текстовую метку элемента (включая вложенные элементы).
     */
    function elementText(el) {
        return normalizeText(el ? el.textContent : '');
    }

    // =============================
    // Очередь запросов с ограничением параллельности
    // =============================

    class RequestQueue {
        constructor(limit = 3) {
            this.limit = limit;
            this.active = 0;
            this.queue = [];
        }

        /**
         * Добавляем задачу в очередь; задача – функция, возвращающая промис.
         */
        add(task) {
            return new Promise((resolve, reject) => {
                const wrapped = () => {
                    this.active++;
                    task()
                        .then(resolve)
                        .catch(reject)
                        .finally(() => {
                            this.active--;
                            this._runNext();
                        });
                };
                this.queue.push(wrapped);
                this._runNext();
            });
        }

        _runNext() {
            if (this.active >= this.limit) {
                return;
            }
            const next = this.queue.shift();
            if (next) {
                next();
            }
        }
    }

    // =============================
    // Кэш с LRU-очисткой
    // =============================

    class LRUCache {
        constructor(maxEntries = 100) {
            this.maxEntries = maxEntries;
            this.map = new Map();
        }

        get(key) {
            if (!this.map.has(key)) {
                return undefined;
            }
            const value = this.map.get(key);
            // При каждом обращении обновляем позицию для LRU.
            this.map.delete(key);
            this.map.set(key, value);
            return value;
        }

        set(key, value) {
            if (this.map.has(key)) {
                this.map.delete(key);
            }
            this.map.set(key, value);
            if (this.map.size > this.maxEntries) {
                const oldestKey = this.map.keys().next().value;
                this.map.delete(oldestKey);
            }
        }
    }

    // =============================
    // Fetcher: работа с сетью
    // =============================

    const requestQueue = new RequestQueue(PREFETCH_CONCURRENCY);

    /**
     * Выполняет fetch с таймаутом и повтором.
     */
    async function fetchWithRetry(url, options = {}, retries = 1, timeoutMs = 12000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        if (options.signal) {
            const outerSignal = options.signal;
            if (outerSignal.aborted) {
                clearTimeout(timer);
                throw new DOMException('Aborted', 'AbortError');
            }
            outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
        }
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                credentials: 'same-origin',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response;
        } catch (err) {
            if (retries > 0 && (err.name === 'AbortError' ? options.signal && !options.signal.aborted : true)) {
                console.warn('[GGSEL Compact Search] Ошибка запроса, попытка повтора', url, err);
                await delay(400);
                return fetchWithRetry(url, options, retries - 1, timeoutMs);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Загружает HTML и возвращает документ DOM.
     */
    async function fetchHtml(url, options = {}) {
        return requestQueue.add(async () => {
            const response = await fetchWithRetry(url, options, 1);
            const text = await response.text();
            const parser = new DOMParser();
            return parser.parseFromString(text, 'text/html');
        });
    }

    // =============================
    // Парсер списка категорий (поиск)
    // =============================

    const listCache = new LRUCache(30);

    function parseListPage(doc) {
        const items = [];
        const tables = Array.from(doc.querySelectorAll(SELECTORS.listTable));
        let targetTable = tables.find((table) => {
            const headers = Array.from(table.querySelectorAll('thead th'))
                .map((th) => elementText(th).toLowerCase());
            return headers.includes('id') && headers.some((text) => /катег|category/i.test(text));
        }) || tables[0];

        if (!targetTable) {
            return { items: [], nextUrl: null };
        }

        const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
        for (const row of rows) {
            const link = row.querySelector(`td ${SELECTORS.listLink}`);
            if (!link) {
                continue;
            }
            const href = link.getAttribute('href');
            if (!href || !href.startsWith(CATEGORY_URL_PREFIX)) {
                continue;
            }
            const idText = normalizeText(link.textContent);
            const id = parseInt(idText, 10);
            if (!Number.isFinite(id)) {
                continue;
            }
            const breadcrumbCell = row.querySelector(SELECTORS.breadcrumbCell);
            if (!breadcrumbCell) {
                continue;
            }
            const crumbLinks = Array.from(breadcrumbCell.querySelectorAll(SELECTORS.listLink));
            if (crumbLinks.length !== 3) {
                // Оставляем только продуктовые узлы (ровно три звена в хлебных крошках).
                continue;
            }
            const name = normalizeText(crumbLinks[crumbLinks.length - 1].textContent);
            if (!name) {
                continue;
            }
            items.push({
                id,
                name,
                href,
            });
        }

        // Поиск ссылки на следующую страницу: rel="next" или кнопка с текстом.
        let nextUrl = null;
        const nextLink = doc.querySelector('a[rel="next"]') ||
            Array.from(doc.querySelectorAll('ul.pagination a')).find((a) => /след|next/i.test(elementText(a)));
        if (nextLink) {
            const href = nextLink.getAttribute('href');
            if (href) {
                nextUrl = new URL(href, location.origin).toString();
            }
        }

        return { items, nextUrl };
    }

    async function loadListPage(url, signal) {
        const cached = listCache.get(url);
        if (cached) {
            return cached;
        }
        const doc = await fetchHtml(url, { signal });
        const parsed = parseListPage(doc);
        listCache.set(url, parsed);
        return parsed;
    }

    // =============================
    // Парсер страницы категории (статы и дочерние)
    // =============================

    const categoryCache = new LRUCache(200);

    function extractValueByLabels(doc, labels) {
        const labelSet = labels.map((l) => l.toLowerCase());
        const candidates = Array.from(doc.querySelectorAll('dt, th'));
        for (const labelNode of candidates) {
            const labelText = elementText(labelNode).toLowerCase();
            if (labelSet.some((lbl) => labelText.includes(lbl))) {
                if (labelNode.tagName === 'DT') {
                    const dd = labelNode.nextElementSibling;
                    return normalizeText(dd ? dd.textContent : '');
                }
                if (labelNode.tagName === 'TH') {
                    const td = labelNode.nextElementSibling;
                    return normalizeText(td ? td.textContent : '');
                }
            }
        }
        return '';
    }

    function findChildrenTable(doc) {
        const tables = Array.from(doc.querySelectorAll('table'));
        for (const table of tables) {
            const heading = findPreviousByPredicate(table, (node) => /дочерн/i.test(elementText(node)), 6);
            if (heading) {
                return table;
            }
        }
        return null;
    }

    function parseCategoryPage(doc) {
        const stats = {
            id: extractValueByLabels(doc, STAT_LABELS.id) || '',
            status: extractValueByLabels(doc, STAT_LABELS.status) || '',
            kind: extractValueByLabels(doc, STAT_LABELS.kind) || '',
            contentType: extractValueByLabels(doc, STAT_LABELS.contentType) || '',
            digiCatalog: extractValueByLabels(doc, STAT_LABELS.digiCatalog) || '',
            createdAt: extractValueByLabels(doc, STAT_LABELS.createdAt) || '',
            updatedAt: extractValueByLabels(doc, STAT_LABELS.updatedAt) || '',
        };

        const table = findChildrenTable(doc);
        const children = [];
        if (table) {
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            for (const row of rows) {
                const links = Array.from(row.querySelectorAll(SELECTORS.listLink));
                if (!links.length) {
                    continue;
                }
                const primaryLink = links[0];
                const href = primaryLink.getAttribute('href');
                if (!href || !href.startsWith(CATEGORY_URL_PREFIX)) {
                    continue;
                }
                const hrefId = href.replace(/.*\//, '');
                const idFromHref = parseInt(hrefId, 10);
                const numericLinkText = normalizeText(primaryLink.textContent);
                const id = Number.isFinite(parseInt(numericLinkText, 10))
                    ? parseInt(numericLinkText, 10)
                    : idFromHref;
                const nameLink = links[links.length - 1];
                const name = normalizeText(nameLink.textContent) || `Категория ${id}`;
                const cells = Array.from(row.querySelectorAll('td'));
                const statusCell = cells.find((cell) => /статус|status/i.test(elementText(cell.previousElementSibling || { textContent: '' }))) || null;
                const status = statusCell ? normalizeText(statusCell.textContent) : '';
                const kindCell = cells.find((cell) => /тип|kind/i.test(elementText(cell.previousElementSibling || { textContent: '' }))) || null;
                const kind = kindCell ? normalizeText(kindCell.textContent) : '';
                const digiCell = cells.find((cell) => /digi/i.test(elementText(cell.previousElementSibling || { textContent: '' }))) || null;
                const digiCatalog = digiCell ? normalizeText(digiCell.textContent) : '';

                children.push({
                    id,
                    name,
                    href,
                    status,
                    kind,
                    digiCatalog,
                });
            }
        }

        return { stats, children };
    }

    async function loadCategory(id, href, signal) {
        const cacheKey = String(id);
        const cached = categoryCache.get(cacheKey);
        if (cached && (!signal || !signal.aborted)) {
            return cached;
        }
        const url = new URL(href, location.origin).toString();
        const doc = await fetchHtml(url, { signal });
        const parsed = parseCategoryPage(doc);
        const payload = {
            stats: {
                id: parsed.stats.id || id,
                status: parsed.stats.status,
                kind: parsed.stats.kind,
                contentType: parsed.stats.contentType,
                digiCatalog: parsed.stats.digiCatalog,
                createdAt: parsed.stats.createdAt,
                updatedAt: parsed.stats.updatedAt,
            },
            children: parsed.children,
            isLeaf: parsed.children.length === 0,
            timestamp: Date.now(),
        };
        categoryCache.set(cacheKey, payload);
        return payload;
    }

    // =============================
    // Управление деревом узлов
    // =============================

    const state = {
        nodes: new Map(),
        rootIds: [],
        visibleIds: [],
        expanded: new Set(),
        loadingIds: new Set(),
    };

    function resetState(nodes) {
        state.nodes.clear();
        state.rootIds = [];
        state.visibleIds = [];
        state.expanded.clear();
        state.loadingIds.clear();
        for (const node of nodes) {
            const enriched = {
                ...node,
                level: 0,
                expanded: false,
                isLeaf: false,
                statsLoaded: false,
            };
            state.nodes.set(node.id, enriched);
            state.rootIds.push(node.id);
        }
        state.visibleIds = [...state.rootIds];
    }

    function setChildren(parentId, children) {
        const parent = state.nodes.get(parentId);
        if (!parent) {
            return;
        }
        parent.children = children.map((child) => {
            const existing = state.nodes.get(child.id);
            const enriched = existing || {
                id: child.id,
                name: child.name,
                href: child.href,
                level: parent.level + 1,
                expanded: false,
                isLeaf: false,
                statsLoaded: false,
            };
            enriched.level = parent.level + 1;
            enriched.parentId = parentId;
            enriched.name = child.name;
            enriched.href = child.href;
            state.nodes.set(enriched.id, enriched);
            return enriched.id;
        });
        if (children.length === 0) {
            parent.isLeaf = true;
        }
    }

    function expandNode(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) {
            return;
        }
        if (!state.visibleIds.includes(nodeId)) {
            return;
        }
        const index = state.visibleIds.indexOf(nodeId);
        if (index === -1) {
            return;
        }
        if (!node.children || node.children.length === 0) {
            return;
        }
        const level = node.level + 1;
        const insertion = [];
        for (const childId of node.children) {
            const child = state.nodes.get(childId);
            if (!child) {
                continue;
            }
            child.level = level;
            insertion.push(childId);
        }
        state.visibleIds.splice(index + 1, 0, ...insertion);
        state.expanded.add(nodeId);
        node.expanded = true;
    }

    function collapseNode(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const index = state.visibleIds.indexOf(nodeId);
        if (index === -1) {
            return;
        }
        const removal = [];
        for (let i = index + 1; i < state.visibleIds.length; i++) {
            const currentId = state.visibleIds[i];
            const current = state.nodes.get(currentId);
            if (!current || current.level <= node.level) {
                break;
            }
            removal.push(currentId);
        }
        state.visibleIds = state.visibleIds.filter((id) => !removal.includes(id));
        state.expanded.delete(nodeId);
        node.expanded = false;
    }

    // =============================
    // UI: построение панели, рендер, обработчики
    // =============================

    const ui = {
        shadowRoot: null,
        container: null,
        input: null,
        list: null,
        status: null,
        popover: null,
        lastHoverId: null,
        hoverTimer: null,

        init() {
            const host = document.createElement('div');
            host.id = 'ggsel-compact-panel-host';
            document.body.appendChild(host);
            const shadow = host.attachShadow({ mode: 'open' });
            this.shadowRoot = shadow;

            const style = document.createElement('style');
            style.textContent = `
                :host {
                    all: initial;
                }
                *, *::before, *::after {
                    box-sizing: border-box;
                }
                .panel {
                    font-family: "Inter", "Segoe UI", sans-serif;
                    position: fixed;
                    top: 80px;
                    right: 24px;
                    width: ${PANEL_WIDTH_PX}px;
                    background: rgba(26, 32, 44, 0.96);
                    color: #f7fafc;
                    border-radius: 10px;
                    box-shadow: 0 10px 40px rgba(15, 23, 42, 0.4);
                    padding: 12px;
                    z-index: 999999;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    font-size: 13px;
                }
                .search-input {
                    width: 100%;
                    height: 32px;
                    border-radius: 6px;
                    border: 1px solid rgba(148, 163, 184, 0.4);
                    background: rgba(15, 23, 42, 0.7);
                    color: inherit;
                    padding: 0 8px;
                }
                .search-input:focus {
                    outline: 2px solid rgba(99, 179, 237, 0.8);
                    outline-offset: 1px;
                }
                .status {
                    min-height: 16px;
                    color: rgba(226, 232, 240, 0.8);
                    font-size: 12px;
                }
                .list {
                    max-height: ${ROW_HEIGHT_PX * 8}px;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                .row {
                    position: relative;
                    display: flex;
                    align-items: center;
                    min-height: ${ROW_HEIGHT_PX}px;
                    padding: 0 8px 0 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: background 0.15s ease;
                    color: rgba(226, 232, 240, 0.95);
                }
                .row:hover {
                    background: rgba(99, 179, 237, 0.15);
                }
                .row.leaf {
                    color: rgba(226, 232, 240, 0.65);
                }
                .row::before {
                    content: '';
                    display: block;
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: rgba(99, 179, 237, 0.6);
                    margin-right: 6px;
                }
                .row.leaf::before {
                    background: rgba(148, 163, 184, 0.6);
                }
                .row.expanded::before {
                    background: rgba(56, 189, 248, 0.9);
                }
                .row .name {
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .row .badge {
                    font-size: 11px;
                    color: rgba(148, 163, 184, 0.9);
                    margin-left: 8px;
                }
                .row[data-level] {
                    padding-left: calc(12px + var(--indent, 0px));
                }
                .popover {
                    position: absolute;
                    top: 0;
                    left: 0;
                    transform: translateY(-100%);
                    background: rgba(15, 23, 42, 0.95);
                    border: 1px solid rgba(148, 163, 184, 0.3);
                    border-radius: 6px;
                    padding: 8px 10px;
                    font-size: 12px;
                    line-height: 1.35;
                    min-width: 220px;
                    max-width: 260px;
                    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
                    pointer-events: none;
                    opacity: 0;
                    transition: opacity 0.1s ease;
                }
                .popover.visible {
                    opacity: 1;
                }
                .popover .title {
                    font-weight: 600;
                    margin-bottom: 4px;
                }
                .popover .line {
                    display: flex;
                    justify-content: space-between;
                    gap: 8px;
                }
                .popover .line span:first-child {
                    color: rgba(148, 163, 184, 0.9);
                }
            `;
            shadow.appendChild(style);

            const panel = document.createElement('div');
            panel.className = 'panel';
            panel.innerHTML = `
                <input type="search" class="search-input" placeholder="Поиск категорий (Ctrl/Cmd+K)">
                <div class="status"></div>
                <div class="list"></div>
            `;
            shadow.appendChild(panel);

            this.container = panel;
            this.input = panel.querySelector('.search-input');
            this.list = panel.querySelector('.list');
            this.status = panel.querySelector('.status');

            this.popover = document.createElement('div');
            this.popover.className = 'popover';
            shadow.appendChild(this.popover);
            this.popover.addEventListener('pointerleave', () => {
                this.hidePopover();
            });

            this.input.addEventListener('input', onSearchInputChange);
            this.input.addEventListener('keydown', onInputKeyDown);
            this.list.addEventListener('click', onRowClick);
            this.list.addEventListener('pointerenter', onRowPointerEnter, { capture: true });
            this.list.addEventListener('pointerleave', onRowPointerLeave, { capture: true });

            document.addEventListener('keydown', (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                    event.preventDefault();
                    this.focusSearch();
                }
            });
        },

        focusSearch() {
            this.input.focus();
            this.input.select();
        },

        setStatus(text) {
            this.status.textContent = text || '';
        },

        render() {
            this.list.innerHTML = '';
            for (const id of state.visibleIds) {
                const node = state.nodes.get(id);
                if (!node) {
                    continue;
                }
                const row = document.createElement('div');
                row.className = 'row';
                if (node.isLeaf) {
                    row.classList.add('leaf');
                }
                if (node.expanded) {
                    row.classList.add('expanded');
                }
                row.dataset.id = String(node.id);
                row.dataset.level = String(node.level);
                row.style.setProperty('--indent', `${node.level * 16}px`);
                row.innerHTML = `
                    <span class="name" title="${node.name.replace(/"/g, '&quot;')}">${node.name}</span>
                    ${state.loadingIds.has(node.id) ? '<span class="badge">…</span>' : ''}
                `;
                this.list.appendChild(row);
            }
        },

        showPopover(node, stats, anchorRect) {
            if (!node) {
                return;
            }
            const lines = [];
            const fields = [
                ['ID', stats.id || node.id],
                ['Статус', stats.status || '—'],
                ['Тип', stats.kind || '—'],
                ['Content', stats.contentType || '—'],
                ['Digi catalog', stats.digiCatalog || '—'],
                ['Создано', stats.createdAt || '—'],
                ['Обновлено', stats.updatedAt || '—'],
            ];
            for (const [label, value] of fields) {
                if (!value) {
                    continue;
                }
                lines.push(`<div class="line"><span>${label}</span><span>${value}</span></div>`);
            }
            this.popover.innerHTML = `
                <div class="title">${node.name}</div>
                ${lines.join('')}
            `;
            const panelRect = this.container.getBoundingClientRect();
            const top = anchorRect.top - panelRect.top;
            const left = anchorRect.left - panelRect.left;
            this.popover.style.top = `${top}px`;
            this.popover.style.left = `${left}px`;
            this.popover.classList.add('visible');
        },

        hidePopover() {
            this.popover.classList.remove('visible');
            this.popover.innerHTML = '';
        },
    };

    // =============================
    // Логика поиска и загрузки
    // =============================

    let searchAbortController = null;
    let searchDebounceTimer = null;

    function onSearchInputChange(event) {
        const target = event && event.target;
        const value = target && typeof target.value === 'string' ? target.value : '';
        scheduleSearch(value);
    }

    /**
     * Планирует запуск поиска: либо сразу (по Enter), либо спустя секунду после последнего ввода.
     */
    function scheduleSearch(rawValue, immediate = false) {
        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        clearTimeout(searchDebounceTimer);
        if (!value) {
            if (searchAbortController) {
                searchAbortController.abort();
                searchAbortController = null;
            }
            ui.setStatus('Введите название или ID категории.');
            state.nodes.clear();
            state.visibleIds = [];
            ui.render();
            return;
        }
        if (immediate) {
            void runSearch(value);
            return;
        }
        searchDebounceTimer = setTimeout(() => {
            void runSearch(value);
        }, 1000);
    }

    async function runSearch(value) {
        if (!value) {
            return;
        }
        clearTimeout(searchDebounceTimer);
        if (searchAbortController) {
            searchAbortController.abort();
        }
        searchAbortController = new AbortController();
        const signal = searchAbortController.signal;
        ui.setStatus('Поиск…');
        try {
            const results = await performSearch(value, signal);
            if (signal.aborted) {
                return;
            }
            if (!results.length) {
                ui.setStatus('Ничего не найдено.');
                state.nodes.clear();
                state.visibleIds = [];
                ui.render();
                return;
            }
            resetState(results);
            ui.setStatus(`Найдено: ${results.length}`);
            ui.render();
            prefetchTopNodes(results.slice(0, 5));
        } catch (err) {
            if (err.name === 'AbortError') {
                return;
            }
            console.error('[GGSEL Compact Search] Ошибка поиска', err);
            ui.setStatus('Ошибка при поиске. Проверьте консоль.');
        }
    }

    async function performSearch(value, signal) {
        const results = [];
        const url = new URL('/admin/categories', location.origin);
        if (isNumericQuery(value)) {
            url.searchParams.set('search[id]', value.trim());
        } else {
            url.searchParams.set('search[q]', value.trim());
        }
        let nextUrl = url.toString();
        let page = 0;
        while (nextUrl && page < MAX_PAGES) {
            page += 1;
            const parsed = await loadListPage(nextUrl, signal);
            if (signal.aborted) {
                break;
            }
            results.push(...parsed.items);
            nextUrl = parsed.nextUrl;
        }
        return results;
    }

    async function ensureNodeLoaded(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) {
            return null;
        }
        if (node.children && typeof node.isLeaf === 'boolean') {
            return node;
        }
        state.loadingIds.add(nodeId);
        ui.render();
        try {
            const data = await loadCategory(node.id, node.href, searchAbortController ? searchAbortController.signal : undefined);
            setChildren(node.id, data.children || []);
            if (data.isLeaf) {
                node.isLeaf = true;
            }
            node.statsLoaded = true;
            node.stats = data.stats;
            return node;
        } catch (err) {
            console.error('[GGSEL Compact Search] Не удалось загрузить категорию', nodeId, err);
            return null;
        } finally {
            state.loadingIds.delete(nodeId);
            ui.render();
        }
    }

    async function toggleNode(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) {
            return;
        }
        if (node.expanded) {
            collapseNode(nodeId);
            ui.render();
            return;
        }
        await ensureNodeLoaded(nodeId);
        if (!node.children || node.children.length === 0) {
            node.isLeaf = true;
            ui.render();
            return;
        }
        expandNode(nodeId);
        ui.render();
        prefetchTopNodes(node.children.map((id) => state.nodes.get(id)).filter(Boolean).slice(0, 3));
    }

    function prefetchTopNodes(nodes) {
        for (const node of nodes) {
            if (!node) {
                continue;
            }
            // Мягкий префетч страниц категорий для ускорения первых раскрытий и поповеров.
            loadCategory(node.id, node.href).catch((err) => {
                console.warn('[GGSEL Compact Search] Префетч не удался', node.id, err);
            });
        }
    }

    // =============================
    // Обработчики UI
    // =============================

    function onRowClick(event) {
        const row = event.target.closest('.row');
        if (!row) {
            return;
        }
        const id = parseInt(row.dataset.id, 10);
        if (!Number.isFinite(id)) {
            return;
        }
        toggleNode(id);
    }

    function onRowPointerEnter(event) {
        const row = event.target.closest('.row');
        if (!row) {
            return;
        }
        const id = parseInt(row.dataset.id, 10);
        if (!Number.isFinite(id)) {
            return;
        }
        ui.lastHoverId = id;
        const node = state.nodes.get(id);
        if (!node) {
            return;
        }
        const anchorRect = row.getBoundingClientRect();
        clearTimeout(ui.hoverTimer);
        ui.hoverTimer = setTimeout(async () => {
            if (ui.lastHoverId !== id) {
                return;
            }
            const data = await loadCategory(node.id, node.href).catch(() => null);
            if (!data || ui.lastHoverId !== id) {
                return;
            }
            node.stats = data.stats;
            node.statsLoaded = true;
            ui.showPopover(node, data.stats, anchorRect);
        }, HOVER_DELAY_MS);
    }

    function onRowPointerLeave(event) {
        const related = event.relatedTarget;
        if (related && ui.popover.contains(related)) {
            return;
        }
        clearTimeout(ui.hoverTimer);
        ui.lastHoverId = null;
        ui.hidePopover();
    }

    function onInputKeyDown(event) {
        if (event.key === 'Enter') {
            if (event.target === ui.input) {
                event.preventDefault();
                scheduleSearch(ui.input.value, true);
            }
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        }
    }

    function moveSelection(delta) {
        const rows = Array.from(ui.list.querySelectorAll('.row'));
        if (!rows.length) {
            return;
        }
        let index = rows.findIndex((row) => row.classList.contains('selected'));
        index = Math.max(0, Math.min(rows.length - 1, index + delta));
        rows.forEach((row, idx) => {
            row.classList.toggle('selected', idx === index);
        });
        rows[index].scrollIntoView({ block: 'nearest' });
    }

    // =============================
    // Инициализация скрипта
    // =============================

    function init() {
        if (ui.shadowRoot) {
            return;
        }
        ui.init();
        ui.setStatus('Введите запрос для поиска продуктовых категорий.');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();
