// ==UserScript==
// @name         GGSEL Category Explorer
// @description  Компактный омнибокс для поиска и просмотра категорий в админке GGSEL
// @version      1.0.1
// @match        https://back-office.staging.ggsel.com/admin/categories*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      back-office.staging.ggsel.com
// ==/UserScript==

(function() {
    'use strict';

    // --- Константы конфигурации ---
    const HOVER_DELAY_MS = 400;
    const PAGINATION_MAX_PAGES = 10;
    const PREFETCH_VISIBLE_LIMIT = 4;
    const PARALLEL_REQUESTS = 4;
    const LOAD_MORE_LABEL = 'Загрузить ещё результаты';
    const RETRY_COUNT = 2;
    const RETRY_DELAY_MS = 700;
    const REQUEST_TIMEOUT_MS = 15000;
    const LIST_LEAF_MARKER_COLOR = '#8a8a8a';
    const LOG_PREFIX = '[GGSEL Explorer]';

    // --- Вспомогательные функции ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- Утилита логирования ---
    const logger = {
        debug: (...args) => console.debug(LOG_PREFIX, ...args),
        info: (...args) => console.info(LOG_PREFIX, ...args),
        warn: (...args) => console.warn(LOG_PREFIX, ...args),
        error: (...args) => console.error(LOG_PREFIX, ...args),
    };

    // --- Класс для определения типа запроса ---
    class QueryParser {
        // Определяем, состоит ли запрос только из цифр
        static parse(input) {
            const trimmed = input.trim();
            if (!trimmed) {
                return { type: 'empty', value: '' };
            }
            if (/^\d+$/.test(trimmed)) {
                return { type: 'id', value: trimmed };
            }
            return { type: 'q', value: trimmed };
        }
    }

    // --- Построитель URL для поиска ---
    class UrlBuilder {
        // Собираем URL с параметрами поиска
        static buildSearchUrl(baseUrl, queryInfo, page = 1) {
            const url = new URL(baseUrl, location.origin);
            const params = url.searchParams;
            params.set('page', String(page));
            params.set('search[id]', queryInfo.type === 'id' ? queryInfo.value : '');
            params.set('search[q]', queryInfo.type === 'q' ? queryInfo.value : '');
            params.set('search[content_type]', '');
            params.set('search[status]', '');
            params.set('search[created_at][from]', '');
            params.set('search[created_at][to]', '');
            params.set('search[updated_at][from]', '');
            params.set('search[updated_at][to]', '');
            params.set('search[kind]', '');
            params.set('search[ggsel_digi_catalog]', '');
            params.set('commit', '\u0424\u0438\u043b\u044c\u0442\u0440\u043e\u0432\u0430\u0442\u044c');
            return url.toString();
        }
    }

    // --- Реализация очереди запросов с ограничением параллелизма ---
    class Fetcher {
        constructor(maxParallel = PARALLEL_REQUESTS) {
            this.maxParallel = maxParallel;
            this.queue = [];
            this.activeCount = 0;
        }

        // Добавляем задачу в очередь
        enqueue(task) {
            return new Promise((resolve, reject) => {
                const wrappedTask = () => task().then(resolve, reject).finally(() => {
                    this.activeCount--;
                    this._next();
                });
                this.queue.push(wrappedTask);
                logger.debug('Постановка запроса в очередь', { active: this.activeCount, queued: this.queue.length });
                this._next();
            });
        }

        // Вызываем следующий запрос, если есть место
        _next() {
            if (this.activeCount >= this.maxParallel) return;
            const nextTask = this.queue.shift();
            if (!nextTask) return;
            this.activeCount++;
            logger.debug('Старт задачи из очереди', { active: this.activeCount, queued: this.queue.length });
            nextTask();
        }

        // Выполняем HTTP-запрос с таймаутом и повторами
        fetchText(url, options = {}) {
            return this.enqueue(() => this._fetchWithRetry(url, options, RETRY_COUNT));
        }

        async _fetchWithRetry(url, options, retries) {
            for (let attempt = 0; attempt <= retries; attempt++) {
                logger.debug('Выполнение запроса', { url, attempt });
                try {
                    const result = await this._fetchWithTimeout(url, options);
                    logger.debug('Успешный ответ', { url, attempt });
                    return result;
                } catch (err) {
                    logger.warn('Ошибка запроса', { url, attempt, error: err && err.message });
                    if (attempt === retries) throw err;
                    await sleep(RETRY_DELAY_MS * (attempt + 1));
                }
            }
        }

        _fetchWithTimeout(url, options) {
            return new Promise((resolve, reject) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(new Error('timeout'));
                }, REQUEST_TIMEOUT_MS);
                const requestOptions = { ...options, signal: controller.signal, credentials: 'same-origin' };
                fetch(url, requestOptions).then(resp => {
                    clearTimeout(timeoutId);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.text();
                }).then(resolve).catch(err => {
                    clearTimeout(timeoutId);
                    if (typeof GM_xmlhttpRequest === 'function') {
                        logger.warn('Переход на GM_xmlhttpRequest', { url, error: err && err.message });
                        this._fallbackRequest(url, options).then(resolve).catch(reject);
                    } else {
                        logger.error('Запрос не удался', { url, error: err && err.message });
                        reject(err);
                    }
                });
            });
        }

        // Фоллбек через GM_xmlhttpRequest
        _fallbackRequest(url, options) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url,
                    headers: options.headers || {},
                    data: options.body,
                    timeout: REQUEST_TIMEOUT_MS,
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response.responseText);
                        } else {
                            reject(new Error('HTTP ' + response.status));
                        }
                    },
                    onerror: () => reject(new Error('network error')),
                    ontimeout: () => reject(new Error('timeout')),
                    anonymous: false,
                    withCredentials: true,
                });
            });
        }
    }

    const fetcher = new Fetcher();
    const domParser = new DOMParser();

    // --- Простая LRU-кэш ---
    class LRUCache {
        constructor(limit = 100) {
            this.limit = limit;
            this.map = new Map();
        }

        get(key) {
            if (!this.map.has(key)) return undefined;
            const value = this.map.get(key);
            this.map.delete(key);
            this.map.set(key, value);
            return value;
        }

        set(key, value) {
            if (this.map.has(key)) {
                this.map.delete(key);
            }
            this.map.set(key, value);
            if (this.map.size > this.limit) {
                const oldestKey = this.map.keys().next().value;
                this.map.delete(oldestKey);
            }
        }
    }

    const pageCache = new LRUCache(50);
    const statsCache = new LRUCache(100);
    const childrenCache = new LRUCache(100);

    // --- Парсер HTML ---
    const Parser = {
        // Извлекаем список категорий из html страницы списка
        parseListPage(html) {
            const doc = domParser.parseFromString(html, 'text/html');
            const tables = Array.from(doc.querySelectorAll('table'));
            let targetTable = doc.querySelector('table#index_table_categories');
            if (!targetTable) {
                targetTable = tables.find(table => {
                    const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim().toLowerCase());
                    if (!headers.includes('id')) return false;
                    const breadcrumbColumn = headers.find(text => text.includes('путь') || text.includes('название') || text.includes('категория'));
                    if (!breadcrumbColumn) return false;
                    return Array.from(table.querySelectorAll('tbody tr')).some(tr => tr.querySelectorAll('a[href*="/admin/categories/"]').length >= 2);
                }) || null;
            }
            if (!targetTable) {
                logger.warn('Таблица со списком категорий не найдена');
                return { items: [], nextPage: null };
            }

            const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
            const items = [];
            logger.debug('Найдено строк в таблице', rows.length);
            for (const tr of rows) {
                const cells = Array.from(tr.children);
                if (cells.length < 2) continue;
                const idLink = cells[0].querySelector('a[href*="/admin/categories/"]');
                if (!idLink) continue;
                const id = idLink.textContent.trim();
                const nameCell = cells.find((td, idx) => idx > 0 && td.querySelector('a[href*="/admin/categories/"]')) || cells[cells.length - 2] || cells[cells.length - 1] || cells[1] || cells[0];
                const pathCellInfo = cells.slice(1).reduce((best, cell) => {
                    const anchorCount = cell.querySelectorAll('a[href*="/admin/categories/"]').length;
                    if (anchorCount > (best ? best.count : 0)) {
                        return { cell, count: anchorCount };
                    }
                    return best;
                }, null);
                const pathCell = pathCellInfo ? pathCellInfo.cell : nameCell;
                const pathAnchors = Array.from(pathCell.querySelectorAll('a[href*="/admin/categories/"]'));
                let breadcrumbNames = pathAnchors.map(a => a.textContent.trim()).filter(Boolean);
                let pathDepth = breadcrumbNames.length;
                if (!pathDepth) {
                    const rawText = pathCell.textContent || '';
                    const parts = rawText.split(/[›>]/).map(part => part.trim()).filter(Boolean);
                    if (parts.length) {
                        breadcrumbNames = parts;
                        pathDepth = parts.length;
                    }
                }
                if (pathDepth !== 3) {
                    logger.debug('Пропуск строки из-за глубины пути', { id, pathDepth, path: breadcrumbNames });
                    continue;
                }
                const name = breadcrumbNames[breadcrumbNames.length - 1] || (nameCell.textContent || '').trim();
                const href = idLink.getAttribute('href');
                items.push({ id, name, pathDepth, href, pathAnchors: breadcrumbNames });
            }
            logger.info('Распарсено элементов', items.length);
            if (!items.length && rows.length) {
                logger.warn('После фильтрации не осталось строк', { всего: rows.length });
            }

            const pagination = doc.querySelector('ul.pagination');
            let nextPage = null;
            if (pagination) {
                const current = pagination.querySelector('li.active span');
                const currentPage = current ? Number(current.textContent.trim()) : 1;
                const candidates = Array.from(pagination.querySelectorAll('a')).filter(a => {
                    const text = a.textContent.trim().toLowerCase();
                    if (text.includes('след') || text.includes('»')) return true;
                    const num = Number(text);
                    return !Number.isNaN(num) && num === currentPage + 1;
                });
                if (candidates.length) {
                    nextPage = new URL(candidates[0].getAttribute('href'), location.origin).toString();
                    logger.debug('Обнаружена ссылка на следующую страницу', { nextPage });
                }
            }

            return { items, nextPage };
        },

        // Парсим таблицу дочерних категорий
        parseChildren(html) {
            const doc = domParser.parseFromString(html, 'text/html');
            const section = Array.from(doc.querySelectorAll('div.box'))
                .find(box => {
                    const title = box.querySelector('.box-header .box-title, h3');
                    return title && title.textContent.trim().includes('Дочерние категории');
                });
            if (!section) return [];
            const table = section.querySelector('table');
            if (!table) return [];
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            const items = rows.map(tr => {
                const cells = Array.from(tr.children);
                const idLink = cells[0] ? cells[0].querySelector('a[href*="/admin/categories/"]') : null;
                const id = idLink ? idLink.textContent.trim() : (cells[0] ? cells[0].textContent.trim() : '');
                return {
                    id,
                    name: cells[1] ? cells[1].textContent.trim() : '',
                    status: cells[2] ? cells[2].textContent.trim() : '',
                    digi: cells[3] ? cells[3].textContent.trim() : '',
                    kind: cells[4] ? cells[4].textContent.trim() : '',
                    href: idLink ? idLink.getAttribute('href') : null,
                };
            }).filter(item => item.id);
            logger.debug('Распарсены дочерние категории', { count: items.length });
            return items;
        },

        // Парсим статусы/мета из карточки категории
        parseStats(html) {
            const doc = domParser.parseFromString(html, 'text/html');
            const stats = {};
            const infoRows = Array.from(doc.querySelectorAll('.box .box-body .row .col-sm-6, .box .box-body .col-md-6'));
            for (const block of infoRows) {
                const labelEl = block.querySelector('strong, span');
                if (!labelEl) continue;
                const label = labelEl.textContent.trim().toLowerCase();
                const value = block.textContent.replace(labelEl.textContent, '').trim();
                if (label.includes('статус')) stats.status = value;
                if (label.includes('тип') && !stats.kind) stats.kind = value;
                if (label.includes('content type')) stats.contentType = value;
                if (label.includes('digi') || label.includes('catalog')) stats.digi = value;
            }
            const idMatch = doc.querySelector('.content-header h1');
            if (idMatch) {
                const text = idMatch.textContent;
                const id = (text.match(/#(\d+)/) || [])[1];
                if (id) stats.id = id;
            }
            const infoTable = doc.querySelector('table');
            if (infoTable) {
                const rows = Array.from(infoTable.querySelectorAll('tr'));
                for (const tr of rows) {
                    const cells = Array.from(tr.children);
                    if (cells.length < 2) continue;
                    const label = cells[0].textContent.trim().toLowerCase();
                    const value = cells[1].textContent.trim();
                    if (label.includes('создан')) stats.createdAt = value;
                    if (label.includes('обновл')) stats.updatedAt = value;
                }
            }
            if (!stats.status) {
                const statusRow = Array.from(doc.querySelectorAll('td')).find(td => td.textContent.trim().toLowerCase().includes('active'));
                if (statusRow) stats.status = statusRow.textContent.trim();
            }
            logger.debug('Распарсена карточка категории', stats);
            return stats;
        }
    };

    // --- Модель узла категории ---
    class CategoryNode {
        constructor(data, parentId = null) {
            this.id = data.id;
            this.name = data.name;
            this.href = data.href || `/admin/categories/${this.id}`;
            this.parentId = parentId;
            this.children = [];
            this.childrenLoaded = false;
            this.expanded = false;
            this.loading = false;
            this.error = null;
            this.status = data.status || '';
            this.kind = data.kind || '';
            this.digi = data.digi || '';
        }
    }

    const nodesMap = new Map();

    // --- Управление состоянием поиска ---
    const SearchState = {
        queryInfo: null,
        results: [],
        nextPage: null,
        pageCount: 0,
        loading: false,
        error: null,
    };

    // --- Инициализация панели ---
    function initPanel() {
        if (typeof GM_addStyle === 'function') {
            // Добавляем минимальный стиль на хост, чтобы гарантировать корректный stacking
            GM_addStyle('#ggsel-category-explorer{all:initial;}');
        }
        const host = document.createElement('div');
        host.id = 'ggsel-category-explorer';
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host, * { box-sizing: border-box; }
            .panel {
                position: fixed;
                top: 16px;
                right: 16px;
                width: 340px;
                background: rgba(15, 15, 20, 0.92);
                color: #f1f1f1;
                font-family: 'Inter', sans-serif;
                border-radius: 8px;
                box-shadow: 0 12px 30px rgba(0,0,0,0.35);
                z-index: 999999;
                border: 1px solid rgba(255,255,255,0.08);
                overflow: hidden;
            }
            .search-input {
                width: 100%;
                border: none;
                outline: none;
                padding: 10px 12px;
                font-size: 14px;
                color: #f1f1f1;
                background: rgba(255,255,255,0.08);
            }
            .search-input::placeholder {
                color: rgba(255,255,255,0.4);
            }
            .results {
                max-height: 480px;
                overflow-y: auto;
                padding: 4px 0;
            }
            .row {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                font-size: 13px;
                line-height: 1.4;
                cursor: pointer;
                white-space: nowrap;
                text-overflow: ellipsis;
                overflow: hidden;
                position: relative;
                transition: background 0.15s ease;
            }
            .row:hover {
                background: rgba(255,255,255,0.08);
            }
            .row.leaf::before {
                content: '';
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: ${LIST_LEAF_MARKER_COLOR};
                margin-right: 4px;
            }
            .row .marker {
                font-size: 11px;
                width: 16px;
                flex: 0 0 16px;
                text-align: center;
                opacity: 0.7;
            }
            .row .name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .row.loading::after {
                content: '...';
                font-size: 12px;
                margin-left: 4px;
                opacity: 0.6;
            }
            .row.error {
                color: #ffb3b3;
            }
            .empty-state,
            .error-state,
            .loading-state {
                padding: 12px;
                font-size: 13px;
                color: rgba(255,255,255,0.6);
            }
            .load-more {
                text-align: center;
                padding: 8px 12px;
                cursor: pointer;
                font-size: 13px;
                color: #9ac4ff;
            }
            .popover {
                position: fixed;
                background: rgba(20,20,28,0.98);
                color: #fff;
                border-radius: 6px;
                padding: 10px;
                font-size: 12px;
                max-width: 260px;
                box-shadow: 0 8px 20px rgba(0,0,0,0.4);
                pointer-events: none;
                border: 1px solid rgba(255,255,255,0.1);
                z-index: 1000000;
            }
            .popover dl {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 4px 8px;
                margin: 0;
            }
            .popover dt {
                font-weight: 600;
                color: rgba(255,255,255,0.7);
            }
            .popover dd {
                margin: 0;
            }
        `;
        shadow.appendChild(style);

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.innerHTML = `
            <input type="text" class="search-input" placeholder="Искать по ID или по q…" />
            <div class="results"></div>
        `;
        shadow.appendChild(panel);

        const input = panel.querySelector('.search-input');
        const resultsEl = panel.querySelector('.results');

        const ui = new UIPanel(shadow, input, resultsEl);
        ui.init();
    }

    // --- Управление UI ---
    class UIPanel {
        constructor(shadowRoot, inputEl, resultsContainer) {
            this.shadowRoot = shadowRoot;
            this.inputEl = inputEl;
            this.resultsContainer = resultsContainer;
            this.hoverTimer = null;
            this.currentPopover = null;
            this.currentHoverRow = null;
            this.debounceTimer = null;
            this.visibleNodes = [];
        }

        init() {
            this.inputEl.addEventListener('input', () => this._onInput());
            this.inputEl.addEventListener('keydown', (e) => this._onKeyDown(e));
            this.resultsContainer.addEventListener('scroll', () => this._prefetchVisible());
            this.render();
        }

        _onInput() {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.startSearch(this.inputEl.value);
            }, 250);
        }

        _onKeyDown(e) {
            const rows = Array.from(this.resultsContainer.querySelectorAll('.row'));
            if (!rows.length) return;
            const activeIndex = rows.findIndex(row => row.classList.contains('active'));
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextIndex = activeIndex >= 0 ? Math.min(rows.length - 1, activeIndex + 1) : 0;
                this._setActiveRow(rows, nextIndex);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const nextIndex = activeIndex >= 0 ? Math.max(0, activeIndex - 1) : rows.length - 1;
                this._setActiveRow(rows, nextIndex);
            } else if (e.key === 'Enter') {
                if (activeIndex >= 0) {
                    rows[activeIndex].click();
                }
            } else if (e.key === 'ArrowRight') {
                if (activeIndex >= 0) {
                    const row = rows[activeIndex];
                    if (row.dataset.state === 'collapsed') row.click();
                }
            } else if (e.key === 'ArrowLeft') {
                if (activeIndex >= 0) {
                    const row = rows[activeIndex];
                    if (row.dataset.state === 'expanded') row.click();
                }
            }
        }

        _setActiveRow(rows, index) {
            rows.forEach(row => row.classList.remove('active'));
            const target = rows[index];
            if (target) {
                target.classList.add('active');
                target.scrollIntoView({ block: 'nearest' });
            }
        }

        startSearch(query) {
            const info = QueryParser.parse(query);
            if (info.type === 'empty') {
                SearchState.queryInfo = null;
                SearchState.results = [];
                SearchState.nextPage = null;
                SearchState.pageCount = 0;
                SearchState.loading = false;
                SearchState.error = null;
                this.render();
                return;
            }
            logger.info('Новый поиск', { type: info.type, value: info.value });
            SearchState.queryInfo = info;
            SearchState.results = [];
            SearchState.nextPage = null;
            SearchState.pageCount = 0;
            SearchState.loading = true;
            SearchState.error = null;
            nodesMap.clear();
            this.render();
            this._performSearch();
        }

        async _performSearch(loadMore = false) {
            if (!SearchState.queryInfo) return;
            if (loadMore && !SearchState.nextPage) return;

            const baseUrl = '/admin/categories';
            let page = SearchState.pageCount + 1;
            let url = loadMore && SearchState.nextPage ? SearchState.nextPage : UrlBuilder.buildSearchUrl(baseUrl, SearchState.queryInfo, page);
            let pagesFetched = 0;
            const maxPages = loadMore ? 1 : PAGINATION_MAX_PAGES;
            const gathered = [];
            let nextPageUrl = null;

            logger.info('Запуск поиска страниц', { loadMore, startUrl: url, alreadyFetched: SearchState.pageCount });

            try {
                while (url && pagesFetched < maxPages) {
                    const cached = pageCache.get(url);
                    if (cached) {
                        logger.debug('Используем кэш страницы', { url });
                    } else {
                        logger.info('Загрузка страницы поиска', { url });
                    }
                    const html = cached ? cached : await fetcher.fetchText(url);
                    if (!cached) pageCache.set(url, html);
                    const { items, nextPage } = Parser.parseListPage(html);
                    logger.info('Получено элементов со страницы', { url, count: items.length, nextPage });
                    for (const item of items) {
                        if (!nodesMap.has(item.id)) {
                            const node = new CategoryNode(item);
                            nodesMap.set(node.id, node);
                            gathered.push(node);
                        }
                    }
                    nextPageUrl = nextPage;
                    url = nextPage;
                    pagesFetched++;
                }
                SearchState.nextPage = nextPageUrl;
                SearchState.pageCount += pagesFetched;
                SearchState.results = loadMore ? SearchState.results.concat(gathered) : gathered;
                SearchState.loading = false;
                this.render();
                this._prefetchVisible();
                logger.info('Обновление результатов', {
                    total: SearchState.results.length,
                    nextPage: SearchState.nextPage,
                    pagesFetched,
                });
                if (!SearchState.results.length) {
                    logger.warn('Поиск не дал результатов', { query: SearchState.queryInfo, pagesFetched: SearchState.pageCount });
                }
            } catch (err) {
                logger.error('Ошибка поиска', { message: err && err.message, stack: err && err.stack });
                SearchState.error = 'Не удалось загрузить результаты';
                SearchState.loading = false;
                this.render();
            }
        }

        render() {
            const container = this.resultsContainer;
            container.innerHTML = '';
            this.visibleNodes = [];

            if (!SearchState.queryInfo) {
                container.innerHTML = `<div class="empty-state">Введите запрос для поиска категорий.</div>`;
                return;
            }
            if (SearchState.loading && SearchState.results.length === 0) {
                container.innerHTML = `<div class="loading-state">Загрузка...</div>`;
                return;
            }
            if (SearchState.error) {
                container.innerHTML = `<div class="error-state">${SearchState.error}</div>`;
                return;
            }
            if (!SearchState.results.length) {
                container.innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
                return;
            }

            const fragment = document.createDocumentFragment();
            for (const node of SearchState.results) {
                this._renderNode(fragment, node, 0);
            }
            if (SearchState.nextPage) {
                const loadMore = document.createElement('div');
                loadMore.className = 'load-more';
                loadMore.textContent = LOAD_MORE_LABEL;
                loadMore.addEventListener('click', () => {
                    logger.info('Запрос догрузки результатов', { nextPage: SearchState.nextPage });
                    SearchState.loading = true;
                    this.render();
                    this._performSearch(true);
                });
                fragment.appendChild(loadMore);
            }
            container.appendChild(fragment);
        }

        _renderNode(parentFragment, node, depth) {
            const row = document.createElement('div');
            row.className = 'row';
            if (node.error) row.classList.add('error');
            if (node.loading) row.classList.add('loading');
            row.dataset.id = node.id;
            row.dataset.depth = String(depth);
            row.dataset.state = node.expanded ? 'expanded' : (node.childrenLoaded && node.children.length === 0 ? 'leaf' : 'collapsed');
            row.title = new URL(node.href, location.origin).toString();
            row.style.paddingLeft = `${10 + depth * 16}px`;

            if (!node.childrenLoaded) {
                row.classList.add('potential');
            }
            const marker = document.createElement('span');
            marker.className = 'marker';
            if (node.childrenLoaded) {
                marker.textContent = node.children.length ? (node.expanded ? '▼' : '▶') : '•';
            } else {
                marker.textContent = node.expanded ? '▼' : '▶';
            }
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = node.name;

            row.appendChild(marker);
            row.appendChild(nameEl);

            if (row.dataset.state === 'leaf') {
                row.classList.add('leaf');
            }

            row.addEventListener('click', (e) => {
                if (e.button === 1) return;
                this._toggleNode(node, row);
            });
            row.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    window.open(row.title, '_blank');
                }
            });
            row.addEventListener('mouseenter', (e) => this._onRowHoverStart(e, node, row));
            row.addEventListener('mouseleave', () => this._onRowHoverEnd());

            parentFragment.appendChild(row);
            this.visibleNodes.push({ node, row });

            if (node.expanded && node.childrenLoaded && node.children.length) {
                for (const child of node.children) {
                    this._renderNode(parentFragment, child, depth + 1);
                }
            }
        }

        async _toggleNode(node, row) {
            if (node.loading) return;
            if (!node.childrenLoaded) {
                node.loading = true;
                this.render();
                try {
                    logger.info('Загрузка дочерних категорий', { id: node.id });
                    const children = await loadChildren(node.id);
                    logger.debug('Получены дочерние категории', { id: node.id, count: children.length });
                    node.children = children.map(childData => {
                        if (nodesMap.has(childData.id)) {
                            return nodesMap.get(childData.id);
                        }
                        const childNode = new CategoryNode(childData, node.id);
                        nodesMap.set(childNode.id, childNode);
                        return childNode;
                    });
                    node.childrenLoaded = true;
                    node.expanded = true;
                    node.loading = false;
                    if (!node.children.length) {
                        node.expanded = false;
                    }
                } catch (err) {
                    logger.error('Ошибка загрузки дочерних категорий', { id: node.id, error: err && err.message });
                    node.error = 'Не удалось загрузить дочерние';
                    node.loading = false;
                }
                this.render();
                this._prefetchVisible();
            } else {
                node.expanded = !node.expanded;
                logger.debug('Переключение узла', { id: node.id, expanded: node.expanded });
                this.render();
            }
        }

        _onRowHoverStart(event, node, row) {
            this._onRowHoverEnd();
            this.currentHoverRow = row;
            logger.debug('Наведение на строку', { id: node.id });
            this.hoverTimer = setTimeout(async () => {
                try {
                    const stats = await loadStats(node.id);
                    this._showPopover(row, stats);
                } catch (err) {
                    logger.error('Ошибка загрузки статистики', { id: node.id, error: err && err.message });
                    this._showPopover(row, { error: 'Не удалось получить данные' });
                }
            }, HOVER_DELAY_MS);
        }

        _onRowHoverEnd() {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
            this.currentHoverRow = null;
            if (this.currentPopover) {
                this.currentPopover.remove();
                this.currentPopover = null;
            }
        }

        _showPopover(row, stats) {
            if (this.currentHoverRow !== row) return;
            if (this.currentPopover) this.currentPopover.remove();
            const pop = document.createElement('div');
            pop.className = 'popover';
            const fields = [
                ['ID', stats.id || row.dataset.id],
                ['Статус', stats.status || '—'],
                ['Тип', stats.kind || '—'],
                ['Content type', stats.contentType || '—'],
                ['digi_catalog', stats.digi || '—'],
                ['Создано', stats.createdAt || '—'],
                ['Обновлено', stats.updatedAt || '—'],
            ];
            if (stats.error) {
                pop.textContent = stats.error;
            } else {
                const dl = document.createElement('dl');
                for (const [label, value] of fields) {
                    const dt = document.createElement('dt');
                    dt.textContent = label;
                    const dd = document.createElement('dd');
                    dd.textContent = value;
                    dl.appendChild(dt);
                    dl.appendChild(dd);
                }
                pop.appendChild(dl);
            }
            this.shadowRoot.appendChild(pop);
            const rect = row.getBoundingClientRect();
            pop.style.top = `${rect.top + window.scrollY}px`;
            pop.style.left = `${rect.right + 8 + window.scrollX}px`;
            this.currentPopover = pop;
            logger.debug('Показ поповера', { id: stats.id });
        }

        _prefetchVisible() {
            const visible = this.visibleNodes.slice(0, PREFETCH_VISIBLE_LIMIT);
            for (const { node } of visible) {
                if (!statsCache.get(node.id)) {
                    loadStats(node.id).catch(() => {});
                }
                if (node.expanded && node.childrenLoaded) {
                    for (const child of node.children.slice(0, PREFETCH_VISIBLE_LIMIT)) {
                        if (!statsCache.get(child.id)) loadStats(child.id).catch(() => {});
                    }
                }
            }
        }
    }

    // --- Загрузка дочерних категорий ---
    async function loadChildren(categoryId) {
        const cached = childrenCache.get(categoryId);
        if (cached) {
            logger.debug('Дочерние категории из кэша', { id: categoryId });
            return cached;
        }
        logger.debug('Запрос на загрузку дочерних категорий', { id: categoryId });
        const url = `/admin/categories/${categoryId}`;
        const cachedPage = pageCache.get(url);
        if (cachedPage) {
            logger.debug('Карточка категории из кэша', { url });
        } else {
            logger.info('Загрузка карточки категории', { url });
        }
        const html = cachedPage ? cachedPage : await fetcher.fetchText(url);
        if (!cachedPage) pageCache.set(url, html);
        const parsed = Parser.parseChildren(html);
        logger.debug('Распарсено дочерних категорий', { id: categoryId, count: parsed.length });
        childrenCache.set(categoryId, parsed);
        return parsed;
    }

    // --- Загрузка статистики категории ---
    async function loadStats(categoryId) {
        const cached = statsCache.get(categoryId);
        if (cached) {
            logger.debug('Статистика из кэша', { id: categoryId });
            return cached;
        }
        logger.debug('Запрос статистики категории', { id: categoryId });
        const url = `/admin/categories/${categoryId}`;
        const cachedPage = pageCache.get(url);
        if (cachedPage) {
            logger.debug('Карточка для статистики из кэша', { url });
        } else {
            logger.info('Загрузка карточки для статистики', { url });
        }
        const html = cachedPage ? cachedPage : await fetcher.fetchText(url);
        if (!cachedPage) pageCache.set(url, html);
        const stats = Parser.parseStats(html);
        stats.id = stats.id || categoryId;
        logger.debug('Распарсена статистика', stats);
        statsCache.set(categoryId, stats);
        return stats;
    }

    // --- Запуск ---
    initPanel();
})();

