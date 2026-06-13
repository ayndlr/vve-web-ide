const files = new Map([
  ['index.html', `<!doctype html>\n<html lang="en">\n  <head>\n    <title>Hello VVE</title>\n  </head>\n  <body>\n    <main>\n      <h1>Hello from a web-native IDE</h1>\n    </main>\n  </body>\n</html>\n`],
  ['styles.css', `:root {\n  color-scheme: dark;\n}\n\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n`],
  ['app.js', `const message = 'CSS Highlights API + Worker LSP';\ndocument.body.append(message);\n`],
]);

const editor = document.querySelector('#editor');
const lineNumbers = document.querySelector('#lineNumbers');
const fileTree = document.querySelector('#fileTree');
const diagnostics = document.querySelector('#diagnostics');
const outline = document.querySelector('#outline');
const completions = document.querySelector('#completions');
const cursorStatus = document.querySelector('#cursorStatus');
const runtimeLog = document.querySelector('#runtimeLog');
const saveState = document.querySelector('#saveState');
const highlightSupport = document.querySelector('#highlightSupport');

const lsp = new Worker(new URL('./workers/lsp-worker.js', import.meta.url), { type: 'module' });
let activeFile = 'index.html';
let debounceId;

const hasHighlights = 'CSS' in globalThis && 'highlights' in CSS && 'Highlight' in globalThis;
highlightSupport.textContent = hasHighlights
  ? 'CSS Highlights API enabled'
  : 'CSS Highlights API unavailable; using text diagnostics only';

function renderFileTree() {
  fileTree.replaceChildren(...[...files.keys()].map((name) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.className = name === activeFile ? 'active' : '';
    button.addEventListener('click', () => openFile(name));
    const item = document.createElement('li');
    item.append(button);
    return item;
  }));
}

function openFile(name) {
  activeFile = name;
  editor.textContent = files.get(name);
  renderFileTree();
  syncEditor();
  editor.focus();
}

function syncEditor() {
  const source = editor.textContent ?? '';
  files.set(activeFile, source);
  lineNumbers.textContent = source.split('\n').map((_, index) => index + 1).join('\n');
  saveState.textContent = 'Unsaved changes';
  clearTimeout(debounceId);
  debounceId = setTimeout(() => lsp.postMessage({ type: 'analyze', uri: activeFile, source }), 120);
  updateCursorStatus();
}

function updateCursorStatus() {
  const selection = getSelection();
  if (!selection?.anchorNode || !editor.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  const text = range.toString();
  const lines = text.split('\n');
  cursorStatus.textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
}

function renderDiagnostics(items) {
  diagnostics.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.className = item.severity;
    li.textContent = `${item.severity}: ${item.message} (Ln ${item.line})`;
    return li;
  }));
  if (!items.length) diagnostics.append(Object.assign(document.createElement('li'), { textContent: 'No problems detected.' }));
  paintDiagnosticHighlights(items);
}

function paintDiagnosticHighlights(items) {
  if (!hasHighlights) return;
  CSS.highlights.delete('diagnostics');
  const textNode = editor.firstChild;
  if (!textNode) return;
  const source = editor.textContent ?? '';
  const ranges = items.map((item) => {
    const range = new Range();
    const start = Math.min(item.start, source.length);
    const end = Math.min(item.end, source.length);
    range.setStart(textNode, start);
    range.setEnd(textNode, Math.max(start, end));
    return range;
  });
  CSS.highlights.set('diagnostics', new Highlight(...ranges));
}

function renderOutline(symbols) {
  outline.replaceChildren(...symbols.map((symbol) => {
    const li = document.createElement('li');
    li.textContent = `${symbol.kind} ${symbol.name} · Ln ${symbol.line}`;
    return li;
  }));
  if (!symbols.length) outline.append(Object.assign(document.createElement('li'), { textContent: 'No symbols yet.' }));
}

function renderCompletions(items) {
  completions.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.title = item.detail;
    button.addEventListener('click', () => document.execCommand('insertText', false, item.insertText));
    return button;
  }));
}

lsp.addEventListener('message', ({ data }) => {
  if (data.uri !== activeFile) return;
  renderDiagnostics(data.diagnostics);
  renderOutline(data.outline);
  renderCompletions(data.completions);
});

editor.addEventListener('input', syncEditor);
document.addEventListener('selectionchange', updateCursorStatus);
document.querySelector('#saveButton').addEventListener('click', () => {
  localStorage.setItem('vve-web-ide:workspace', JSON.stringify(Object.fromEntries(files)));
  saveState.textContent = `Saved ${new Date().toLocaleTimeString()}`;
});
document.querySelector('#formatButton').addEventListener('click', () => {
  editor.textContent = (editor.textContent ?? '').replace(/\s+$/gm, '').concat('\n');
  syncEditor();
});
document.querySelector('#runButton').addEventListener('click', () => {
  runtimeLog.textContent = `Preview generated for ${activeFile} at ${new Date().toLocaleTimeString()}.`;
});

const saved = localStorage.getItem('vve-web-ide:workspace');
if (saved) Object.entries(JSON.parse(saved)).forEach(([key, value]) => files.set(key, value));
renderFileTree();
openFile(activeFile);
