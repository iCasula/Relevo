// Context handed to a different agent when a thread switches provider (Claude ↔ Codex ↔ Antigravity), so it
// carries on with what was said and done.
//
// A brief, not the conversation: the code is already on disk, so the receiving agent gets the goal, the plan,
// where the work stands, what each turn did (the files it touched and the commands it ran, not their
// contents) and the latest exchange in more detail. Code blocks are left out, and the whole conversation
// goes to a file the agent can read if it needs a detail. That keeps a handoff at a few thousand tokens
// however long the thread is, instead of tens of thousands.

import fs from 'node:fs';
import path from 'node:path';

/** Characters for the whole brief (≈ 3–4k tokens). */
export const BRIEF_BUDGET = 14_000;
const GOAL_MAX = 1_500;
const PLAN_MAX = 1_500;
const STATE_MAX = 2_500;
const LAST_USER_MAX = 2_500;
const LAST_REPLY_MAX = 3_000;
const LAST_TOOLS_MAX = 25;

// MARK: - Text helpers

const FENCE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n```|$)/g;

/** Fenced code blocks longer than `keep` lines become a one-line mention (the code is on disk). */
export function elideCode(text, keep = 6) {
  return String(text ?? '').replace(FENCE, (m, lang, body) => {
    const lines = body.split('\n').length;
    if (lines <= keep) return m;
    return `[código${lang ? ` ${lang}` : ''}, ${lines} líneas: omitido, está en disco o en la traza]`;
  });
}

/** At most `n` characters, cut at a word, with a mark when something was left out. */
export function clip(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, '');
  return `${cut || s.slice(0, n)} …`;
}

/** The start and, mostly, the end of a long reply (where the conclusion and next steps are). */
function headTail(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.3);
  return `${clip(s, head)}\n[…]\n${s.slice(-(n - head)).replace(/^\S*\s/, '')}`;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// MARK: - Turns

/** Items grouped by user message: [{ user, items: [...] }]. What comes before the first message is left out. */
export function turnsOf(items) {
  const turns = [];
  for (const it of items) {
    if (it.kind === 'user') turns.push({ user: it, items: [] });
    else if (turns.length) turns[turns.length - 1].items.push(it);
  }
  return turns;
}

const EDIT = /^(Editar|Crear|Borrar) (.+)$/;
const READ = /^(Leer|Buscar|Abrir) /;
const COMMAND_TOOLS = new Set(['Bash', 'Shell', 'commandExecution', 'execute', 'run_command', 'shell']);

/** What a turn did with its tools: files touched, commands run (✗ when they failed), reads and web searches. */
export function toolSummary(items) {
  const files = new Map(); // path → 'nuevo' | 'editado' | 'borrado'
  const commands = [];
  let reads = 0, web = 0, failed = 0;
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    const title = oneLine(it.title ?? it.text);
    if (it.toolState === 'failed') failed++;
    const m = EDIT.exec(title);
    if (m) {
      const kind = m[1] === 'Crear' ? 'nuevo' : m[1] === 'Borrar' ? 'borrado' : 'editado';
      for (const f of m[2].split(', ')) if (!files.has(f) || kind !== 'editado') files.set(f, kind);
    } else if (/web|WebSearch|WebFetch/i.test(it.toolName ?? '') || /^Buscar en la web|^Abrir https?:/.test(title)) web++;
    else if (READ.test(title)) reads++;
    else if (COMMAND_TOOLS.has(it.toolName) || (it.output ?? '').startsWith('$ ')) commands.push(`${clip(title, 80)}${it.toolState === 'failed' ? ' ✗' : ''}`);
    else if (it.toolName !== 'TodoWrite') commands.push(`${clip(title, 60)}${it.toolState === 'failed' ? ' ✗' : ''}`);
  }
  return { files, commands, reads, web, failed };
}

function summaryLine({ files, commands, reads, web }, maxCommands = 6) {
  const parts = [];
  if (files.size) {
    const list = [...files].map(([f, k]) => (k === 'editado' ? f : `${f} (${k})`));
    parts.push(`Ficheros: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ` y ${list.length - 12} más` : ''}`);
  }
  if (commands.length) parts.push(`Comandos: ${commands.slice(-maxCommands).join(' · ')}${commands.length > maxCommands ? ` (+${commands.length - maxCommands})` : ''}`);
  if (reads) parts.push(`${reads} lecturas/búsquedas`);
  if (web) parts.push(`${web} consultas web`);
  return parts.join(' · ');
}

function authorOf(item, accounts) {
  const a = accounts.get(item.accountId);
  return `${a?.name ?? 'agente'}${item.model && item.model !== 'default' ? ` · ${item.model}` : ''}`;
}

const replyOf = (turn) => turn.items.filter((i) => i.kind === 'assistant' && i.text?.trim());

/** Turn n (1-based) in two or three lines: request, outcome, tools, errors. */
function turnLine(turn, n, accounts, { isFirst }) {
  const replies = replyOf(turn);
  const last = replies[replies.length - 1];
  const errors = turn.items.filter((i) => i.kind === 'error');
  const lines = [`- Turno ${n} · Usuario: ${isFirst ? '(el objetivo)' : clip(oneLine(elideCode(turn.user.text, 0)), 260)}`];
  if (last) lines.push(`  ${authorOf(last, accounts)}: ${clip(oneLine(elideCode(last.text, 0)), 360)}`);
  else if (!errors.length) lines.push('  (sin respuesta)');
  const tools = summaryLine(toolSummary(turn.items), 4);
  if (tools) lines.push(`  ${tools}`);
  if (errors.length) lines.push(`  Error: ${clip(oneLine(errors[errors.length - 1].text), 160)}`);
  return lines.join('\n');
}

/** The latest turn in detail: the request, the reply (code left out), each tool, and the errors. */
function lastExchange(turn, accounts, pendingRequest) {
  const out = [`### Usuario\n${clip(elideCode(turn.user.text, 15), LAST_USER_MAX)}`];
  const replies = replyOf(turn);
  if (replies.length) {
    const text = replies.map((r) => r.text.trim()).join('\n\n');
    out.push(`### ${authorOf(replies[replies.length - 1], accounts)}\n${headTail(elideCode(text, 10), LAST_REPLY_MAX)}`);
  }
  const tools = turn.items.filter((i) => i.kind === 'tool' && i.toolName !== 'TodoWrite');
  if (tools.length) {
    const shown = tools.slice(-LAST_TOOLS_MAX);
    const lines = shown.map((t) => {
      const state = t.toolState === 'failed' ? ' → ERROR' : t.toolState === 'running' ? ' → sin terminar' : '';
      let line = `- ${clip(oneLine(t.title ?? t.text), 120)}${state}`;
      const output = (t.output ?? '').trim();
      if ((t.toolState === 'failed' || t.toolState === 'running') && output) line += `\n  ${clip(output.slice(-400), 400).replaceAll('\n', '\n  ')}`;
      return line;
    });
    out.push(`### Acciones${tools.length > shown.length ? ` (últimas ${shown.length} de ${tools.length})` : ''}\n${lines.join('\n')}`);
  }
  const errors = turn.items.filter((i) => i.kind === 'error');
  if (errors.length) out.push(`### Errores\n${errors.slice(-3).map((e) => `- ${clip(e.text, 400)}`).join('\n')}`);
  const open = turn.items.filter((i) => i.kind === 'approval' && !i.resolution);
  if (open.length) out.push(`### Sin responder\n${open.map((a) => `- ${clip(a.title ?? a.text, 200)}`).join('\n')}`);
  if (pendingRequest) out.push('(Este turno se cortó antes de terminar.)');
  return out.join('\n\n');
}

