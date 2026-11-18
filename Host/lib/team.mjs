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
const RULES_VERSION = 6;
/** The orchestrator gets a fresh session (with a brief of its own thread) past any of these. */
const LEAD_REFRESH = { context: 150_000, conversation: 1_200_000, turns: 60, share: 0.6 };
/** Decisions the team keeps (the oldest go first past this). */
const DECISIONS_MAX = 40;
/** Research reports the team keeps, and how many the agents are reminded of. */
const FINDINGS_MAX = 60, FINDINGS_SHOWN = 15;
/** A background job older than this (seconds) gets its agent asked to check it, then again every so often. */
export const BG_CHECK = Number(process.env.RELEVO_BG_CHECK ?? 1800);
/** From this hour (host time) each team that worked today gets its day's summary. */
const SUMMARY_HOUR = 21;
/** Executors and the researcher start a fresh session past this share of their window (or LEAD_REFRESH.context). */
const MEMBER_REFRESH = { share: 0.7, context: 180_000, conversation: 2_000_000 };

/** Automatic messages in a row (with no message from you) before the team pauses itself. */
export const AUTO_LIMIT = 60;
const REPORT_MAX = 2_500;

// MARK: - Orders in the agents' replies

const TAG = /<relevo:(tarea|urgente|investigar|respuesta|pregunta|integrar|fin|decisi[oó]n|descartar|hito|hecho)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/relevo:\1\s*>)/gi;
const FENCED = /```[\s\S]*?(?:```|$)/g;

