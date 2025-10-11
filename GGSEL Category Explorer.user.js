// ==UserScript==
// @name         GGSEL Category Explorer
// @description  Компактный омнибокс для поиска и просмотра категорий в админке GGSEL
// @version      1.0.7
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
    const LIST_LEAF_MARKER_COLOR = '#a9b0c6';
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

    // --- Форматирование числовых данных для интерфейса ---
    const trimTrailingZeros = (value) => String(value).replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');

    const formatNumber = (num, fractionDigits = 2) => {
        if (num == null || Number.isNaN(Number(num))) return '';
        const fixed = Number(num).toFixed(fractionDigits);
        return trimTrailingZeros(fixed);
    };

    const formatPercent = (value) => {
        if (value == null || Number.isNaN(Number(value))) return null;
        const amount = Number(value);
        const digits = amount >= 10 ? 1 : 2;
        return `${formatNumber(amount, digits)}%`;
    };

    const formatAutoFinish = (hours, rawValue) => {
        if (hours == null || Number.isNaN(Number(hours))) {
            return rawValue || '—';
        }
        const hoursValue = Number(hours);
        const daysValue = hoursValue / 24;
        const hoursText = formatNumber(hoursValue, hoursValue % 1 === 0 ? 0 : 1);
        const daysText = formatNumber(daysValue, daysValue >= 10 ? 1 : 2);
        return `${hoursText} ч · ${daysText} дн.`;
    };

    const getStatusClass = (status) => {
        if (!status) return '';
        const text = status.toLowerCase();
        if (text.includes('active') || text.includes('актив')) return 'status-active';
        if (text.includes('pause') || text.includes('inactive') || text.includes('неактив') || text.includes('останов') || text.includes('disabled')) {
            return 'status-inactive';
        }
        return '';
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
    const pendingChildrenPromises = new Map();

    // --- Парсер HTML ---
    const Parser = {
        // Извлекаем список категорий из html страницы списка
        parseListPage(html) {
            const doc = domParser.parseFromString(html, 'text/html');
            const tables = Array.from(doc.querySelectorAll('table'));
            let targetTable = null;

            // Пытаемся найти таблицу внутри бокса с заголовком «Category» (основной список)
            const categoryBox = Array.from(doc.querySelectorAll('.box'))
                .find(box => {
                    const title = box.querySelector('.box-header .box-title, .box-header h3, h3');
                    if (!title) return false;
                    const text = title.textContent.trim().toLowerCase();
                    return text === 'category' || text.includes('category');
                });
            if (categoryBox) {
                targetTable = categoryBox.querySelector('table');
                logger.debug('Используем таблицу из блока Category', { found: Boolean(targetTable) });
            }

            if (!targetTable) {
                targetTable = doc.querySelector('table#index_table_categories');
            }

            if (!targetTable) {
                targetTable = tables.find(table => {
                    const headerCells = Array.from(table.querySelectorAll('thead th, tr th'));
                    if (!headerCells.length) return false;
                    const headers = headerCells.map(th => th.textContent.trim().toLowerCase());
                    if (!headers.some(text => text === 'id' || text.includes('id'))) return false;
                    const breadcrumbColumn = headers.find(text => text.includes('путь') || text.includes('название') || text.includes('категория'));
                    if (!breadcrumbColumn) return false;
                    return Array.from(table.querySelectorAll('tbody tr, tr'))
                        .some(tr => tr.querySelectorAll('a[href*="/admin/categories/"]').length >= 2);
                }) || null;
            }
            if (!targetTable) {
                logger.warn('Таблица со списком категорий не найдена');
                return { items: [], nextPage: null };
            }

            const allRows = Array.from(targetTable.querySelectorAll('tbody tr'));
            let headerCells = Array.from(targetTable.querySelectorAll('thead th'));
            if (!headerCells.length) {
                const headerRow = Array.from(targetTable.querySelectorAll('tbody tr'))
                    .find(tr => Array.from(tr.children).some(cell => cell.tagName === 'TH'));
                if (headerRow) {
                    headerCells = Array.from(headerRow.children);
                }
            }
            const columnIndex = { status: null, kind: null, digi: null };
            headerCells.forEach((cell, idx) => {
                const text = (cell.textContent || '').trim().toLowerCase();
                if (!text) return;
                if (text.includes('статус') || text.includes('status')) columnIndex.status = idx;
                if (text.includes('kind') || text.includes('тип')) columnIndex.kind = idx;
                if (text.includes('digi') || text.includes('catalog') || text.includes('каталог')) columnIndex.digi = idx;
            });
            let rows = allRows.filter(tr => !tr.querySelector('th'));
            if (!rows.length) {
                const fallbackRows = Array.from(targetTable.querySelectorAll('tr')).filter(tr => !tr.querySelector('th'));
                if (allRows.length) {
                    logger.debug('Все строки оказались заголовками, пробуем использовать все tr без thead', { fallback: fallbackRows.length });
                }
                rows = fallbackRows;
            }
            const items = [];
            logger.debug('Найдено строк в таблице', rows.length);
            if (!rows.length) {
                logger.warn('В таблице не найдено ни одной строки с данными');
            }
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
                if (!pathDepth) {
                    logger.debug('Не удалось определить путь строки', { id, text: pathCell.textContent });
                    continue;
                }
                if (pathDepth !== 3) {
                    logger.debug('Пропуск строки из-за глубины пути', { id, pathDepth, path: breadcrumbNames });
                    continue;
                }
                const pickCellText = (idx, fallbackIdx) => {
                    const targetIdx = typeof idx === 'number' && idx >= 0 ? idx : fallbackIdx;
                    if (typeof targetIdx !== 'number') return '';
                    const cell = cells[targetIdx];
                    return cell ? cell.textContent.trim() : '';
                };
                const status = pickCellText(columnIndex.status, 1);
                const kind = pickCellText(columnIndex.kind, 2);
                const digi = pickCellText(columnIndex.digi, 3);
                const name = breadcrumbNames[breadcrumbNames.length - 1] || (nameCell.textContent || '').trim();
                const href = idLink.getAttribute('href');
                items.push({ id, name, pathDepth, href, pathAnchors: breadcrumbNames, status, kind, digi });
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

            const labelPairs = [];

            const pushPair = (label, value) => {
                const cleanLabel = label.trim();
                const cleanValue = value.trim();
                if (!cleanLabel || !cleanValue) return;
                labelPairs.push({
                    label: cleanLabel.toLowerCase(),
                    value: cleanValue,
                });
            };

            const categoryBox = Array.from(doc.querySelectorAll('div.box'))
                .find(box => {
                    const header = box.querySelector('.box-header .box-title, h3');
                    if (!header) return false;
                    const text = header.textContent.trim().toLowerCase();
                    return text.includes('category') || text.includes('категор');
                });

            const collectFromTables = (scope) => {
                const tables = scope ? scope.querySelectorAll('table') : doc.querySelectorAll('table');
                for (const table of tables) {
                    for (const row of Array.from(table.querySelectorAll('tr'))) {
                        const cells = Array.from(row.children).filter(Boolean);
                        if (cells.length < 2) continue;
                        const labelCell = cells[0];
                        const valueCell = cells[1];
                        if (labelCell.tagName === 'TH' && valueCell.tagName === 'TH') continue;
                        const labelText = labelCell.textContent || '';
                        const valueText = valueCell.textContent || '';
                        if (!labelText.trim() || !valueText.trim()) continue;
                        pushPair(labelText, valueText);
                    }
                }
            };

            const collectDefinitionLists = (scope) => {
                const dls = scope ? scope.querySelectorAll('dl') : doc.querySelectorAll('dl');
                for (const dl of dls) {
                    const dts = Array.from(dl.querySelectorAll('dt'));
                    for (const dt of dts) {
                        const dd = dt.nextElementSibling;
                        if (!dd) continue;
                        pushPair(dt.textContent || '', dd.textContent || '');
                    }
                }
            };

            const collectInfoBlocks = (scope) => {
                const selectors = ['.row .col-sm-6', '.row .col-md-6', '.form-group'];
                for (const selector of selectors) {
                    for (const block of Array.from((scope || doc).querySelectorAll(selector))) {
                        const labelEl = block.querySelector('strong, span, label');
                        if (!labelEl) continue;
                        const labelText = labelEl.textContent || '';
                        const fullText = block.textContent || '';
                        const valueText = fullText.replace(labelText, '').trim();
                        pushPair(labelText, valueText);
                    }
                }
            };

            if (categoryBox) {
                collectFromTables(categoryBox);
                collectDefinitionLists(categoryBox);
                collectInfoBlocks(categoryBox);
            } else {
                collectFromTables(null);
                collectDefinitionLists(null);
                collectInfoBlocks(null);
            }

            const setIfEmpty = (key, value) => {
                if (value == null || value === '') return;
                if (stats[key] == null || stats[key] === '') {
                    stats[key] = value;
                }
            };

            for (const { label, value } of labelPairs) {
                if (label.includes('статус') || label.includes('status')) {
                    setIfEmpty('status', value);
                }
                if ((label.includes('тип') || label.includes('kind')) && !label.includes('контент')) {
                    setIfEmpty('kind', value);
                }
                if (label.includes('content type')) {
                    setIfEmpty('contentType', value);
                }
                if (label.includes('digi') || label.includes('catalog') || label.includes('каталог')) {
                    if (/[\d\-]+/.test(value)) {
                        setIfEmpty('digi', value.replace(/[^\d]/g, ''));
                    } else {
                        setIfEmpty('digi', value);
                    }
                }
                if (label.includes('комис')) {
                    const numeric = parseFloat(value.replace(',', '.'));
                    if (!Number.isNaN(numeric)) {
                        const percent = numeric <= 1 ? numeric * 100 : numeric;
                        stats.commissionPercent = Math.round(percent * 100) / 100;
                    } else {
                        stats.commissionRaw = value;
                    }
                }
                if (label.includes('автозаверш') || label.includes('autofinish') || label.includes('auto finish')) {
                    const numeric = parseFloat(value.replace(',', '.'));
                    if (!Number.isNaN(numeric)) {
                        stats.autoFinishHours = numeric;
                    } else {
                        stats.autoFinishRaw = value;
                    }
                }
                if (label.includes('создан')) {
                    setIfEmpty('createdAt', value);
                }
                if (label.includes('обновл')) {
                    setIfEmpty('updatedAt', value);
                }
                if (label.includes('id') && !stats.id) {
                    const match = value.match(/\d+/);
                    if (match) {
                        stats.id = match[0];
                    }
                }
            }

            const header = doc.querySelector('.content-header h1');
            if (header && !stats.id) {
                const text = header.textContent || '';
                const match = text.match(/#(\d+)/);
                if (match) stats.id = match[1];
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
            this.hasChildren = typeof data.hasChildren === 'boolean' ? data.hasChildren : null;
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
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
            :host, * {
                box-sizing: border-box;
                font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }
            :host {
                color: #e8eaf2;
            }
            .panel {
                --bg:#0e1014;
                --panel:#151824;
                --panel-2:#101320;
                --text:#e8eaf2;
                --muted:#a9b0c6;
                --border:#273046;
                --ring:#8ab4ff;
                --blue:#3B82F6;
                --blue-600:#2563eb;
                --rose:#FB7185;
                --rose-600:#e11d48;
                --accent-danger:#f43f5e;
                --success:#22c55e;
                --warn:#f59e0b;
                --radius:14px;
                --radius-sm:10px;
                --shadow-1:0 6px 24px rgba(0,0,0,.28);
                --shadow-2:0 10px 34px rgba(0,0,0,.34);
                --dur-1:.12s;
                --dur-2:.18s;
                position: fixed;
                top: 16px;
                right: 16px;
                width: 348px;
                padding: 14px 14px 10px;
                background: var(--panel);
                color: var(--text);
                border-radius: var(--radius);
                border: 1px solid var(--border);
                box-shadow: var(--shadow-1);
                display: flex;
                flex-direction: column;
                gap: 6px;
                z-index: 999999;
            }
            .search-input {
                width: 100%;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 11px 14px;
                font-size: 14px;
                color: var(--text);
                background: var(--panel-2);
                transition: border-color var(--dur-1), box-shadow var(--dur-2), background var(--dur-1);
            }
            .search-input::placeholder {
                color: rgba(169,176,198,.65);
            }
            .search-input:focus {
                outline: none;
                border-color: var(--rose);
                box-shadow: 0 0 0 3px rgba(251,113,133,.25);
                background: rgba(21,24,36,.96);
            }
            .results {
                max-height: 520px;
                overflow-y: auto;
                padding: 2px 0 6px;
                margin: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
                scrollbar-width: thin;
                scrollbar-color: rgba(59,130,246,.22) transparent;
            }
            .results::-webkit-scrollbar { width: 8px; }
            .results::-webkit-scrollbar-thumb {
                background: rgba(59,130,246,.22);
                border-radius: 999px;
            }
            .results::-webkit-scrollbar-thumb:hover { background: rgba(59,130,246,.35); }
            .row {
                position: relative;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 7px 12px;
                border-radius: var(--radius-sm);
                border: 1px solid transparent;
                margin: 0 2px;
                font-size: 13px;
                line-height: 1.35;
                cursor: pointer;
                white-space: nowrap;
                text-overflow: ellipsis;
                overflow: hidden;
                color: var(--text);
                transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1), box-shadow var(--dur-2);
            }
            .row:hover,
            .row.active {
                background: rgba(59,130,246,.14);
                border-color: rgba(59,130,246,.35);
                box-shadow: inset 0 0 0 1px rgba(59,130,246,.18);
                color: var(--text);
            }
            .row.leaf::before {
                content: '';
                width: 6px;
                height: 6px;
                border-radius: 999px;
                background: ${LIST_LEAF_MARKER_COLOR};
                opacity: 0.85;
                flex: 0 0 auto;
            }
            .row .marker {
                font-size: 11px;
                width: 18px;
                flex: 0 0 18px;
                text-align: center;
                color: var(--muted);
                opacity: 0.85;
            }
            .row[data-state="expanded"] .marker {
                color: var(--blue);
            }
            .row.potential .marker {
                color: rgba(59,130,246,.75);
            }
            .row.error .marker {
                color: var(--rose);
            }
            .row .name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .row.loading::after {
                content: '…';
                font-size: 12px;
                margin-left: 6px;
                color: var(--muted);
            }
            .row.error {
                color: var(--rose);
                border-color: rgba(251,113,133,.35);
            }
            .empty-state,
            .error-state,
            .loading-state {
                margin: 4px 2px 0;
                padding: 12px 14px;
                border-radius: var(--radius-sm);
                background: var(--panel-2);
                border: 1px solid rgba(39,48,70,.6);
                font-size: 13px;
                color: var(--muted);
            }
            .load-more {
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 6px 2px 2px;
                padding: 10px 12px;
                border-radius: 12px;
                border: 1px solid var(--border);
                color: var(--text);
                background: var(--panel-2);
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: transform var(--dur-1), box-shadow var(--dur-2), background var(--dur-1), border-color var(--dur-1), color var(--dur-1);
            }
            .load-more:hover {
                background: rgba(59,130,246,.14);
                border-color: var(--blue);
                color: var(--blue);
                box-shadow: 0 8px 28px rgba(59,130,246,.20);
                transform: translateY(-1px);
            }
            .load-more:active {
                transform: translateY(1px);
            }
            .popover {
                position: fixed;
                background: linear-gradient(160deg, rgba(10,13,22,.98), rgba(21,24,36,.94));
                color: var(--text);
                border-radius: var(--radius);
                padding: 16px 18px;
                font-size: 12px;
                max-width: 280px;
                box-shadow: var(--shadow-2);
                pointer-events: auto;
                border: 1px solid rgba(39,48,70,.9);
                z-index: 1000000;
                backdrop-filter: blur(10px) saturate(130%);
                user-select: text;
            }
            .popover.status-active {
                border-color: rgba(59,130,246,.55);
                box-shadow: 0 18px 44px rgba(59,130,246,.28);
                background: linear-gradient(165deg, rgba(59,130,246,.26), rgba(10,13,22,.95));
            }
            .popover.status-inactive {
                border-color: rgba(251,113,133,.55);
                box-shadow: 0 18px 44px rgba(251,113,133,.28);
                background: linear-gradient(165deg, rgba(251,113,133,.28), rgba(10,13,22,.95));
            }
            .popover .status-line {
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: .05em;
                margin-bottom: 10px;
                font-size: 11px;
                color: rgba(232,234,242,.88);
            }
            .popover .grid {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 6px 14px;
            }
            .popover .label {
                color: rgba(169,176,198,.85);
                white-space: nowrap;
            }
            .popover .value {
                color: rgba(232,234,242,.96);
                text-align: right;
                font-weight: 600;
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
            this.currentPopoverAnchor = null;
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
            row.dataset.status = node.status || '';
            row.dataset.digi = node.digi || '';
            const isLeaf = node.childrenLoaded ? node.children.length === 0 : node.hasChildren === false;
            row.dataset.state = node.expanded ? 'expanded' : (isLeaf ? 'leaf' : 'collapsed');
            row.title = new URL(node.href, location.origin).toString();
            row.style.paddingLeft = `${10 + depth * 16}px`;

            if (!node.childrenLoaded && node.hasChildren !== false) {
                row.classList.add('potential');
            }
            const marker = document.createElement('span');
            marker.className = 'marker';
            if (node.childrenLoaded) {
                marker.textContent = node.children.length ? (node.expanded ? '▼' : '▶') : '•';
            } else if (node.hasChildren === false) {
                marker.textContent = '•';
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
            row.addEventListener('mouseleave', (e) => this._onRowHoverEnd(e));

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
                            const existing = nodesMap.get(childData.id);
                            existing.parentId = node.id;
                            if (typeof childData.hasChildren === 'boolean') {
                                existing.hasChildren = childData.hasChildren;
                            }
                            if (childData.status) existing.status = childData.status;
                            if (childData.kind) existing.kind = childData.kind;
                            if (childData.digi) existing.digi = childData.digi;
                            return existing;
                        }
                        const childNode = new CategoryNode(childData, node.id);
                        nodesMap.set(childNode.id, childNode);
                        return childNode;
                    });
                    node.childrenLoaded = true;
                    node.hasChildren = node.children.length > 0;
                    node.expanded = true;
                    node.loading = false;
                    if (!node.children.length) {
                        node.expanded = false;
                    }
                    this._ensureChildrenLeafInfo(node);
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
                if (node.expanded && node.childrenLoaded) {
                    this._ensureChildrenLeafInfo(node);
                }
            }
        }

        _ensureChildrenLeafInfo(node) {
            const candidates = node.children.filter(child => child.hasChildren === null);
            if (!candidates.length) return;
            logger.debug('Префетч дочерних уровней', { parentId: node.id, count: candidates.length });
            Promise.allSettled(candidates.map(child => ensureLeafState(child))).then(() => {
                logger.debug('Актуализированы флаги листьев', { parentId: node.id });
                this.render();
            });
        }

        _onRowHoverStart(event, node, row) {
            this._onRowHoverEnd();
            this.currentHoverRow = row;
            logger.debug('Наведение на строку', { id: node.id });
            this.hoverTimer = setTimeout(async () => {
                try {
                    const stats = await loadStats(node.id);
                    this._showPopover(row, node, stats);
                } catch (err) {
                    logger.error('Ошибка загрузки статистики', { id: node.id, error: err && err.message });
                    this._showPopover(row, node, { error: 'Не удалось получить данные' });
                }
            }, HOVER_DELAY_MS);
        }

        _onRowHoverEnd(event) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
            if (event && this.currentPopover) {
                const related = event.relatedTarget;
                if (related && (related === this.currentPopover || this.currentPopover.contains(related))) {
                    this.currentHoverRow = null;
                    return;
                }
            }
            this.currentHoverRow = null;
            this._hidePopover();
        }

        _showPopover(row, node, stats) {
            if (this.currentHoverRow !== row) return;
            this._hidePopover();
            const pop = document.createElement('div');
            pop.className = 'popover';
            if (stats.error) {
                pop.textContent = stats.error;
            } else {
                const effectiveStatus = stats.status || node.status || row.dataset.status || '—';
                const statusClass = getStatusClass(effectiveStatus);
                if (statusClass) pop.classList.add(statusClass);
                const title = document.createElement('div');
                title.className = 'status-line';
                const idText = stats.id || node.id || row.dataset.id;
                title.textContent = `#${idText || '—'} · ${effectiveStatus}`;
                const grid = document.createElement('div');
                grid.className = 'grid';

                const appendRow = (label, value) => {
                    const labelEl = document.createElement('span');
                    labelEl.className = 'label';
                    labelEl.textContent = label;
                    const valueEl = document.createElement('span');
                    valueEl.className = 'value';
                    valueEl.textContent = value;
                    grid.appendChild(labelEl);
                    grid.appendChild(valueEl);
                };

                const digiValue = stats.digi || node.digi || row.dataset.digi || '—';
                const commissionValue = stats.commissionPercent != null
                    ? formatPercent(stats.commissionPercent)
                    : (stats.commissionRaw || '—');
                const autoFinishValue = formatAutoFinish(stats.autoFinishHours, stats.autoFinishRaw);

                appendRow('Каталог', digiValue);
                appendRow('Комиссия', commissionValue || '—');
                appendRow('Автозавершение', autoFinishValue);

                pop.appendChild(title);
                pop.appendChild(grid);
            }
            this.shadowRoot.appendChild(pop);
            const rect = row.getBoundingClientRect();
            const popRect = pop.getBoundingClientRect();
            const verticalCenter = rect.top + rect.height / 2;
            let top = verticalCenter + window.scrollY - popRect.height / 2;
            const minTop = window.scrollY + 8;
            const maxTop = window.scrollY + window.innerHeight - popRect.height - 8;
            if (top < minTop) top = minTop;
            if (top > maxTop) top = Math.max(minTop, maxTop);
            let left = rect.right + 12 + window.scrollX;
            if (left + popRect.width > window.innerWidth - 12) {
                left = rect.left + window.scrollX - popRect.width - 12;
            }
            if (left < 12) {
                left = 12;
            }
            pop.style.top = `${top}px`;
            pop.style.left = `${left}px`;
            pop.addEventListener('mouseleave', (e) => {
                const related = e.relatedTarget;
                if (related && (related === row || row.contains(related))) {
                    return;
                }
                this._hidePopover();
            });
            this.currentPopover = pop;
            this.currentPopoverAnchor = row;
            logger.debug('Показ поповера', { id: stats.id });
        }

        _hidePopover() {
            if (this.currentPopover) {
                this.currentPopover.remove();
                this.currentPopover = null;
                this.currentPopoverAnchor = null;
            }
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
        if (pendingChildrenPromises.has(categoryId)) {
            return pendingChildrenPromises.get(categoryId);
        }
        const cached = childrenCache.get(categoryId);
        if (cached) {
            logger.debug('Дочерние категории из кэша', { id: categoryId });
            return cached;
        }
        const promise = (async () => {
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
            const parsed = Parser.parseChildren(html).map(child => ({ ...child }));
            logger.debug('Распарсено дочерних категорий', { id: categoryId, count: parsed.length });
            childrenCache.set(categoryId, parsed);
            return parsed;
        })();
        pendingChildrenPromises.set(categoryId, promise);
        try {
            const result = await promise;
            return result;
        } finally {
            pendingChildrenPromises.delete(categoryId);
        }
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
        const relatedNode = nodesMap.get(categoryId);
        if (relatedNode) {
            if (stats.status) relatedNode.status = stats.status;
            if (stats.kind) relatedNode.kind = stats.kind;
            if (stats.digi) relatedNode.digi = stats.digi;
        }
        statsCache.set(categoryId, stats);
        return stats;
    }

    // --- Определение, является ли узел листом ---
    async function ensureLeafState(node) {
        if (!node || node.hasChildren !== null) return;
        try {
            const children = await loadChildren(node.id);
            node.hasChildren = children.length > 0;
            logger.debug('Флаг листа обновлён', { id: node.id, hasChildren: node.hasChildren });
        } catch (err) {
            logger.warn('Не удалось определить наличие дочерних', { id: node.id, error: err && err.message });
        }
    }

    // --- Запуск ---
    initPanel();
})();

