const htmlTags = ['main', 'section', 'article', 'header', 'footer', 'dialog', 'template', 'slot', 'button'];
const cssProps = ['accent-color', 'color-scheme', 'container-type', 'content-visibility', 'scrollbar-color'];
const jsGlobals = ['structuredClone', 'navigator', 'customElements', 'AbortController', 'IntersectionObserver'];

self.addEventListener('message', ({ data }) => {
  if (data.type !== 'analyze') return;
  const language = data.uri.split('.').at(-1);
  const diagnostics = findDiagnostics(data.source, language);
  self.postMessage({
    uri: data.uri,
    diagnostics,
    outline: findOutline(data.source, language),
    completions: completionItems(language),
  });
});

function findDiagnostics(source, language) {
  const diagnostics = [];
  const lines = source.split('\n');
  const openTags = [...source.matchAll(/<([a-z][\w-]*)\b(?![^>]*\/>)/gi)];
  const closeTags = [...source.matchAll(/<\/([a-z][\w-]*)>/gi)].map((match) => match[1]);

  if (language === 'html') {
    for (const match of openTags) {
      const tag = match[1].toLowerCase();
      if (!['!doctype', 'meta', 'link', 'br', 'img', 'input'].includes(tag) && !closeTags.includes(tag)) {
        diagnostics.push(toDiagnostic(source, match.index, `Missing closing </${tag}> tag`, 'error'));
      }
    }
  }

  lines.forEach((line, index) => {
    if (line.length > 100) {
      diagnostics.push({ severity: 'warning', message: 'Line exceeds 100 characters', line: index + 1, start: offsetAt(lines, index, 0), end: offsetAt(lines, index, line.length) });
    }
    if (/TODO/i.test(line)) {
      diagnostics.push({ severity: 'info', message: 'TODO marker found', line: index + 1, start: offsetAt(lines, index, line.indexOf('TODO')), end: offsetAt(lines, index, line.length) });
    }
  });

  return diagnostics;
}

function findOutline(source, language) {
  if (language === 'js') {
    return [...source.matchAll(/(?:function|const|let|class)\s+([\w$]+)/g)].map((match) => symbol(source, match.index, match[1], 'JS'));
  }
  if (language === 'css') {
    return [...source.matchAll(/([^{}]+)\{/g)].map((match) => symbol(source, match.index, match[1].trim(), 'CSS'));
  }
  return [...source.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)].map((match) => symbol(source, match.index, stripTags(match[1]), 'HTML'));
}

function completionItems(language) {
  const values = language === 'css' ? cssProps : language === 'js' ? jsGlobals : htmlTags;
  return values.map((value) => ({ label: value, insertText: value, detail: `Suggested ${language.toUpperCase()} symbol` }));
}

function toDiagnostic(source, start, message, severity) {
  return { severity, message, line: source.slice(0, start).split('\n').length, start, end: start + 8 };
}

function symbol(source, start, name, kind) {
  return { kind, name, line: source.slice(0, start).split('\n').length };
}

function stripTags(input) {
  return input.replace(/<[^>]+>/g, '').trim();
}

function offsetAt(lines, targetLine, column) {
  return lines.slice(0, targetLine).reduce((total, line) => total + line.length + 1, 0) + column;
}
