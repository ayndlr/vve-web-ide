const STORAGE_KEY = 'vve-web-ide:workspace:v2';
const SETTINGS_KEY = 'vve-web-ide:settings:v2';

const seedFiles = new Map([
  ['index.html', `<!doctype html>\n<html lang="en">\n  <head>\n    <title>Hello VVE</title>\n  </head>\n  <body>\n    <main>\n      <h1>Hello from a web-native IDE</h1>\n    </main>\n    <script type="module" src="./app.js"></script>\n  </body>\n</html>\n`],
  ['styles.css', `:root {\n  color-scheme: dark;\n  accent-color: #007acc;\n}\n\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n`],
  ['app.js', `const message = 'Offline-first VS Code style web IDE';\ndocument.body.append(message);\n`],
]);

const state = {
  files: loadWorkspace(),
  activeFile: 'index.html',
  diagnostics: [],
  outline: [],
  completions: [],
  lspSocket: null,
  lspId: 0,
  deferredInstall: null,
  settings: loadSettings(),
};

const $ = (selector) => document.querySelector(selector);
const editor = $('#editor');
const highlightLayer = $('#highlightLayer');
const lineNumbers = $('#lineNumbers');
const fileTree = $('#fileTree');
const diagnostics = $('#diagnostics');
const outline = $('#outline');
const completions = $('#completions');
const cursorStatus = $('#cursorStatus');
const runtimeLog = $('#runtimeLog');
const saveState = $('#saveState');
const syncState = $('#syncState');
const lspState = $('#lspState');
const pwaState = $('#pwaState');
const highlightSupport = $('#highlightSupport');
const activeTab = $('#activeTab');
const ide = $('.ide');
const lspWorker = new Worker(new URL('./workers/lsp-worker.js', import.meta.url), { type: 'module' });

let debounceId;
const hasHighlights = 'CSS' in globalThis && 'highlights' in CSS && 'Highlight' in globalThis;
highlightSupport.textContent = hasHighlights ? 'CSS Highlights API available' : 'CSS Highlights API unavailable';

boot();

function boot() {
  applySettings();
  registerServiceWorker();
  bindEvents();
  renderFileTree();
  openFile(state.activeFile);
}

function loadWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved ? new Map(Object.entries(saved)) : new Map(seedFiles);
  } catch {
    return new Map(seedFiles);
  }
}

function loadSettings() {
  return { theme: 'dark', fontSize: 14, tabSize: 2, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
}

function persistSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function applySettings() {
  document.documentElement.dataset.theme = state.settings.theme;
  editor.style.fontSize = `${state.settings.fontSize}px`;
  highlightLayer.style.fontSize = `${state.settings.fontSize}px`;
  editor.style.tabSize = state.settings.tabSize;
  highlightLayer.style.tabSize = state.settings.tabSize;
  $('#fontSize').value = state.settings.fontSize;
  $('#tabSize').value = state.settings.tabSize;
  $('#themeButton').setAttribute('aria-pressed', String(state.settings.theme === 'light'));
}

function bindEvents() {
  editor.addEventListener('input', syncEditor);
  editor.addEventListener('scroll', syncScroll);
  editor.addEventListener('keydown', handleEditorKeys);
  editor.addEventListener('click', updateCursorStatus);
  editor.addEventListener('keyup', updateCursorStatus);
  $('#saveButton').addEventListener('click', saveWorkspace);
  $('#formatButton').addEventListener('click', formatActiveFile);
  $('#runButton').addEventListener('click', runPreview);
  $('#themeButton').addEventListener('click', toggleTheme);
  $('#sidebarButton').addEventListener('click', () => ide.dataset.sidebar = ide.dataset.sidebar === 'open' ? 'closed' : 'open');
  $('#newFileButton').addEventListener('click', createFile);
  $('#searchInput').addEventListener('input', searchWorkspace);
  $('#fontSize').addEventListener('input', (event) => updateSetting('fontSize', Number(event.target.value)));
  $('#tabSize').addEventListener('input', (event) => updateSetting('tabSize', Number(event.target.value)));
  $('#lspForm').addEventListener('submit', connectLspServer);
  $('.activitybar').addEventListener('click', switchView);
  $('#installButton').addEventListener('click', installPwa);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    $('#installButton').hidden = false;
  });
}

function renderFileTree() {
  fileTree.replaceChildren(...[...state.files.keys()].map((name) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.className = name === state.activeFile ? 'active' : '';
    button.addEventListener('click', () => openFile(name));
    const item = document.createElement('li');
    item.append(button);
    return item;
  }));
}

