// ==UserScript==
// @name         GGSEL Chat Anywhere
// @description  View GGSEL admin chat threads from any website with live polling and optional basic auth
// @version      1.0.0
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      seller.ggsel.net
// @run-at       document-idle
// ==/UserScript==

// README: После установки скрипта в Tampermonkey появится плавающая кнопка «GG Chat» на всех страницах.
// Нажмите её, чтобы открыть панель, введите ссылку на чат (https://seller.ggsel.net/messages?chatId=...) и нажмите «Connect».
// В панели доступны настройки автоподгрузки, интервала опроса и (опционально) Basic Auth для закрытых страниц.
// Скрипт не отправляет введённые данные наружу и использует только сессионные куки браузера для seller.ggsel.net.

(function() {
    'use strict';

    const STORAGE_KEY = 'ggsel-chat-anywhere:settings';
    const DEFAULT_SETTINGS = {
        url: '',
        autoRefresh: false,
        intervalSec: 5,
        basicAuth: {
            login: '',
            password: '',
        },
    };

    const state = {
        settings: loadSettings(),
        isPanelOpen: false,
        isFetching: false,
        timerId: null,
        messages: [],
        seenSignatures: new Set(),
    };

    function loadSettings() {
        try {
            const saved = GM_getValue ? GM_getValue(STORAGE_KEY) : null;
            if (!saved || typeof saved !== 'object') {
                return { ...DEFAULT_SETTINGS };
            }
            const interval = Number(saved.intervalSec);
            const normalized = {
                url: typeof saved.url === 'string' ? saved.url : DEFAULT_SETTINGS.url,
                autoRefresh: Boolean(saved.autoRefresh),
                intervalSec: Number.isFinite(interval) && interval >= 2 ? interval : DEFAULT_SETTINGS.intervalSec,
                basicAuth: {
                    login: saved.basicAuth && typeof saved.basicAuth.login === 'string' ? saved.basicAuth.login : DEFAULT_SETTINGS.basicAuth.login,
                    password: saved.basicAuth && typeof saved.basicAuth.password === 'string' ? saved.basicAuth.password : DEFAULT_SETTINGS.basicAuth.password,
                },
            };
            return normalized;
        } catch (err) {
            console.warn('[GGSEL Chat Anywhere] Unable to load settings:', err && err.message);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(partial) {
        state.settings = {
            ...state.settings,
            ...partial,
            basicAuth: {
                ...state.settings.basicAuth,
                ...(partial.basicAuth || {}),
            },
        };
        try {
            if (GM_setValue) {
                GM_setValue(STORAGE_KEY, state.settings);
            }
        } catch (err) {
            console.warn('[GGSEL Chat Anywhere] Unable to persist settings:', err && err.message);
        }
    }

    function ensureMinimumInterval(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.intervalSec;
        return Math.max(2, Math.round(numeric));
    }

    function createEl(tag, options = {}) {
        const el = document.createElement(tag);
        if (options.className) {
            el.className = options.className;
        }
        if (options.text) {
            el.textContent = options.text;
        }
        if (options.type) {
            el.type = options.type;
        }
        if (options.placeholder) {
            el.placeholder = options.placeholder;
        }
        if (options.value !== undefined) {
            el.value = options.value;
        }
        if (options.min !== undefined) {
            el.min = options.min;
        }
        if (options.step !== undefined) {
            el.step = options.step;
        }
        if (options.title) {
            el.title = options.title;
        }
        return el;
    }

    function injectStyles() {
        GM_addStyle(`
            .ggsel-chat-fab {
                position: fixed;
                z-index: 2147483646;
                right: 24px;
                bottom: 24px;
                width: 54px;
                height: 54px;
                border-radius: 50%;
                border: none;
                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                color: #fff;
                font-weight: 700;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                cursor: pointer;
                box-shadow: 0 12px 34px rgba(17, 24, 39, 0.45);
                transition: transform 0.18s ease, box-shadow 0.18s ease;
            }
            .ggsel-chat-fab:hover {
                transform: translateY(-2px);
                box-shadow: 0 16px 36px rgba(17, 24, 39, 0.55);
            }
            .ggsel-chat-panel {
                position: fixed;
                z-index: 2147483647;
                right: 24px;
                bottom: 24px;
                width: 380px;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                background: rgba(24, 26, 34, 0.96);
                backdrop-filter: blur(6px);
                color: #f7f7ff;
                border-radius: 18px;
                box-shadow: 0 18px 48px rgba(10, 10, 15, 0.6);
                border: 1px solid rgba(129, 140, 248, 0.26);
                overflow: hidden;
                font-family: 'Inter', 'Segoe UI', sans-serif;
            }
            .ggsel-chat-hidden {
                display: none !important;
            }
            .ggsel-chat-header {
                padding: 16px 18px 12px;
                font-size: 16px;
                font-weight: 600;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                border-bottom: 1px solid rgba(129, 140, 248, 0.16);
            }
            .ggsel-chat-controls {
                padding: 12px 18px 14px;
                display: grid;
                grid-template-columns: 1fr;
                gap: 10px;
                border-bottom: 1px solid rgba(129, 140, 248, 0.1);
            }
            .ggsel-chat-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .ggsel-chat-row input[type="url"],
            .ggsel-chat-row input[type="number"],
            .ggsel-chat-row input[type="text"],
            .ggsel-chat-row input[type="password"] {
                flex: 1;
                padding: 8px 10px;
                border-radius: 10px;
                border: 1px solid rgba(148, 163, 184, 0.3);
                background: rgba(15, 17, 24, 0.74);
                color: inherit;
                font-family: inherit;
            }
            .ggsel-chat-row input:focus {
                outline: none;
                border-color: rgba(129, 140, 248, 0.58);
                box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
            }
            .ggsel-chat-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
            }
            .ggsel-chat-buttons {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 8px;
            }
            .ggsel-chat-btn {
                padding: 8px 12px;
                border-radius: 10px;
                border: none;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                transition: background 0.18s ease, transform 0.18s ease;
            }
            .ggsel-chat-btn-primary {
                background: linear-gradient(135deg, #6366f1, #8b5cf6);
                color: #fff;
            }
            .ggsel-chat-btn-secondary {
                background: rgba(148, 163, 184, 0.16);
                color: #e2e8f0;
            }
            .ggsel-chat-btn:hover {
                transform: translateY(-1px);
            }
            .ggsel-chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 18px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                background: radial-gradient(circle at top right, rgba(79, 70, 229, 0.16), transparent 60%);
            }
            .ggsel-chat-date {
                align-self: center;
                padding: 2px 10px;
                border-radius: 999px;
                background: rgba(148, 163, 184, 0.16);
                color: rgba(226, 232, 240, 0.78);
                font-size: 12px;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
            }
            .ggsel-chat-msg {
                display: flex;
                flex-direction: column;
                max-width: 80%;
            }
            .ggsel-chat-msg--me {
                align-self: flex-end;
                text-align: right;
            }
            .ggsel-chat-msg--them {
                align-self: flex-start;
                text-align: left;
            }
            .ggsel-chat-msg__bubble {
                padding: 10px 14px;
                border-radius: 16px;
                font-size: 13px;
                line-height: 1.45;
                background: rgba(63, 63, 83, 0.72);
                color: #f8fafc;
                white-space: pre-wrap;
                word-wrap: break-word;
            }
            .ggsel-chat-msg--me .ggsel-chat-msg__bubble {
                background: linear-gradient(135deg, rgba(99, 102, 241, 0.85), rgba(129, 140, 248, 0.9));
            }
            .ggsel-chat-msg__meta {
                margin-top: 4px;
                font-size: 11px;
                color: rgba(203, 213, 225, 0.72);
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
            }
            .ggsel-chat-status {
                padding: 10px 18px 12px;
                border-top: 1px solid rgba(129, 140, 248, 0.14);
                font-size: 12px;
                color: rgba(226, 232, 240, 0.75);
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
            }
            .ggsel-chat-status span {
                flex: 1;
            }
            .ggsel-chat-basic-auth {
                background: rgba(15, 17, 24, 0.7);
                border-radius: 12px;
                padding: 10px 12px 12px;
                border: 1px solid rgba(148, 163, 184, 0.12);
            }
            .ggsel-chat-basic-auth summary {
                cursor: pointer;
                font-weight: 600;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                color: rgba(196, 181, 253, 0.9);
            }
            .ggsel-chat-basic-auth[open] {
                background: rgba(79, 70, 229, 0.08);
            }
            .ggsel-chat-basic-auth-fields {
                margin-top: 8px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ggsel-chat-status-indicator {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: rgba(148, 163, 184, 0.5);
            }
            .ggsel-chat-status-indicator.ggsel-chat-status-indicator--ok {
                background: #34d399;
            }
            .ggsel-chat-status-indicator.ggsel-chat-status-indicator--error {
                background: #f87171;
            }
            @media (max-width: 520px) {
                .ggsel-chat-panel {
                    right: 12px;
                    bottom: 12px;
                    width: calc(100vw - 24px);
                }
                .ggsel-chat-fab {
                    right: 12px;
                    bottom: 12px;
                }
            }
        `);
    }

    function initUI() {
        injectStyles();

        const fab = createEl('button', { className: 'ggsel-chat-fab', text: 'GG\nChat' });
        fab.addEventListener('click', () => {
            togglePanel(true);
        });

        const panel = createEl('div', { className: 'ggsel-chat-panel ggsel-chat-hidden' });
        const header = createEl('div', { className: 'ggsel-chat-header', text: 'GGSEL CHAT RELAY' });
        const controls = createEl('div', { className: 'ggsel-chat-controls' });

        const urlRow = createEl('div', { className: 'ggsel-chat-row' });
        const urlInput = createEl('input', {
            type: 'url',
            placeholder: 'https://seller.ggsel.net/messages?chatId=...',
            value: state.settings.url,
        });
        urlRow.appendChild(urlInput);

        const autoRow = createEl('div', { className: 'ggsel-chat-row' });
        const autoLabel = createEl('label', { className: 'ggsel-chat-toggle' });
        const autoCheckbox = createEl('input', { type: 'checkbox' });
        autoCheckbox.checked = Boolean(state.settings.autoRefresh);
        const autoText = createEl('span', { text: 'Auto-refresh' });
        autoLabel.appendChild(autoCheckbox);
        autoLabel.appendChild(autoText);
        const intervalInput = createEl('input', {
            type: 'number',
            min: '2',
            step: '1',
            value: String(state.settings.intervalSec || DEFAULT_SETTINGS.intervalSec),
            title: 'Interval in seconds',
        });
        const intervalLabel = createEl('label', { className: 'ggsel-chat-toggle' });
        intervalLabel.textContent = 'Interval, sec';
        autoRow.appendChild(autoLabel);
        autoRow.appendChild(intervalLabel);
        autoRow.appendChild(intervalInput);

        const buttonsRow = createEl('div', { className: 'ggsel-chat-buttons' });
        const connectBtn = createEl('button', { className: 'ggsel-chat-btn ggsel-chat-btn-primary', text: 'Connect' });
        const refreshBtn = createEl('button', { className: 'ggsel-chat-btn ggsel-chat-btn-secondary', text: 'Refresh' });
        const openBtn = createEl('button', { className: 'ggsel-chat-btn ggsel-chat-btn-secondary', text: 'Open in GGSEL' });
        const closeBtn = createEl('button', { className: 'ggsel-chat-btn ggsel-chat-btn-secondary', text: 'Close' });
        buttonsRow.appendChild(connectBtn);
        buttonsRow.appendChild(refreshBtn);
        buttonsRow.appendChild(openBtn);
        buttonsRow.appendChild(closeBtn);

        const basicAuthSection = document.createElement('details');
        basicAuthSection.className = 'ggsel-chat-basic-auth';
        const basicSummary = createEl('summary', { text: 'Basic Auth (optional)' });
        const basicFields = createEl('div', { className: 'ggsel-chat-basic-auth-fields' });
        const loginInput = createEl('input', {
            type: 'text',
            placeholder: 'Login',
            value: state.settings.basicAuth.login,
        });
        const passwordInput = createEl('input', {
            type: 'password',
            placeholder: 'Password',
            value: state.settings.basicAuth.password,
        });
        basicFields.appendChild(loginInput);
        basicFields.appendChild(passwordInput);
        basicAuthSection.appendChild(basicSummary);
        basicAuthSection.appendChild(basicFields);

        controls.appendChild(urlRow);
        controls.appendChild(autoRow);
        controls.appendChild(buttonsRow);
        controls.appendChild(basicAuthSection);

        const messagesContainer = createEl('div', { className: 'ggsel-chat-messages' });
        const statusBar = createEl('div', { className: 'ggsel-chat-status' });
        const statusText = createEl('span', { text: 'Waiting for connection…' });
        const statusIndicator = createEl('div', { className: 'ggsel-chat-status-indicator' });
        statusBar.appendChild(statusText);
        statusBar.appendChild(statusIndicator);

        panel.appendChild(header);
        panel.appendChild(controls);
        panel.appendChild(messagesContainer);
        panel.appendChild(statusBar);

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        function updateStatus(message, status = 'idle') {
            statusText.textContent = message;
            statusIndicator.classList.remove('ggsel-chat-status-indicator--ok', 'ggsel-chat-status-indicator--error');
            if (status === 'ok') {
                statusIndicator.classList.add('ggsel-chat-status-indicator--ok');
            } else if (status === 'error') {
                statusIndicator.classList.add('ggsel-chat-status-indicator--error');
            }
        }

        function togglePanel(forceOpen) {
            const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !state.isPanelOpen;
            state.isPanelOpen = shouldOpen;
            if (shouldOpen) {
                panel.classList.remove('ggsel-chat-hidden');
                fab.classList.add('ggsel-chat-hidden');
            } else {
                panel.classList.add('ggsel-chat-hidden');
                fab.classList.remove('ggsel-chat-hidden');
            }
        }

        function resetMessagesView() {
            state.messages = [];
            state.seenSignatures.clear();
            messagesContainer.textContent = '';
        }

        function appendNormalizedEntries(entries) {
            let appended = false;
            for (const entry of entries) {
                const signature = buildSignature(entry);
                if (state.seenSignatures.has(signature)) {
                    continue;
                }
                state.seenSignatures.add(signature);
                state.messages.push(entry);
                if (entry.type === 'date') {
                    const dateEl = createEl('div', { className: 'ggsel-chat-date', text: entry.text });
                    messagesContainer.appendChild(dateEl);
                } else if (entry.type === 'msg') {
                    const wrapper = createEl('div', {
                        className: `ggsel-chat-msg ${entry.author === 'me' ? 'ggsel-chat-msg--me' : 'ggsel-chat-msg--them'}`,
                    });
                    const bubble = createEl('div', { className: 'ggsel-chat-msg__bubble' });
                    bubble.textContent = entry.text;
                    const meta = createEl('div', { className: 'ggsel-chat-msg__meta' });
                    const authorLabel = entry.author === 'me' ? 'You' : 'Companion';
                    meta.textContent = entry.time ? `${authorLabel} · ${entry.time}` : authorLabel;
                    wrapper.appendChild(bubble);
                    wrapper.appendChild(meta);
                    messagesContainer.appendChild(wrapper);
                }
                appended = true;
            }
            if (appended) {
                requestAnimationFrame(() => {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                });
            }
        }

        function buildSignature(entry) {
            if (entry.type === 'date') {
                return `date:${entry.text}`;
            }
            const hash = hashText(entry.text || '');
            return `msg:${entry.author}|${entry.time || ''}|${hash}`;
        }

        function hashText(text) {
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) {
                hash = (hash << 5) - hash + text.charCodeAt(i);
                hash |= 0;
            }
            return hash.toString(16);
        }

        function updateTimer() {
            stopTimer();
            if (!state.settings.autoRefresh || !state.settings.url) {
                return;
            }
            const intervalMs = ensureMinimumInterval(state.settings.intervalSec) * 1000;
            state.timerId = setInterval(() => {
                fetchChat();
            }, intervalMs);
        }

        function stopTimer() {
            if (state.timerId) {
                clearInterval(state.timerId);
                state.timerId = null;
            }
        }

        function encodeBasicAuth(login, password) {
            const raw = `${login}:${password}`;
            try {
                return btoa(unescape(encodeURIComponent(raw)));
            } catch (err) {
                console.warn('[GGSEL Chat Anywhere] Unable to encode credentials:', err && err.message);
                return null;
            }
        }

        function applySettingsFromInputs() {
            const trimmedUrl = (urlInput.value || '').trim();
            const intervalValue = ensureMinimumInterval(intervalInput.value);
            const basicLogin = (loginInput.value || '').trim();
            const basicPassword = passwordInput.value || '';
            const nextSettings = {
                url: trimmedUrl,
                autoRefresh: autoCheckbox.checked,
                intervalSec: intervalValue,
                basicAuth: {
                    login: basicLogin,
                    password: basicPassword,
                },
            };
            saveSettings(nextSettings);
            intervalInput.value = String(state.settings.intervalSec);
        }

        function fetchChat({ reset = false } = {}) {
            if (state.isFetching) {
                return;
            }
            if (!state.settings.url) {
                updateStatus('Set chat URL first.', 'error');
                return;
            }
            state.isFetching = true;
            if (reset) {
                resetMessagesView();
            }
            updateStatus('Loading…');
            const requestUrl = state.settings.url;
            const headers = {};
            const { login, password } = state.settings.basicAuth || {};
            if (login && password) {
                const encoded = encodeBasicAuth(login, password);
                if (encoded) {
                    headers.Authorization = `Basic ${encoded}`;
                }
            }
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: requestUrl,
                    headers,
                    anonymous: false,
                    onload: (response) => {
                        state.isFetching = false;
                        if (response.status === 401 || response.status === 403) {
                            updateStatus('401/403: Please log in to seller.ggsel.net in this browser.', 'error');
                            return;
                        }
                        if (response.status < 200 || response.status >= 300) {
                            updateStatus(`Request failed: ${response.status}`, 'error');
                            return;
                        }
                        try {
                            const parsed = parseMessages(response.responseText);
                            appendNormalizedEntries(parsed);
                            const timestamp = new Date().toLocaleTimeString();
                            updateStatus(`Updated at ${timestamp}`, 'ok');
                        } catch (parseError) {
                            console.warn('[GGSEL Chat Anywhere] Parse error:', parseError);
                            updateStatus('Parsing failed. Check console for details.', 'error');
                        }
                    },
                    onerror: (err) => {
                        state.isFetching = false;
                        updateStatus('Network error. Check console.', 'error');
                        console.warn('[GGSEL Chat Anywhere] Request error:', err);
                    },
                    ontimeout: () => {
                        state.isFetching = false;
                        updateStatus('Request timeout.', 'error');
                    },
                    timeout: ensureMinimumInterval(state.settings.intervalSec) * 1000,
                });
            } catch (err) {
                state.isFetching = false;
                updateStatus('Request setup failed.', 'error');
                console.warn('[GGSEL Chat Anywhere] GM_xmlhttpRequest failed:', err);
            }
        }

        function parseMessages(htmlString) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlString, 'text/html');
            let root = doc.querySelector('[class*="messageChatBody"]');
            if (!root) {
                root = doc.querySelector('[data-simplebar]');
            }
            if (!root) {
                root = doc.body;
            }
            if (!root) {
                throw new Error('No message container found');
            }
            const elements = Array.from(root.querySelectorAll('*'));
            const results = [];
            const seenDates = new Set();
            for (const el of elements) {
                const className = el.className || '';
                if (typeof className === 'string' && className.includes('date')) {
                    const text = (el.textContent || '').trim();
                    if (text && !seenDates.has(text)) {
                        results.push({ type: 'date', text });
                        seenDates.add(text);
                    }
                    continue;
                }
                if (typeof className === 'string' && className.includes('messageText')) {
                    const text = (el.textContent || '').trim();
                    if (!text) {
                        continue;
                    }
                    const author = detectIsCurrentUser(el) ? 'me' : 'them';
                    const time = extractTimestamp(el);
                    results.push({ type: 'msg', author, text, time });
                }
            }
            return results;
        }

        function detectIsCurrentUser(element) {
            let current = element;
            while (current && current !== element.ownerDocument) {
                if (current.classList && Array.from(current.classList).some(cls => cls.includes('currentUser'))) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        }

        function extractTimestamp(element) {
            const bubble = element.closest('[class]');
            if (!bubble) return undefined;
            const timestampEl = bubble.querySelector('[class*="timestamp"]');
            if (timestampEl) {
                const raw = (timestampEl.textContent || '').trim();
                if (raw) {
                    return raw;
                }
            }
            let current = bubble.parentElement;
            while (current && current !== element.ownerDocument) {
                const found = current.querySelector('[class*="timestamp"]');
                if (found) {
                    const raw = (found.textContent || '').trim();
                    if (raw) {
                        return raw;
                    }
                }
                current = current.parentElement;
            }
            return undefined;
        }

        connectBtn.addEventListener('click', () => {
            applySettingsFromInputs();
            if (!state.settings.url) {
                updateStatus('Enter chat URL before connecting.', 'error');
                return;
            }
            resetMessagesView();
            fetchChat({ reset: true });
            updateTimer();
        });

        refreshBtn.addEventListener('click', () => {
            applySettingsFromInputs();
            fetchChat();
        });

        openBtn.addEventListener('click', () => {
            applySettingsFromInputs();
            if (state.settings.url) {
                window.open(state.settings.url, '_blank', 'noopener');
            }
        });

        closeBtn.addEventListener('click', () => {
            togglePanel(false);
        });

        autoCheckbox.addEventListener('change', () => {
            applySettingsFromInputs();
            updateTimer();
        });

        intervalInput.addEventListener('change', () => {
            applySettingsFromInputs();
            updateTimer();
        });

        urlInput.addEventListener('change', () => {
            applySettingsFromInputs();
        });

        loginInput.addEventListener('change', () => {
            applySettingsFromInputs();
        });

        passwordInput.addEventListener('change', () => {
            applySettingsFromInputs();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && state.isPanelOpen) {
                togglePanel(false);
            }
        });

        // Expose for inner functions
        state.togglePanel = togglePanel;
        state.updateStatus = updateStatus;
        state.fetchChat = fetchChat;
        state.resetMessagesView = resetMessagesView;

        if (state.settings.url) {
            updateStatus('Ready. Press Connect to load chat.');
        }
    }

    initUI();

})();
