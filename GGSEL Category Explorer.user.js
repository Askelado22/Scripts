// ==UserScript==
// @name         GGSEL Category Explorer
// @description  Компактный омнибокс для поиска и просмотра категорий в админке GGSEL
// @version      1.2.14
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
    const INPUT_DEBOUNCE_MS = 1500;
    const WAIT_FOR_TIMEOUT_MS = 6500;
    const WAIT_FOR_INTERVAL_MS = 120;
    const FOCUSED_HIGHLIGHT_MS = 1600;
    const TOAST_HIDE_MS = 4500;
    const LIST_LEAF_HIGHLIGHT_BG = 'rgba(59,130,246,.18)';
    const LIST_LEAF_HIGHLIGHT_BORDER = 'rgba(59,130,246,.38)';
    const SUBLIST_BASE_INDENT = 24;
    const SUBLIST_INDENT_STEP = 14;
    const STORAGE_KEY = 'ggsel-category-explorer:last-state';
    const STORAGE_SCHEMA_VERSION = 1;
    const PANEL_STORAGE_KEY = 'ggsel-category-explorer:panel-placement';
    const PANEL_STORAGE_SCHEMA_VERSION = 1;
    const POPOVER_HIDE_DELAY_MS = 220;
    const EDGE_FLUSH_EPSILON = 2;
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

    const storage = {
        load() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || parsed.version !== STORAGE_SCHEMA_VERSION || typeof parsed.payload !== 'object') {
                    return null;
                }
                return parsed.payload;
            } catch (err) {
                logger.warn('Не удалось прочитать состояние', { error: err && err.message });
                return null;
            }
        },
        save(payload) {
            try {
                if (!payload || !payload.query || !payload.query.trim()) {
                    localStorage.removeItem(STORAGE_KEY);
                    return;
                }
                const data = {
                    version: STORAGE_SCHEMA_VERSION,
                    payload,
                };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            } catch (err) {
                logger.warn('Не удалось сохранить состояние', { error: err && err.message });
            }
        },
        clear() {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (err) {
                logger.warn('Не удалось очистить состояние', { error: err && err.message });
            }
        },
    };

    const panelPlacementStorage = {
        load() {
            try {
                const raw = localStorage.getItem(PANEL_STORAGE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || parsed.version !== PANEL_STORAGE_SCHEMA_VERSION || typeof parsed.payload !== 'object') {
                    return null;
                }
                return parsed.payload;
            } catch (err) {
                logger.warn('Не удалось прочитать позицию панели', { error: err && err.message });
                return null;
            }
        },
        save(payload) {
            if (!payload || typeof payload !== 'object') return;
            try {
                const data = {
                    version: PANEL_STORAGE_SCHEMA_VERSION,
                    payload,
                };
                localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(data));
            } catch (err) {
                logger.warn('Не удалось сохранить позицию панели', { error: err && err.message });
            }
        },
    };

    const PATH_SEPARATOR_RE = /[>›→]/;

    const collapseSpaces = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const normalizeText = (value) => collapseSpaces(value).toLowerCase();

    const parsePathSegments = (rawInput) => {
        if (!rawInput || !PATH_SEPARATOR_RE.test(rawInput)) return null;
        const parts = rawInput
            .split(PATH_SEPARATOR_RE)
            .map(part => collapseSpaces(part))
            .filter(Boolean);
        if (!parts.length) return null;
        if (parts.length && normalizeText(parts[0]) === 'ggsel.net') {
            parts.shift();
        }
        return parts.length >= 2 ? parts : null;
    };

    const waitFor = (conditionFn, { timeout = WAIT_FOR_TIMEOUT_MS, interval = WAIT_FOR_INTERVAL_MS } = {}) => {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const check = () => {
                try {
                    const result = conditionFn();
                    if (result) {
                        resolve(result);
                        return;
                    }
                } catch (err) {
                    logger.debug('waitFor: ошибка проверки условия', { message: err && err.message });
                }
                if (Date.now() - started >= timeout) {
                    reject(new Error('waitFor timeout'));
                    return;
                }
                setTimeout(check, interval);
            };
            check();
        });
    };

    const copyTextToClipboard = async (text) => {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {
            logger.warn('Clipboard API недоступен', { error: err && err.message });
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
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
            logger.error('Не удалось скопировать текст', { error: err && err.message });
        }
        document.body.removeChild(textarea);
        return success;
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
            this.name = (data.name || '').trim();
            this.href = data.href || `/admin/categories/${this.id}`;
            this.parentId = parentId;
            this.children = [];
            this.childrenLoaded = false;
            this.expanded = false;
            this.loading = false;
            this.error = null;
            this.status = data.status || '';
            this.kind = data.kind || '';
            this.digi = (data.digi || '').trim();
            this.hasChildren = typeof data.hasChildren === 'boolean' ? data.hasChildren : null;
            const rawSegments = Array.isArray(data.pathAnchors) && data.pathAnchors.length
                ? data.pathAnchors.slice()
                : (Array.isArray(data.pathSegments) ? data.pathSegments.slice() : []);
            if (!rawSegments.length && this.name) {
                rawSegments.push(this.name);
            }
            if (this.name && rawSegments[rawSegments.length - 1] !== this.name) {
                rawSegments.push(this.name);
            }
            this.pathSegments = rawSegments.filter(Boolean);
        }
    }

    const nodesMap = new Map();

    const getNodePathSegments = (node) => {
        if (!node) return [];
        if (Array.isArray(node.pathSegments) && node.pathSegments.length) {
            return node.pathSegments.slice();
        }
        const chain = [];
        const visited = new Set();
        let current = node;
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            chain.unshift(current.name);
            if (!current.parentId) break;
            current = nodesMap.get(current.parentId);
        }
        return chain.filter(Boolean);
    };

    const updateNodePathFromParent = (node, parentNode) => {
        const parentPath = getNodePathSegments(parentNode);
        const newPath = parentPath.concat(node.name).filter(Boolean);
        node.pathSegments = newPath;
    };

    const upsertChildNode = (childData, parentNode) => {
        let childNode = nodesMap.get(childData.id);
        if (childNode) {
            childNode.name = (childData.name || childNode.name || '').trim();
            childNode.status = childData.status || childNode.status;
            childNode.kind = childData.kind || childNode.kind;
            childNode.digi = (childData.digi || childNode.digi || '').trim();
            if (typeof childData.hasChildren === 'boolean') {
                childNode.hasChildren = childData.hasChildren;
            }
        } else {
            childNode = new CategoryNode(childData, parentNode.id);
            nodesMap.set(childNode.id, childNode);
        }
        childNode.parentId = parentNode.id;
        updateNodePathFromParent(childNode, parentNode);
        return childNode;
    };

    const orderChildrenForDisplay = (children) => {
        if (!Array.isArray(children) || children.length < 2) {
            return Array.isArray(children) ? children : [];
        }
        const categories = [];
        const sections = [];
        for (const child of children) {
            if (!child) continue;
            const isCategory = child.hasChildren !== false || (child.childrenLoaded && child.children.length > 0);
            if (isCategory) {
                categories.push(child);
            } else {
                sections.push(child);
            }
        }
        return categories.concat(sections);
    };

    const applyDisplayOrder = (items) => {
        if (!Array.isArray(items)) {
            return [];
        }
        if (items.length < 2) {
            return items;
        }
        const ordered = orderChildrenForDisplay(items);
        if (ordered.length !== items.length) {
            return ordered;
        }
        for (let index = 0; index < ordered.length; index++) {
            if (ordered[index] !== items[index]) {
                return ordered;
            }
        }
        return items;
    };

    const assignChildrenToNode = (node, childrenData) => {
        const mapped = Array.isArray(childrenData)
            ? childrenData.map(childData => upsertChildNode(childData, node))
            : [];
        const ordered = applyDisplayOrder(mapped);
        node.children = ordered;
        return ordered;
    };

    // --- Управление состоянием поиска ---
    const SearchState = {
        queryInfo: null,
        results: [],
        nextPage: null,
        pageCount: 0,
        loading: false,
        error: null,
    };

    function reorderSiblingsForNode(node) {
        if (!node) return;
        if (node.parentId) {
            const parent = nodesMap.get(node.parentId);
            if (parent && Array.isArray(parent.children) && parent.children.length > 1) {
                const ordered = applyDisplayOrder(parent.children);
                if (ordered !== parent.children) {
                    parent.children = ordered;
                }
            }
        } else if (Array.isArray(SearchState.results) && SearchState.results.length > 1) {
            const orderedRoots = applyDisplayOrder(SearchState.results);
            if (orderedRoots !== SearchState.results) {
                SearchState.results = orderedRoots;
            }
        }
    }

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
                --rose:#f43f5e;
                --rose-600:#e11d48;
                --accent-rose:var(--rose);
                --accent-danger:#f43f5e;
                --success:#22c55e;
                --warn:#f59e0b;
                --radius:14px;
                --radius-sm:10px;
                --row-pad-x:12px;
                --row-pad-y:7px;
                --row-gap:10px;
                --row-min-height:32px;
                --shadow-1:0 6px 24px rgba(0,0,0,.28);
                --shadow-2:0 10px 34px rgba(0,0,0,.34);
                --dur-1:.12s;
                --dur-2:.18s;
                --panel-width: 348px;
                position: fixed;
                top: 0;
                left: 0;
                width: var(--panel-width);
                min-width: var(--panel-width);
                padding: 14px;
                background: var(--panel);
                color: var(--text);
                border-radius: var(--radius);
                border: 1px solid var(--border);
                box-shadow: var(--shadow-1);
                display: flex;
                flex-direction: column;
                gap: 6px;
                z-index: 999999;
                user-select: none;
                -webkit-user-select: none;
                transition: width var(--dur-2), min-width var(--dur-2), padding var(--dur-2), gap var(--dur-2);
            }
            .panel.flush-left { border-top-left-radius: 0; border-bottom-left-radius: 0; }
            .panel.flush-right { border-top-right-radius: 0; border-bottom-right-radius: 0; }
            .panel.flush-top { border-top-left-radius: 0; border-top-right-radius: 0; }
            .panel.flush-bottom { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
            .panel.flush-left.compact { padding-left: 0; }
            .panel.flush-right.compact { padding-right: 0; }
            .panel.flush-top.compact { padding-top: 0; }
            .panel.flush-bottom.compact { padding-bottom: 0; }
            .panel.dragging {
                transition: none !important;
                cursor: grabbing;
            }
            .panel.dragging .search-toggle {
                cursor: grabbing;
            }
            .panel.compact {
                --panel-width: calc(46px + 24px);
                padding: 12px;
                gap: 0;
            }
            .panel.dock-right .search-row {
                justify-content: flex-end;
            }
            .panel.dock-bottom .search-row {
                order: 2;
            }
            .panel.dock-bottom .results {
                order: 1;
            }
            .panel.dock-bottom .toast-stack {
                order: 0;
            }
            .panel.compact .search-row { gap: 0; }
            .panel.compact.dock-left .search-row { justify-content: flex-start; }
            .panel.compact.dock-right .search-row { justify-content: flex-end; }
            .panel.compact:not(.dock-left):not(.dock-right) .search-row { justify-content: center; }
            .panel.compact .search-control {
                width: 46px;
                max-width: 46px;
            }
            .search-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .selection-actions {
                display: none;
                flex: 0 0 auto;
                align-items: center;
                gap: 6px;
            }
            .selection-actions.visible {
                display: flex;
            }
            .search-control {
                position: relative;
                flex: 1 1 auto;
                display: flex;
                align-items: center;
                justify-content: flex-end;
                height: 46px;
                max-width: 100%;
                transition: max-width var(--dur-2), width var(--dur-2);
            }
            .search-control.collapsed {
                flex: 0 0 auto;
                max-width: 46px;
                width: 46px;
            }
            .search-control.expanded {
                width: 100%;
            }
            .search-control.collapsed .search-toggle {
                cursor: pointer;
            }
            .search-control.manual-collapse .search-toggle {
                opacity: 1 !important;
                visibility: visible !important;
                pointer-events: auto !important;
                transform: none !important;
            }
            .search-control.manual-collapse .search-toggle svg {
                transform: none !important;
            }
            .panel.flush-left .search-control.collapsed .search-toggle,
            .panel.flush-left .search-control.manual-collapse .search-toggle {
                border-top-left-radius: 0;
                border-bottom-left-radius: 0;
                padding-left: 4px;
                padding-right: 7px;
            }
            .panel.flush-right .search-control.collapsed .search-toggle,
            .panel.flush-right .search-control.manual-collapse .search-toggle {
                border-top-right-radius: 0;
                border-bottom-right-radius: 0;
                padding-right: 4px;
                padding-left: 7px;
            }
            .panel.flush-top .search-control.collapsed .search-toggle,
            .panel.flush-top .search-control.manual-collapse .search-toggle {
                border-top-left-radius: 0;
                border-top-right-radius: 0;
            }
            .panel.flush-bottom .search-control.collapsed .search-toggle,
            .panel.flush-bottom .search-control.manual-collapse .search-toggle {
                border-bottom-left-radius: 0;
                border-bottom-right-radius: 0;
            }
            .search-toggle {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 10px;
                border-radius: 999px;
                border: 1px solid rgba(244,63,94,.45);
                background: rgba(244,63,94,.18);
                box-shadow: 0 12px 26px rgba(244,63,94,.18);
                transition: border-color var(--dur-1), box-shadow var(--dur-2), background var(--dur-1), transform var(--dur-1), border-radius var(--dur-2), padding var(--dur-2), opacity var(--dur-1);
                z-index: 1;
            }
            .search-control.collapsed .search-toggle:hover {
                border-color: rgba(244,63,94,.6);
                background: rgba(244,63,94,.28);
                box-shadow: 0 16px 32px rgba(244,63,94,.26);
            }
            .search-control.collapsed .search-toggle:active {
                transform: translateY(1px);
            }
            .search-toggle svg {
                display: block;
                width: 32px;
                height: 32px;
                transition: transform var(--dur-1), opacity var(--dur-1);
            }
            .search-control.expanded .search-toggle {
                justify-content: flex-start;
                padding-left: 18px;
                border-radius: var(--radius-sm);
                background: rgba(244,63,94,.2);
                border-color: rgba(244,63,94,.55);
                box-shadow: 0 18px 44px rgba(244,63,94,.28);
                cursor: default;
                pointer-events: none;
            }
            .search-control.expanded .search-toggle svg {
                transform: translateX(-6px) scale(0.9);
            }
            .search-control.has-value .search-toggle {
                opacity: 0;
                pointer-events: none;
                visibility: hidden;
                transform: scale(0.7);
            }
            .search-control.has-value .search-toggle svg {
                transform: translateX(-6px) scale(0.72);
            }
            .panel.dock-right .search-control.expanded .search-toggle {
                justify-content: flex-end;
                padding-left: 14px;
                padding-right: 18px;
            }
            .panel.dock-right .search-control.expanded .search-toggle svg {
                transform: translateX(6px) scale(0.9);
            }
            .panel.dock-right .search-control.has-value .search-toggle svg {
                transform: translateX(6px) scale(0.72);
            }
            .selection-button {
                background: rgba(21,24,36,.92);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 9px 12px;
                font-size: 12px;
                font-weight: 600;
                color: var(--text);
                cursor: pointer;
                transition: transform var(--dur-1), box-shadow var(--dur-2), background var(--dur-1), border-color var(--dur-1), color var(--dur-1);
                white-space: nowrap;
            }
            .selection-button:hover {
                background: rgba(59,130,246,.14);
                border-color: rgba(59,130,246,.45);
                color: #cfe0ff;
                box-shadow: 0 8px 18px rgba(59,130,246,.18);
                transform: translateY(-1px);
            }
            .selection-button:active {
                transform: translateY(1px);
            }
            .search-input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 11px 14px 11px 58px;
                font-size: 14px;
                color: var(--text);
                background: var(--panel-2);
                transition: border-color var(--dur-1), box-shadow var(--dur-2), background var(--dur-1), opacity var(--dur-2), transform var(--dur-2);
                user-select: text;
                -webkit-user-select: text;
                opacity: 0;
                pointer-events: none;
                transform: translateX(12px) scaleX(0.82);
                z-index: 2;
            }
            .panel.dock-right .search-input {
                padding: 11px 58px 11px 14px;
                transform: translateX(-12px) scaleX(0.82);
            }
            .search-input::placeholder {
                color: rgba(169,176,198,.65);
            }
            .search-input:focus {
                outline: none;
                border-color: var(--rose);
                box-shadow: 0 0 0 3px rgba(244,63,94,.25);
                background: rgba(21,24,36,.96);
            }
            .search-control.collapsed .search-input {
                border-width: 0;
            }
            .search-control.expanded .search-input {
                opacity: 1;
                border-width: 1px;
                pointer-events: auto;
                transform: none;
            }
            .search-control.has-value .search-input {
                padding-left: 18px;
            }
            .panel.dock-right .search-control.has-value .search-input {
                padding-right: 18px;
                padding-left: 14px;
            }
            .results {
                max-height: 520px;
                overflow-y: auto;
                padding: 2px 6px 6px 0;
                margin: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
                scrollbar-width: thin;
                scrollbar-color: rgba(59,130,246,.22) transparent;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
                user-select: none;
                -webkit-user-select: none;
            }
            .results[hidden] {
                display: none !important;
                padding: 0;
                margin: 0;
                max-height: 0;
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
                gap: var(--row-gap);
                padding: 0 var(--row-pad-x);
                border-radius: var(--radius-sm);
                border: 1px solid transparent;
                margin: 0 2px;
                font-size: 13px;
                line-height: 1.35;
                cursor: pointer;
                color: var(--text);
                transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1), box-shadow var(--dur-2);
                height: var(--row-min-height);
                min-height: var(--row-min-height);
                overflow: hidden;
                user-select: none;
                -webkit-user-select: none;
            }
            .row:hover,
            .row.active {
                background: rgba(244,63,94,.12);
                border-color: rgba(244,63,94,.32);
                box-shadow: inset 0 0 0 1px rgba(244,63,94,.2);
                color: var(--text);
            }
            .row .digi-badge {
                flex: 0 0 auto;
                font-weight: 650;
                font-size: 12px;
                letter-spacing: .01em;
                color: #e0f2ff;
                background: rgba(59,130,246,.16);
                border: 1px solid rgba(59,130,246,.45);
                border-radius: 8px;
                padding: 4px 12px;
                white-space: nowrap;
            }
            .row .name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .row[data-has-children="true"]:not(.leaf),
            .row[data-has-children="unknown"]:not(.leaf) {
                border-color: rgba(39,48,70,.85);
            }
            .row[data-has-children="true"][data-state="expanded"],
            .row[data-has-children="unknown"][data-state="expanded"] {
                border-color: transparent;
            }
            .row.potential {
                border-color: rgba(59,130,246,.22);
            }
            .row.loading::after {
                content: '…';
                font-size: 12px;
                margin-left: 6px;
                color: var(--muted);
            }
            .sublist {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 2px;
                margin: 0 0 0 var(--sublist-indent, 15px);
                padding: 0 0 0 var(--row-pad-x);
                border-left: 2px solid rgba(244,63,94,.45);
                contain: content;
            }
            .sublist > .row {
                margin: 0;
                padding: 0 var(--row-pad-x);
                height: var(--row-min-height);
                min-height: var(--row-min-height);
            }
            .row.leaf {
                background: ${LIST_LEAF_HIGHLIGHT_BG};
                border-color: ${LIST_LEAF_HIGHLIGHT_BORDER};
                color: #dbeafe;
                cursor: default;
            }
            .row.leaf .digi-badge {
                background: rgba(59,130,246,.16);
                border-color: rgba(59,130,246,.45);
                color: #e0f2ff;
            }
            .row.leaf:hover {
                background: ${LIST_LEAF_HIGHLIGHT_BG};
                color: #e8f1ff;
                box-shadow: inset 0 0 0 1px rgba(59,130,246,.2);
            }
            .row.gce-selected {
                background: rgba(244,63,94,.22);
                border-color: rgba(244,63,94,.45);
                box-shadow: inset 0 0 0 1px rgba(244,63,94,.3);
            }
            .row.gce-selected:hover {
                background: rgba(244,63,94,.28);
                border-color: rgba(244,63,94,.55);
                box-shadow: inset 0 0 0 1px rgba(244,63,94,.35);
            }
            .row.gce-selected .digi-badge {
                background: rgba(244,63,94,.2);
                border-color: rgba(244,63,94,.45);
                color: #ffe1e6;
            }
            .row.gce-focused {
                box-shadow: 0 0 0 2px rgba(244,63,94,.35);
            }
            .row[data-has-children="false"] {
                cursor: default;
            }
            .row.error {
                color: var(--rose);
                border-color: rgba(244,63,94,.35);
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
            .toast-stack {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin: 4px 2px 0;
            }
            .toast-stack[hidden] {
                display: none !important;
                margin: 0;
            }
            .toast {
                background: rgba(21,24,36,.94);
                border: 1px solid rgba(39,48,70,.85);
                border-radius: var(--radius-sm);
                padding: 10px 12px;
                font-size: 12px;
                color: var(--text);
                box-shadow: var(--shadow-1);
                opacity: 0;
                transform: translateY(-6px);
                transition: opacity var(--dur-2), transform var(--dur-2);
            }
            .toast.show {
                opacity: 1;
                transform: translateY(0);
            }
            .toast--info {
                border-color: rgba(59,130,246,.38);
                background: rgba(59,130,246,.18);
                color: #dbeafe;
            }
            .toast--error {
                border-color: rgba(244,63,94,.55);
                background: rgba(244,63,94,.18);
                color: #ffe1e6;
            }
            .toast--success {
                border-color: rgba(34,197,94,.45);
                background: rgba(34,197,94,.18);
                color: #dcfce7;
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
                border-color: rgba(244,63,94,.55);
                box-shadow: 0 18px 44px rgba(244,63,94,.28);
                background: linear-gradient(165deg, rgba(244,63,94,.28), rgba(10,13,22,.95));
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
            <div class="search-row">
                <div class="selection-actions" hidden>
                    <button type="button" class="selection-button selection-copy-digi">DIGI</button>
                    <button type="button" class="selection-button selection-copy-paths">Пути</button>
                </div>
                <div class="search-control collapsed" data-expanded="false">
                    <button type="button" class="search-toggle" aria-label="Открыть поиск" aria-expanded="false">
                        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="28" viewBox="0 0 512 512" role="img" focusable="false" aria-hidden="true">
                          <path d="M335.646 261.389C339.197 264.491 342.607 267.725 346 270.999 346.717 271.664 347.433 272.329 348.172 273.014 376.736 300.208 396.087 345.642 398.203 384.753 398.475 406.812 391.943 425.548 376.813 441.75 362.672 455.15 346.392 460.797 327.105 460.488 317.286 459.986 308.026 456.722 298.699 453.82 265.762 443.81 231.982 447.549 199.766 458.055 186.081 462.114 170.109 461.616 157 456 156.124 455.638 155.247 455.276 154.344 454.903 147.778 451.914 142.408 447.731 137 443.001 136.384 442.48 135.768 441.959 135.133 441.423 121.299 428.8 114.512 409.772 113.615 391.449 112.526 348.022 135.879 303.221 164.676 272.111 210.651 224.472 284.467 218.197 335.646 261.389Z" fill="var(--accent-rose)"></path>
                          <path d="M335.646 261.389C339.197 264.491 342.607 267.725 346 270.999 346.717 271.664 347.433 272.329 348.172 273.014 376.736 300.208 396.087 345.642 398.203 384.753 398.475 406.812 391.943 425.548 376.813 441.75 362.672 455.15 346.392 460.797 327.105 460.488 317.286 459.986 308.026 456.722 298.699 453.82 265.762 443.81 231.982 447.549 199.766 458.055 186.081 462.114 170.109 461.616 157 456 156.124 455.638 155.247 455.276 154.344 454.903 147.778 451.914 142.408 447.731 137 443.001 136.384 442.48 135.768 441.959 135.133 441.423 121.299 428.8 114.512 409.772 113.615 391.449 112.526 348.022 135.879 303.221 164.676 272.111 210.651 224.472 284.467 218.197 335.646 261.389ZM185 298C162.824 322.881 144.807 359.764 146.551 393.695 147.488 404.561 152.268 412.612 160.137 420.008 166.936 425.679 173.381 428.389 182.314 428.274 187.886 427.705 193.17 425.837 198.5 424.187 234.578 413.466 274.771 411.565 310.828 423.594 321.788 427.249 331.488 430.445 342.813 426.098 352.076 421.45 359.221 413.61 363.438 404.188 368.292 389.035 364.648 372.703 360 358 359.754 357.213 359.507 356.426 359.254 355.615 348.604 322.479 328.198 291.269 296.911 274.6 257.083 254.313 214.677 266.672 185 298Z" fill="var(--accent-rose)"></path>
                          <path d="M361.5 60.195C380.356 73.807 390.96 94.885 394.664 117.575 398.505 145.291 394.336 174.527 377.5 197.496 368.434 209.204 355.938 218.66 341 221 323.408 222.118 309.501 218.427 295.875 206.813 278.073 190.098 269.612 165.414 268.816 141.399 268.307 116.033 274.044 88.986 292 70 310.795 50.46 338.208 45.189 361.5 60.195Z" fill="var(--accent-rose)"></path>
                          <path d="M206.125 58.688C225.594 71.168 235.867 91.04 241 113 246.731 139.925 242.426 169.441 228 193 225.256 196.948 222.305 200.513 219 204 218.314 204.727 217.629 205.454 216.922 206.203 206.071 216.732 192.428 221.44 177.579 221.364 162.512 220.997 149.335 213.769 139 203 121.191 182.769 114.945 156.045 116.106 129.573 117.662 105.248 126.015 82.397 143.687 65.188 161.551 49.836 185.648 47.326 206.125 58.688Z" fill="var(--accent-rose)"></path>
                          <path d="M473.313 187.313C486.541 197.329 494.128 210.59 497 227 497.941 241.365 497.79 255.337 493 269 492.638 270.059 492.276 271.118 491.903 272.21 485.205 289.873 472.599 304.295 455.672 312.64 444.023 317.632 430.404 319.377 418.222 314.964 405.381 309.39 394.619 300.353 389.237 287.125 380.796 264.519 381.831 240.644 391.653 218.653 399.582 202.085 412.857 188.882 430 182 444.752 177.595 460.343 178.679 473.313 187.313Z" fill="var(--accent-rose)"></path>
                          <path d="M92.688 187.188C111.369 200.012 123.292 218.972 127.589 241.21 130.707 262.343 127.566 282.182 115.04 299.75 108.695 307.487 98.416 315.045 88.301 316.821 69.151 318.317 54.465 313.979 39.637 301.447 25.559 288.391 16.089 269.174 14.796 249.959 14.698 246.679 14.679 243.408 14.688 240.127 14.672 239.033 14.656 237.938 14.64 236.811 14.63 220.332 20.041 205.104 31.625 193.187 48.877 177.325 72.512 175.074 92.688 187.188Z" fill="var(--accent-rose)"></path>
                          <path d="M183 84C193.454 87.49 198.716 94.229 203.75 103.688 209.156 114.918 210.258 124.808 210.375 137.125 210.389 138.222 210.403 139.319 210.418 140.449 210.374 147.738 209.287 154.087 207 161 206.71 161.878 206.42 162.755 206.122 163.66 202.484 174.178 195.956 182.855 186 188 181.065 189.645 176.819 189.625 172.063 187.5 160.032 180.765 154.186 168.281 150.508 155.477 146.224 134.587 148.482 114.136 160 96 162.551 92.478 164.959 90.08 168.625 87.75 169.401 87.25 170.177 86.75 170.977 86.234 174.997 83.782 178.348 83.334 183 84Z" fill="var(--accent-rose)"></path>
                          <path d="M338.102 84.734C349.405 89.898 355.594 100.899 360 112 364.974 126.424 365.113 145.685 360 160 359.637 161.026 359.273 162.052 358.899 163.109 354.797 173.747 348.473 183.184 338.062 188.5 331.723 189.535 326.825 188.844 321.312 185.438 310.276 177.358 304.303 163.18 302 150 300.775 129.13 301.676 109.386 315.375 92.438 321.587 85.976 329.101 81.59 338.102 84.734Z" fill="var(--accent-rose)"></path>
                          <path d="M453.063 213C458.753 216.874 462.631 222.584 464.523 229.207 466.972 243.558 464.795 257.273 456.625 269.5 451.697 275.911 447.031 281.724 439 284 434.011 284.575 429.681 284.841 425.125 282.563 417.168 272.968 414.981 262.393 415.762 250.121 417.174 237.557 423.429 225.478 433.125 217.438 439.447 212.58 445.179 210.426 453.063 213Z" fill="var(--accent-rose)"></path>
                          <path d="M70.25 212.719C80.574 217.044 86.966 224.215 91.519 234.399 96.441 247.022 98.641 259.863 93.137 272.727 90.648 277.705 88.454 281.911 83 284 76.468 284.925 71.292 284.555 65.903 280.599 65.275 280.071 64.647 279.544 64 279.001 62.981 278.164 62.981 278.164 61.941 277.31 52.695 268.938 47.661 256.644 46.719 244.329 46.473 234.148 47.415 225.134 54 217 59.222 212.399 63.207 210.469 70.25 212.719Z" fill="var(--accent-rose)"></path>
                        </svg>
                    </button>
                    <input type="text" class="search-input" placeholder="Искать по ID или по q…" />
                </div>
            </div>
            <div class="results"></div>
            <div class="toast-stack" aria-live="polite"></div>
        `;
        shadow.appendChild(panel);

        const searchControlEl = panel.querySelector('.search-control');
        const searchToggleEl = panel.querySelector('.search-toggle');
        const input = panel.querySelector('.search-input');
        const resultsEl = panel.querySelector('.results');
        const selectionActionsEl = panel.querySelector('.selection-actions');
        const copyDigiBtn = panel.querySelector('.selection-copy-digi');
        const copyPathsBtn = panel.querySelector('.selection-copy-paths');
        const toastStackEl = panel.querySelector('.toast-stack');

        const ui = new UIPanel(shadow, panel, input, resultsEl, selectionActionsEl, copyDigiBtn, copyPathsBtn, toastStackEl, searchControlEl, searchToggleEl);
        ui.init();
    }

    // --- Управление UI ---
    class UIPanel {
        constructor(shadowRoot, panelEl, inputEl, resultsContainer, selectionActionsEl, copyDigiBtn, copyPathsBtn, toastStackEl, searchControlEl, searchToggleEl) {
            this.shadowRoot = shadowRoot;
            this.panelEl = panelEl;
            this.inputEl = inputEl;
            this.resultsContainer = resultsContainer;
            this.selectionActionsEl = selectionActionsEl;
            this.copyDigiBtn = copyDigiBtn;
            this.copyPathsBtn = copyPathsBtn;
            this.toastStackEl = toastStackEl;
            this.searchControlEl = searchControlEl;
            this.searchToggleEl = searchToggleEl;
            this.panelPlacement = this._loadPanelPlacement() || this._getDefaultPanelPlacement();
            this.hoverTimer = null;
            this.currentPopover = null;
            this.currentPopoverAnchor = null;
            this.currentHoverRow = null;
            this.popoverHideTimer = null;
            this.debounceTimer = null;
            this.visibleNodes = [];
            this.selectedIds = new Set();
            this.lastFocusedId = null;
            this.navigationInProgress = false;
            this.pendingRestoreState = null;
            this.persistTimer = null;
            this.restoring = false;
            this.collapseTimer = null;
            this._manualCollapsed = false;
            this._hiddenDueToCollapse = { results: false, toasts: false };
            if (this.resultsContainer) {
                this.resultsContainer.hidden = true;
            }
            if (this.toastStackEl) {
                this.toastStackEl.hidden = true;
            }
            this._applyPanelPosition();
            this._updatePanelLayout();
        }

        init() {
            this.inputEl.addEventListener('input', () => this._onInput());
            this.inputEl.addEventListener('keydown', (e) => this._onKeyDown(e));
            this.inputEl.addEventListener('focus', () => this._onInputFocus());
            this.inputEl.addEventListener('blur', () => this._onInputBlur());
            if (this.searchToggleEl) {
                this.searchToggleEl.addEventListener('click', () => this._onSearchToggleClick());
            }
            this.resultsContainer.addEventListener('scroll', () => {
                this._prefetchVisible();
                this._schedulePersist();
            });
            this.copyDigiBtn.addEventListener('click', () => this._copySelectedDigis());
            this.copyPathsBtn.addEventListener('click', () => this._copySelectedPaths());
            window.addEventListener('keydown', (e) => this._onGlobalKeyDown(e));
            this._setupDragHandles();
            this._onWindowResize = () => {
                this._applyPanelPosition({ persist: true });
            };
            window.addEventListener('resize', this._onWindowResize);
            this._setupScrollIsolation();
            this._updateSearchAffordance();
            this.render();
            this._restoreState().catch((err) => {
                logger.warn('Не удалось восстановить состояние', { error: err && err.message });
            });
        }

        _schedulePersist(immediate = false) {
            if (this.restoring && !immediate) {
                return;
            }
            if (this.persistTimer) {
                clearTimeout(this.persistTimer);
                this.persistTimer = null;
            }
            if (immediate) {
                this._persistState();
                return;
            }
            this.persistTimer = setTimeout(() => {
                this.persistTimer = null;
                this._persistState();
            }, 160);
        }

        _persistState() {
            if (this.restoring) return;
            const query = this.inputEl ? this.inputEl.value || '' : '';
            if (!query.trim()) {
                storage.clear();
                return;
            }
            const expandedNodes = [];
            for (const node of nodesMap.values()) {
                if (node && node.expanded) {
                    const depth = getNodePathSegments(node).length;
                    expandedNodes.push({ id: node.id, depth });
                }
            }
            expandedNodes.sort((a, b) => {
                if (a.depth !== b.depth) return a.depth - b.depth;
                return String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
            });
            const expandedIds = expandedNodes.map((item) => item.id);
            const payload = {
                query,
                selectedIds: Array.from(this.selectedIds),
                expandedIds,
                lastFocusedId: this.lastFocusedId || null,
                scrollTop: this.resultsContainer ? this.resultsContainer.scrollTop : 0,
            };
            storage.save(payload);
        }

        async _restoreState() {
            const saved = storage.load();
            if (!saved || !saved.query || !saved.query.trim()) {
                return;
            }
            this.restoring = true;
            this.pendingRestoreState = {
                expandedIds: Array.isArray(saved.expandedIds) ? saved.expandedIds.slice() : [],
                selectedIds: Array.isArray(saved.selectedIds) ? saved.selectedIds.slice() : [],
                lastFocusedId: saved.lastFocusedId || null,
                scrollTop: typeof saved.scrollTop === 'number' ? saved.scrollTop : 0,
            };
            this.selectedIds = new Set(this.pendingRestoreState.selectedIds);
            this.lastFocusedId = this.pendingRestoreState.lastFocusedId;
            if (this.inputEl) {
                this.inputEl.value = saved.query;
                this._updateSearchAffordance();
            }
            const result = this.startSearch(saved.query, { preserveSelection: true });
            if (result && typeof result.then === 'function') {
                await result;
            }
            await this._applyPendingRestore();
            this.restoring = false;
            this._schedulePersist(true);
        }

        async _applyPendingRestore() {
            const state = this.pendingRestoreState;
            if (!state) {
                this._updateSelectionUI();
                return;
            }
            const uniqueExpanded = Array.from(new Set(state.expandedIds || []));
            const idsWithDepth = uniqueExpanded
                .map((id) => {
                    const node = nodesMap.get(id);
                    if (!node) return null;
                    const depth = getNodePathSegments(node).length;
                    return { id, depth };
                })
                .filter(Boolean)
                .sort((a, b) => {
                    if (a.depth !== b.depth) return a.depth - b.depth;
                    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
                });
            let needsRender = false;
            for (const { id } of idsWithDepth) {
                const node = nodesMap.get(id);
                if (!node || node.hasChildren === false) continue;
                if (!node.childrenLoaded) {
                    const expanded = await this._loadChildrenForNode(node, { expand: true });
                    if (expanded) {
                        needsRender = true;
                    }
                } else if (!node.expanded) {
                    node.expanded = true;
                    needsRender = true;
                    this._ensureChildrenLeafInfo(node);
                }
            }
            if (needsRender) {
                this.render();
            } else {
                this._updateSelectionUI();
            }
            this.selectedIds = new Set(state.selectedIds || []);
            this.lastFocusedId = state.lastFocusedId;
            this._updateSelectionUI();
            if (this.resultsContainer && typeof state.scrollTop === 'number') {
                this.resultsContainer.scrollTop = state.scrollTop;
            }
            this.pendingRestoreState = null;
        }

        _setupScrollIsolation() {
            const container = this.resultsContainer;
            if (!container) return;
            const lineMode = typeof WheelEvent !== 'undefined' ? WheelEvent.DOM_DELTA_LINE : 1;
            const pageMode = typeof WheelEvent !== 'undefined' ? WheelEvent.DOM_DELTA_PAGE : 2;
            const toPixels = (delta, mode) => {
                if (mode === lineMode) return delta * 16;
                if (mode === pageMode) return delta * container.clientHeight;
                return delta;
            };
            const onWheel = (event) => {
                event.stopPropagation();
                if (event.cancelable) {
                    event.preventDefault();
                }
                const deltaY = toPixels(event.deltaY, event.deltaMode);
                const deltaX = toPixels(event.deltaX, event.deltaMode);
                if (deltaY) container.scrollTop += deltaY;
                if (deltaX) container.scrollLeft += deltaX;
            };
            container.addEventListener('wheel', onWheel, { passive: false });

            let lastTouchY = null;
            let lastTouchX = null;
            container.addEventListener('touchstart', (event) => {
                if (event.touches.length === 1) {
                    const touch = event.touches[0];
                    lastTouchY = touch.clientY;
                    lastTouchX = touch.clientX;
                }
            }, { passive: true });
            container.addEventListener('touchmove', (event) => {
                if (event.touches.length === 1) {
                    const touch = event.touches[0];
                    const deltaY = lastTouchY != null ? lastTouchY - touch.clientY : 0;
                    const deltaX = lastTouchX != null ? lastTouchX - touch.clientX : 0;
                    lastTouchY = touch.clientY;
                    lastTouchX = touch.clientX;
                    container.scrollTop += deltaY;
                    container.scrollLeft += deltaX;
                    event.stopPropagation();
                    if (event.cancelable) {
                        event.preventDefault();
                    }
                }
            }, { passive: false });
        }

        _getDefaultPanelPlacement() {
            return {
                anchorX: 'right',
                anchorY: 'top',
                offsetX: 16,
                offsetY: 16,
            };
        }

        _loadPanelPlacement() {
            const saved = panelPlacementStorage.load();
            if (!saved) return null;
            const anchorX = saved.anchorX === 'left' ? 'left' : 'right';
            const anchorY = saved.anchorY === 'bottom' ? 'bottom' : 'top';
            const offsetX = Number.isFinite(saved.offsetX) ? Math.max(0, Number(saved.offsetX)) : 16;
            const offsetY = Number.isFinite(saved.offsetY) ? Math.max(0, Number(saved.offsetY)) : 16;
            return { anchorX, anchorY, offsetX, offsetY };
        }

        _savePanelPlacement() {
            if (!this.panelPlacement) return;
            panelPlacementStorage.save({
                anchorX: this.panelPlacement.anchorX,
                anchorY: this.panelPlacement.anchorY,
                offsetX: this.panelPlacement.offsetX,
                offsetY: this.panelPlacement.offsetY,
            });
        }

        _applyPanelPosition({ persist = false } = {}) {
            if (!this.panelEl) return;
            if (!this.panelPlacement) {
                this.panelPlacement = this._getDefaultPanelPlacement();
            }
            const placement = this.panelPlacement;
            const rect = this.panelEl.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            const maxOffsetX = Math.max(0, Math.round(viewportWidth - width));
            const maxOffsetY = Math.max(0, Math.round(viewportHeight - height));
            let offsetX = Math.min(Math.max(Math.round(placement.offsetX), 0), maxOffsetX);
            let offsetY = Math.min(Math.max(Math.round(placement.offsetY), 0), maxOffsetY);
            if (!Number.isFinite(offsetX)) offsetX = 0;
            if (!Number.isFinite(offsetY)) offsetY = 0;
            if (placement.anchorX === 'left') {
                this.panelEl.style.left = `${offsetX}px`;
                this.panelEl.style.right = 'auto';
            } else {
                this.panelEl.style.left = 'auto';
                this.panelEl.style.right = `${offsetX}px`;
            }
            if (placement.anchorY === 'top') {
                this.panelEl.style.top = `${offsetY}px`;
                this.panelEl.style.bottom = 'auto';
            } else {
                this.panelEl.style.top = 'auto';
                this.panelEl.style.bottom = `${offsetY}px`;
            }
            this.panelEl.classList.toggle('dock-left', placement.anchorX === 'left');
            this.panelEl.classList.toggle('dock-right', placement.anchorX === 'right');
            this.panelEl.classList.toggle('dock-top', placement.anchorY === 'top');
            this.panelEl.classList.toggle('dock-bottom', placement.anchorY === 'bottom');
            const flushLeft = placement.anchorX === 'left' && offsetX <= EDGE_FLUSH_EPSILON;
            const flushRight = placement.anchorX === 'right' && offsetX <= EDGE_FLUSH_EPSILON;
            const flushTop = placement.anchorY === 'top' && offsetY <= EDGE_FLUSH_EPSILON;
            const flushBottom = placement.anchorY === 'bottom' && offsetY <= EDGE_FLUSH_EPSILON;
            this.panelEl.classList.toggle('flush-left', flushLeft);
            this.panelEl.classList.toggle('flush-right', flushRight);
            this.panelEl.classList.toggle('flush-top', flushTop);
            this.panelEl.classList.toggle('flush-bottom', flushBottom);
            const nextPlacement = {
                anchorX: placement.anchorX,
                anchorY: placement.anchorY,
                offsetX,
                offsetY,
            };
            this.panelPlacement = nextPlacement;
            if (persist) {
                this._savePanelPlacement();
            }
        }

        _setupDragHandles() {
            if (!this.searchToggleEl || !this.panelEl) return;
            this._dragState = null;
            const onPointerDown = (event) => {
                if (event.button !== 0) return;
                if (!(event.ctrlKey && event.altKey)) return;
                const rect = this.panelEl.getBoundingClientRect();
                this._dragState = {
                    pointerId: event.pointerId,
                    offsetX: event.clientX - rect.left,
                    offsetY: event.clientY - rect.top,
                };
                this.panelEl.classList.add('dragging');
                try {
                    this.panelEl.setPointerCapture(event.pointerId);
                } catch (err) {
                    logger.debug('Не удалось зафиксировать указатель', { message: err && err.message });
                }
                event.preventDefault();
            };
            const onPointerMove = (event) => {
                if (!this._dragState || event.pointerId !== this._dragState.pointerId) return;
                const rect = this.panelEl.getBoundingClientRect();
                const width = rect.width;
                const height = rect.height;
                const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                let nextLeft = event.clientX - this._dragState.offsetX;
                let nextTop = event.clientY - this._dragState.offsetY;
                const maxLeft = Math.max(0, viewportWidth - width);
                const maxTop = Math.max(0, viewportHeight - height);
                nextLeft = Math.min(Math.max(nextLeft, 0), maxLeft);
                nextTop = Math.min(Math.max(nextTop, 0), maxTop);
                this.panelEl.style.left = `${nextLeft}px`;
                this.panelEl.style.top = `${nextTop}px`;
                this.panelEl.style.right = 'auto';
                this.panelEl.style.bottom = 'auto';
            };
            const finalizeDrag = (event) => {
                if (!this._dragState || (event && event.pointerId !== this._dragState.pointerId)) return;
                const rect = this.panelEl.getBoundingClientRect();
                const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                const distLeft = rect.left;
                const distRight = viewportWidth - rect.right;
                const distTop = rect.top;
                const distBottom = viewportHeight - rect.bottom;
                const anchorX = distLeft <= distRight ? 'left' : 'right';
                const anchorY = distTop <= distBottom ? 'top' : 'bottom';
                const offsetX = anchorX === 'left' ? Math.max(0, Math.round(distLeft)) : Math.max(0, Math.round(distRight));
                const offsetY = anchorY === 'top' ? Math.max(0, Math.round(distTop)) : Math.max(0, Math.round(distBottom));
                this.panelPlacement = { anchorX, anchorY, offsetX, offsetY };
                this._applyPanelPosition({ persist: true });
                if (event && typeof event.pointerId === 'number') {
                    try {
                        this.panelEl.releasePointerCapture(event.pointerId);
                    } catch (err) {
                        logger.debug('Не удалось отпустить указатель', { message: err && err.message });
                    }
                }
                this.panelEl.classList.remove('dragging');
                this._dragState = null;
            };
            this.searchToggleEl.addEventListener('pointerdown', onPointerDown);
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', finalizeDrag);
            window.addEventListener('pointercancel', finalizeDrag);
        }

        _onInput() {
            this._updateSearchAffordance();
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this._handleInputValue(this.inputEl.value);
            }, INPUT_DEBOUNCE_MS);
        }

        _onInputFocus() {
            if (this.collapseTimer) {
                clearTimeout(this.collapseTimer);
                this.collapseTimer = null;
            }
            this._setSearchExpanded(true);
        }

        _onInputBlur() {
            if (this.collapseTimer) {
                clearTimeout(this.collapseTimer);
            }
            this.collapseTimer = setTimeout(() => {
                this.collapseTimer = null;
                const value = this.inputEl ? this.inputEl.value : '';
                if (!value || !value.trim()) {
                    this._setSearchExpanded(false);
                }
            }, 60);
        }

        _onSearchToggleClick() {
            const isExpanded = this._isSearchExpanded();
            if (!isExpanded) {
                this._setSearchExpanded(true, { focus: true });
                return;
            }
            if (this.inputEl) {
                this.inputEl.focus();
                if (!this.inputEl.value || !this.inputEl.value.trim()) {
                    this.inputEl.select();
                }
            }
        }

        _collapseSearchToFab({ preserveQuery = true } = {}) {
            if (!this.searchControlEl) return;
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
            }
            if (this.resultsContainer && !this.resultsContainer.hidden && this.resultsContainer.childElementCount > 0) {
                this.resultsContainer.hidden = true;
                this._hiddenDueToCollapse.results = true;
            }
            if (this.toastStackEl && !this.toastStackEl.hidden && this.toastStackEl.childElementCount > 0) {
                this.toastStackEl.hidden = true;
                this._hiddenDueToCollapse.toasts = true;
            }
            if (!preserveQuery && this.inputEl) {
                this.inputEl.value = '';
            }
            if (this.inputEl) {
                this.inputEl.blur();
            }
            this._setSearchExpanded(false, { manual: true });
            if (!preserveQuery) {
                this._updateSearchAffordance();
            }
        }

        _isSearchExpanded() {
            if (!this.searchControlEl) return true;
            return this.searchControlEl.classList.contains('expanded');
        }

        _setSearchExpanded(expanded, { focus = false, manual = false } = {}) {
            if (!this.searchControlEl) return;
            this.searchControlEl.classList.toggle('expanded', expanded);
            this.searchControlEl.classList.toggle('collapsed', !expanded);
            this.searchControlEl.dataset.expanded = expanded ? 'true' : 'false';
            if (this.searchToggleEl) {
                this.searchToggleEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            }
            if (expanded) {
                this._manualCollapsed = false;
                this.searchControlEl.classList.remove('manual-collapse');
                if (this._hiddenDueToCollapse.results && this.resultsContainer && this.resultsContainer.childElementCount > 0) {
                    this.resultsContainer.hidden = false;
                }
                if (this._hiddenDueToCollapse.toasts && this.toastStackEl && this.toastStackEl.childElementCount > 0) {
                    this.toastStackEl.hidden = false;
                }
                this._hiddenDueToCollapse.results = false;
                this._hiddenDueToCollapse.toasts = false;
            } else {
                if (manual) {
                    this._manualCollapsed = true;
                    this.searchControlEl.classList.add('manual-collapse');
                } else {
                    this._manualCollapsed = false;
                    this.searchControlEl.classList.remove('manual-collapse');
                }
            }
            if (expanded && focus && this.inputEl) {
                requestAnimationFrame(() => {
                    this.inputEl.focus();
                    this.inputEl.select();
                });
            }
            this._updatePanelLayout();
        }

        _updateSearchAffordance() {
            if (!this.searchControlEl) return;
            const value = this.inputEl ? this.inputEl.value : '';
            const hasValue = Boolean(value && value.trim().length > 0);
            const activeElement = this.shadowRoot ? this.shadowRoot.activeElement : null;
            const isFocused = this.inputEl && activeElement === this.inputEl;
            this.searchControlEl.classList.toggle('has-value', hasValue);
            if (this._manualCollapsed && !isFocused) {
                return;
            }
            this._setSearchExpanded(hasValue || isFocused);
        }

        async _handleInputValue(rawValue) {
            if (this.navigationInProgress) return;
            const pathSegments = parsePathSegments(rawValue);
            if (pathSegments) {
                this.navigationInProgress = true;
                try {
                    await this._followPath(pathSegments);
                } catch (err) {
                    logger.error('Ошибка автонавигации', { error: err && err.message });
                } finally {
                    this.navigationInProgress = false;
                }
                return;
            }
            this.startSearch(rawValue);
        }

        _onKeyDown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (this._isSearchExpanded()) {
                    this._collapseSearchToFab();
                } else if (this.inputEl) {
                    this.inputEl.blur();
                }
                return;
            }
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

        startSearch(query, { preserveSelection = false } = {}) {
            const info = QueryParser.parse(query);
            if (info.type === 'empty') {
                SearchState.queryInfo = null;
                SearchState.results = [];
                SearchState.nextPage = null;
                SearchState.pageCount = 0;
                SearchState.loading = false;
                SearchState.error = null;
                nodesMap.clear();
                if (!preserveSelection) {
                    this._clearSelection();
                    this.lastFocusedId = null;
                }
                this.render();
                this._schedulePersist(true);
                return Promise.resolve();
            }
            logger.info('Новый поиск', { type: info.type, value: info.value });
            SearchState.queryInfo = info;
            SearchState.results = [];
            SearchState.nextPage = null;
            SearchState.pageCount = 0;
            SearchState.loading = true;
            SearchState.error = null;
            nodesMap.clear();
            if (!preserveSelection) {
                this._clearSelection();
                this.lastFocusedId = null;
            }
            this.render();
            this._schedulePersist();
            return this._performSearch();
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
                const combined = loadMore ? SearchState.results.concat(gathered) : gathered;
                SearchState.results = applyDisplayOrder(combined);
                SearchState.loading = false;
                this.render();
                this._prefetchVisible();
                this._schedulePersist();
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
                this._schedulePersist();
            }
        }

        render() {
            const container = this.resultsContainer;
            container.innerHTML = '';
            this.visibleNodes = [];
            this._setResultsVisibility(false);

            if (!SearchState.queryInfo) {
                this._updateSelectionUI();
                return;
            }
            if (SearchState.loading && SearchState.results.length === 0) {
                container.innerHTML = `<div class="loading-state">Загрузка...</div>`;
                this._setResultsVisibility(true);
                this._updateSelectionUI();
                return;
            }
            if (SearchState.error) {
                container.innerHTML = `<div class="error-state">${SearchState.error}</div>`;
                this._setResultsVisibility(true);
                this._updateSelectionUI();
                return;
            }
            if (!SearchState.results.length) {
                container.innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
                this._setResultsVisibility(true);
                this._updateSelectionUI();
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
            this._setResultsVisibility(true);
            this._updateSelectionUI();
        }

        _setResultsVisibility(visible) {
            if (!this.resultsContainer) return;
            this.resultsContainer.hidden = !visible;
            this._updatePanelLayout();
        }

        _updatePanelLayout() {
            if (!this.panelEl) return;
            const expanded = this._isSearchExpanded();
            const hasResults = this.resultsContainer && !this.resultsContainer.hidden && this.resultsContainer.childElementCount > 0;
            const selectionVisible = this.selectionActionsEl && this.selectionActionsEl.classList && this.selectionActionsEl.classList.contains('visible');
            const hasToasts = this.toastStackEl && !this.toastStackEl.hidden && this.toastStackEl.childElementCount > 0;
            const shouldCompact = !expanded && !selectionVisible && !hasResults && !hasToasts;
            this.panelEl.classList.toggle('compact', shouldCompact);
            this._applyPanelPosition();
        }

        _renderNode(parentContainer, node, depth) {
            const row = document.createElement('div');
            row.className = 'row';
            row.classList.add('CATologies-acc-row');
            if (node.error) row.classList.add('error');
            if (node.loading) row.classList.add('loading');
            row.dataset.id = node.id;
            row.dataset.depth = String(depth);
            row.dataset.status = node.status || '';
            row.dataset.digi = node.digi || '';
            row.dataset.name = node.name;
            row.dataset.parentId = node.parentId || 'root';
            const hasChildrenKnown = node.childrenLoaded ? node.children.length > 0 : (node.hasChildren === false ? false : null);
            const isLeaf = node.childrenLoaded ? node.children.length === 0 : node.hasChildren === false;
            row.dataset.state = node.expanded ? 'expanded' : (isLeaf ? 'leaf' : 'collapsed');
            row.dataset.hasChildren = isLeaf ? 'false' : (hasChildrenKnown ? 'true' : 'unknown');
            if (row.dataset.hasChildren === 'false') {
                row.classList.add('CATologies-type-section');
            } else {
                row.classList.add('CATologies-type-category');
            }
            const nodeHref = new URL(node.href, location.origin).toString();
            row.dataset.href = nodeHref;
            const pathTitle = this._buildPathForNode(node);
            row.title = pathTitle;
            row.style.paddingLeft = 'var(--row-pad-x)';

            if (!node.childrenLoaded && node.hasChildren !== false) {
                row.classList.add('potential');
            }
            const digiBadge = document.createElement('span');
            digiBadge.className = 'digi-badge';
            digiBadge.textContent = node.digi ? node.digi : '—';
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = node.name;

            row.appendChild(digiBadge);
            row.appendChild(nameEl);

            if (row.dataset.state === 'leaf') {
                row.classList.add('leaf');
            }

            if (this.selectedIds.has(node.id)) {
                row.classList.add('gce-selected');
            }

            row.addEventListener('click', (e) => {
                if (e.button === 1) return;
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._toggleSelection(node, row);
                    return;
                }
                if (e.shiftKey) {
                    e.preventDefault();
                    this._selectRange(node, row);
                    return;
                }
                this._handlePrimaryClick(node, row);
            });
            row.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    window.open(row.dataset.href || nodeHref, '_blank');
                }
            });
            row.addEventListener('mouseenter', (e) => this._onRowHoverStart(e, node, row));
            row.addEventListener('mouseleave', (e) => this._onRowHoverEnd(e));

            parentContainer.appendChild(row);
            this.visibleNodes.push({ node, row });

            if (node.expanded && node.childrenLoaded && node.children.length) {
                const sublist = document.createElement('div');
                sublist.className = 'sublist CATologies-acc-sublist';
                sublist.dataset.parentId = node.id;
                sublist.dataset.depth = String(depth + 1);
                const indent = SUBLIST_BASE_INDENT + depth * SUBLIST_INDENT_STEP;
                sublist.style.setProperty('--sublist-indent', `${indent}px`);
                parentContainer.appendChild(sublist);
                for (const child of node.children) {
                    this._renderNode(sublist, child, depth + 1);
                }
            }
        }

        async _toggleNode(node, row) {
            if (node.loading) return;
            if (node.childrenLoaded && node.children.length === 0) {
                node.hasChildren = false;
                reorderSiblingsForNode(node);
            }
            if (node.hasChildren === false && node.childrenLoaded) {
                logger.debug('Игнорируем клик по листу', { id: node.id });
                return;
            }
            if (!node.childrenLoaded) {
                const hasChildren = await this._loadChildrenForNode(node, { expand: true });
                if (!hasChildren) {
                    logger.debug('Узел оказался листом после загрузки', { id: node.id });
                    return;
                }
            } else if (!node.children.length) {
                node.hasChildren = false;
                node.expanded = false;
                reorderSiblingsForNode(node);
                this.render();
                this._schedulePersist();
                return;
            } else {
                node.expanded = !node.expanded;
                logger.debug('Переключение узла', { id: node.id, expanded: node.expanded });
                this.render();
                if (node.expanded) {
                    this._ensureChildrenLeafInfo(node);
                }
                this._schedulePersist();
            }
        }

        _handlePrimaryClick(node, row) {
            this.lastFocusedId = node.id;
            if (row.dataset.hasChildren === 'false') {
                return;
            }
            this._toggleNode(node, row);
        }

        _toggleSelection(node, row) {
            if (this.selectedIds.has(node.id)) {
                this.selectedIds.delete(node.id);
                row.classList.remove('gce-selected');
            } else {
                this.selectedIds.add(node.id);
                row.classList.add('gce-selected');
            }
            this.lastFocusedId = node.id;
            this._updateSelectionUI();
            this._schedulePersist();
        }

        _selectRange(node, row) {
            if (!this.lastFocusedId || this.lastFocusedId === node.id) {
                this._toggleSelection(node, row);
                return;
            }
            const parentKey = row.dataset.parentId || 'root';
            const depth = row.dataset.depth;
            const siblings = Array.from(this.resultsContainer.querySelectorAll(`.row[data-parent-id="${parentKey}"][data-depth="${depth}"]`));
            const currentIndex = siblings.indexOf(row);
            const anchorRow = siblings.find(r => r.dataset.id === this.lastFocusedId);
            if (currentIndex === -1 || !anchorRow) {
                this._toggleSelection(node, row);
                return;
            }
            const anchorIndex = siblings.indexOf(anchorRow);
            const [start, end] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
            this.selectedIds.clear();
            for (let i = start; i <= end; i++) {
                const siblingRow = siblings[i];
                if (!siblingRow) continue;
                siblingRow.classList.add('gce-selected');
                this.selectedIds.add(siblingRow.dataset.id);
            }
            for (const otherRow of Array.from(this.resultsContainer.querySelectorAll('.row.gce-selected'))) {
                if (!this.selectedIds.has(otherRow.dataset.id)) {
                    otherRow.classList.remove('gce-selected');
                }
            }
            this.lastFocusedId = node.id;
            this._updateSelectionUI();
            this._schedulePersist();
        }

        _clearSelection() {
            if (!this.selectedIds.size) return;
            this.selectedIds.clear();
            for (const row of Array.from(this.resultsContainer.querySelectorAll('.row.gce-selected'))) {
                row.classList.remove('gce-selected');
            }
            this._updateSelectionUI();
            this._schedulePersist();
        }

        _updateSelectionUI() {
            if (this.selectionActionsEl) {
                if (this.selectedIds.size > 0) {
                    this.selectionActionsEl.hidden = false;
                    this.selectionActionsEl.classList.add('visible');
                } else {
                    this.selectionActionsEl.hidden = true;
                    this.selectionActionsEl.classList.remove('visible');
                }
            }
            this._updatePanelLayout();
        }

        async _copySelectedDigis() {
            if (!this.selectedIds.size) return;
            const lines = [];
            for (const id of this.selectedIds) {
                const node = nodesMap.get(id);
                if (!node) continue;
                lines.push((node.digi || '').trim());
            }
            if (!lines.length) {
                this._showToast('Нет выбранных элементов для копирования DIGI', 'error');
                return;
            }
            const text = lines.join('\n');
            const success = await copyTextToClipboard(text);
            this._showToast(success ? 'DIGI скопированы' : 'Не удалось скопировать DIGI', success ? 'success' : 'error');
        }

        async _copySelectedPaths() {
            if (!this.selectedIds.size) return;
            const lines = [];
            for (const id of this.selectedIds) {
                const node = nodesMap.get(id);
                if (!node) continue;
                lines.push(this._buildPathForNode(node));
            }
            if (!lines.length) {
                this._showToast('Нет путей для копирования', 'error');
                return;
            }
            const success = await copyTextToClipboard(lines.join('\n'));
            this._showToast(success ? 'Пути скопированы' : 'Не удалось скопировать пути', success ? 'success' : 'error');
        }

        _buildPathForNode(node) {
            const segments = getNodePathSegments(node).map(part => collapseSpaces(part)).filter(Boolean);
            if (segments.length && normalizeText(segments[0]) === 'ggsel.net') {
                segments.shift();
            }
            if (!segments.length) {
                segments.push(node.name);
            }
            return segments.join(' > ');
        }

        _showToast(message, type = 'info') {
            if (!this.toastStackEl) return;
            const toast = document.createElement('div');
            toast.className = `toast toast--${type}`;
            toast.textContent = message;
            this.toastStackEl.appendChild(toast);
            this._setToastVisibility(true);
            requestAnimationFrame(() => {
                toast.classList.add('show');
            });
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => {
                    toast.remove();
                    this._setToastVisibility(this.toastStackEl.children.length > 0);
                }, 220);
            }, TOAST_HIDE_MS);
        }

        _setToastVisibility(visible) {
            if (!this.toastStackEl) return;
            this.toastStackEl.hidden = !visible;
            this._updatePanelLayout();
        }

        async _loadChildrenForNode(node, { expand = false } = {}) {
            if (node.loading) {
                logger.debug('Узел уже загружается', { id: node.id });
                return node.children && node.children.length > 0;
            }
            node.loading = true;
            this.render();
            try {
                logger.info('Загрузка дочерних категорий', { id: node.id });
                const children = await loadChildren(node.id);
                logger.debug('Получены дочерние категории', { id: node.id, count: children.length });
                const mappedChildren = assignChildrenToNode(node, children);
                node.childrenLoaded = true;
                node.hasChildren = mappedChildren.length > 0;
                reorderSiblingsForNode(node);
                node.loading = false;
                if (expand && node.hasChildren) {
                    node.expanded = true;
                    this._ensureChildrenLeafInfo(node);
                } else {
                    node.expanded = expand && node.hasChildren;
                }
                if (!node.hasChildren) {
                    node.expanded = false;
                }
                this.render();
                this._prefetchVisible();
                this._schedulePersist();
                return node.hasChildren;
            } catch (err) {
                logger.error('Ошибка загрузки дочерних категорий', { id: node.id, error: err && err.message });
                node.error = 'Не удалось загрузить дочерние';
                node.loading = false;
                this.render();
                this._schedulePersist();
                return false;
            }
        }

        async _ensureNodeExpanded(node) {
            if (!node) return false;
            if (node.hasChildren === false && node.childrenLoaded) {
                return false;
            }
            if (!node.childrenLoaded) {
                return await this._loadChildrenForNode(node, { expand: true });
            }
            if (!node.children.length) {
                node.hasChildren = false;
                node.expanded = false;
                reorderSiblingsForNode(node);
                this.render();
                this._schedulePersist();
                return false;
            }
            if (!node.expanded) {
                node.expanded = true;
                this.render();
                this._schedulePersist();
            }
            this._ensureChildrenLeafInfo(node);
            return true;
        }

        async _focusRow(nodeId) {
            try {
                const row = await waitFor(() => this.resultsContainer.querySelector(`.row[data-id="${nodeId}"]`), {
                    timeout: WAIT_FOR_TIMEOUT_MS,
                });
                if (!row) return;
                row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                row.classList.add('gce-focused');
                setTimeout(() => {
                    const fresh = this.resultsContainer.querySelector(`.row[data-id="${nodeId}"]`);
                    if (fresh) {
                        fresh.classList.remove('gce-focused');
                    }
                }, FOCUSED_HIGHLIGHT_MS);
            } catch (err) {
                logger.warn('Не удалось сфокусировать строку', { id: nodeId, error: err && err.message });
            }
        }

        _onGlobalKeyDown(event) {
            if (event.key === 'Escape') {
                this._clearSelection();
            }
        }

        _findBestMatch(candidates, segment) {
            if (!Array.isArray(candidates) || !candidates.length) return null;
            const target = normalizeText(segment);
            const exact = candidates.find(item => normalizeText(item.name) === target);
            if (exact) return exact;
            for (const item of candidates) {
                if (Array.isArray(item.pathSegments) && item.pathSegments.some(seg => normalizeText(seg) === target)) {
                    return item;
                }
            }
            let best = null;
            let bestScore = 0;
            for (const item of candidates) {
                const nameNorm = normalizeText(item.name);
                if (!nameNorm) continue;
                let score = 0;
                if (nameNorm.includes(target)) {
                    score = target.length / nameNorm.length + 0.2;
                } else if (target.includes(nameNorm)) {
                    score = nameNorm.length / target.length + 0.2;
                } else {
                    const diff = Math.abs(nameNorm.length - target.length);
                    score = 1 / (1 + diff);
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = item;
                }
            }
            return best;
        }

        async _followPath(segments) {
            if (!segments.length) return;
            logger.info('Автонавигация по пути', { segments });
            await this.startSearch(segments[0], { preserveSelection: true });
            const rootNode = this._findBestMatch(SearchState.results, segments[0]);
            if (!rootNode) {
                const message = `Не найден сегмент "${segments[0]}"`;
                this._showToast(message, 'error');
                throw new Error(message);
            }
            let currentNode = rootNode;
            for (let index = 1; index < segments.length; index++) {
                const segment = segments[index];
                const expanded = await this._ensureNodeExpanded(currentNode);
                if (!expanded) {
                    const message = `"${currentNode.name}" не имеет дочерних для сегмента "${segment}"`;
                    this._showToast(message, 'error');
                    throw new Error(message);
                }
                const match = this._findBestMatch(currentNode.children, segment);
                if (!match) {
                    const message = `Не удалось найти сегмент "${segment}"`;
                    this._showToast(message, 'error');
                    throw new Error(message);
                }
                currentNode = match;
            }
            await this._focusRow(currentNode.id);
            this.lastFocusedId = currentNode.id;
            ensureLeafState(currentNode).catch(() => {});
            this._showToast(`Перешли к «${currentNode.name}»`, 'success');
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
            this._cancelPopoverHide();
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
            this._cancelPopoverHide();
            if (event && this.currentPopover) {
                const related = event.relatedTarget;
                if (related && (related === this.currentPopover || this.currentPopover.contains(related))) {
                    this.currentHoverRow = null;
                    return;
                }
            }
            this.currentHoverRow = null;
            if (event && this.currentPopover) {
                this._schedulePopoverHide();
            } else {
                this._hidePopover();
            }
        }

        _showPopover(row, node, stats) {
            if (this.currentHoverRow !== row) return;
            this._hidePopover();
            this._cancelPopoverHide();
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
            let top = verticalCenter - popRect.height / 2;
            const minTop = 8;
            const maxTop = window.innerHeight - popRect.height - 8;
            if (top < minTop) top = minTop;
            if (top > maxTop) top = Math.max(minTop, maxTop);
            let left = rect.right + 6;
            if (left + popRect.width > window.innerWidth - 12) {
                left = rect.left - popRect.width - 6;
            }
            if (left < 12) {
                left = 12;
            }
            pop.style.top = `${top}px`;
            pop.style.left = `${left}px`;
            pop.addEventListener('mouseenter', () => {
                this._cancelPopoverHide();
            });
            pop.addEventListener('mouseleave', (e) => {
                const related = e.relatedTarget;
                if (related && (related === row || row.contains(related))) {
                    return;
                }
                this._schedulePopoverHide();
            });
            this.currentPopover = pop;
            this.currentPopoverAnchor = row;
            logger.debug('Показ поповера', { id: stats.id });
        }

        _hidePopover() {
            this._cancelPopoverHide();
            if (this.currentPopover) {
                this.currentPopover.remove();
                this.currentPopover = null;
                this.currentPopoverAnchor = null;
            }
        }

        _schedulePopoverHide() {
            this._cancelPopoverHide();
            this.popoverHideTimer = setTimeout(() => {
                this.popoverHideTimer = null;
                this._hidePopover();
            }, POPOVER_HIDE_DELAY_MS);
        }

        _cancelPopoverHide() {
            if (this.popoverHideTimer) {
                clearTimeout(this.popoverHideTimer);
                this.popoverHideTimer = null;
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
        if (!node || node.childrenLoaded) return;
        try {
            const children = await loadChildren(node.id);
            const mappedChildren = assignChildrenToNode(node, children);
            node.childrenLoaded = true;
            node.hasChildren = mappedChildren.length > 0;
            reorderSiblingsForNode(node);
            if (!node.hasChildren) {
                node.expanded = false;
            }
            logger.debug('Флаг листа обновлён', { id: node.id, hasChildren: node.hasChildren });
        } catch (err) {
            logger.warn('Не удалось определить наличие дочерних', { id: node.id, error: err && err.message });
        }
    }

    // --- Запуск ---
    initPanel();
})();