function openFile(name) {
  state.activeFile = name;
  activeTab.textContent = name;
  editor.value = state.files.get(name) ?? '';
  renderFileTree();
  syncEditor({ skipPersistLabel: true });
  editor.focus({ preventScroll: true });
}

function syncEditor(options = {}) {
  const source = editor.value;
  state.files.set(state.activeFile, source);
  renderEditorText(source);
  if (!options.skipPersistLabel) saveState.textContent = 'Unsaved changes';
  clearTimeout(debounceId);
  debounceId = setTimeout(() => analyze(source), 120);
  updateCursorStatus();
}

function renderEditorText(source) {
  lineNumbers.textContent = source.split('\n').map((_, index) => index + 1).join('\n');
  highlightLayer.textContent = source;
  syncScroll();
}

function syncScroll() {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
  lineNumbers.scrollTop = editor.scrollTop;
}

function analyze(source) {
  const languageId = languageFor(state.activeFile);
  if (state.lspSocket?.readyState === WebSocket.OPEN) {
    sendLspNotification('textDocument/didChange', {
      textDocument: { uri: uriFor(state.activeFile), version: Date.now() },
      contentChanges: [{ text: source }],
    });
    sendLspRequest('textDocument/documentSymbol', { textDocument: { uri: uriFor(state.activeFile) } });
    sendLspRequest('textDocument/completion', { textDocument: { uri: uriFor(state.activeFile) }, position: cursorPosition() });
  }
  lspWorker.postMessage({ type: 'analyze', uri: state.activeFile, languageId, source });
}

function renderDiagnostics(items) {
  state.diagnostics = items;
  diagnostics.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.className = item.severity;
    li.textContent = `${item.severity}: ${item.message} (Ln ${item.line})`;
    li.addEventListener('click', () => jumpToOffset(item.start));
    return li;
  }));
  if (!items.length) diagnostics.append(Object.assign(document.createElement('li'), { textContent: 'No problems detected.' }));
  paintDiagnosticHighlights(items);
}

function paintDiagnosticHighlights(items) {
  if (!hasHighlights) return;
  CSS.highlights.delete('diagnostics');
  const textNode = highlightLayer.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
  const source = editor.value;
  const ranges = items.map((item) => {
    const range = new Range();
    const start = Math.min(item.start, source.length);
    const end = Math.min(Math.max(start + 1, item.end), source.length);
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    return range;
  });
  CSS.highlights.set('diagnostics', new Highlight(...ranges));
}

function renderOutline(symbols) {
  state.outline = symbols;
  outline.replaceChildren(...symbols.map((symbol) => {
    const li = document.createElement('li');
    li.textContent = `${symbol.kind} ${symbol.name} · Ln ${symbol.line}`;
    li.addEventListener('click', () => jumpToOffset(symbol.start ?? 0));
    return li;
  }));
  if (!symbols.length) outline.append(Object.assign(document.createElement('li'), { textContent: 'No symbols yet.' }));
}

function renderCompletions(items) {
  state.completions = items;
  completions.replaceChildren(...items.slice(0, 12).map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.title = item.detail ?? item.label;
    button.addEventListener('click', () => insertText(item.insertText ?? item.label));
    return button;
  }));
}

function updateCursorStatus() {
  const position = cursorPosition();
  cursorStatus.textContent = `Ln ${position.line + 1}, Col ${position.character + 1}`;
}

function cursorPosition() {
  const before = editor.value.slice(0, editor.selectionStart);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function handleEditorKeys(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveWorkspace();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    insertText(' '.repeat(state.settings.tabSize));
  }
}