/** The agent's latest plan (Claude's TodoWrite, kept as a checklist in the tool's output), if any. */
function latestPlan(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool' && it.toolName === 'TodoWrite' && it.plan) return it.plan;
  }
  return null;
}

// MARK: - The brief

/**
 * The text that goes before the new message when another agent takes the thread over.
 * `traceFile`: where the whole conversation was saved (see `saveTrace`), so the agent can look details up.
 */
/** What ran in the background lately (a build, an emulator), so whoever takes over checks it before relaunching. */
function backgroundBlock(background) {
  if (!background?.length) return '';
  const hm = (at) => new Date(at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `\n- Trabajos lanzados en segundo plano hace poco (mira su salida o sus logs antes de relanzarlos):\n${background.map((b) => `  - ${clip(b.description, 160)}: empezó a las ${hm(b.startedAt)}${b.endedAt ? `, terminó a las ${hm(b.endedAt)}` : ', seguía en marcha (el cambio de agente lo ha cortado)'}`).join('\n')}`;
}

/**
 * Back in its own earlier session (it kept everything it knew): only what other agents did in this thread
 * while it was away, and the git state now.
 */
/**
 * Back in its own session after another model carried the thread: what happened meanwhile, newest turns
 * first while they fit, and the whole stretch in a file for what doesn't.
 */
export function catchUpText({ items, accounts, workState = null, pendingRequest = false, traceFile = null, budget = BRIEF_BUDGET }) {
  const turns = turnsOf(items);
  const lines = [];
  let room = budget;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = turnLine(turns[i], i + 1, accounts, { isFirst: false });
    if (line.length > room) { lines.unshift(`- (${i + 1} turno${i ? 's' : ''} anterior${i ? 'es' : ''} sin resumir aquí${traceFile ? ': léelos en la traza' : ''})`); break; }
    lines.unshift(line);
    room -= line.length + 1;
  }
  const agents = [...new Set(items.filter((i) => i.kind === 'assistant').map((i) => accounts.get(i.accountId)?.agentName).filter(Boolean))].join(', ');
  return `<relevo_mientras_tanto>
Vuelves a este hilo en tu propia sesión: conservas todo lo que sabías. Mientras no estabas, ${agents || 'otro agente'} siguió con él (por cuota). Lo que hizo:
${lines.join('\n') || '- Nada que contar.'}
${workState ? `\nEstado de git ahora:\n${clip(workState, STATE_MAX)}\n` : ''}${traceFile ? `\nLo que pasó mientras no estabas, entero, está en ${traceFile}: si el resumen no basta (te falta por qué se decidió algo, qué se descartó o en qué punto está una investigación), léelo antes de responder.\n` : ''}Comprueba en disco lo que haya cambiado antes de seguir.
</relevo_mientras_tanto>

${pendingRequest ? 'La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:' : 'Nuevo mensaje del usuario:'}

`;
}

