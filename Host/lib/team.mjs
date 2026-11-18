// Teams: several agents on one project, each in its own thread, coordinated by an orchestrator agent.
//
// - The orchestrator plans, hands out tasks, answers the others' questions and unblocks them. It writes
//   orders as tags in its replies (<relevo:tarea para="Ejecutor 1">…</relevo:tarea>, …) and Relevo delivers
//   them as messages to the right thread.
// - Executors do the work. When a turn ends Relevo sends the orchestrator a short report; a question
//   (<relevo:pregunta>…</relevo:pregunta>, or the agent's own question card) goes to the orchestrator instead
//   of waiting for you.
// - The researcher only finds things out: existing libraries, open source projects, issues and docs that
//   shorten the way, so an executor doesn't spend the night reinventing what is already solved.
//
// It works with any agent (Claude, Codex, Antigravity, ACP): it only needs text in and text out. You can
// talk to any of them at any time; automatic messages stop after a while without you (a loop guard).

import { elideCode, clip } from './handoff.mjs';

export const ROLES = {
  orchestrator: { label: 'Orquestador', short: 'Orq.' },
  executor: { label: 'Ejecutor', short: 'Ej.' },
  researcher: { label: 'Investigador', short: 'Inv.' },
};

/** Automatic messages in a row (with no message from you) before the team pauses itself. */
export const AUTO_LIMIT = 60;
const REPORT_MAX = 2_500;

// MARK: - Orders in the agents' replies

const TAG = /<relevo:(tarea|investigar|respuesta|pregunta|fin)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/relevo:\1\s*>)/gi;
const FENCED = /```[\s\S]*?(?:```|$)/g;

/** The orders in a reply, outside code blocks: [{ type, to, body }]. */
export function parseOrders(text) {
  const plain = String(text ?? '').replace(FENCED, '');
  const out = [];
  for (const m of plain.matchAll(TAG)) {
    const to = /para\s*=\s*["“']?([^"”'>]+?)["”']?\s*$/i.exec(m[2].trim())?.[1]?.trim() ?? null;
    out.push({ type: m[1].toLowerCase(), to, body: (m[3] ?? '').trim() });
  }
  return out;
}