function insertText(text) {
  const { selectionStart, selectionEnd, value } = editor;
  editor.value = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`;
  editor.selectionStart = editor.selectionEnd = selectionStart + text.length;
  syncEditor();
  editor.focus();
}

function saveWorkspace() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(state.files)));
  saveState.textContent = `Saved ${new Date().toLocaleTimeString()}`;
}

function formatActiveFile() {
  editor.value = editor.value.replace(/\s+$/gm, '').concat('\n');
  syncEditor();
}

function runPreview() {
  const html = state.files.get('index.html') ?? '';
  const css = state.files.get('styles.css') ?? '';
  const js = state.files.get('app.js') ?? '';
  const preview = html.replace('</head>', `<style>${css}</style></head>`).replace('</body>', `<script type="module">${js.replaceAll('</script>', '<\\/script>')}</script></body>`);
  const url = URL.createObjectURL(new Blob([preview], { type: 'text/html' }));
  runtimeLog.innerHTML = '';
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.textContent = `Open preview for ${state.activeFile}`;
  runtimeLog.append(anchor);
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  persistSettings();
  applySettings();
}

function updateSetting(key, value) {
  state.settings[key] = value;
  persistSettings();
  applySettings();
}

function createFile() {
  const extension = state.files.size % 2 ? 'js' : 'css';
  const name = `untitled-${state.files.size + 1}.${extension}`;
  state.files.set(name, '');
  renderFileTree();
  openFile(name);
}

function searchWorkspace(event) {
  const query = event.target.value.trim().toLowerCase();
  const results = $('#searchResults');
  if (!query) {
    results.replaceChildren();
    return;
  }
  const matches = [...state.files].flatMap(([name, source]) => source.split('\n').map((line, index) => ({ name, line, index })).filter((entry) => entry.line.toLowerCase().includes(query)));
  results.replaceChildren(...matches.map((match) => {
    const li = document.createElement('li');
    li.textContent = `${match.name}:${match.index + 1} ${match.line.trim()}`;
    li.addEventListener('click', () => openFile(match.name));
    return li;
  }));
}

function switchView(event) {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  document.querySelectorAll('.activitybar button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `${button.dataset.view}View`));
  ide.dataset.sidebar = 'open';
}

function jumpToOffset(offset) {
  editor.focus();
  editor.selectionStart = editor.selectionEnd = offset;
  updateCursorStatus();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    pwaState.textContent = 'Service worker unavailable';
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js', { type: 'classic' });
    pwaState.textContent = 'Offline cache ready';
  } catch (error) {
    pwaState.textContent = `Offline cache failed: ${error.message}`;
  }
}

async function installPwa() {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  await state.deferredInstall.userChoice;
  state.deferredInstall = null;
  $('#installButton').hidden = true;
}

function connectLspServer(event) {
  event.preventDefault();
  const url = new FormData(event.currentTarget).get('lspUrl')?.toString().trim();
  if (!url) return;
  state.lspSocket?.close();
  state.lspSocket = new WebSocket(url);
  lspState.textContent = 'Connecting to LSP…';
  state.lspSocket.addEventListener('open', () => {
    lspState.textContent = `Connected: ${url}`;
    sendLspRequest('initialize', {
      processId: null,
      rootUri: location.origin,
      capabilities: { textDocument: { synchronization: {}, completion: {}, documentSymbol: {} } },
    });
    sendLspNotification('initialized', {});
    analyze(editor.value);
  });
  state.lspSocket.addEventListener('message', handleLspMessage);
  state.lspSocket.addEventListener('close', () => { lspState.textContent = 'Local worker language service'; });
  state.lspSocket.addEventListener('error', () => { lspState.textContent = 'LSP connection error; using local worker'; });
}

function handleLspMessage(event) {
  const messages = event.data.toString().split('\n').filter(Boolean);
  for (const raw of messages) {
    try {
      const message = JSON.parse(raw);
      if (message.method === 'textDocument/publishDiagnostics') {
        renderDiagnostics(message.params.diagnostics.map(fromLspDiagnostic));
      }
      if (Array.isArray(message.result)) {
        renderOutline(message.result.map(fromLspSymbol));
      }
      if (message.result?.items) {
        renderCompletions(message.result.items.map((item) => ({ label: item.label, detail: item.detail, insertText: item.insertText ?? item.label })));
      }
    } catch (error) {
      console.warn('Ignoring non-JSON LSP frame', error);
    }
  }
}

function sendLspRequest(method, params) {
  sendLsp({ jsonrpc: '2.0', id: ++state.lspId, method, params });
}

function sendLspNotification(method, params) {
  sendLsp({ jsonrpc: '2.0', method, params });
}

function sendLsp(payload) {
  state.lspSocket?.send(JSON.stringify(payload));
}

function fromLspDiagnostic(item) {
  const start = offsetFromPosition(item.range.start);
  return {
    severity: ['error', 'warning', 'info', 'hint'][item.severity - 1] ?? 'info',
    message: item.message,
    line: item.range.start.line + 1,
    start,
    end: offsetFromPosition(item.range.end),
  };
}

function fromLspSymbol(item) {
  return { kind: 'LSP', name: item.name, line: item.range.start.line + 1, start: offsetFromPosition(item.range.start) };
}

function offsetFromPosition(position) {
  const lines = editor.value.split('\n');
  return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
}

function languageFor(name) {
  return name.endsWith('.css') ? 'css' : name.endsWith('.js') ? 'javascript' : 'html';
}

function uriFor(name) {
  return `${location.origin}/workspace/${encodeURIComponent(name)}`;
}


lspWorker.addEventListener('message', ({ data }) => {
  if (data.uri !== state.activeFile) return;
  syncState.textContent = `Indexed ${data.languageId} locally`;
  renderDiagnostics(data.diagnostics);
  renderOutline(data.outline);
  renderCompletions(data.completions);
});