export function handoffText({ items, accounts, projectPath, target, pendingRequest, workState = null, traceFile = null, budget = BRIEF_BUDGET, fresh = false, background = [], note = null }) {
  const agents = [...new Set(items.filter((i) => i.kind === 'assistant').map((i) => accounts.get(i.accountId)?.agentName).filter(Boolean))].join(', ');
  const intro = fresh
    ? 'Sigues con tu propio trabajo en una sesión nueva: Relevo la ha renovado porque la anterior se había hecho muy larga. Esto es un resumen de lo que llevabas, no la conversación entera.'
    : `Retomas una tarea que llevaba otro agente de IA (${agents || 'otro agente'}): el usuario ha cambiado de proveedor desde Relevo (normalmente porque el anterior se quedó sin cuota) y ahora sigues tú, como ${target.agentName}. Esto es un resumen, no la conversación entera.`;
  const head = `<relevo_handoff>
${intro}
- Proyecto: ${projectPath}
- El código y los cambios ya están en disco: léelos de los ficheros (git status, git diff), no esperes encontrarlos aquí.
- Comprueba lo que quedó a medias antes de repetirlo y no rehagas lo que ya está hecho.${traceFile ? `\n- Si te falta algún detalle, la conversación completa está en ${traceFile} (léela solo si hace falta).` : ''}${backgroundBlock(background)}${note?.text ? `\n\nTu nota de traspaso (la escribiste tú justo antes de renovar la sesión; fíate de ella):\n${note.text}` : ''}`;
  const body = threadBrief({ items, accounts, pendingRequest, workState, traceFile, budget: budget - head.length });
  return `${head}

${body}
</relevo_handoff>

${pendingRequest ? 'La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:' : 'Nuevo mensaje del usuario:'}

`;
}

