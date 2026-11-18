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

import * as gitops from './gitops.mjs';
import { elideCode, clip, threadBrief } from './handoff.mjs';
import { isReadOnlyCommand } from './codex.mjs';

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export const ROLES = {
  orchestrator: { label: 'Orquestador', short: 'Orq.' },
  executor: { label: 'Ejecutor', short: 'Ej.' },
  researcher: { label: 'Investigador', short: 'Inv.' },
};

/** Bumped when the agents' instructions change: teams made before get them again. */
const RULES_VERSION = 4;
/** The orchestrator gets a fresh session (with a brief of its own thread) past any of these. */
const LEAD_REFRESH = { context: 150_000, conversation: 1_200_000, turns: 40 };

/** Automatic messages in a row (with no message from you) before the team pauses itself. */
export const AUTO_LIMIT = 60;
const REPORT_MAX = 2_500;

// MARK: - Orders in the agents' replies

const TAG = /<relevo:(tarea|urgente|investigar|respuesta|pregunta|integrar|fin)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/relevo:\1\s*>)/gi;
const FENCED = /```[\s\S]*?(?:```|$)/g;

/** The orders in a reply, outside code blocks: [{ type, to, body }]. */
export function parseOrders(text) {
  const plain = String(text ?? '').replace(FENCED, '');
  const out = [];
  for (const m of plain.matchAll(TAG)) {
    // para="…" (or de="…" for integrar) anywhere among the attributes, quoted or not.
    const attr = /\b(?:para|de)\s*=\s*(?:["“']([^"”']+)["”']|([^\s"”'>/]+))/i.exec(m[2]);
    const to = (attr?.[1] ?? attr?.[2])?.trim() || null;
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

/**
 * A member's fallback when its subscription runs out: '' (as in Ajustes), 'wait' (until it resets), or
 * '<accountId>|<model>' (relay to that one). As the thread's out-of-quota plan, and back.
 */
export function planFromFallback(host, fallback) {
  if (fallback === undefined) return undefined;
  if (!fallback) return null;
  if (fallback === 'wait') return { mode: 'wait', targets: [] };
  const [accountId, model] = String(fallback).split('|');
  return host._validPlan({ mode: 'chain', targets: [{ accountId, model: model || 'default' }] });
}
export function fallbackOf(plan) {
  if (!plan) return '';
  if (plan.mode === 'wait') return 'wait';
  const t = plan.mode === 'chain' && plan.targets?.[0];
  return t ? `${t.accountId}|${t.model || 'default'}` : '';
}

/** Instructions as stored: trimmed, at most 2000 characters, or undefined. */
const noteOf = (x) => String(x ?? '').trim().slice(0, 2000) || undefined;

/** What you wrote for this agent when creating the team, if anything. */
const notesOf = (member) => (member.notes ? `\nIndicaciones del usuario para ti:\n${member.notes}\n` : '');

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
${executors.some((e) => host.threads.get(e.threadId)?.worktree) ? '<relevo:integrar de="Ejecutor 2"/>  fusiona en la rama principal el worktree de un ejecutor que ha terminado (lo hace Relevo, sin que tú toques git).\n' : ''}<relevo:fin>resumen para el usuario</relevo:fin>  cuando el objetivo esté cumplido y revisado.

<relevo:urgente para="${executors[0]?.name ?? 'Ejecutor 1'}">…</relevo:urgente>  solo si lo que está haciendo ahora es claramente erróneo o ya no sirve: interrumpe su turno.

Cómo funciona la entrega: a un agente que está trabajando solo le llega lo urgente; lo demás Relevo no se lo entrega (te lo dirá). No hace falta: cuando termine recibirás su informe y entonces decides su siguiente tarea, con información fresca. Relevo te enviará los informes, dudas y bloqueos de cada agente con su nombre delante («[${executors[0]?.name ?? 'Ejecutor 1'} · informe]», «… · pregunta») y al final el estado del equipo (quién trabaja y cuántos mensajes tuyos le esperan). Reglas:
- No acuses recibo ni contestes a informes de progreso («compilando…», «sigo con…»): si no hay nada nuevo que pedir, responde sin órdenes y espera.
- No mandes nada a quien está trabajando salvo que sea urgente: espera a su informe (mira el estado del equipo). Quien espera un trabajo en segundo plano (una compilación, un emulador) también está trabajando: te informará cuando acabe.
- Una respuesta a quien no te ha preguntado nada no se entrega: se guarda y le llega con su siguiente tarea. No respondas a informes con ESTADO: esperando.
- No hagas tú el trabajo de los ejecutores (depurar, compilar, hacer commits o merges): pídeselo a ellos${executors.some((e) => host.threads.get(e.threadId)?.worktree) ? ' o usa integrar' : ''}.
- Toda respuesta y tarea lleva para="…". No existen otras órdenes ni opciones («force», «redirect»…) aparte de las de arriba.
- Tareas pequeñas y comprobables. No des a dos ejecutores los mismos ficheros a la vez.
${researcher ? `- Antes de que un ejecutor construya algo que ya puede existir (una librería, un proyecto open source, un ejemplo), o en cuanto lleve dos intentos fallidos con el mismo problema, pide al ${researcher.name} que lo busque, y pasa al ejecutor la recomendación concreta.\n` : '- Si un ejecutor lleva dos intentos fallidos con el mismo problema, para y busca otro enfoque (librerías o proyectos open source que ya lo resuelvan) antes de insistir.\n'}- Responde tú las dudas que puedas. Si solo el usuario puede decidir, pregúntaselo en tu respuesta sin dar órdenes y espera.
- Sé breve y gasta poco: todos ven el código en disco, no lo copies en los mensajes; no leas el proyecto entero, apóyate en los informes y lee solo lo que necesites para decidir.
${notesOf(member)}
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
${notesOf(member)}</relevo_equipo>

`;
  }
  return `<relevo_equipo>
Eres ${member.name} en un equipo de agentes de IA coordinado por un orquestador, desde Relevo. Trabajas en ${t.projectPath}${t.worktree ? ` (tu propio worktree, rama ${t.worktree.branch})` : ''}.

Equipo:
${roster}

- Haz la tarea que te llega. Al terminar, responde con un informe breve que empiece por una línea «ESTADO: hecho», «ESTADO: esperando» o «ESTADO: bloqueado», y luego: qué has hecho, qué ficheros has tocado, cómo lo has comprobado y qué queda. No pegues código: está en disco.
- Si dejas algo en segundo plano (una compilación, un emulador) y terminas el turno para esperarlo, no hace falta que informes: Relevo lo sabe y el orquestador no te escribirá hasta que acabes.
- Si te bloqueas o necesitas una decisión, termina tu respuesta con <relevo:pregunta>tu duda concreta</relevo:pregunta> y espera la respuesta.${researcher ? ` Si llevas dos intentos fallidos con el mismo problema, pregunta: el ${researcher.name} puede buscar soluciones que ya existan.` : ''}
- Otros agentes pueden estar trabajando en el mismo proyecto: toca solo lo que te pidan.
${notesOf(member)}</relevo_equipo>

`;
}

// MARK: - The coordinator

export class Teams {
  constructor(host) {
    this.host = host;
    host.state.teams ??= [];
    this._dropOrphans();
    this._upgrade();
  }

  /**
   * Teams made by an older version: their agents get the current instructions with their next message, and
   * the messages piled up waiting for each of them become one.
   */
  _upgrade() {
    const h = this.host;
    for (const team of this.list) {
      if (team.rules === RULES_VERSION) continue;
      team.rules = RULES_VERSION;
      for (const m of team.members) {
        const t = h.threads.get(m.threadId);
        if (!t) continue;
        t.teamPrimed = false;
        if (m.role === 'researcher' && h.accountsById.get(t.accountId)?.kind === 'codex' && t.mode !== 'plan') {
          t.mode = 'plan';
          h.agents.get(t.id)?.close();
          h.agents.delete(t.id);
        }
        const waiting = t.queued.filter((q) => q.team);
        if (m.role !== 'orchestrator' && waiting.length) {
          // Messages from other agents waiting for a busy member are stale by now: they go, and the
          // orchestrator is told what was dropped. What you wrote yourself stays.
          t.queued = t.queued.filter((q) => !q.team);
          const lines = waiting.map((q) => clip(q.text.replace(/\s+/g, ' '), 120));
          team.notes = [...(team.notes ?? []), `Al actualizar Relevo se han descartado ${waiting.length} mensaje${waiting.length === 1 ? '' : 's'} que esperaban a ${m.name} mientras trabajaba: ${lines.map((x) => `«${x}»`).join(' · ')}. Si algo sigue haciendo falta, dáselo con su siguiente tarea.`].slice(-6);
        } else if (waiting.length > 1) {
          const [first, ...rest] = waiting;
          for (const q of rest) this._merge(first, q.header ?? `[${q.from?.name ?? 'Equipo'}]`, q.text, q.prompt ?? q.text, m.role);
          t.queued = t.queued.filter((q) => !rest.includes(q));
        }
      }
    }
    h._saveState();
  }

  /**
   * Threads pointing at a team that doesn't exist (a creation that failed halfway in 0.6.x) go back to being
   * normal threads, and the empty ones that creation made are removed.
   */
  _dropOrphans() {
    const h = this.host;
    const ids = new Set(this.list.map((x) => x.id));
    for (const t of [...h.threads.values()]) {
      if (!t.team || ids.has(t.team.id)) continue;
      if (!t.items.length) h.deleteThread(t, false);
      else { delete t.team; delete t.teamPrimed; }
      h._saveState();
    }
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
    // A thread that already did work can join as the first executor, keeping its agent and its session.
    const existing = spec.threadId ? h.threads.get(String(spec.threadId).toUpperCase()) : null;
    if (spec.threadId && !existing) throw new Error('Hilo desconocido');
    if (existing?.team) throw new Error('Este hilo ya está en un equipo');
    if (existing) spec.projectId = existing.projectId;
    const executors = (spec.executors ?? []).slice(0, existing ? 3 : 4);
    if (!executors.length && !existing) throw new Error('El equipo necesita al menos un ejecutor');
    if (!h.projects().some((p) => p.id === spec.projectId)) throw new Error('Proyecto desconocido');
    const team = { id: h._uuid(), projectId: spec.projectId, goal, createdAt: Date.now() / 1000, status: 'active', auto: 0, held: [], members: [], rules: RULES_VERSION };
    const make = (role, name, pick, mode, worktree) => this._newMember(team, role, name, pick, mode, worktree);
    const lead = make('orchestrator', 'Orquestador', spec.orchestrator, 'ask', false);
    const mode = ['ask', 'autoEdit', 'full'].includes(spec.mode) ? spec.mode : 'autoEdit';
    const count = executors.length + (existing ? 1 : 0);
    const execName = (i) => (count > 1 ? `Ejecutor ${i + 1}` : 'Ejecutor');
    const projectPath = h.projects().find((p) => p.id === spec.projectId)?.path;
    // Worktrees need a git repository with a commit; without one the executors share the folder.
    const worktrees = !!spec.worktrees && count > 1 && executors.length > 0 && gitops.hasCommits(projectPath);
    if (spec.worktrees && count > 1 && executors.length && !worktrees) {
      h._append(lead, { id: h._uuid(), kind: 'notice', text: 'Sin worktrees: el proyecto no es un repositorio git con algún commit, así que los ejecutores comparten la carpeta' });
    }
    if (existing) {
      const name = execName(0);
      existing.team = { id: team.id, role: 'executor', name };
      existing.teamPrimed = false;
      const plan = planFromFallback(h, spec.threadFallback);
      if (plan !== undefined) existing.limitPlan = plan;
      team.members.push(clean({ threadId: existing.id, role: 'executor', name, notes: noteOf(spec.threadNotes) }));
      h._append(existing, { id: h._uuid(), kind: 'notice', text: `Este hilo es ahora ${name} de un equipo: el Orquestador le irá dando tareas. Puedes seguir escribiéndole tú.` });
      h._changed(existing);
    }
    try {
      executors.forEach((e, i) => make('executor', execName(i + (existing ? 1 : 0)), e, mode, worktrees));
      if (spec.researcher) make('researcher', 'Investigador', spec.researcher, 'ask', false);
    } catch (e) {
      // All or nothing: the threads made so far go, and the thread that was joining is left as it was.
      for (const m of team.members) {
        const t = h.threads.get(m.threadId);
        if (!t) continue;
        if (t === existing) { delete t.team; delete t.teamPrimed; t.items = t.items.filter((i) => !/^Este hilo es ahora/.test(i.text ?? '')); h._changed(t); } else {
          if (t.worktree) { try { h.removeWorktree(t, true, false); } catch {} }
          h.deleteThread(t, false);
        }
      }
      h._saveState();
      h._broadcastSnapshot();
      throw e;
    }
    this.list.push(team);
    // Each agent needs its own process to work at the same time.
    if (h.settings.maxAgents < team.members.length) {
      h.state.settings = { ...h.state.settings, maxAgents: Math.min(8, team.members.length) };
      h._append(lead, { id: h._uuid(), kind: 'notice', text: `Máximo de agentes a la vez subido a ${h.state.settings.maxAgents} para que el equipo trabaje en paralelo` });
    }
    for (const m of team.members) h._saveThread(h.threads.get(m.threadId));
    h._saveState();
    h._broadcastSnapshot();
    let start = 'Empieza: mira el proyecto lo justo, planifica y reparte las primeras tareas.';
    if (existing) {
      // The orchestrator joins work already under way: a brief of that thread instead of reading it all.
      const member = team.members.find((m) => m.threadId === existing.id);
      const accounts = new Map(h.accounts.map((a) => [a.id, a]));
      const brief = threadBrief({ items: existing.items, accounts, workState: gitops.workState(existing.projectPath), budget: 9_000 });
      const busy = h._rt(existing).isRunning ? ` Ahora mismo está en mitad de un turno: su informe te llegará al terminar.` : '';
      start = `${member.name} ya lleva trabajo hecho en este proyecto, en su propio hilo, y conserva su sesión (sabe lo que ha hecho).${busy} Resumen de su hilo:\n\n<hilo_de_${member.name.toLowerCase().replace(/\s+/g, '_')}>\n${brief}\n</hilo_de_${member.name.toLowerCase().replace(/\s+/g, '_')}>\n\nEmpieza: decide el siguiente paso hacia el objetivo y dale una tarea concreta (o pide una investigación si ves que se está atascando). No le pidas que repita lo que ya está hecho.`;
    }
    h._startTurn(lead, goal, false, { prompt: start });
    return { teamId: team.id, threadId: lead.id };
  }

  /** A new thread for a member: its subscription, model and mode, titled with its role and the goal. */
  _newMember(team, role, name, pick, mode, worktree) {
    const h = this.host;
    const t = worktree ? h.createWorktreeThread(team.projectId) : h.createThread(team.projectId);
    const account = h.accountsById.get(pick?.accountId) ?? h.accountsById.get(t.accountId);
    t.accountId = account?.id ?? t.accountId;
    t.model = pick?.model || 'default';
    // A Codex researcher runs read-only: it can read and search without asking, and can't write.
    t.mode = role === 'researcher' && account?.kind === 'codex' ? 'plan' : mode;
    t.title = `${name} · ${clip(team.goal.split('\n')[0], 48)}`;
    t.team = { id: team.id, role, name };
    t.aiTitled = true; // the role and the goal are a better title than one guessed from the first message
    const plan = planFromFallback(h, pick?.fallback);
    if (plan !== undefined) t.limitPlan = plan;
    team.members.push(clean({ threadId: t.id, role, name, notes: noteOf(pick?.notes) }));
    return t;
  }

  /**
   * Changes a team without starting over; what isn't sent stays as it was. The orchestrator is told what
   * changed, and a member whose instructions changed gets them again with its next message.
   * changes: { goal?, members?: [{ threadId, accountId?, model?, notes? }], remove?: [threadId],
   *            add?: { executors?: [{ accountId, model, notes }], researcher?: { accountId, model, notes } },
   *            worktrees?, mode? }
   */
  update(teamId, changes = {}) {
    const h = this.host;
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    const leadMember = team.members.find((m) => m.role === 'orchestrator');
    const news = [];
    const goal = String(changes.goal ?? '').trim();
    if (goal && goal !== team.goal) { team.goal = goal; news.push(`Nuevo objetivo:\n${goal}`); }

    for (const c of changes.members ?? []) {
      const m = team.members.find((x) => x.threadId === String(c.threadId).toUpperCase());
      const t = m && h.threads.get(m.threadId);
      if (!t) continue;
      if (c.notes !== undefined && (noteOf(c.notes) ?? null) !== (m.notes ?? null)) {
        if (noteOf(c.notes)) m.notes = noteOf(c.notes); else delete m.notes;
        t.teamPrimed = false; // its next message carries the new instructions
        if (m.role !== 'orchestrator') news.push(`${m.name} tiene indicaciones nuevas${m.notes ? `: ${clip(m.notes.replace(/\s+/g, ' '), 300)}` : ' (ninguna)'}`);
        else news.push(`Tus indicaciones han cambiado${m.notes ? `:\n${m.notes}` : ': ya no hay ninguna'}`);
      }
      const plan = planFromFallback(h, c.fallback);
      if (plan !== undefined && JSON.stringify(plan) !== JSON.stringify(t.limitPlan ?? null)) { t.limitPlan = plan; h._changed(t); }
      const account = c.accountId && h.accountsById.get(String(c.accountId).toUpperCase());
      const model = c.model || 'default';
      if (account && (account.id !== t.accountId || model !== (t.model || 'default'))) {
        h.select(t, account.id, model, false);
        if (m.role !== 'orchestrator') news.push(`${m.name} pasa a ${account.name} · ${h._modelName(account, model)}`);
      }
    }

    for (const id of changes.remove ?? []) {
      const i = team.members.findIndex((x) => x.threadId === String(id).toUpperCase());
      if (i < 0) continue;
      const m = team.members[i];
      if (m.role === 'orchestrator') throw new Error('El orquestador no se puede quitar: disuelve el equipo');
      if (m.role === 'executor' && team.members.filter((x) => x.role === 'executor').length === 1 && !(changes.add?.executors ?? []).length) {
        throw new Error('El equipo necesita al menos un ejecutor');
      }
      team.members.splice(i, 1);
      const t = h.threads.get(m.threadId);
      if (t) {
        delete t.team; delete t.teamPrimed;
        h._append(t, { id: h._uuid(), kind: 'notice', text: 'Este hilo ha salido del equipo: sigue como un hilo normal' });
        h._changed(t);
      }
      news.push(`${m.name} ha salido del equipo`);
    }

    const added = changes.add ?? {};
    const newExecutors = (added.executors ?? []).slice(0, Math.max(0, 4 - team.members.filter((x) => x.role === 'executor').length));
    if (newExecutors.length) {
      const projectPath = h.projects().find((p) => p.id === team.projectId)?.path;
      const worktrees = changes.worktrees !== false && gitops.hasCommits(projectPath);
      const mode = ['ask', 'autoEdit', 'full'].includes(changes.mode) ? changes.mode : 'autoEdit';
      const taken = new Set(team.members.map((m) => m.name));
      let n = 1;
      for (const e of newExecutors) {
        while (taken.has(`Ejecutor ${n}`) || (n === 1 && taken.has('Ejecutor'))) n++;
        const name = `Ejecutor ${n}`;
        taken.add(name);
        const t = this._newMember(team, 'executor', name, e, mode, worktrees);
        const a = h.accountsById.get(t.accountId);
        news.push(`Se une ${name} (${a?.name ?? 'agente'} · ${h._modelName(a, t.model)}${t.worktree ? `, en su worktree, rama ${t.worktree.branch}` : ', en la misma carpeta'})${noteOf(e.notes) ? ` con estas indicaciones: ${clip(e.notes.replace(/\s+/g, ' '), 300)}` : ''}`);
      }
    }
    if (added.researcher && !team.members.some((m) => m.role === 'researcher')) {
      const t = this._newMember(team, 'researcher', 'Investigador', added.researcher, 'ask', false);
      const a = h.accountsById.get(t.accountId);
      news.push(`Se une el Investigador (${a?.name ?? 'agente'} · ${h._modelName(a, t.model)}): ya puedes pedirle investigaciones`);
    }

    if (h.settings.maxAgents < team.members.length) h.state.settings = { ...h.state.settings, maxAgents: Math.min(8, team.members.length) };
    for (const m of team.members) { const t = h.threads.get(m.threadId); if (t) h._saveThread(t); }
    h._saveState();
    h._broadcastSnapshot();
    if (news.length && leadMember) {
      this._deliver(team, leadMember, `${news.map((x) => `- ${x}`).join('\n')}\n\nTenlo en cuenta a partir de ahora.`, { name: 'Relevo', role: 'relevo', label: 'cambios en el equipo' });
    }
    return {};
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
    const reads = READ_ONLY.has(req.toolName) || (req.toolName === 'commandExecution' && isReadOnlyCommand(req.command));
    if (member.role !== 'executor' && !item.questions?.length && reads) {
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
  onTurnFinished(thread, { text, changes, errors, background = [] }) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member || team.status === 'done') return;
    const h = this.host;
    if (member.role === 'orchestrator') {
      const orders = parseOrders(text);
      for (const o of orders) this._order(team, member, o);
      // A turn with no orders is the orchestrator talking to you (a question, a decision, a summary).
      const said = withoutOrders(text).trim();
      if (!orders.length && said && team.status !== 'done') this._attention(thread, 'orquestador', said);
      team.leadTurns = (team.leadTurns ?? 0) + 1;
      this._maybeRefreshLead(team, thread);
      h._saveState();
      return;
    }
    const orders = parseOrders(text);
    const question = orders.find((o) => o.type === 'pregunta');
    const body = withoutOrders(text);
    const state = /^\s*\**ESTADO:?\**\s*(hecho|esperando|bloqueado)/im.exec(body)?.[1]?.toLowerCase() ?? null;
    if (question) {
      member.awaitingAnswer = true;
      this._setTask(member, 'bloqueado');
      this._toLead(team, member, 'pregunta', `${question.body}${body ? `\n\n(Contexto: ${clip(body.replace(/\s+/g, ' '), 600)})` : ''}`);
      return;
    }
    // A turn that ended with nothing new (no text, no error): nothing to report.
    if (!body.trim() && !errors?.length) return;
    // Waiting for something running in the background: not worth waking the orchestrator; the agent picks
    // up by itself when it ends, and reports then.
    if (background.length && !errors?.length && member.role !== 'researcher') {
      member.waitingFor = background.map((b) => b.description).slice(0, 3);
      this._setTask(member, 'esperando un trabajo en segundo plano');
      h._saveState();
      return;
    }
    member.waitingFor = null;
    const report = [];
    report.push(headTail(elideCode(body, 8), REPORT_MAX));
    if (changes?.files) report.push(`Cambios en disco: ${changes.files} fichero${changes.files === 1 ? '' : 's'} (+${changes.added} −${changes.removed})`);
    if (errors?.length) report.push(`Errores: ${errors.slice(-2).map((e) => clip(e, 300)).join(' · ')}`);
    const kind = member.role === 'researcher' ? 'informe de investigación' : errors?.length && !body ? 'error'
      : state === 'esperando' ? 'espera (no necesita respuesta)' : 'informe';
    this._setTask(member, state === 'bloqueado' ? 'bloqueado' : state === 'esperando' ? 'esperando' : 'hecha');
    // A researcher's report also goes straight to whoever it was for, if it's free to read it now.
    const forName = member.role === 'researcher' ? member.reportFor : null;
    member.reportFor = null;
    const target = forName && findMember(team, forName);
    if (target && target.role !== 'orchestrator') {
      const tt = h.threads.get(target.threadId);
      if (tt && !this._busy(tt)) {
        this._deliver(team, target, report.join('\n\n'), { threadId: thread.id, name: member.name, role: member.role, label: 'informe para ti' });
        report.push(`(También enviado a ${target.name}.)`);
      } else report.push(`(${target.name} está trabajando: no se le ha enviado. Pásale lo que le sirva junto con su siguiente tarea.)`);
    }
    this._toLead(team, member, kind, report.join('\n\n'));
  }

  /** Something in this thread is for you: the apps notify it until you write there. */
  _attention(t, kind, text) {
    if (!t) return;
    t.attention = { kind, text: clip(text.replace(/\s+/g, ' '), 240), at: Date.now() / 1000 };
    this.host._changed(t);
    this.host._broadcastSnapshot();
  }

  /** Working, waiting for an answer, or waiting for something it left running in the background. */
  _busy(t) {
    const r = this.host._rt(t);
    return r.isRunning || r.approvals.size > 0 || r.backgroundTasks?.length > 0;
  }

  /** The member's current task on the team board: what, in which state, since when. */
  _setTask(member, state, text = null) {
    member.task = { text: text ?? member.task?.text ?? null, state, since: Date.now() / 1000 };
  }

  /**
   * A long orchestrator session costs on every turn: past a size it starts a new one, with a brief of its
   * own thread (goal, what each turn did, the latest exchange) and the team instructions again.
   */
  _maybeRefreshLead(team, t) {
    const h = this.host;
    const r = h._rt(t);
    const big = (r.context?.used ?? 0) > LEAD_REFRESH.context || (r.sessionTokens ?? 0) > LEAD_REFRESH.conversation || team.leadTurns >= LEAD_REFRESH.turns;
    if (!big) return;
    team.leadTurns = 0;
    h.agents.get(t.id)?.close();
    h.agents.delete(t.id);
    t.sessionId = null;
    t.handoffPending = true;
    t.freshSession = true;
    t.teamPrimed = false;
    r.sessionTokens = 0;
    r.context = null;
    h._append(t, { id: h._uuid(), kind: 'notice', text: 'Sesión del orquestador renovada para no arrastrar todo el contexto: el siguiente mensaje lleva un resumen de lo hecho' });
    h._changed(t);
  }

  /** After a restart: whoever was waiting for a background job (which the restart stopped) relaunches it. */
  afterRestart() {
    const h = this.host;
    for (const team of this.list) {
      for (const m of team.members) {
        if (!m.waitingFor?.length) continue;
        const t = h.threads.get(m.threadId);
        const jobs = m.waitingFor.join(', ');
        m.waitingFor = null;
        if (!t || this._busy(t)) continue;
        this._setTask(m, 'en curso');
        h._startTurn(t, `Relevo se ha reiniciado y paró lo que tenías en segundo plano (${jobs}).`, false, {
          from: { name: 'Relevo', role: 'relevo', label: 'reinicio' },
          prompt: `(Relevo se ha reiniciado y paró lo que tenías en segundo plano: ${jobs}.) Comprueba si llegó a terminar; si no, vuelve a lanzarlo y sigue con tu tarea.`,
        });
      }
    }
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
      case 'tarea':
      case 'urgente': {
        const to = o.to ? findMember(team, o.to) : executors.length === 1 ? executors[0] : null;
        if (!to || to.role === 'orchestrator') { complain(`No sé a quién va la tarea${o.to ? ` «${o.to}»` : ''}: pon para="…". El equipo: ${team.members.map((m) => m.name).join(', ')}.`); return; }
        if (!o.body) return;
        // Answers saved because it hadn't asked anything go with its next task.
        const notes = to.stash?.length ? `(Notas anteriores del ${lead.name}: ${to.stash.join(' · ')})\n\n` : '';
        const tt = h.threads.get(to.threadId);
        const delivered = !tt || !this._busy(tt) || o.type === 'urgente';
        this._deliver(team, to, `${notes}${o.body}`, { ...from, label: o.type === 'urgente' ? 'urgente' : 'tarea' }, false, o.type === 'urgente');
        if (delivered) { to.stash = []; this._setTask(to, 'en curso', clip(o.body.replace(/\s+/g, ' '), 140)); }
        return;
      }
      case 'investigar': {
        if (!researcher) { complain('Este equipo no tiene investigador: busca tú o pide al usuario que lo añada.'); return; }
        researcher.reportFor = o.to && findMember(team, o.to)?.name || null;
        this._deliver(team, researcher, o.body, { ...from, label: researcher.reportFor ? `investigación para ${researcher.reportFor}` : 'investigación' });
        return;
      }
      case 'respuesta': {
        // Without para=: whoever is waiting for an answer, if only one is; else the only executor.
        const asking = team.members.filter((m) => m.pendingQuestion && m.role !== 'orchestrator');
        const to = o.to ? findMember(team, o.to) : asking.length === 1 ? asking[0] : executors.length === 1 ? executors[0] : null;
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
        if (to.awaitingAnswer) {
          to.awaitingAnswer = false;
          this._deliver(team, to, o.body, { ...from, label: 'respuesta' });
          return;
        }
        // It hadn't asked anything (an acknowledgement, a comment): opening a turn for that costs its whole
        // context. It's kept and goes with its next task.
        to.stash = [...(to.stash ?? []), clip(o.body.replace(/\s+/g, ' '), 300)].slice(-4);
        h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Respuesta guardada para la próxima tarea de ${to.name} (no había preguntado nada)` });
        h._changed(leadThread);
        return;
      }
      case 'integrar': {
        const to = o.to ? findMember(team, o.to) : null;
        const t = to && h.threads.get(to.threadId);
        if (!t?.worktree) { complain(`${to ? `${to.name} no trabaja en un worktree` : 'No sé de quién integrar el trabajo: pon de="…"'}: no hay nada que fusionar.`); return; }
        if (this._busy(t)) { complain(`${to.name} sigue trabajando: integra cuando haya terminado.`); return; }
        h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Integrando el trabajo de ${to.name} (rama ${t.worktree.branch})…` });
        h._changed(leadThread);
        h.mergeWorktree(t, `Relevo: integra el trabajo de ${to.name}`, false).then(
          () => this._deliver(team, lead, `Integrado: la rama ${t.worktree?.branch ?? ''} de ${to.name} está fusionada en ${t.worktree?.base ?? 'la rama principal'}.`, { name: 'Relevo', role: 'relevo', label: 'integración' }),
          (e) => this._deliver(team, lead, `No se ha podido integrar el trabajo de ${to.name}: ${clip(e.message, 600)}. Pídele que lo resuelva (rebase o conflictos) y vuelve a intentarlo.`, { name: 'Relevo', role: 'relevo', label: 'integración' }),
        );
        return;
      }
      case 'fin': {
        team.status = 'done';
        this._attention(leadThread, 'fin', o.body || 'Objetivo cumplido');
        h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Equipo: objetivo cumplido${o.body ? ` · ${clip(o.body.replace(/\s+/g, ' '), 200)}` : ''}` });
        h._changed(leadThread);
        h._broadcastSnapshot();
        return;
      }
      default:
    }
  }

  /** A message to a member: now if it's idle, after its turn otherwise (merged with others waiting for it). */
  _deliver(team, member, text, from, resumed = false, urgent = false) {
    const h = this.host;
    // Someone working only gets urgent orders: anything else would wait until its turn ends, maybe an hour,
    // and be stale by then. The orchestrator gets its report when it finishes and decides with that.
    const target = h.threads.get(member.threadId);
    const busy = target && this._busy(target);
    if (busy && !urgent && member.role !== 'orchestrator' && (from.role === 'orchestrator' || from.role === 'researcher')) {
      this._bounce(team, member, text, from);
      return;
    }
    if (team.status === 'paused' && !resumed) { team.held.push({ to: member, text, from }); return; }
    team.auto += 1;
    if (team.auto > AUTO_LIMIT && team.status === 'active') {
      team.status = 'paused';
      team.held.push({ to: member, text, from });
      const lead = this._lead(team);
      if (lead) {
        h._append(lead, { id: h._uuid(), kind: 'notice', text: `Equipo en pausa tras ${AUTO_LIMIT} mensajes automáticos seguidos sin ti. Reanúdalo cuando quieras.` });
        this._attention(lead, 'pausa', `Equipo en pausa tras ${AUTO_LIMIT} mensajes automáticos seguidos sin ti`);
        h._changed(lead);
      }
      h._broadcastSnapshot();
      return;
    }
    const t = h.threads.get(member.threadId);
    if (!t) return;
    if (member.role === 'orchestrator' && team.notes?.length) {
      text = `${team.notes.map((n) => `(${n})`).join('\n')}\n\n${text}`;
      team.notes = [];
    }
    const header = `[${from.name}${from.label ? ` · ${from.label}` : ''}]`;
    // The orchestrator always sees where the team stands, so it doesn't pile orders on someone busy.
    const status = member.role === 'orchestrator' ? `\n\n(${this._status(team, member)})` : '';
    const prompt = `${header}\n${text}${status}`;
    const meta = { from: { threadId: from.threadId ?? null, name: from.name, role: from.role, label: from.label ?? null } };
    const r = h._rt(t);
    if (urgent && r.isRunning && member.role !== 'orchestrator') {
      h.sendNow(t, text, { ...meta, prompt: `${prompt}\n\n(Esto interrumpe lo que estabas haciendo: atiéndelo primero.)` });
      return;
    }
    if (r.isRunning || r.approvals.size) {
      // Whatever arrives for someone busy goes as one message when its turn ends, not one turn per message.
      const waiting = t.queued.find((q) => q.team);
      if (waiting) this._merge(waiting, header, text, prompt, member.role);
      else t.queued.push({ id: h._uuid(), text, prompt, header, from: meta.from, team: true });
      h._changed(t);
      return;
    }
    h._startTurn(t, text, false, { ...meta, prompt });
  }

  /**
   * An order for someone busy goes back: a line in the orchestrator's thread now (no extra turn), and a note
   * with its next message, so it gives that member what's next after reading its report.
   */
  _bounce(team, member, text, from) {
    const h = this.host;
    const lead = this._lead(team);
    const what = clip(text.replace(/\s+/g, ' '), 140);
    team.notes = [...(team.notes ?? []), `No entregado a ${member.name}, que estaba trabajando: «${what}». Decide qué darle cuando llegue su informe; si no podía esperar, usa urgente.`].slice(-6);
    if (lead) {
      h._append(lead, { id: h._uuid(), kind: 'notice', text: `No entregado a ${member.name} (está trabajando): ${from.role === 'researcher' ? 'el informe del Investigador' : 'tu mensaje'} queda para cuando termine` });
      h._changed(lead);
    }
    h._saveState();
  }

  /** Adds a message to the one already waiting for a member. */
  _merge(waiting, header, text, prompt, role) {
    if (!waiting.merged) {
      waiting.text = `${waiting.header ?? ''}\n${waiting.text}`.trim();
      if (role !== 'orchestrator') waiting.prompt = `(Varios mensajes que te llegaron mientras trabajabas, en orden; si se contradicen, vale el último.)\n\n${waiting.prompt}`;
    }
    waiting.merged = true;
    waiting.text += `\n\n${header}\n${text}`;
    waiting.prompt += `\n\n${prompt}`;
    waiting.from = { name: 'Equipo', role: 'team', label: 'varios mensajes' };
  }

  /** «Ejecutor 1 trabajando, con 2 mensajes tuyos sin entregar · Ejecutor 2 libre · …» */
  _status(team, lead) {
    const h = this.host;
    const parts = team.members.filter((m) => m !== lead).map((m) => {
      const t = h.threads.get(m.threadId);
      if (!t) return null;
      const r = h._rt(t);
      const waiting = t.queued.filter((q) => q.team).reduce((n, q) => n + (q.merged ? (q.text.match(/^\[/gm) ?? []).length : 1), 0);
      const state = r.approvals.size ? 'esperando una respuesta o una aprobación' : r.isRunning ? 'trabajando'
        : r.backgroundTasks?.length ? `esperando un trabajo en segundo plano (${r.backgroundTasks.map((b) => b.description).slice(0, 2).join(', ')})` : 'libre';
      const task = m.task?.text ? ` · tarea «${clip(m.task.text, 90)}» (${m.task.state} desde las ${new Date(m.task.since * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })})` : '';
      return `${m.name} ${state}${waiting ? `, con ${waiting} mensaje${waiting === 1 ? '' : 's'} sin entregar` : ''}${task}`;
    }).filter(Boolean);
    return `Estado del equipo: ${parts.join(' | ')}`;
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
