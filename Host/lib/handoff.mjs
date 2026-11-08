// Context handed to a different agent when a thread switches provider (Claude ↔ Codex), so it carries on
// with what was said and done. A smaller version of Handoff.swift on the Mac.

const BUDGET = 45_000;

function transcript(items, accounts, toolOutputLimit) {
  const out = [];
  let lastAuthor = null;
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        out.push(`### Usuario\n${item.text}`);
        lastAuthor = null;
        break;
      case 'assistant': {
        if (!item.text) break;
        const author = `${accounts.get(item.accountId)?.name ?? 'agente'}${item.model && item.model !== 'default' ? ` · ${item.model}` : ''}`;
        out.push(author !== lastAuthor ? `### Asistente (${author})\n${item.text}` : item.text);
        lastAuthor = author;
        break;
      }
      case 'tool': {
        let line = `- [herramienta ${item.toolName ?? ''}] ${item.title ?? item.text}`;
        if (item.toolState === 'failed') line += ' → ERROR';
        const output = (item.output ?? '').trim();
        if (output && toolOutputLimit > 0) {
          const clipped = output.length > toolOutputLimit ? `${output.slice(0, toolOutputLimit)} …` : output;
          line += `\n  \`\`\`\n  ${clipped.replaceAll('\n', '\n  ')}\n  \`\`\``;
        }
        out.push(line);
        break;
      }
      case 'error': out.push(`- [error] ${item.text.slice(0, 500)}`); break;
      case 'notice': out.push(`_(${item.text})_`); break;
      case 'approval': if (item.resolution) out.push(`- [permiso] ${item.title ?? item.text} → ${item.resolution}`); break;
      default: break;
    }
  }
  return out.join('\n\n');
}

/** Long threads: every user message (trimmed), the latest exchanges in full and only tool titles before. */
function compact(items, accounts) {
  const tailStart = Math.max(0, items.length - 40);
  const parts = items.map((item, i) => {
    if (i >= tailStart) return transcript([item], accounts, i >= items.length - 12 ? 400 : 0);
    if (item.kind === 'user') return `### Usuario\n${item.text.slice(0, 1200)}`;
    if (item.kind === 'assistant') return `### Asistente\n${item.text.slice(0, 600)}${item.text.length > 600 ? ' …' : ''}`;
    if (item.kind === 'tool') return `- [herramienta] ${item.title ?? item.text}`;
    return '';
  }).filter(Boolean);
  let text = parts.join('\n\n');
  if (text.length > BUDGET) text = `…(principio omitido)…\n\n${text.slice(-BUDGET)}`;
  return text;
}

export function handoffText({ items, accounts, projectPath, target, pendingRequest }) {
  let body = transcript(items, accounts, 600);
  if (body.length > BUDGET) body = compact(items, accounts);
  const agents = [...new Set(items.filter((i) => i.kind === 'assistant').map((i) => accounts.get(i.accountId)?.agentName).filter(Boolean))].join(', ');
  return `<relevo_handoff>
Retomas una conversación que empezó con otro agente de IA (${agents || 'otro agente'}). El usuario ha cambiado de proveedor desde Relevo (normalmente porque el anterior se quedó sin cuota) y ahora continúas tú, como ${target.agentName}, con el mismo contexto.
- Proyecto: ${projectPath}
- Los cambios en ficheros ya están aplicados en disco: si hay acciones a medias, comprueba su resultado antes de repetirlas.
- No repitas trabajo ya hecho; continúa desde donde se quedó el agente anterior.

<transcripcion>
${body}
</transcripcion>
</relevo_handoff>

${pendingRequest ? 'La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:' : 'Nuevo mensaje del usuario:'}

`;
}