/**
 * A thread in a few thousand characters: goal, plan, git state, the earlier turns in a line or three each
 * (newest first while they fit) and the latest exchange in more detail. For handoffs and for an orchestrator
 * joining a thread that already did work.
 */
export function threadBrief({ items, accounts, pendingRequest = false, workState = null, traceFile = null, budget = BRIEF_BUDGET }) {
  const turns = turnsOf(items);
  const sections = [];
  const goal = turns[0]?.user.text;
  if (goal) sections.push(`<objetivo>\n${clip(elideCode(goal, 15), GOAL_MAX)}\n</objetivo>`);
  const plan = latestPlan(items);
  if (plan) sections.push(`<plan>\n${clip(plan, PLAN_MAX)}\n</plan>`);
  if (workState) sections.push(`<estado_de_trabajo>\n${clip(workState, STATE_MAX)}\n</estado_de_trabajo>`);
  const last = turns.length ? `<ultimo_intercambio>\n${lastExchange(turns[turns.length - 1], accounts, pendingRequest)}\n</ultimo_intercambio>` : '';

  // The earlier turns, newest first, as long as they fit; the oldest left out are only counted.
  let room = budget - sections.join('\n\n').length - last.length - 400;
  const history = [];
  for (let i = turns.length - 2; i >= 0; i--) {
    const line = turnLine(turns[i], i + 1, accounts, { isFirst: i === 0 });
    if (line.length > room) {
      history.unshift(`- (${i + 1} turno${i ? 's' : ''} anterior${i ? 'es' : ''} sin resumir aquí${traceFile ? ': están en la traza' : ''})`);
      break;
    }
    history.unshift(line);
    room -= line.length + 1;
  }
  if (history.length) sections.push(`<historial>\n${history.join('\n')}\n</historial>`);
  if (last) sections.push(last);
  return sections.join('\n\n');
}

// MARK: - The full trace

/** The whole conversation as Markdown, tool output included (clipped), for the trace file. */
export function transcript(items, accounts, toolOutputLimit = 2_000) {
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
        const author = authorOf(item, accounts);
        out.push(author !== lastAuthor ? `### Asistente (${author})\n${item.text}` : item.text);
        lastAuthor = author;
        break;
      }
      case 'tool': {
        let line = `- [${item.toolName ?? 'herramienta'}] ${item.title ?? item.text}`;
        if (item.toolState === 'failed') line += ' → ERROR';
        const output = (item.plan ?? item.output ?? '').trim();
        if (output && toolOutputLimit > 0) {
          const clipped = output.length > toolOutputLimit ? `${output.slice(0, toolOutputLimit)} …` : output;
          line += `\n  \`\`\`\n  ${clipped.replaceAll('\n', '\n  ')}\n  \`\`\``;
        }
        out.push(line);
        break;
      }
      case 'error': out.push(`- [error] ${item.text.slice(0, 1000)}`); break;
      case 'notice': out.push(`_(${item.text})_`); break;
      case 'approval': if (item.resolution) out.push(`- [permiso] ${item.title ?? item.text} → ${item.resolution}`); break;
      default: break;
    }
  }
  return out.join('\n\n');
}

const KEEP_TRACES = 8;

/**
 * Writes the whole conversation to `dir` (a folder the agent can read) and returns its path. Keeps the latest
 * few per folder. Errors are not fatal: the brief just goes without the pointer.
 */
export function saveTrace({ dir, threadId, title, items, accounts, workState }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${String(threadId).slice(0, 8).toLowerCase()}-${stamp}.md`);
    const doc = `# Relevo · ${title ?? 'hilo'}\n\n${workState ? `## Estado de trabajo\n\n${workState}\n\n` : ''}## Conversación\n\n${transcript(items, accounts)}\n`;
    fs.writeFileSync(file, doc);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP_TRACES);
    for (const { f } of old) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  } catch {
    return null;
  }
}