/** The reply without the order tags (what's left is the agent's own comment). */
export function withoutOrders(text) {
  return String(text ?? '').replace(TAG, '').replace(/\n{3,}/g, '\n\n').trim();
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** The member an order names: «Ejecutor 1», «ejecutor1», «1», «investigador»… */
export function findMember(team, name) {
  const n = norm(name);
  if (!n) return null;
  return team.members.find((m) => norm(m.name) === n)
    ?? team.members.find((m) => m.role === 'executor' && norm(m.name).endsWith(n) && /^\d+$/.test(n))
    ?? team.members.find((m) => norm(ROLES[m.role].label) === n && team.members.filter((x) => x.role === m.role).length === 1)
    ?? null;
}

// MARK: - What each role is told

function rosterLine(host, team, m) {
  const t = host.threads.get(m.threadId);
  const a = t && host.accountsById.get(t.accountId);
  const where = t?.worktree ? ` · en su worktree (rama ${t.worktree.branch}, carpeta ${t.worktree.path})` : '';
  const what = m.role === 'researcher' ? ' · investiga (internet, documentación, código); no modifica ficheros'
    : m.role === 'orchestrator' ? ' · coordina' : '';
  return `- ${m.name} (${a ? `${a.name} · ${host._modelName(a, t.model)}` : 'agente'})${what}${where}`;
}

export function preamble(host, team, member) {
  const t = host.threads.get(member.threadId);
  const roster = team.members.map((m) => rosterLine(host, team, m)).join('\n');
  const executors = team.members.filter((m) => m.role === 'executor');
  const researcher = team.members.find((m) => m.role === 'researcher');
  const project = host.projects().find((p) => p.id === team.projectId);
  if (member.role === 'orchestrator') {
    return `<relevo_equipo>
Eres el ORQUESTADOR de un equipo de agentes de IA que trabaja en el proyecto ${project?.path ?? t.projectPath}, desde Relevo. No implementas tú: planificas, repartes el trabajo, respondes dudas, desbloqueas y revisas.

Equipo:
${roster}

Para dar órdenes, escríbelas tal cual en tu respuesta (fuera de bloques de código); Relevo las entrega:
<relevo:tarea para="${executors[0]?.name ?? 'Ejecutor 1'}">qué hacer, criterio de terminado, ficheros o pistas</relevo:tarea>
${researcher ? `<relevo:investigar para="${executors[0]?.name ?? 'Ejecutor 1'}">qué averiguar y para qué</relevo:investigar>  (para= es opcional: a quién más le llega el informe)\n` : ''}<relevo:respuesta para="${executors[0]?.name ?? 'Ejecutor 1'}">respuesta a su duda o cómo desbloquearse</relevo:respuesta>
<relevo:fin>resumen para el usuario</relevo:fin>  cuando el objetivo esté cumplido y revisado.

Relevo te enviará los informes, dudas y bloqueos de cada agente con su nombre delante («[${executors[0]?.name ?? 'Ejecutor 1'} · informe]», «… · pregunta»). Reglas:
- Tareas pequeñas y comprobables. No des a dos ejecutores los mismos ficheros a la vez.
${researcher ? `- Antes de que un ejecutor construya algo que ya puede existir (una librería, un proyecto open source, un ejemplo), o en cuanto lleve dos intentos fallidos con el mismo problema, pide al ${researcher.name} que lo busque, y pasa al ejecutor la recomendación concreta.\n` : '- Si un ejecutor lleva dos intentos fallidos con el mismo problema, para y busca otro enfoque (librerías o proyectos open source que ya lo resuelvan) antes de insistir.\n'}- Responde tú las dudas que puedas. Si solo el usuario puede decidir, pregúntaselo en tu respuesta sin dar órdenes y espera.
- Sé breve: todos ven el código en disco; no lo copies en los mensajes.

Objetivo del usuario:
${team.goal}
</relevo_equipo>

`;
  }
  if (member.role === 'researcher') {
    return `<relevo_equipo>
Eres el ${member.name} de un equipo de agentes de IA coordinado por un orquestador, desde Relevo, en el proyecto ${t.projectPath}.

Equipo:
${roster}

Tu trabajo es averiguar, no implementar: no modifiques ficheros del proyecto.
- Busca en internet (buscador, documentación, GitHub, issues, foros) y en el código del proyecto lo que acorte el camino: librerías, proyectos open source, ejemplos y soluciones a errores conocidos.
- Responde con un informe accionable y corto (unas 40 líneas como mucho): las opciones que recomiendas con enlace, licencia y lo madura que parece cada una, por qué encaja aquí, cómo aplicarla en pasos concretos, y los riesgos. Nada de volcados de código largos.
- Si la petición no está clara, termina con <relevo:pregunta>tu duda</relevo:pregunta>.
</relevo_equipo>

`;
  }
  return `<relevo_equipo>
Eres ${member.name} en un equipo de agentes de IA coordinado por un orquestador, desde Relevo. Trabajas en ${t.projectPath}${t.worktree ? ` (tu propio worktree, rama ${t.worktree.branch})` : ''}.

Equipo:
${roster}

- Haz la tarea que te llega. Al terminar, responde con un informe breve: qué has hecho, qué ficheros has tocado, cómo lo has comprobado y qué queda. No pegues código: está en disco.
- Si te bloqueas o necesitas una decisión, termina tu respuesta con <relevo:pregunta>tu duda concreta</relevo:pregunta> y espera la respuesta.${researcher ? ` Si llevas dos intentos fallidos con el mismo problema, pregunta: el ${researcher.name} puede buscar soluciones que ya existan.` : ''}
- Otros agentes pueden estar trabajando en el mismo proyecto: toca solo lo que te pidan.
</relevo_equipo>

`;
}

// MARK: - The coordinator

export class Teams {
  constructor(host) {
    this.host = host;
    host.state.teams ??= [];
  }

  get list() { return this.host.state.teams; }
  byId(id) { return this.list.find((t) => t.id === id) ?? null; }
  of(thread) { return thread?.team ? this.byId(thread.team.id) : null; }
  memberOf(thread) { return this.of(thread)?.members.find((m) => m.threadId === thread.id) ?? null; }

  /**
   * A new team: an orchestrator (and the goal as its first message), one or more executors, maybe a
   * researcher. spec: { projectId, goal, orchestrator: {accountId, model}, executors: [{accountId, model}],
   * researcher: {accountId, model} | null, worktrees, mode }
   */
  create(spec) {
    const h = this.host;
    const goal = String(spec.goal ?? '').trim();
    if (!goal) throw new Error('Falta el objetivo del equipo');
    const executors = (spec.executors ?? []).slice(0, 4);
    if (!executors.length) throw new Error('El equipo necesita al menos un ejecutor');
    if (!h.projects().some((p) => p.id === spec.projectId)) throw new Error('Proyecto desconocido');
    const team = { id: h._uuid(), projectId: spec.projectId, goal, createdAt: Date.now() / 1000, status: 'active', auto: 0, held: [], members: [] };
    const title = clip(goal.split('\n')[0], 48);
    const make = (role, name, pick, mode, worktree) => {
      const t = worktree ? h.createWorktreeThread(spec.projectId) : h.createThread(spec.projectId);
      const account = h.accountsById.get(pick?.accountId) ?? h.accountsById.get(t.accountId);
      t.accountId = account?.id ?? t.accountId;
      t.model = pick?.model || 'default';
      t.mode = mode;
      t.title = `${name} · ${title}`;
      t.team = { id: team.id, role, name };
      t.aiTitled = true; // the role and the goal are a better title than one guessed from the first message
      team.members.push({ threadId: t.id, role, name });
      return t;
    };
    const lead = make('orchestrator', 'Orquestador', spec.orchestrator, 'ask', false);
    const mode = ['ask', 'autoEdit', 'full'].includes(spec.mode) ? spec.mode : 'autoEdit';
    executors.forEach((e, i) => make('executor', executors.length > 1 ? `Ejecutor ${i + 1}` : 'Ejecutor', e, mode, !!spec.worktrees && executors.length > 1));
    if (spec.researcher) make('researcher', 'Investigador', spec.researcher, 'ask', false);
    this.list.push(team);
    // Each agent needs its own process to work at the same time.
    if (h.settings.maxAgents < team.members.length) {
      h.state.settings = { ...h.state.settings, maxAgents: Math.min(8, team.members.length) };
      h._append(lead, { id: h._uuid(), kind: 'notice', text: `Máximo de agentes a la vez subido a ${h.state.settings.maxAgents} para que el equipo trabaje en paralelo` });
    }
    for (const m of team.members) h._saveThread(h.threads.get(m.threadId));
    h._saveState();
    h._broadcastSnapshot();
    h._startTurn(lead, goal, false, { prompt: 'Empieza: mira el proyecto lo justo, planifica y reparte las primeras tareas.' });
    return { teamId: team.id, threadId: lead.id };
  }

  action(teamId, action) {
    const h = this.host;
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    const lead = this._lead(team);
    if (action === 'pause') {
      team.status = 'paused';
      if (lead) h._append(lead, { id: h._uuid(), kind: 'notice', text: 'Equipo en pausa: los mensajes entre agentes esperan hasta que lo reanudes' });
    } else if (action === 'resume') {
      team.status = 'active';
      team.auto = 0;
      if (lead) h._append(lead, { id: h._uuid(), kind: 'notice', text: 'Equipo reanudado' });
      const held = team.held.splice(0);
      for (const d of held) this._deliver(team, d.to, d.text, d.from, true);
    } else if (action === 'dissolve') {
      for (const m of team.members) {
        const t = h.threads.get(m.threadId);
        if (t) { delete t.team; delete t.teamPrimed; h._append(t, { id: h._uuid(), kind: 'notice', text: 'Equipo disuelto: este hilo sigue como uno normal' }); h._changed(t); }
      }
      h.state.teams = this.list.filter((x) => x !== team);
    } else throw new Error('Acción desconocida');
    if (lead) h._changed(lead);
    h._saveState();
    h._broadcastSnapshot();
    return {};
  }

  /** A thread leaving (deleted): the team forgets it; without an orchestrator the team is dissolved. */
  forget(threadId) {
    for (const team of this.list) {
      const i = team.members.findIndex((m) => m.threadId === threadId);
      if (i < 0) continue;
      const [gone] = team.members.splice(i, 1);
      if (gone.role === 'orchestrator' || !team.members.some((m) => m.role === 'executor')) this.action(team.id, 'dissolve');
    }
  }

  /** You wrote in one of the team's threads: the loop guard starts over. */
  userSpoke(thread) {
    const team = this.of(thread);
    if (!team) return;
    team.auto = 0;
    if (team.status === 'done') team.status = 'active'; // you asked for more
  }

  /** The team instructions to put before a message, once per agent session. */
  promptPrefix(thread, freshSession) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member || (thread.teamPrimed && !freshSession)) return '';
    thread.teamPrimed = true;
    return preamble(this.host, team, member);
  }

  /**
   * Called when an agent asks for permission or asks a question. Returns true when the team took care of it:
   * the orchestrator and the researcher read and search without asking; an executor's question goes to the
   * orchestrator.
   */
  onApproval(thread, item, req) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member) return false;
    if (member.role !== 'executor' && !item.questions?.length && READ_ONLY.has(req.toolName)) {
      const allow = (item.options ?? []).find((o) => o.isAllow);
      if (allow) { this.host._resolve(thread, item.id, allow.id, null); return true; }
    }
    if (member.role !== 'orchestrator' && item.questions?.length) {
      member.pendingQuestion = item.id;
      const qs = item.questions.map((q) => `- ${q.question}${q.options?.length ? `\n  Opciones: ${q.options.map((o) => o.label).join(' · ')}` : ''}`).join('\n');
      this._toLead(team, member, 'pregunta', `${qs}\n\nEstá esperando: contéstale con una orden de respuesta para ${member.name} (el usuario también puede contestar en su hilo).`);
      return false; // the card stays in its thread too, for you to answer if you prefer
    }
    return false;
  }

  /** A turn ended in a team thread: deliver what the orchestrator ordered, or report a member's work to it. */
  onTurnFinished(thread, { text, changes, errors }) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member || team.status === 'done') return;
    const h = this.host;
    if (member.role === 'orchestrator') {
      for (const o of parseOrders(text)) this._order(team, member, o);
      h._saveState();
      return;
    }
    const orders = parseOrders(text);
    const question = orders.find((o) => o.type === 'pregunta');
    const body = withoutOrders(text);
    if (question) {
      this._toLead(team, member, 'pregunta', `${question.body}${body ? `\n\n(Contexto: ${clip(body.replace(/\s+/g, ' '), 600)})` : ''}`);
      return;
    }
    const report = [];
    report.push(body ? headTail(elideCode(body, 8), REPORT_MAX) : '(terminó sin decir nada)');
    if (changes?.files) report.push(`Cambios en disco: ${changes.files} fichero${changes.files === 1 ? '' : 's'} (+${changes.added} −${changes.removed})`);
    if (errors?.length) report.push(`Errores: ${errors.slice(-2).map((e) => clip(e, 300)).join(' · ')}`);
    const kind = member.role === 'researcher' ? 'informe de investigación' : errors?.length && !body ? 'error' : 'informe';
    // A researcher's report also goes straight to whoever it was for.
    const forName = member.role === 'researcher' ? member.reportFor : null;
    member.reportFor = null;
    const target = forName && findMember(team, forName);
    if (target && target.role !== 'orchestrator') {
      this._deliver(team, target, report.join('\n\n'), { threadId: thread.id, name: member.name, role: member.role, label: 'informe para ti' });
      report.push(`(También enviado a ${target.name}.)`);
    }
    this._toLead(team, member, kind, report.join('\n\n'));
  }

  // MARK: - Delivery

  _lead(team) {
    const m = team.members.find((x) => x.role === 'orchestrator');
    return m ? this.host.threads.get(m.threadId) : null;
  }

  _toLead(team, from, kind, text) {
    const lead = team.members.find((m) => m.role === 'orchestrator');
    if (lead) this._deliver(team, lead, text, { threadId: from.threadId, name: from.name, role: from.role, label: kind });
  }

  _order(team, lead, o) {
    const h = this.host;
    const leadThread = h.threads.get(lead.threadId);
    const executors = team.members.filter((m) => m.role === 'executor');
    const researcher = team.members.find((m) => m.role === 'researcher');
    const complain = (text) => this._deliver(team, lead, text, { name: 'Relevo', role: 'relevo', label: 'aviso' });
    const from = { threadId: lead.threadId, name: lead.name, role: 'orchestrator' };
    switch (o.type) {
      case 'tarea': {
        const to = o.to ? findMember(team, o.to) : executors.length === 1 ? executors[0] : null;
        if (!to || to.role === 'orchestrator') { complain(`No sé a quién va la tarea${o.to ? ` «${o.to}»` : ''}. El equipo: ${team.members.map((m) => m.name).join(', ')}.`); return; }
        if (!o.body) return;
        this._deliver(team, to, o.body, { ...from, label: 'tarea' });
        return;
      }
      case 'investigar': {
        if (!researcher) { complain('Este equipo no tiene investigador: busca tú o pide al usuario que lo añada.'); return; }
        researcher.reportFor = o.to && findMember(team, o.to)?.name || null;
        this._deliver(team, researcher, o.body, { ...from, label: researcher.reportFor ? `investigación para ${researcher.reportFor}` : 'investigación' });
        return;
      }
      case 'respuesta': {
        const to = o.to ? findMember(team, o.to) : null;
        if (!to || to.role === 'orchestrator') { complain(`No sé a quién va la respuesta${o.to ? ` «${o.to}»` : ''}.`); return; }
        const t = h.threads.get(to.threadId);
        const pending = to.pendingQuestion && h._item(t, to.pendingQuestion);
        to.pendingQuestion = null;
        if (pending && !pending.resolution && h._rt(t).approvals.has(pending.id)) {
          const answers = Object.fromEntries(pending.questions.map((q) => [q.question, o.body]));
          h._resolve(t, pending.id, null, answers);
          h._append(t, { id: h._uuid(), kind: 'notice', text: `${lead.name} ha respondido por ti` });
          h._changed(t);
          return;
        }
        this._deliver(team, to, o.body, { ...from, label: 'respuesta' });
        return;
      }
      case 'fin': {
        team.status = 'done';
        h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Equipo: objetivo cumplido${o.body ? ` · ${clip(o.body.replace(/\s+/g, ' '), 200)}` : ''}` });
        h._changed(leadThread);
        h._broadcastSnapshot();
        return;
      }
      default:
    }
  }

  /** A message to a member: now if it's idle, after its turn otherwise (merged with others waiting for it). */
  _deliver(team, member, text, from, resumed = false) {
    const h = this.host;
    if (team.status === 'paused' && !resumed) { team.held.push({ to: member, text, from }); return; }
    team.auto += 1;
    if (team.auto > AUTO_LIMIT && team.status === 'active') {
      team.status = 'paused';
      team.held.push({ to: member, text, from });
      const lead = this._lead(team);
      if (lead) {
        h._append(lead, { id: h._uuid(), kind: 'notice', text: `Equipo en pausa tras ${AUTO_LIMIT} mensajes automáticos seguidos sin ti. Reanúdalo cuando quieras.` });
        h._changed(lead);
      }
      h._broadcastSnapshot();
      return;
    }
    const t = h.threads.get(member.threadId);
    if (!t) return;
    const header = `[${from.name}${from.label ? ` · ${from.label}` : ''}]`;
    const prompt = `${header}\n${text}`;
    const meta = { from: { threadId: from.threadId ?? null, name: from.name, role: from.role, label: from.label ?? null } };
    if (h._rt(t).isRunning || h._rt(t).approvals.size) {
      // Several reports for a busy orchestrator go as one message when it's free.
      const waiting = t.queued.find((q) => q.team);
      if (waiting && member.role === 'orchestrator') {
        if (!waiting.merged) waiting.text = `${waiting.header}\n${waiting.text}`;
        waiting.merged = true;
        waiting.text += `\n\n${header}\n${text}`;
        waiting.prompt += `\n\n${prompt}`;
        waiting.from = { name: 'Equipo', role: 'team', label: 'varios mensajes' };
      } else t.queued.push({ id: h._uuid(), text, prompt, header, from: meta.from, team: true });
      h._changed(t);
      return;
    }
    h._startTurn(t, text, false, { ...meta, prompt });
  }
}

/** Tools the orchestrator and the researcher use without asking: reading and searching, never writing. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite', 'Task', 'Agent']);

function headTail(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.35);
  return `${clip(s, head)}\n[…]\n${s.slice(-(n - head))}`;
}