/** The orders in a reply, outside code blocks: [{ type, to, body }]. */
export function parseOrders(text) {
  const plain = String(text ?? '').replace(FENCED, '');
  const out = [];
  for (const m of plain.matchAll(TAG)) {
    // para="…" (or de="…" for integrar) anywhere among the attributes, quoted or not.
    const attr = /\b(?:para|de)\s*=\s*(?:["“']([^"”']+)["”']|([^\s"”'>/]+))/i.exec(m[2]);
    const to = (attr?.[1] ?? attr?.[2])?.trim() || null;
    out.push({ type: m[1].toLowerCase().replace('decisión', 'decision'), to, body: (m[3] ?? '').trim() });
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
    // A name it had before you renamed it (the orchestrator may still use it for a while).
    ?? team.members.find((m) => (m.formerNames ?? []).some((x) => norm(x) === n))
    ?? null;
}

/** A member's name as you typed it: one line, no quotes or angle brackets (it goes in para="…"), at most 32. */
export function memberName(s) {
  return String(s ?? '').replace(/["“”'<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
}
const RESERVED = new Set(['relevo', 'usuario', 'tu', 'yo', 'todos', 'equipo']);

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
export function planFromFallback(host, fallback, role = 'executor') {
  if (fallback === undefined) return undefined;
  if (!fallback) return null;
  if (fallback === 'wait') return { mode: 'wait', targets: [] };
  // The best model with quota for its role, chosen when it runs out: the strongest for an executor, a light
  // one for the orchestrator and the researcher.
  if (fallback === 'auto') return { mode: 'smart', targets: [], tier: role === 'executor' ? 'heavy' : 'light' };
  const [accountId, model] = String(fallback).split('|');
  return host._validPlan({ mode: 'chain', targets: [{ accountId, model: model || 'default' }] });
}
export function fallbackOf(plan) {
  if (!plan) return '';
  if (plan.mode === 'wait') return 'wait';
  if (plan.mode === 'smart') return 'auto';
  const t = plan.mode === 'chain' && plan.targets?.[0];
  return t ? `${t.accountId}|${t.model || 'default'}` : '';
}

/** Instructions as stored: trimmed, at most 2000 characters, or undefined. */
const noteOf = (x) => String(x ?? '').trim().slice(0, 2000) || undefined;

/** What you wrote for this agent when creating the team, if anything. */
const notesOf = (member) => (member.notes ? `\nIndicaciones del usuario para ti:\n${member.notes}\n` : '');

/** The team's decisions, for an agent starting (or starting over): what not to reopen. */
export function decisionsBlock(team) {
  const list = team.decisions ?? [];
  if (!list.length) return '';
  return `\nDecisiones del equipo (ya tomadas: síguelas y no las reabras salvo que aparezca evidencia nueva que las contradiga; en ese caso dilo antes de cambiar de rumbo):\n${list.map((d) => `#${d.id} ${d.text}`).join('\n')}\n`;
}

/** The goal's milestones: done, and the one in progress (the first not done). */
export function milestonesBlock(team, forLead = false) {
  const list = team.milestones ?? [];
  if (!list.length) return forLead ? '\nHitos: aún no hay. Escríbelos al planificar (de 3 a 8, comprobables, en orden).\n' : '';
  const current = list.find((m) => !m.done);
  return `\nHitos del objetivo (${list.filter((m) => m.done).length}/${list.length}):\n${list.map((m) => `${m.done ? '✓' : m === current ? '→' : '○'} #${m.id} ${m.text}`).join('\n')}\n`;
}

/** What the researcher already found: reuse it, ask only for what's new. */
export function findingsBlock(team) {
  const list = (team.findings ?? []).slice(-FINDINGS_SHOWN);
  if (!list.length) return '';
  return `\nYa investigado en este equipo (reutilízalo; investiga solo lo nuevo o para ampliar algo concreto):\n${list.map((f) => `#${f.id} ${clip(f.topic, 110)} — ${clip(f.summary.split('\n').find((l) => l.trim()) ?? '', 170)}`).join('\n')}\n`;
}

/** Where the team stood when the orchestrator starts a fresh session: the board and each agent's last report. */
function boardBlock(host, team, lead) {
  const reports = team.members.filter((m) => m !== lead && m.lastReport).map((m) => `- ${m.name} (${new Date(m.lastReport.at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}): ${m.lastReport.text}`);
  return `\nDónde está el equipo ahora (vienes de una sesión anterior; esto y las decisiones son lo que importa de ella):\n${host.teams._status(team, lead)}\n${reports.length ? `Último informe de cada uno:\n${reports.join('\n')}\n` : ''}`;
}

export function preamble(host, team, member, fresh = false) {
  const taskLine = fresh && member.role !== 'orchestrator' && member.task?.text ? `\nVienes de una sesión anterior. Tu tarea actual (${member.task.state}): ${member.task.text}\n` : '';
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
<relevo:hito>un paso comprobable hacia el objetivo</relevo:hito>  añade un hito (en orden); <relevo:hecho>2</relevo:hecho> marca el #2 como conseguido cuando lo hayas comprobado. Relevo los muestra al usuario como progreso y te los recuerda siempre.
<relevo:decision>una decisión firme, en una línea (qué y por qué)</relevo:decision>  Relevo la guarda y se la recuerda a todo el equipo, también a ti en tus sesiones nuevas. Úsala para lo que no debe reabrirse: tecnologías y proyectos elegidos (p. ej. «usamos shadPS4 como referencia para GNM»), enfoques descartados y por qué, criterios del usuario. <relevo:descartar>3</relevo:descartar> retira la decisión #3 si deja de valer.

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
${notesOf(member)}${milestonesBlock(team, true)}${decisionsBlock(team)}${findingsBlock(team)}${fresh ? boardBlock(host, team, member) : ''}
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
- Relevo guarda cada informe tuyo en la biblioteca del equipo: empieza con una línea de conclusión («Conclusión: …»).
${notesOf(member)}${decisionsBlock(team)}${findingsBlock(team)}${taskLine}</relevo_equipo>

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
${notesOf(member)}${decisionsBlock(team)}${taskLine}</relevo_equipo>

`;
}

// MARK: - The coordinator

export class Teams {
  constructor(host) {
    this.host = host;
    host.state.teams ??= [];
    this._dropOrphans();
    this._upgrade();
    this._watch = setInterval(() => {
      try { this.watchBackground(); this._maybeSummary(); } catch (e) { host.log?.(`team watch: ${e.message}`); }
    }, Math.min(60, BG_CHECK / 2) * 1000);
    this._watch.unref?.();
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
      const plan = planFromFallback(h, spec.threadFallback, 'executor');
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
    const plan = planFromFallback(h, pick?.fallback, role);
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
    // Names first, all of them checked before anything changes.
    const renames = new Map();
    for (const c of changes.members ?? []) {
      if (c.name === undefined) continue;
      const m = team.members.find((x) => x.threadId === String(c.threadId).toUpperCase());
      const name = memberName(c.name);
      if (!m || name === m.name) continue;
      if (!name) throw new Error('Cada agente necesita un nombre');
      if (RESERVED.has(norm(name))) throw new Error(`«${name}» no puede ser el nombre de un agente`);
      renames.set(m, name);
    }
    const finalName = (m) => renames.get(m) ?? m.name;
    const leaving = new Set((changes.remove ?? []).map((id) => String(id).toUpperCase()));
    const seen = new Set();
    for (const m of team.members) {
      if (leaving.has(m.threadId)) continue;
      const n = norm(finalName(m));
      if (seen.has(n)) throw new Error(`Dos agentes no pueden llamarse «${finalName(m)}»`);
      seen.add(n);
    }
    for (const [m, name] of renames) {
      const old = m.name;
      m.formerNames = [...new Set([...(m.formerNames ?? []), old])].filter((x) => norm(x) !== norm(name)).slice(-4);
      if (!m.formerNames.length) delete m.formerNames;
      m.name = name;
      const t = h.threads.get(m.threadId);
      if (t) {
        if (t.team) t.team = { ...t.team, name };
        if (t.title?.startsWith(`${old} · `)) t.title = `${name} · ${t.title.slice(old.length + 3)}`;
        t.teamPrimed = false; // its next message says who it is now
        h._append(t, { id: h._uuid(), kind: 'notice', text: `${old} ahora se llama ${name}` });
        h._changed(t);
      }
      news.push(m.role === 'orchestrator' ? `Ahora te llamas ${name}` : `${old} ahora se llama ${name}: usa ese nombre en para="…"`);
    }
    if (changes.budget !== undefined) {
      const usd = Number(changes.budget?.usd);
      team.budget = usd > 0 ? { usd: Math.round(usd * 100) / 100, action: changes.budget.action === 'light' ? 'light' : 'pause' } : null;
      team.budgetDay = null;
    }
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
      const plan = planFromFallback(h, c.fallback, m.role);
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
    if (!team || !member) return '';
    // Notes for the orchestrator (decisions you set or withdrew…) also go with a message you write it.
    let notes = '';
    if (member.role === 'orchestrator' && team.notes?.length) {
      notes = `${team.notes.map((n) => `(${n})`).join('\n')}\n\n`;
      team.notes = [];
    }
    if (thread.teamPrimed && !freshSession) return notes;
    thread.teamPrimed = true;
    member.decisionsSeen = team.nextDecision ?? 0; // the preamble lists them all
    return preamble(this.host, team, member, !!freshSession) + notes;
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
    this._checkBudget(team);
    if (member.role === 'orchestrator') {
      const orders = parseOrders(text);
      this._dispatch(team, member, thread, orders);
      // A turn with no orders is the orchestrator talking to you (a question, a decision, a summary).
      const said = withoutOrders(text).trim();
      if (!orders.some((o) => !['decision', 'descartar', 'hito', 'hecho'].includes(o.type)) && said && team.status !== 'done') this._attention(thread, 'orquestador', said);
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
    if (member.role === 'researcher' && body.trim()) {
      this.addFinding(team, { topic: member.inquiry || clip(body.split('\n').find((l) => l.trim()) ?? '', 200), body, by: member.name });
      member.inquiry = null;
    }
    // Executors sharing one folder: uncommitted work piles up and gets mixed.
    if (member.role === 'executor' && !thread.worktree) {
      const others = team.members.filter((m) => m !== member && m.role === 'executor' && !h.threads.get(m.threadId)?.worktree);
      const files = others.length && gitops.isRepo(thread.projectPath) ? gitops.status(thread.projectPath).files.length : 0;
      if (files >= 1) report.push(`Carpeta compartida con ${others.map((m) => m.name).join(', ')}: ${files} fichero${files === 1 ? '' : 's'} sin commit. Pide que cada uno haga commit de lo suyo al cerrar cada tarea, para no mezclar trabajo.`);
    }
    // What it said last, for the orchestrator's next fresh session.
    member.lastReport = { text: clip(headTail(elideCode(body, 4), 900).replace(/\n{2,}/g, '\n'), 900), at: Date.now() / 1000 };
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
    this._maybeRefreshMember(team, member, thread);
  }

  /** The orders of the orchestrator's turn not sent yet (some may have gone when it started waiting on a timer). */
  _dispatch(team, member, thread, orders) {
    const r = this.host._rt(thread);
    r.sentOrders ??= new Set();
    for (const o of orders) {
      const sig = `${o.type}|${o.to ?? ''}|${o.body}`;
      if (r.sentOrders.has(sig)) continue;
      r.sentOrders.add(sig);
      this._order(team, member, o);
    }
  }

  /**
   * A tool started in a team thread. The orchestrator waiting on a timer (Antigravity's schedule, a sleep) keeps
   * its turn open: the orders it wrote so far go now instead of when the timer ends, and while it only waits, a
   * message for it interrupts the wait (see _deliver).
   */
  onToolStarted(thread, name, title, input, turnText) {
    const member = this.memberOf(thread);
    const team = this.of(thread);
    if (!team || member?.role !== 'orchestrator') return;
    const r = this.host._rt(thread);
    r.waitingTimer = isWaitTool(name, title, input);
    if (!r.waitingTimer) return;
    // Who it's waiting for, if the timer says (Antigravity's schedule carries what it's for).
    const said = `${title ?? ''} ${JSON.stringify(input ?? {})}`;
    r.waitingFor = team.members.filter((m) => m !== member && new RegExp(`\\b${m.name.replace(/\s+/g, '\\s*')}\\b`, 'i').test(said)).map((m) => m.name);
    this._dispatch(team, member, thread, parseOrders(turnText));
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
  /** Keeps a decision for the whole team (from the orchestrator or you). Returns it, or null if it was already there. */
  addDecision(team, text, by) {
    const clean = clip(String(text ?? '').replace(/\s+/g, ' ').trim(), 400);
    if (!clean) return null;
    team.decisions ??= [];
    if (team.decisions.some((d) => norm(d.text) === norm(clean))) return null;
    team.nextDecision = (team.nextDecision ?? 0) + 1;
    const d = { id: team.nextDecision, text: clean, by, at: Date.now() / 1000 };
    team.decisions.push(d);
    if (team.decisions.length > DECISIONS_MAX) team.decisions.splice(0, team.decisions.length - DECISIONS_MAX);
    this.host._saveState();
    this.host._broadcastSnapshot();
    return d;
  }

  /** Withdraws decisions by number ("3", "#3, #5"). */
  dropDecisions(team, which) {
    const ids = new Set(String(which ?? '').match(/\d+/g)?.map(Number) ?? []);
    const gone = (team.decisions ?? []).filter((d) => ids.has(d.id));
    if (!gone.length) return [];
    team.decisions = team.decisions.filter((d) => !ids.has(d.id));
    this.host._saveState();
    this.host._broadcastSnapshot();
    return gone;
  }

  /** You add or withdraw a decision from the apps: the orchestrator hears it with its next message. */
  editDecisions(teamId, { add, remove } = {}) {
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    const lead = team.members.find((m) => m.role === 'orchestrator');
    if (add) {
      const d = this.addDecision(team, add, 'usuario');
      if (!d) throw new Error(String(add).trim() ? 'Esa decisión ya está guardada' : 'Escribe la decisión');
      team.notes = [...(team.notes ?? []), `El usuario ha fijado la decisión #${d.id}: ${d.text}`];
    }
    if (remove !== undefined && remove !== null) {
      const gone = this.dropDecisions(team, String(remove));
      if (gone.length) team.notes = [...(team.notes ?? []), `El usuario ha retirado ${gone.map((d) => `la decisión #${d.id} («${clip(d.text, 120)}»)`).join(' y ')}`];
    }
    if (lead) lead.decisionsSeen = team.nextDecision ?? 0; // told through the notes instead
    return {};
  }

  addMilestone(team, text) {
    const clean = clip(String(text ?? '').replace(/\s+/g, ' ').trim(), 240);
    if (!clean) return null;
    team.milestones ??= [];
    if (team.milestones.some((m) => norm(m.text) === norm(clean))) return null;
    team.nextMilestone = (team.nextMilestone ?? 0) + 1;
    const m = { id: team.nextMilestone, text: clean, done: false, at: Date.now() / 1000 };
    team.milestones.push(m);
    this._memoryChanged();
    return m;
  }

  /** Marks milestones done (or not) by number. Returns the ones that changed. */
  setMilestones(team, which, done) {
    const ids = new Set(String(which ?? '').match(/\d+/g)?.map(Number) ?? []);
    const changed = (team.milestones ?? []).filter((m) => ids.has(m.id) && m.done !== done);
    for (const m of changed) { m.done = done; m.doneAt = done ? Date.now() / 1000 : undefined; }
    if (changed.length) this._memoryChanged();
    return changed;
  }

  /** A research report into the team's library (its conclusion line first, links kept apart). */
  addFinding(team, { topic, body, by }) {
    const text = String(body ?? '');
    const conclusion = /^\s*\**conclusi[oó]n:?\**\s*(.+)$/im.exec(text)?.[1];
    const summary = clip((conclusion ? `${conclusion}\n` : '') + headTail(elideCode(text, 4), 700).replace(/\n{2,}/g, '\n'), 800);
    const links = [...new Set(text.match(/https?:\/\/[^\s)>\]"'`]+/g) ?? [])].slice(0, 8);
    team.findings ??= [];
    team.nextFinding = (team.nextFinding ?? 0) + 1;
    const f = { id: team.nextFinding, topic: clip(String(topic ?? '').replace(/\s+/g, ' ').trim() || 'Investigación', 200), summary, links, by, at: Date.now() / 1000 };
    team.findings.push(f);
    if (team.findings.length > FINDINGS_MAX) team.findings.splice(0, team.findings.length - FINDINGS_MAX);
    this._memoryChanged();
    return f;
  }

  /** Today's spend of the whole team (tokens and cost of every member's turns since midnight). */
  spendToday(team) {
    let tokens = 0, cost = 0;
    for (const m of team.members) {
      const t = this.host.threads.get(m.threadId);
      const sp = t && this.host._spendToday(t);
      tokens += sp?.tokens ?? 0;
      cost += sp?.cost ?? 0;
    }
    return { tokens, cost };
  }

  /** Over its daily budget: the team pauses, or its orchestrator and researcher move to light models. Once a day. */
  _checkBudget(team) {
    if (!team.budget?.usd) return;
    const day = new Date().toDateString();
    if (team.budgetDay === day) return;
    const { cost } = this.spendToday(team);
    if (cost < team.budget.usd) return;
    team.budgetDay = day;
    const h = this.host;
    const lead = this._lead(team);
    const spent = `${cost.toFixed(2)} USD de ${team.budget.usd.toFixed(2)}`;
    if (team.budget.action === 'light') {
      const moved = [];
      for (const m of team.members.filter((x) => x.role !== 'executor')) {
        const t = h.threads.get(m.threadId);
        if (!t) continue;
        const target = h._smartTarget(t, 'light', true);
        if (!target || (target.accountId === t.accountId && target.model === t.model)) continue;
        h.select(t, target.accountId, target.model, false, true);
        const a = h.accountsById.get(target.accountId);
        moved.push(`${m.name} → ${a?.name} · ${h._modelName(a, target.model)}`);
      }
      if (lead) {
        h._append(lead, { id: h._uuid(), kind: 'notice', text: `Presupuesto de hoy superado (${spent}): ${moved.length ? `pasan a modelos ligeros ${moved.join(', ')}` : 'ya usaban modelos ligeros'}` });
        this._attention(lead, 'presupuesto', `Presupuesto de hoy superado (${spent})`);
      }
    } else {
      team.status = 'paused';
      if (lead) {
        h._append(lead, { id: h._uuid(), kind: 'notice', text: `Equipo en pausa: presupuesto de hoy superado (${spent}). Reanúdalo cuando quieras.` });
        this._attention(lead, 'presupuesto', `Equipo en pausa: presupuesto de hoy superado (${spent})`);
      }
    }
    h._saveState();
    h._broadcastSnapshot();
  }

  /**
   * The day's summary in the orchestrator's thread, without an AI: milestones reached, decisions, research and
   * spend. Once a day, from SUMMARY_HOUR, for teams that worked that day.
   */
  dailySummary(team, at = new Date()) {
    const h = this.host;
    const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
    const since = midnight.getTime() / 1000;
    const today = (x) => (x ?? 0) >= since;
    const lines = [];
    const ms = team.milestones ?? [];
    const reached = ms.filter((m) => m.done && today(m.doneAt));
    if (ms.length) lines.push(`Hitos: ${ms.filter((m) => m.done).length}/${ms.length}${reached.length ? ` · hoy: ${reached.map((m) => `#${m.id} ${m.text}`).join('; ')}` : ' · ninguno nuevo hoy'}${ms.find((m) => !m.done) ? ` · ahora: ${ms.find((m) => !m.done).text}` : ''}`);
    const ds = (team.decisions ?? []).filter((d) => today(d.at));
    if (ds.length) lines.push(`Decisiones nuevas: ${ds.map((d) => `#${d.id} ${clip(d.text, 120)}`).join('; ')}`);
    const fs = (team.findings ?? []).filter((f) => today(f.at));
    if (fs.length) lines.push(`Investigado: ${fs.map((f) => clip(f.topic, 80)).join('; ')}`);
    const spend = team.members.map((m) => { const t = h.threads.get(m.threadId); const sp = t && h._spendToday(t); return sp?.tokens ? `${m.name} ${Math.round(sp.tokens / 1000)}k tokens${sp.cost ? ` (${sp.estimated ? '≈ ' : ''}${sp.cost.toFixed(2)} USD)` : ''}` : null; }).filter(Boolean);
    if (spend.length) lines.push(`Gasto: ${spend.join(' · ')}`);
    const tasks = team.members.filter((m) => m.role !== 'orchestrator' && m.task?.text).map((m) => `${m.name}: ${clip(m.task.text, 90)} (${m.task.state})`);
    if (tasks.length) lines.push(`En curso: ${tasks.join(' · ')}`);
    return lines.length ? `Resumen de hoy\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
  }

  _maybeSummary(now = new Date()) {
    if (now.getHours() < SUMMARY_HOUR) return;
    const day = now.toDateString();
    for (const team of this.list) {
      if (team.summaryDay === day || team.status === 'done') continue;
      if (!this.spendToday(team).tokens) continue;
      team.summaryDay = day;
      const text = this.dailySummary(team, now);
      const lead = this._lead(team);
      if (!text || !lead) continue;
      this.host._append(lead, { id: this.host._uuid(), kind: 'notice', text });
      this._attention(lead, 'resumen', text.split('\n').slice(1, 3).join(' '));
      this.host._saveState();
    }
  }

  _memoryChanged() {
    this.host._saveState();
    this.host._broadcastSnapshot();
  }

  /**
   * You change the team's memory from the apps: decisions, milestones (add, toggle, remove) and research
   * (remove). The orchestrator hears what matters with its next message.
   */
  editMemory(teamId, { kind, add, remove, toggle } = {}) {
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    if (kind === 'decision') return this.editDecisions(teamId, { add, remove });
    const ids = (x) => new Set(String(x ?? '').match(/\d+/g)?.map(Number) ?? []);
    const tell = (n) => { team.notes = [...(team.notes ?? []), n]; };
    if (kind === 'milestone') {
      if (add) {
        const m = this.addMilestone(team, add);
        if (!m) throw new Error(String(add).trim() ? 'Ese hito ya está' : 'Escribe el hito');
        tell(`El usuario ha añadido el hito #${m.id}: ${m.text}`);
      }
      if (toggle) {
        for (const m of (team.milestones ?? []).filter((x) => ids(toggle).has(x.id))) {
          this.setMilestones(team, String(m.id), !m.done);
          tell(`El usuario ha marcado el hito #${m.id} como ${m.done ? 'conseguido' : 'pendiente'}`);
        }
      }
      if (remove) {
        const gone = (team.milestones ?? []).filter((x) => ids(remove).has(x.id));
        team.milestones = (team.milestones ?? []).filter((x) => !ids(remove).has(x.id));
        if (gone.length) { tell(`El usuario ha quitado ${gone.map((m) => `el hito #${m.id}`).join(' y ')}`); this._memoryChanged(); }
      }
      return {};
    }
    if (kind === 'finding') {
      if (remove) { team.findings = (team.findings ?? []).filter((x) => !ids(remove).has(x.id)); this._memoryChanged(); }
      return {};
    }
    throw new Error('Tipo desconocido');
  }

  /**
   * An executor or the researcher whose session grew too big starts a fresh one (with a brief, the decisions
   * and its task), like the orchestrator. Never while it has something running in the background.
   */
  _maybeRefreshMember(team, member, t) {
    const h = this.host;
    const r = h._rt(t);
    if (r.backgroundTasks?.length || r.isRunning) return;
    const limit = Math.min(MEMBER_REFRESH.context, (r.context?.window ?? Infinity) * MEMBER_REFRESH.share);
    if ((r.context?.used ?? 0) <= limit && (r.sessionTokens ?? 0) <= MEMBER_REFRESH.conversation) return;
    h.agents.get(t.id)?.close();
    h.agents.delete(t.id);
    t.sessionId = null;
    t.sessions = {}; // older sessions are bigger still: none is resumed after this
    t.handoffPending = true;
    t.freshSession = true;
    t.teamPrimed = false;
    r.sessionTokens = 0;
    r.context = null;
    h._append(t, { id: h._uuid(), kind: 'notice', text: 'Sesión renovada para no arrastrar todo el contexto: el siguiente mensaje lleva un resumen, su tarea y las decisiones del equipo' });
    h._changed(t);
  }

  /**
   * A job left running in the background for a long time may have hung (a stuck emulator, a dead process with
   * its waiter still alive): its agent is asked to look, once per BG_CHECK.
   */
  watchBackground(now = Date.now() / 1000) {
    const h = this.host;
    for (const team of this.list) {
      if (team.status !== 'active') continue;
      for (const member of team.members) {
        const t = h.threads.get(member.threadId);
        if (!t) continue;
        const r = h._rt(t);
        if (r.isRunning || r.approvals.size || !r.backgroundTasks?.length) continue;
        r.bgChecked ??= {};
        const old = r.backgroundTasks.filter((b) => now - (r.bgChecked[b.id] ?? b.startedAt ?? now) >= BG_CHECK);
        if (!old.length) continue;
        for (const b of old) r.bgChecked[b.id] = now;
        const list = old.map((b) => `«${b.description}» (lleva ${Math.round((now - (b.startedAt ?? now)) / 60)} min)`).join(', ');
        this._deliver(team, member, `Tienes en segundo plano ${list}. Comprueba que sigue avanzando (su log, su proceso, si su salida crece). Si está colgado o el proceso ha muerto, páralo y cuéntalo en tu informe; si va bien, di en una línea cómo va y sigue esperando.`, { name: 'Relevo', role: 'relevo', label: 'comprobación' });
      }
    }
  }

  _maybeRefreshLead(team, t) {
    const h = this.host;
    const r = h._rt(t);
    // A model with a small window renews sooner, one with a big window no later than LEAD_REFRESH.context.
    const contextLimit = Math.min(LEAD_REFRESH.context, (r.context?.window ?? Infinity) * LEAD_REFRESH.share);
    const big = (r.context?.used ?? 0) > contextLimit || (r.sessionTokens ?? 0) > LEAD_REFRESH.conversation || team.leadTurns >= LEAD_REFRESH.turns;
    if (!big) return;
    team.leadTurns = 0;
    h.agents.get(t.id)?.close();
    h.agents.delete(t.id);
    t.sessionId = null;
    t.sessions = {}; // older sessions are bigger still: none is resumed after this
    t.handoffPending = true;
    t.freshSession = true;
    t.teamPrimed = false;
    r.sessionTokens = 0;
    r.context = null;
    h._append(t, { id: h._uuid(), kind: 'notice', text: `Sesión del orquestador renovada para no arrastrar todo el contexto: el siguiente mensaje lleva un resumen, el estado del equipo${team.decisions?.length ? ` y las ${team.decisions.length} decisiones guardadas` : ''}` });
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
        researcher.inquiry = clip(o.body.replace(/\s+/g, ' '), 300);
        this._deliver(team, researcher, `${o.body}${findingsBlock(team) ? `\n${findingsBlock(team)}` : ''}`, { ...from, label: researcher.reportFor ? `investigación para ${researcher.reportFor}` : 'investigación' });
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
      case 'hito': {
        const m = this.addMilestone(team, o.body);
        if (m) { h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Hito #${m.id}: ${clip(m.text, 200)}` }); h._changed(leadThread); }
        return;
      }
      case 'hecho': {
        const done = this.setMilestones(team, o.body || o.to, true);
        for (const m of done) h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Hito conseguido: #${m.id} ${clip(m.text, 200)} (${team.milestones.filter((x) => x.done).length}/${team.milestones.length})` });
        if (done.length) h._changed(leadThread);
        return;
      }
      case 'decision': {
        const d = this.addDecision(team, o.body, lead.name);
        if (d) {
          lead.decisionsSeen = d.id;
          h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Decisión #${d.id} guardada: ${clip(d.text, 200)}` });
          h._changed(leadThread);
        }
        return;
      }
      case 'descartar': {
        const gone = this.dropDecisions(team, o.body || o.to);
        if (gone.length) {
          h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Decisión retirada: ${gone.map((d) => `#${d.id}`).join(', ')}` });
          h._changed(leadThread);
        }
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
    // Decisions taken since this agent last heard them (unless its next message brings the whole preamble).
    let fresh = '';
    const seen = member.decisionsSeen ?? 0;
    const news = (team.decisions ?? []).filter((d) => d.id > seen);
    if (news.length && t.teamPrimed) {
      fresh = `(Decisiones nuevas del equipo: síguelas.\n${news.map((d) => `#${d.id} ${d.text}`).join('\n')})\n\n`;
    }
    member.decisionsSeen = team.nextDecision ?? 0;
    // The orchestrator always sees where the team stands, so it doesn't pile orders on someone busy.
    const status = member.role === 'orchestrator' ? `\n\n(${this._status(team, member)})` : '';
    const prompt = `${fresh}${header}\n${text}${status}`;
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
      // An orchestrator only waiting on its own timer stops waiting when what it waits for arrives: a message
      // from the agent the timer names (any, if it names none), or anything that can't wait (a question, a
      // blocker, an error, Relevo).
      const pressing = ['pregunta', 'error', 'aviso', 'urgente'].includes(from.label) || from.role === 'relevo' || /^\s*\**ESTADO:?\**\s*bloqueado/im.test(text);
      const awaited = !r.waitingFor?.length || r.waitingFor.includes(from.name);
      if (member.role === 'orchestrator' && r.waitingTimer && !r.approvals.size && (awaited || pressing)) {
        r.waitingTimer = false;
        r.statusLine = `Llega un mensaje de ${from.name}: deja de esperar…`;
        h.agents.get(t.id)?.interrupt();
      }
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

/** A timer or a plain wait: Antigravity's schedule, sleep / Start-Sleep / timeout. */
export function isWaitTool(name, title, input) {
  const n = String(name ?? '').toLowerCase();
  if (['schedule', 'wait', 'sleep', 'timer', 'set_timer', 'wait_for', 'scheduler'].includes(n)) return true;
  const cmd = String(input?.command ?? title ?? '').trim();
  return /^(sleep|Start-Sleep|timeout(\.exe)?\s+\/t)\b/i.test(cmd);
}

/** Tools the orchestrator and the researcher use without asking: reading and searching, never writing. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite', 'Task', 'Agent']);

function headTail(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.35);
  return `${clip(s, head)}\n[…]\n${s.slice(-(n - head))}`;
}
