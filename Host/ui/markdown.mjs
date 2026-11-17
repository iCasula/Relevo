// Markdown as the agents write it (GitHub flavour), to HTML: fenced code, headings, lists (nested, ordered,
// task boxes), quotes, tables, rules, and inline code, bold, italics, strikethrough and links. Everything else
// is escaped: the text comes from agents and tools, never trusted as HTML.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function inline(text) {
  const codes = [];
  let s = String(text ?? '').replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const raw = url.replaceAll('&amp;', '&');
    return SAFE_URL.test(raw) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i])
  || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTableStart(lines, i);

export function markdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = line.trim().slice(3).trim().split(/\s/)[0];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    let m = HEADING.exec(line);
    if (m) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const li = LIST.exec(l);
        if (li) {
          items.push({ indent: li[1].replace(/\t/g, '    ').length, ordered: /\d/.test(li[2]), start: parseInt(li[2], 10), text: li[3] });
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1].text += '\n' + l.trim();
          i++;
        } else if (!l.trim() && i + 1 < lines.length && LIST.exec(lines[i + 1]) && items.length) {
          i++; // a blank line between items keeps the list going
        } else break;
      }
      out.push(renderList(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function renderList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ''}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
    }
    let text = inline(it.text).replace(/\n/g, '<br>');
    text = text.replace(/^\[( |x|X)\]\s+/, (_, x) => `<span class="task">${x === ' ' ? '☐' : '☑'}</span> `);
    html += `<li>${text}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}
