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
// talk to any of them at any time; automatic messages go on until the goal is met, you pause the team or its daily budget runs out.

import fs from 'node:fs';
import path from 'node:path';
import * as gitops from './gitops.mjs';
import { elideCode, clip, threadBrief } from './handoff.mjs';
import { isReadOnlyCommand } from './codex.mjs';
import { workDir } from './guard.mjs';

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export const ROLES = {
  orchestrator: { label: 'Orquestador', short: 'Orq.' },
  executor: { label: 'Ejecutor', short: 'Ej.' },
  researcher: { label: 'Investigador', short: 'Inv.' },
};

/** Bumped when the agents' instructions change: teams made before get them again. */
const RULES_VERSION = 11;
/** The orchestrator gets a fresh session (with a brief of its own thread) past any of these. */
/**
 * When an agent starts a fresh session: only once its context is really full (this share of the model's
 * window, never past `cap`; with an unknown window, at `cap`). Counting turns or accumulated tokens renewed
 * the orchestrator about once an hour, and each renewal costs it what it hadn't saved.
 */
export const REFRESH = { share: 0.75, cap: 400_000 };
/** The agent's own handoff note before a renewal: kept this long (seconds) and at most this many characters. */
const NOTE_MAX = 6_000, NOTE_TTL = 24 * 3600;
/** Decisions the team keeps (the oldest go first past this). */
const DECISIONS_MAX = 40;
/** Where the team's decisions are written in full, inside the project (kept out of git). */
export const DECISIONS_DIR = '.relevo';
/** Where the agents note what they'd delete but the orchestrator didn't see clear: cleaned up later, by you. */
export const PENDING_DELETES = 'borrados-pendientes.md';
const DECISION_FULL_MAX = 8000;
/** Research reports the team keeps, and how many the agents are reminded of. */
const FINDINGS_MAX = 60, FINDINGS_SHOWN = 15;
/** A background job older than this (seconds) gets its agent asked to check it, then again every so often. */
export const BG_CHECK = Number(process.env.RELEVO_BG_CHECK ?? 1800);
/** From this hour (host time) each team that worked today gets its day's summary. */
const SUMMARY_HOUR = 21;


/** The whole team idle this long (seconds) wakes the orchestrator; an order «en curso» never received, after STUCK_AFTER. */
export const IDLE_NUDGE = Number(process.env.RELEVO_IDLE_NUDGE ?? 900);
const STUCK_AFTER = Math.min(600, IDLE_NUDGE);
/** A thread this quiet (seconds) has finished saying what it had to say. */
const QUIET = Math.min(20, IDLE_NUDGE / 3);
/** Orders that are messages for someone (the rest only change the team's memory). */
const MESSAGE_ORDERS = ['tarea', 'urgente', 'investigar', 'respuesta', 'integrar', 'fin', 'aprobar', 'denegar', 'consultar'];
/** A permission the orchestrator hasn't decided in this long (seconds) goes to you. */
export const PERMIT_WAIT = Number(process.env.RELEVO_PERMIT_WAIT ?? 600);

// MARK: - Orders in the agents' replies

const TAG = /<relevo:(tarea|urgente|investigar|respuesta|pregunta|integrar|fin|decisi[oó]n|descartar|hito|hecho|aprobar|denegar|consultar|pedir)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/relevo:\1\s*>)/gi;
const FENCED = /```[\s\S]*?(?:```|$)/g;
const orderSig = (o) => `${o.type}|${o.to ?? ''}|${o.body}`;
/** What became of a message, as the orchestrator and you read it. */
const RESULT = { sent: 'entregada', queued: 'en cola (la lee al terminar su turno)', bounced: 'no entregada: estaba a mitad de un turno', parked: 'pendiente: se la doy cuando termine su turno', held: 'retenida (equipo en pausa)', gone: 'no entregada: su hilo no existe', stashed: 'guardada para su próxima tarea', answered: 'respondida en su pregunta', approved: 'permitido', denied: 'denegado', escalated: 'pasado al usuario', nothing: 'no tenía ningún permiso esperando (ya estaba decidido)', replaced: 'sustituida por otra más reciente', dropped: 'descartada: le diste otra orden' };

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
/** An orchestrator's untagged comment that looks addressed to you (a question, a request, waiting for you). */
const ASKS_USER = /\?|\b(usuario|necesito que|necesitamos que|puedes|podr[ií]as|confirma|conf[ií]rmame|decide|elige|dime|ind[ií]came|pru[eé]balo|esperando (al usuario|tu|a que))\b/i;
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
  // «account|model» or «account|model|effort».
  const [accountId, model, effort] = String(fallback).split('|');
  return host._validPlan({ mode: 'chain', targets: [{ accountId, model: model || 'default', effort: effort || undefined }] });
}
export function fallbackOf(plan) {
  if (!plan) return '';
  if (plan.mode === 'wait') return 'wait';
  if (plan.mode === 'smart') return 'auto';
  const t = plan.mode === 'chain' && plan.targets?.[0];
  return t ? `${t.accountId}|${t.model || 'default'}${t.effort ? `|${t.effort}` : ''}` : '';
}

/** Instructions as stored: trimmed, at most 2000 characters, or undefined. */
const noteOf = (x) => String(x ?? '').trim().slice(0, 2000) || undefined;

/** What you wrote for this agent when creating the team, if anything. */
const notesOf = (member) => (member.notes ? `\nIndicaciones del usuario para ti:\n${member.notes}\n` : '');

/** The team's decisions, for an agent starting (or starting over): what not to reopen. */
export function decisionsBlock(team) {
  const list = team.decisions ?? [];
  if (!list.length) return '';
  const where = team.decisionsFile ? `Aquí van resumidas; enteras (y las antiguas o retiradas) están en ${team.decisionsFile}: léelas ahí si te falta el detalle o no recuerdas una.\n` : '';
  return `\nDecisiones del equipo (ya tomadas: síguelas y no las reabras salvo que aparezca evidencia nueva que las contradiga; en ese caso dilo antes de cambiar de rumbo). ${where}${list.map((d) => `#${d.id} ${d.text}`).join('\n')}\n`;
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
  return `\nYa investigado en este equipo (reutilízalo; investiga solo lo nuevo o para ampliar algo concreto):\n${list.map(findingLine).join('\n')}\n`;
}

/** One research report in a line: what was asked and what came out. */
function findingLine(f) {
  return `#${f.id} ${clip(f.topic, 110)} — ${clip(f.summary.split('\n').find((l) => l.trim()) ?? '', 170)}`;
}

/**
 * The researcher's report out of what it wrote in a turn: from its last message that carries the conclusion
 * line. What came before is narration («voy a revisar…»). Without such a line, everything, as written.
 */
export function researchReport(messages) {
  const list = (messages ?? []).map((m) => String(m ?? '')).filter((m) => m.trim());
  for (let i = list.length - 1; i >= 0; i--) if (/^\s*[*_#>\- ]*conclusi[oó]n\b/im.test(list[i])) return list.slice(i).join('\n\n');
  return list.join('\n\n');
}

/** Where the team stood when the orchestrator starts a fresh session: the board and each agent's last report. */
function boardBlock(host, team, lead) {
  const reports = team.members.filter((m) => m !== lead && m.lastReport).map((m) => `- ${m.name} (${new Date(m.lastReport.at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}): ${m.lastReport.text}`);
  return `\nDónde está el equipo ahora (vienes de una sesión anterior; esto y las decisiones son lo que importa de ella):\n${host.teams._status(team, lead)}\n${reports.length ? `Último informe de cada uno:\n${reports.join('\n')}\n` : ''}`;
}

/** What the agent itself wrote down before its session was renewed: the first thing its next session reads. */
function noteBlock(member) {
  const n = member.handoffNote;
  if (!n?.text || Date.now() / 1000 - (n.at ?? 0) > NOTE_TTL) return '';
  return `\nTu nota de traspaso (la escribiste tú a las ${new Date(n.at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}, justo antes de renovar la sesión; fíate de ella):\n${n.text}\n`;
}

/** What you (the user) wrote lately in this thread, as written: it often carries facts («ya funciona», «está en el escritorio»). */
function userSaidBlock(host, member) {
  const t = host.threads.get(member.threadId);
  const since = Date.now() / 1000 - 24 * 3600;
  const said = (t?.items ?? []).filter((i) => i.kind === 'user' && !i.from && (i.date ?? 0) >= since && i.text?.trim()).slice(-10);
  if (!said.length) return '';
  const hm = (d) => new Date(d * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `\nLo último que te ha dicho el usuario (tal cual, del más antiguo al más reciente):\n${said.map((i) => `- ${hm(i.date)}: ${clip(i.text.replace(/\s+/g, ' '), 400)}`).join('\n')}\n`;
}

export function preamble(host, team, member, fresh = false) {
  const carried = fresh ? `${noteBlock(member)}${userSaidBlock(host, member)}` : '';
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
<relevo:pedir>qué necesitas que haga el usuario y por qué, en una o dos frases</relevo:pedir>  la única forma de que al usuario le llegue un aviso: úsala solo cuando necesites que haga algo (decidir entre opciones, probar en la consola, darte un acceso o un archivo, desbloquear lo que el equipo no puede). No la uses para informar ni para resúmenes: lo que escribas sin ella lo lee cuando entre, sin aviso.
<relevo:hito>un paso comprobable hacia el objetivo</relevo:hito>  añade un hito (en orden); <relevo:hecho>2</relevo:hecho> marca el #2 como conseguido cuando lo hayas comprobado. Relevo los muestra al usuario como progreso y te los recuerda siempre.
<relevo:decision>una decisión firme, en una línea (qué y por qué)</relevo:decision>  Relevo la guarda y se la recuerda a todo el equipo, también a ti en tus sesiones nuevas. Úsala para lo que no debe reabrirse: tecnologías y proyectos elegidos (p. ej. «usamos shadPS4 como referencia para GNM»), enfoques descartados y por qué, criterios del usuario, y TODO resultado ya comprobado (en la consola, en tests o por el usuario), con fecha: «Comprobado 19-nov: Vulkan enumera 1 dispositivo en la consola sin consoleInit; no repetir la prueba». Un diagnóstico guardado no dice que el arreglo funcione: cuando se compruebe, guárdalo. <relevo:descartar>3</relevo:descartar> retira la decisión #3 si deja de valer.

<relevo:urgente para="${executors[0]?.name ?? 'Ejecutor 1'}">…</relevo:urgente>  solo si lo que está haciendo ahora es claramente erróneo o ya no sirve: interrumpe su turno.

Permisos: cuando un agente necesita permiso (escribir fuera de la carpeta del proyecto, un comando que su modo no deja pasar, o un borrado o descarte de git que Relevo ha detenido), Relevo te lo pasa como «[${executors[0]?.name ?? 'Ejecutor 1'} · permiso]» con el comando entero, y el agente queda parado hasta que decidas. Los borrados apruébalos solo si tienes claro que lo que se pierde sobra (salidas de compilación, temporales, logs, copias que se regeneran, dentro del proyecto) y encaja con su tarea; si no lo ves claro, no se lo pases al usuario: deniégalo diciéndole que busque otra forma o que lo anote en ${DECISIONS_DIR}/${PENDING_DELETES} para limpiarlo en otro momento. Formatear discos, tocar la raíz de un disco o un git push --force van siempre directos al usuario.
<relevo:aprobar para="${executors[0]?.name ?? 'Ejecutor 1'}"/>  si encaja con su tarea y sus rutas son las del proyecto o las herramientas que ya usa el equipo.
<relevo:denegar para="${executors[0]?.name ?? 'Ejecutor 1'}">por qué y qué hacer en su lugar</relevo:denegar>  si no debe hacerlo.
<relevo:consultar para="${executors[0]?.name ?? 'Ejecutor 1'}">qué te preocupa</relevo:consultar>  se lo pasa al usuario: si sobrescribe o pierde datos, toca el sistema (instalar, configurar, registro, servicios), publica o envía algo fuera (git push a otro remoto, subidas), usa credenciales o dinero, o si no entiendes para qué lo necesita. Ante la duda, consulta (salvo los borrados: esos los resuelves tú, como se dice arriba).

Cómo funciona la entrega: a un agente a mitad de un turno solo le llega lo urgente (y la respuesta a una duda suya); lo demás queda pendiente: cuando termine, te llega su informe con tu orden pendiente al lado, y si no le das otra en esa respuesta, Relevo se la entrega tal cual. Al final de cada mensaje que recibes, «Qué ha sido de tus mensajes» te dice si cada orden se entregó, está en cola o pendiente: no supongas que algo llegó sin verlo ahí. Relevo te enviará los informes, dudas y bloqueos de cada agente con su nombre delante («[${executors[0]?.name ?? 'Ejecutor 1'} · informe]», «… · pregunta») y al final el estado del equipo: de cada uno si trabaja (desde cuándo y en qué), espera un trabajo en segundo plano, está libre, BLOQUEADO esperando al usuario o SIN CUOTA (y cuándo retoma), y cuántos mensajes tuyos le esperan. A quien está SIN CUOTA o BLOQUEADO no le sirve una orden nueva: reparte su trabajo urgente a otro o espera. Reglas:
- No acuses recibo ni contestes a informes de progreso («compilando…», «sigo con…»): si no hay nada nuevo que pedir, responde sin órdenes y espera.
- No mandes nada a quien está a mitad de un turno salvo que sea urgente: espera a su informe (mira el estado del equipo). Quien solo espera un trabajo en segundo plano (una compilación, un emulador) sí recibe tus mensajes; si no tienes nada nuevo para él, deja que te informe cuando acabe.
- Si Relevo te dice «Pendiente para…», no la repitas: le llega sola salvo que le des otra orden al leer su informe. Si te dice «no entregada», esa sí tienes que volver a darla.
- Si Relevo te avisa de que el equipo lleva un rato parado, reparte el trabajo que quede; si estáis esperando al usuario, dilo en una línea.
- Una respuesta a quien no te ha preguntado nada no se entrega: se guarda y le llega con su siguiente tarea. No respondas a informes con ESTADO: esperando.
- No hagas tú el trabajo de los ejecutores (depurar, compilar, hacer commits o merges): pídeselo a ellos${executors.some((e) => host.threads.get(e.threadId)?.worktree) ? ' o usa integrar' : ''}.
- Toda respuesta y tarea lleva para="…". No existen otras órdenes ni opciones («force», «redirect»…) aparte de las de arriba.
- Tareas pequeñas y comprobables. No des a dos ejecutores los mismos ficheros a la vez.
${researcher ? `- Antes de que un ejecutor construya algo que ya puede existir (una librería, un proyecto open source, un ejemplo), o en cuanto lleve dos intentos fallidos con el mismo problema, pide al ${researcher.name} que lo busque, y pasa al ejecutor la recomendación concreta.\n` : '- Si un ejecutor lleva dos intentos fallidos con el mismo problema, para y busca otro enfoque (librerías o proyectos open source que ya lo resuelvan) antes de insistir.\n'}- Responde tú las dudas que puedas. Si solo el usuario puede decidir o hacer algo, pídeselo con <relevo:pedir> y espera.
- Sé breve y gasta poco: todos ven el código en disco, no lo copies en los mensajes; no leas el proyecto entero, apóyate en los informes y lee solo lo que necesites para decidir.
${notesOf(member)}${milestonesBlock(team, true)}${decisionsBlock(team)}${findingsBlock(team)}${fresh ? boardBlock(host, team, member) : ''}${carried}
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
- Tu informe es para quien lo pidió (el orquestador o un ejecutor), no para el usuario. Su primera línea es la conclusión, tal cual: «Conclusión: …», sin ninguna frase delante («He revisado…», «Informe:»). Lo que escribas antes del mensaje que empieza así no se envía.
- Después de la conclusión, solo lo que hace falta para actuar: la evidencia con fichero:línea o enlace, qué hacer en pasos concretos y los riesgos; si recomiendas algo externo, su licencia y lo maduro que está. Apunta a unos 2.500 caracteres y pásate solo si un hallazgo lo exige. Sin títulos, tablas ni volcados de código.
- Si la petición no está clara, termina con <relevo:pregunta>tu duda</relevo:pregunta>.
- Relevo guarda cada informe en la biblioteca del equipo con su línea de conclusión: no repitas lo ya investigado, amplíalo.
- Cada mensaje del equipo trae al final el estado de los demás (quién trabaja, quién está libre, BLOQUEADO o SIN CUOTA).
${notesOf(member)}${decisionsBlock(team)}${findingsBlock(team)}${taskLine}${carried}</relevo_equipo>

`;
  }
  return `<relevo_equipo>
Eres ${member.name} en un equipo de agentes de IA coordinado por un orquestador, desde Relevo. Trabajas en ${t.projectPath}${t.worktree ? ` (tu propio worktree, rama ${t.worktree.branch})` : ''}.

Equipo:
${roster}

- Haz la tarea que te llega. Al terminar, tu ÚLTIMO mensaje es el informe para el orquestador (no para el usuario); Relevo solo le envía ese. Primera línea «ESTADO: hecho», «ESTADO: esperando» o «ESTADO: bloqueado», y después como mucho 10 líneas sencillas: qué has hecho, ficheros tocados, cómo lo has comprobado, qué queda y cualquier hallazgo que cambie el plan. Sin títulos, tablas ni negritas; no pegues código ni logs: están en disco.
- Si dejas algo en segundo plano (una compilación, un emulador) y terminas el turno para esperarlo, no hace falta que informes: Relevo lo sabe y el orquestador no te escribirá hasta que acabes.
- Si te bloqueas o necesitas una decisión, termina tu respuesta con <relevo:pregunta>tu duda concreta</relevo:pregunta> y espera la respuesta.${researcher ? ` Si llevas dos intentos fallidos con el mismo problema, pregunta: el ${researcher.name} puede buscar soluciones que ya existan.` : ''}
- Otros agentes pueden estar trabajando en el mismo proyecto: toca solo lo que te pidan.
- Cada mensaje del equipo trae al final el estado de los demás (trabajando, en segundo plano, libre, BLOQUEADO esperando al usuario, SIN CUOTA y cuándo retoma): no esperes una respuesta de quien no puede darla; dilo en tu informe.
${notesOf(member)}${decisionsBlock(team)}${taskLine}${carried}</relevo_equipo>

`;
}

// MARK: - The coordinator

export class Teams {
  constructor(host) {
    this.host = host;
    host.state.teams ??= [];
    this._dropOrphans();
    this._upgrade();
    // Decisions on disk too (a one-off command such as `pair` only reads).
    if (!host.config?.readOnly) for (const team of this.list) { this._recoverDecisions(team); this._writeDecisions(team); }
    // Teams paused by an older version: why, from the notice it left (the loop guard's pause ends when you write).
    for (const team of this.list) {
      if (team.status !== 'paused' || team.pausedBy !== undefined) continue;
      const lead = this._lead(team);
      const last = [...(lead?.items ?? [])].reverse().find((i) => i.kind === 'notice' && /^Equipo (en pausa|reanudado)/.test(i.text ?? ''));
      team.pausedBy = /mensajes automáticos/.test(last?.text ?? '') ? 'limit' : /presupuesto/.test(last?.text ?? '') ? 'budget' : 'user';
    }
    // The loop guard is gone: a team it paused carries on (what it held stays for you to review).
    // Once the host is up (this runs while it starts).
    if (!host.config?.readOnly && this.list.some((x) => x.status === 'paused' && x.pausedBy === 'limit')) {
      setTimeout(() => { for (const team of this.list) if (team.status === 'paused' && team.pausedBy === 'limit') { this._reactivate(team, 'Equipo reactivado: Relevo ya no pausa el equipo por llevar muchos mensajes sin ti'); this.host._saveState(); this.host._broadcastSnapshot(); } }, 0);
    }
    this._watch = setInterval(() => {
      try { this.watchBackground(); this._maybeSummary(); this.sweepUnreported(); this.watchIdle(); this.watchPermits(); } catch (e) { host.log?.(`team watch: ${e.message}`); }
    }, Math.max(1, Math.min(60, BG_CHECK / 2, IDLE_NUDGE / 3)) * 1000);
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
    const t = worktree ? h.createWorktreeThread(team.projectId, typeof worktree === 'object' ? worktree : null) : h.createThread(team.projectId);
    const account = h.accountsById.get(pick?.accountId) ?? h.accountsById.get(t.accountId);
    t.accountId = account?.id ?? t.accountId;
    t.model = pick?.model || 'default';
    t.effort = pick?.effort || null;
    t.daybreak = !!pick?.daybreak || undefined;
    // A Codex researcher runs read-only: it can read and search without asking, and can't write.
    t.mode = role === 'researcher' && account?.kind === 'codex' ? 'plan' : mode;
    t.title = `${name} · ${clip(team.goal.split('\n')[0], 48)}`;
    t.team = { id: team.id, role, name };
    t.aiTitled = true; // the role and the goal are a better title than one guessed from the first message
    const plan = planFromFallback(h, pick?.fallback, role);
    if (plan !== undefined) t.limitPlan = plan;
    if (team.guard !== undefined && team.guard !== null) t.guard = team.guard;
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
  async update(teamId, changes = {}) {
    const h = this.host;
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    // The new executors' worktrees first, before anything changes: in a big repository each checkout takes
    // minutes, and the host keeps running its agents meanwhile. If one can't be made, nothing changes.
    const room = Math.max(0, 4 - team.members.filter((x) => x.role === 'executor').length);
    const wanted = (changes.add?.executors ?? []).slice(0, room);
    const projectPath0 = h.projects().find((p) => p.id === team.projectId)?.path;
    const ready = [];
    if (wanted.length && changes.worktrees !== false && gitops.hasCommits(projectPath0)) {
      try { for (const _ of wanted) ready.push(await h.prepareWorktree(team.projectId)); } catch (e) {
        for (const wt of ready) { try { gitops.removeWorktree(wt, true); } catch {} }
        throw e;
      }
    }
    const leadMember = team.members.find((m) => m.role === 'orchestrator');
    const news = [];
    const badDirs = Array.isArray(changes.workDirs) ? changes.workDirs.filter((d) => String(d ?? '').trim() && !workDir(d)) : [];
    if (badDirs.length) throw new Error(`Carpeta de trabajo no válida (ruta absoluta, nunca la raíz de un disco, /, /home o /mnt/x): ${badDirs.join(', ')}`);
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
    if (Array.isArray(changes.workDirs)) {
      const dirs = [...new Set(changes.workDirs.map(workDir).filter(Boolean))].slice(0, 8);
      if (JSON.stringify(dirs) !== JSON.stringify(team.workDirs ?? [])) {
        if (dirs.length) team.workDirs = dirs; else delete team.workDirs;
        news.push(dirs.length ? `Carpetas de trabajo del equipo, además del proyecto: ${dirs.join(', ')}. Relevo deja escribir en ellas sin pedir permiso; los borrados recursivos siguen pasando por ti (orquestador) y borrar una entera llega al usuario.` : 'El equipo ya no tiene carpetas de trabajo fuera del proyecto: escribir fuera vuelve a pedir permiso');
      }
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
      const effort = c.effort === undefined ? undefined : (c.effort || null);
      const moved = account && (account.id !== t.accountId || model !== (t.model || 'default'));
      if (account && (moved || (effort !== undefined && effort !== (t.effort ?? null)))) {
        h.select(t, account.id, model, false, false, effort);
        if (m.role !== 'orchestrator') news.push(`${m.name} pasa a ${account.name} · ${h._modelName(account, model)}${effort ? ` (esfuerzo ${effort})` : ''}`);
      }
      // Daybreak: from its next turn (Codex only; the program its model accepts with this account).
      if (c.daybreak !== undefined && !!c.daybreak !== !!t.daybreak) {
        t.daybreak = !!c.daybreak || undefined;
        if (t.items.length) h._append(t, { id: h._uuid(), kind: 'notice', text: t.daybreak ? 'Daybreak activado: menos rechazos en trabajo de ciberseguridad defensiva desde el próximo turno' : 'Daybreak desactivado' });
        h._changed(t);
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
      // Unless you say, a new executor works like the team's others (one in «Auto-editar» among «Acceso total» ones
      // would ask for every command).
      const modes = team.members.filter((x) => x.role === 'executor').map((x) => h.threads.get(x.threadId)?.mode).filter((x) => ['ask', 'autoEdit', 'full'].includes(x));
      const usual = modes.sort((a, b) => modes.filter((x) => x === b).length - modes.filter((x) => x === a).length)[0];
      const mode = ['ask', 'autoEdit', 'full'].includes(changes.mode) ? changes.mode : usual ?? 'autoEdit';
      const taken = new Set(team.members.map((m) => m.name));
      let n = 1;
      for (const e of newExecutors) {
        while (taken.has(`Ejecutor ${n}`) || (n === 1 && taken.has('Ejecutor'))) n++;
        const name = `Ejecutor ${n}`;
        taken.add(name);
        const t = this._newMember(team, 'executor', name, e, mode, worktrees && (ready.shift() ?? true));
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
      team.pausedBy = 'user';
      if (lead) h._append(lead, { id: h._uuid(), kind: 'notice', text: 'Equipo en pausa: los mensajes entre agentes se retienen hasta que los revises o lo reanudes' });
    } else if (action === 'resume') {
      // What was held stays for you to review one by one: much of it may be stale by now.
      this._reactivate(team, 'Equipo reanudado');
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

  _reactivate(team, why) {
    const h = this.host;
    const lead = this._lead(team);
    team.status = 'active';
    team.pausedBy = null;
    team.auto = 0;
    const n = team.held.length;
    if (lead) h._append(lead, { id: h._uuid(), kind: 'notice', text: `${why}${n ? `: ${n} mensaje${n === 1 ? '' : 's'} retenido${n === 1 ? '' : 's'} esperan tu revisión (Retenidos, en la barra del equipo)` : ''}` });
    if (n) team.notes = [...(team.notes ?? []), `El equipo vuelve a estar activo. ${n} mensaje${n === 1 ? '' : 's'} de cuando estaba en pausa siguen retenidos sin entregar hasta que el usuario los revise: no des por hecho que llegaron; si algo sigue haciendo falta, vuelve a pedirlo.`];
    if (lead) h._changed(lead);
  }

  /** You wrote in one of the team's threads: a pause from an older version's loop guard ends. */
  userSpoke(thread) {
    const team = this.of(thread);
    if (!team) return;
    if (team.status === 'paused' && team.pausedBy === 'limit') this._reactivate(team, 'Equipo reactivado por tu mensaje');
    team.auto = 0;
    team.nudges = 0;
    team.askHinted = false;
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
    if (member.role === 'orchestrator' && team.status === 'paused') {
      notes += `(El equipo está EN PAUSA: las órdenes que des se retienen sin entregar hasta que el usuario las revise o lo reanude; hay ${team.held.length} retenidas. No digas que las has enviado.)\n\n`;
    }
    if (thread.teamPrimed && !freshSession) return notes;
    thread.teamPrimed = true;
    member.decisionsSeen = team.nextDecision ?? 0; // the preamble lists them all
    member.findingsSeen = team.nextFinding ?? 0;
    return preamble(this.host, team, member, !!freshSession) + notes;
  }

  /**
   * Called when an agent asks for permission or asks a question. Returns true when the team took care of it:
   * the orchestrator and the researcher read and search without asking; an executor's question goes to the
   * orchestrator.
   */
  onApproval(thread, item, req, held = null) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member) return false;
    const reads = !held && (READ_ONLY.has(req.toolName) || (req.toolName === 'commandExecution' && isReadOnlyCommand(req.command)));
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
    if (item.questions?.length || member.role === 'orchestrator') return false;
    return this._askLead(team, member, thread, item, req, held);
  }

  /**
   * A member's permission goes to the orchestrator, with the whole command, why Relevo stopped it and what the
   * member was doing. It approves, denies or passes it on to you; meanwhile the card stays in the member's thread
   * for you to decide if you prefer. Not when the orchestrator can't answer (no quota, team paused) or you
   * turned it off: then it's yours, as before.
   */
  _askLead(team, member, thread, item, req, held) {
    const h = this.host;
    const lead = team.members.find((m) => m.role === 'orchestrator');
    const lt = lead && h.threads.get(lead.threadId);
    if (!lt || team.leadApproves === false || team.status === 'paused' || team.status === 'done') return false;
    const lr = h._rt(lt);
    if (!lr.isRunning && (lr.limit || lr.resumeAt || lr.pendingRelay)) return false;
    const r = h._rt(thread);
    const input = req.input && typeof req.input === 'object' && !Array.isArray(req.input) ? req.input : {};
    const command = req.command ?? input.command ?? null;
    const file = input.file_path ?? input.notebook_path ?? input.path ?? null;
    const what = command ?? [req.title, file && !String(req.title ?? '').includes(file) ? file : null, req.grantRoot ? `Carpeta: ${req.grantRoot}` : null, !req.title ? req.detail : null].filter(Boolean).join('\n');
    const said = (r.turnItems ?? []).map((id) => h._item(thread, id)).filter((x) => x?.kind === 'assistant' && x.text?.trim()).at(-1)?.text;
    const cwd = req.cwd ?? thread.worktree?.path ?? thread.projectPath;
    const name = member.name;
    const pending = held?.critical ? this._pendingDeletesFile(team) : null;
    if (held?.critical) item.critical = true;
    const text = (held?.critical ? [
      `${name} quiere hacer algo que no se puede deshacer (${held.reason}):`,
      '```', clip(String(what).replace(/```/g, "'''"), 4000), '```',
      cwd ? `Desde ${cwd}.` : null,
      member.task?.text ? `Su tarea: ${clip(member.task.text.replace(/\s+/g, ' '), 300)}` : null,
      said ? `Lo último que ha dicho: ${clip(withoutOrders(said).replace(/\s+/g, ' '), 400)}` : null,
      '',
      'Está parado hasta que decidas. Apruébalo solo si tienes claro que lo que se pierde sobra: salidas de compilación, temporales, logs o copias que se regeneran, dentro del proyecto, y que encaja con su tarea. Si no lo ves claro (código o datos que nadie más tiene, algo fuera del proyecto, rutas que no entiendes), no se lo pases al usuario: deniégalo y dile qué hacer en su lugar, por ejemplo otra carpeta de salida, sobrescribir en vez de borrar, o mover lo viejo a una carpeta de descartes dentro del proyecto' + (pending ? `; y si no hay otra forma, que lo anote en ${pending} (qué, ruta y por qué) para limpiarlo en otro momento y siga.` : '.'),
      '```',
      `<relevo:aprobar para="${name}"/>`,
      `<relevo:denegar para="${name}">por qué y qué hacer en su lugar</relevo:denegar>`,
      '```',
    ] : [
      `${name} pide permiso para${command ? ' ejecutar' : ''}:`,
      '```', clip(String(what).replace(/```/g, "'''"), 4000), '```',
      cwd ? `Desde ${cwd}.` : null,
      held ? `Relevo lo ha parado porque ${held.reason}.` : req.detail && req.title ? `El agente dice: ${clip(String(req.detail).replace(/\s+/g, ' '), 300)}` : null,
      member.task?.text ? `Su tarea: ${clip(member.task.text.replace(/\s+/g, ' '), 300)}` : null,
      said ? `Lo último que ha dicho: ${clip(withoutOrders(said).replace(/\s+/g, ' '), 400)}` : null,
      '',
      `Está parado hasta que decidas. Responde con una de estas órdenes (fuera de bloques de código):`,
      '```',
      `<relevo:aprobar para="${name}"/>`,
      `<relevo:denegar para="${name}">por qué y qué hacer en su lugar</relevo:denegar>`,
      `<relevo:consultar para="${name}">qué te preocupa</relevo:consultar>`,
      '```',
      'Apruébalo si encaja con su tarea y sus rutas son las del proyecto o las herramientas que ya usa el equipo. Consulta al usuario si sobrescribe o pierde datos, toca el sistema, publica o envía algo fuera, usa credenciales, o si no ves para qué lo necesita. Ante la duda, consulta.',
    ]).filter((x) => x !== null).join('\n');
    // Marked first: the team's status that goes with it already reads «waiting for the orchestrator».
    item.reviewBy = lead.name;
    item.reviewAt = Date.now() / 1000;
    const res = this._toLead(team, member, 'permiso', text);
    if (res !== 'sent' && res !== 'queued') { delete item.reviewBy; delete item.reviewAt; return false; }
    r.statusLine = `Esperando el permiso de ${lead.name}…`;
    h._append(thread, { id: h._uuid(), kind: 'notice', text: held?.critical
      ? `Borrado pasado a ${lead.name}: lo permite si lo que se pierde sobra claramente; si no, le dice que busque otra forma o que lo anote en ${DECISIONS_DIR}/${PENDING_DELETES}. Puedes decidir tú aquí si prefieres.`
      : `Permiso pedido a ${lead.name}: lo permite si encaja con la tarea o te lo pasa si es delicado. Puedes decidir tú aquí si prefieres.` });
    h._changed(thread);
    return true;
  }

  /** The permissions of a member that wait for the orchestrator (not yet decided, nor passed on to you). */
  _permits(member) {
    const h = this.host;
    const t = h.threads.get(member.threadId);
    if (!t) return [];
    return [...h._rt(t).approvals.keys()].map((id) => h._item(t, id)).filter((it) => it?.reviewBy && !it.escalated && !it.resolution);
  }

  /** A permission the orchestrator passes on to you (or didn't decide in time): you get it as any other. */
  _escalate(team, member, item, why) {
    const h = this.host;
    const t = h.threads.get(member.threadId);
    if (!t) return;
    item.escalated = why;
    t.attention = { kind: 'guard', text: `${why}: ${clip(String(item.output || item.title || '').replace(/\s+/g, ' '), 160)}`, at: Date.now() / 1000 };
    h._rt(t).statusLine = 'Esperando tu permiso…';
    h._touch(t, item);
    h._push(t, `${member.name} necesita tu permiso`, clip(`${why}. ${String(item.output || item.title || '').replace(/\s+/g, ' ')}`, 300), 'guard');
    h._changed(t);
    h._broadcastSnapshot();
  }

  /** Permissions the orchestrator hasn't decided in PERMIT_WAIT go to you. */
  watchPermits(nowS = Date.now() / 1000) {
    const h = this.host;
    for (const team of this.list) {
      const lead = team.members.find((m) => m.role === 'orchestrator');
      for (const m of team.members) {
        for (const it of this._permits(m)) {
          if ((it.reviewAt ?? 0) > nowS - PERMIT_WAIT) continue;
          const why = `${lead?.name ?? 'El orquestador'} no lo ha decidido en ${Math.round(PERMIT_WAIT / 60)} min`;
          this._escalate(team, m, it, why);
          const t = h.threads.get(m.threadId);
          h._append(t, { id: h._uuid(), kind: 'notice', text: `${why}: te toca a ti` });
          h._changed(t);
        }
      }
    }
  }

  /** You turn on or off the orchestrator deciding the team's permissions (on unless you turn it off). */
  setLeadApproves(teamId, on) {
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    team.leadApproves = !!on;
    this.host._saveState();
    this.host._broadcastSnapshot();
    return {};
  }

  /** A turn ended in a team thread: deliver what the orchestrator ordered, or report a member's work to it. */
  onTurnFinished(thread, { items = null, text, messages, changes, errors, background = [] }) {
    const team = this.of(thread);
    const member = this.memberOf(thread);
    if (!team || !member || team.status === 'done') return;
    const h = this.host;
    // The turn Relevo asked for before renewing: what it wrote is its handoff note, not a report or orders.
    if (member.noteRequested) {
      member.noteRequested = false;
      const asked = [...thread.items].reverse().find((i) => i.kind === 'user')?.from?.label === 'traspaso';
      if (asked) {
        const note = withoutOrders(messages?.length ? messages[messages.length - 1] : text).trim();
        if (note) member.handoffNote = { text: clip(compactReport(note), NOTE_MAX), at: Date.now() / 1000 };
        for (const i of items ?? []) i.teamSkip = true; // its handoff note: for its next session, not the team
        this._renew(team, member, thread);
        h._saveState();
        return;
      }
    }
    this._checkBudget(team);
    if (member.role === 'orchestrator') {
      const orders = parseOrders(text);
      const sent = this._dispatch(team, member, thread, orders, items);
      this._offerParked(team, sent);
      this._receipt(team, thread, sent);
      // Only <relevo:pedir> tells you (see _order). A turn with no orders that seems to ask you something gets
      // the tag recalled once, until it uses it or you write: without it you'd get no notice.
      const said = withoutOrders(text).trim();
      if (orders.some((o) => o.type === 'pedir')) team.askHinted = false;
      else if (!orders.some((o) => !['decision', 'descartar', 'hito', 'hecho'].includes(o.type)) && said && team.status !== 'done' && !team.askHinted && ASKS_USER.test(said)) {
        team.askHinted = true;
        this._deliver(team, member, 'Si eso era para el usuario y necesitas que haga algo, pídeselo con <relevo:pedir>qué y por qué</relevo:pedir>: sin la etiqueta no le llega ningún aviso. Si no lo era, sigue sin más.', { name: 'Relevo', role: 'relevo', label: 'aviso' });
      }
      team.leadTurns = (team.leadTurns ?? 0) + 1;
      this._maybeRefreshLead(team, thread);
      h._saveState();
      return;
    }
    const orders = parseOrders(text);
    const question = orders.find((o) => o.type === 'pregunta');
    // The report is its last message (with its status line); the researcher's findings can span several.
    const body = withoutOrders(!messages?.length ? text : member.role === 'researcher' ? researchReport(messages) : finalMessage(messages));
    const state = /^\s*\**ESTADO:?\**\s*(hecho|esperando|bloqueado)/im.exec(body)?.[1]?.toLowerCase() ?? null;
    if (question) {
      member.awaitingAnswer = true;
      this._setTask(member, 'bloqueado');
      this._toLead(team, member, 'pregunta', `${question.body}${body.trim() ? `\n\nSu informe:\n${compactReport(body)}` : ''}`);
      this._markSent(team, thread, items, body, 'pregunta');
      return;
    }
    // A turn that ended with nothing new (no text, no error): nothing to report.
    if (!body.trim() && !errors?.length) return;
    // Waiting for something running in the background: not worth waking the orchestrator; the agent picks
    // up by itself when it ends, and reports then.
    // «ESTADO: hecho» or «bloqueado» is a report: it goes whatever is still running (a blocked agent must not
    // sit unheard just because a job it left is still listed).
    if (background.length && !errors?.length && state !== 'hecho' && state !== 'bloqueado' && member.role !== 'researcher') {
      member.waitingFor = background.map((b) => b.description).slice(0, 3);
      this._setTask(member, 'esperando un trabajo en segundo plano');
      h._saveState();
      return;
    }
    member.waitingFor = background.length ? background.map((b) => b.description).slice(0, 3) : null;
    const report = [];
    report.push(compactReport(body));
    if (background.length) report.push(`(Sigue en segundo plano: ${background.map((b) => b.description).slice(0, 3).join(', ')}. Puedes escribirle igualmente.)`);
    if (changes?.files) report.push(`Cambios en disco: ${changes.files} fichero${changes.files === 1 ? '' : 's'} (+${changes.added} −${changes.removed})`);
    if (errors?.length) report.push(`Errores: ${errors.slice(-2).map((e) => clip(e, 300)).join(' · ')}`);
    const kind = member.role === 'researcher' ? 'informe de investigación' : errors?.length && !body ? 'error'
      : state === 'esperando' ? 'espera (no necesita respuesta)' : 'informe';
    // A turn without a status line (an answer to you, a quick check) leaves a blocked agent blocked.
    const stuck = ['bloqueado', 'esperando'].includes(member.task?.state) ? member.task.state : null;
    this._setTask(member, state === 'bloqueado' ? 'bloqueado' : state === 'esperando' ? 'esperando' : state ? 'hecha' : stuck ?? 'hecha');
    if (member.role === 'researcher' && body.trim()) {
      const found = this.addFinding(team, { topic: member.inquiry || clip(body.split('\n').find((l) => l.trim()) ?? '', 200), body, by: member.name });
      if (found) member.findingsSeen = found.id; // it wrote it: no need to tell it
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
    if (target && target.role === 'executor') {
      const tt = h.threads.get(target.threadId);
      if (tt && !this._busy(tt)) {
        this._deliver(team, target, report.join('\n\n'), { threadId: thread.id, name: member.name, role: member.role, label: 'informe para ti' });
        report.push(`(También enviado a ${target.name}.)`);
      } else report.push(`(${target.name} está trabajando: no se le ha enviado. Pásale lo que le sirva junto con su siguiente tarea.)`);
    }
    this._toLead(team, member, kind, report.join('\n\n'));
    this._markSent(team, thread, items, body, kind);
    this._maybeRefreshMember(team, member, thread);
  }

  /**
   * The messages of a member's turn that went to the orchestrator (its report, its question) say so, with the
   * same shape as a message that arrives from someone: in the window they read as for the orchestrator, not you.
   */
  _markSent(team, thread, items, body, label) {
    const lead = team.members.find((m) => m.role === 'orchestrator');
    if (!lead || !items?.length) return;
    const h = this.host;
    const r = h._rt(thread);
    let marked = false;
    for (const it of items) {
      const said = withoutOrders(it.text ?? '').trim();
      const asks = parseOrders(it.text ?? '').some((o) => o.type === 'pregunta');
      if (!asks && !(said && body.includes(said.slice(0, 200)))) continue;
      it.to = { threadId: lead.threadId, name: lead.name, role: 'orchestrator', label };
      (r.dirty ??= new Set()).add(it.id);
      marked = true;
    }
    if (marked) h._changed(thread, false);
  }

  /** The orders of the orchestrator's turn not sent yet (some may have gone when it started waiting on a timer). */
  _dispatch(team, member, thread, orders, items = null) {
    const r = this.host._rt(thread);
    r.sentOrders ??= new Set();
    const sent = [];
    // Each order is marked on the message that has it once it goes out: the sweep sends whatever never did.
    const list = items?.length
      ? items.flatMap((it) => parseOrders(it.text).map((o) => ({ o, it })))
      : orders.map((o) => ({ o, it: null }));
    for (const { o, it } of list) {
      const sig = orderSig(o);
      if (it?.orderSigs?.includes(sig)) continue;
      if (it) it.orderSigs = [...(it.orderSigs ?? []), sig];
      if (r.sentOrders.has(sig)) continue;
      r.sentOrders.add(sig);
      const res = this._order(team, member, o);
      if (res) sent.push(res);
    }
    for (const it of items ?? []) it.teamDone = true;
    return sent;
  }

  /** «Entregado: tarea → Ejecutor 2 · investigar → Investigador (en cola)»: what each order did, in the lead's thread. */
  _receipt(team, thread, sent) {
    if (!sent.length) return;
    const h = this.host;
    h._append(thread, { id: h._uuid(), kind: 'notice', text: `Entregas: ${sent.map((x) => `${x.type} → ${x.to}: ${RESULT[x.result] ?? x.result}`).join(' · ')}` });
    h._changed(thread);
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
    const sent = this._dispatch(team, member, thread, parseOrders(turnText), this._turnItems(thread));
    for (const it of this._turnItems(thread)) delete it.teamDone; // the turn isn't over: what it says next still counts
    this._receipt(team, thread, sent);
  }

  /** The replies of the turn running now in a thread (since the message that started it). */
  _turnItems(thread) {
    const r = this.host._rt(thread);
    const start = r.turnUserItem ? thread.items.findIndex((i) => i.id === r.turnUserItem) + 1 : 0;
    return thread.items.slice(Math.max(0, start)).filter((i) => i.kind === 'assistant' && i.text);
  }

  /** Something in this thread is for you: the apps notify it until you write there. */
  _attention(t, kind, text) {
    if (!t) return;
    t.attention = { kind, text: clip(text.replace(/\s+/g, ' '), 240), at: Date.now() / 1000 };
    this.host._changed(t);
    this.host._broadcastSnapshot();
    // Only a request from the orchestrator reaches your phone; the rest you see when you come in.
    if (kind === 'pedir') this.host._push?.(t, `${this.memberOf(t)?.name ?? 'El orquestador'} te pide algo`, t.attention.text, kind);
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
    const whole = String(text ?? '').trim();
    const clean = clip(whole.replace(/\s+/g, ' '), 400);
    if (!clean) return null;
    team.decisions ??= [];
    if (team.decisions.some((d) => norm(d.text) === norm(clean))) return null;
    team.nextDecision = (team.nextDecision ?? 0) + 1;
    // The short text travels in every preamble and to the apps; the whole one goes to the file on disk.
    const d = { id: team.nextDecision, text: clean, by, at: Date.now() / 1000, ...(clean !== whole.replace(/\s+/g, ' ') ? { full: clip(whole, DECISION_FULL_MAX) } : {}) };
    team.decisions.push(d);
    if (team.decisions.length > DECISIONS_MAX) this._archiveDecisions(team, team.decisions.splice(0, team.decisions.length - DECISIONS_MAX), 'antigua');
    this._writeDecisions(team);
    this.host._saveState();
    this.host._broadcastSnapshot();
    return d;
  }

  /** The project folder of a team, where its decisions are written. */
  _decisionsDir(team) {
    const root = this.host.projects?.().find((p) => p.id === team.projectId)?.path;
    return root ? path.join(root, DECISIONS_DIR) : null;
  }

  /**
   * The decisions, whole, in the project: an agent can read them back at any time (after a fresh session,
   * after another model carried its thread), not only when Relevo hands them over. Kept out of git.
   */
  _writeDecisions(team) {
    const dir = this._decisionsDir(team);
    if (!dir || !team.decisions?.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this._ignoreInGit(path.dirname(dir));
      const file = path.join(dir, 'decisiones.md');
      const day = (at) => new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const body = team.decisions.map((d) => `## #${d.id} · ${d.by ?? ''} · ${day(d.at)}\n\n${d.full ?? d.text}\n`).join('\n');
      fs.writeFileSync(file, `# Decisiones del equipo\n\nObjetivo: ${clip(String(team.goal ?? '').split('\n')[0], 200)}\n\nLas escribe Relevo: no edites este fichero (cámbialas con órdenes de decisión o desde la app). Las antiguas y las retiradas están en decisiones-anteriores.md.\n\n${body}`);
      team.decisionsFile = file;
    } catch (e) { this.host.log?.(`decisiones a disco: ${e.message}`); }
  }

  /** The file where deletions left for later are noted (in the project's .relevo folder, out of git). */
  _pendingDeletesFile(team) {
    const dir = this._decisionsDir(team);
    if (!dir) return null;
    const file = path.join(dir, PENDING_DELETES);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this._ignoreInGit(path.dirname(dir));
      if (!fs.existsSync(file)) fs.writeFileSync(file, '# Borrados pendientes\n\nLo que un agente quería borrar y el orquestador no vio claro: revísalo y límpialo cuando toque. Una línea por cosa: qué, ruta, por qué, quién y cuándo.\n\n');
    } catch (e) { this.host.log?.(`borrados pendientes: ${e.message}`); }
    return file;
  }

  /** Decisions that leave the list (too old, or withdrawn) are kept at the end of a second file. */
  _archiveDecisions(team, list, why) {
    const dir = this._decisionsDir(team);
    if (!dir || !list.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'decisiones-anteriores.md');
      const head = fs.existsSync(file) ? '' : '# Decisiones anteriores del equipo\n\nYa no están en vigor como lista activa: las antiguas salieron por límite y las retiradas se anularon.\n\n';
      fs.appendFileSync(file, head + list.map((d) => `## #${d.id} (${why}) · ${d.by ?? ''}\n\n${d.full ?? d.text}\n\n`).join(''));
    } catch (e) { this.host.log?.(`decisiones a disco: ${e.message}`); }
  }

  /** The folder stays out of git (the agents' `git add -A` would otherwise pick it up). */
  _ignoreInGit(root) {
    const gitDir = path.join(root, '.git');
    try {
      if (!fs.statSync(gitDir).isDirectory()) return;
      const exclude = path.join(gitDir, 'info', 'exclude');
      const now = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (now.split(/\r?\n/).some((l) => l.trim() === `/${DECISIONS_DIR}/`)) return;
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}/${DECISIONS_DIR}/\n`);
    } catch {}
  }

  /**
   * Decisions saved before the whole text was kept (cut at 400 characters): the whole one is still in the
   * orchestrator's messages.
   */
  _recoverDecisions(team) {
    const cut = (team.decisions ?? []).filter((d) => !d.full && d.text.endsWith('…'));
    if (!cut.length) return;
    const bodies = [];
    for (const it of this._lead(team)?.items ?? []) {
      if (it.kind !== 'assistant') continue;
      for (const m of String(it.text ?? '').matchAll(/<relevo:decisi[oó]n\b[^>]*>([\s\S]*?)<\/relevo:decisi[oó]n\s*>/gi)) bodies.push(m[1].trim());
    }
    for (const d of cut) {
      const key = norm(d.text.slice(0, -1)).slice(0, 200);
      const whole = bodies.find((b) => norm(b).startsWith(key));
      if (whole) d.full = clip(whole, DECISION_FULL_MAX);
    }
  }

  /** Withdraws decisions by number ("3", "#3, #5"). */
  dropDecisions(team, which) {
    const ids = new Set(String(which ?? '').match(/\d+/g)?.map(Number) ?? []);
    const gone = (team.decisions ?? []).filter((d) => ids.has(d.id));
    if (!gone.length) return [];
    team.decisions = team.decisions.filter((d) => !ids.has(d.id));
    this._archiveDecisions(team, gone, 'retirada');
    this._writeDecisions(team);
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
      team.pausedBy = 'budget';
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
   * An agent whose context is really full starts a fresh session. First it writes its own handoff note (one
   * short turn): what is verified, what it waits for, what it has half done. Then the session is renewed, and
   * the new one reads that note, the decisions, the board and your latest messages. Never while it works,
   * waits for an answer or has something running in the background.
   */
  _maybeRefresh(team, member, t) {
    const h = this.host;
    const r = h._rt(t);
    if (r.isRunning || r.approvals.size || r.backgroundTasks?.length || member.noteRequested) return;
    if ((r.context?.used ?? 0) <= h._renewLimit(r, t)) return;
    member.noteRequested = true;
    h._append(t, { id: h._uuid(), kind: 'notice', text: 'Contexto casi lleno: antes de renovar la sesión, el agente escribe su nota de traspaso' });
    h._startTurn(t, 'Relevo va a renovar tu sesión: escribe tu nota de traspaso.', false, {
      from: { name: 'Relevo', role: 'relevo', label: 'traspaso' },
      prompt: `(Relevo va a renovar tu sesión porque el contexto está casi lleno. Tu siguiente sesión NO recordará esta conversación: recibirá las decisiones y los hitos guardados, el estado del equipo, los últimos mensajes del usuario y ESTA nota.)\nEscribe ahora tu nota de traspaso: solo texto, sin usar herramientas${member.role === 'orchestrator' ? ' ni dar órdenes' : ''}, en menos de 40 líneas:\n1) Qué está ya comprobado y no hay que repetir (con fecha, commit o fichero).\n2) Qué estás esperando y de quién (del usuario, de cada agente).\n3) Qué tienes a medias y cuál es tu siguiente paso.\n4) Avisos: trampas, rutas, comandos o acuerdos con el usuario que no estén en las decisiones.\nNo repitas las decisiones ni los hitos ya guardados.`,
    });
  }

  /** The note is written (or there is none to wait for): the session starts over. */
  _renew(team, member, t) {
    const h = this.host;
    const r = h._rt(t);
    h.agents.get(t.id)?.close();
    h.agents.delete(t.id);
    t.sessionId = null;
    t.sessions = {}; // older sessions are bigger still: none is resumed after this
    t.handoffPending = true;
    t.freshSession = true;
    t.teamPrimed = false;
    r.sessionTokens = 0;
    r.context = null;
    const carries = ['su nota de traspaso', 'un resumen', member.role === 'orchestrator' ? 'el estado del equipo' : 'su tarea', team.decisions?.length ? `las ${team.decisions.length} decisiones` : null, 'tus últimos mensajes'].filter(Boolean);
    h._append(t, { id: h._uuid(), kind: 'notice', text: `Sesión renovada (contexto lleno): el siguiente mensaje lleva ${carries.slice(0, -1).join(', ')} y ${carries[carries.length - 1]}` });
    h._changed(t);
  }

  _maybeRefreshMember(team, member, t) { this._maybeRefresh(team, member, t); }

  /**
   * The safety net, end to end: whatever went wrong on the way, it compares what each agent said with what the
   * orchestrator got from it, and what the orchestrator wrote with what went out. Once a thread is quiet:
   * - the orchestrator's orders that never left (a message with an order not marked as sent) go now;
   * - an agent's last words the orchestrator never received (said after the last thing it got from it) go now.
   * Each at most once.
   */
  sweepUnreported(nowMs = Date.now(), only = null) {
    const h = this.host;
    const nowS = nowMs / 1000;
    for (const team of this.list) {
      if (team.status === 'done') continue;
      const lead = team.members.find((m) => m.role === 'orchestrator');
      for (const member of team.members) {
        const t = h.threads.get(member.threadId);
        if (!t || (only && t !== only)) continue;
        // The first look at a thread: what it said before counts as handled.
        if (t.teamSince === undefined) { t.teamSince = nowS; continue; }
        const r = h._rt(t);
        if (r.isRunning || r.approvals.size || r.sendNow || t.queued.length) continue;
        const last = t.items[t.items.length - 1];
        if (!only && (last?.date ?? 0) > nowS - QUIET) continue;
        if (member.role === 'orchestrator') {
          const pending = t.items.filter((i) => i.kind === 'assistant' && i.text && !i.teamSkip && (i.date ?? 0) > t.teamSince
            && parseOrders(i.text).some((o) => !(i.orderSigs ?? []).includes(orderSig(o))));
          if (!pending.length) continue;
          h.log?.(`equipo: ${member.name} escribió órdenes que no habían salido; se envían ahora`);
          h._append(t, { id: h._uuid(), kind: 'notice', text: 'Relevo envía ahora órdenes que escribiste y no habían salido' });
          const sent = this._dispatch(team, member, t, [], pending);
          this._receipt(team, t, sent);
          h._changed(t);
          h._saveState?.();
          continue;
        }
        // Waiting on its own job: it reports when that ends.
        if (r.backgroundTasks?.length || !lead) continue;
        const since = Math.max(member.lastToLeadAt ?? 0, t.teamSince);
        const said = t.items.filter((i) => i.kind === 'assistant' && i.text?.trim() && !i.teamSkip && (i.date ?? 0) > since);
        if (!said.length || member.sweptItem === said[said.length - 1].id) continue;
        member.sweptItem = said[said.length - 1].id;
        h.log?.(`equipo: lo último que dijo ${member.name} no había llegado a ${lead.name}; se envía ahora`);
        h._append(t, { id: h._uuid(), kind: 'notice', text: 'Relevo envía ahora al equipo lo último que dijo este agente: no había llegado' });
        h._changed(t);
        try {
          this.onTurnFinished(t, {
            items: said, text: said.map((i) => i.text).join('\n\n'), messages: said.map((i) => i.text), changes: null,
            errors: t.items.filter((i) => i.kind === 'error' && (i.date ?? 0) > since).map((i) => i.text), background: [],
          });
        } catch (e) { h.log?.(`equipo: no se pudo enviar lo de «${t.title}»: ${e?.stack ?? e}`); }
      }
    }
  }

  /** Before its agent changes: whatever it said that hasn't reached the team goes now, from the model that said it. */
  flushUnreported(thread) { this.sweepUnreported(Date.now(), thread); }

  /**
   * The watchdog, without an AI: a team where nobody works, waits on a job or has a message on its way gets its
   * orchestrator woken once that lasts IDLE_NUDGE (with what each agent said last). Twice in a row with no order
   * coming out of it, and it's you who gets told instead. Also: a pending order for an agent that's now free
   * goes, and an order that's «en curso» on the board but never reached its agent is pointed out.
   */
  watchIdle(nowS = Date.now() / 1000) {
    const h = this.host;
    const hhmm = (s) => new Date(s * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    for (const team of this.list) {
      if (team.status !== 'active') continue;
      const lead = team.members.find((m) => m.role === 'orchestrator');
      const leadThread = lead && h.threads.get(lead.threadId);
      if (!leadThread) continue;
      const busy = (t) => {
        const r = h._rt(t);
        return !!(r.isRunning || r.approvals.size || r.sendNow || t.queued.length || r.backgroundTasks?.length || r.limit || r.resumeAt || r.pendingRelay);
      };
      const members = team.members.map((m) => ({ m, t: h.threads.get(m.threadId) })).filter((x) => x.t);
      // A pending order whose agent is free, with nobody deciding about it now: it goes.
      for (const { m, t } of members) {
        if (m.parked && m.role !== 'orchestrator' && !busy(t) && !busy(leadThread) && nowS - m.parked.at > QUIET * 3) this._deliverParked(team, m);
      }
      // An order on the board that its agent never got (it said nothing and was never asked since).
      for (const { m, t } of members) {
        if (m.role === 'orchestrator' || m.task?.state !== 'en curso' || busy(t) || m.stuckWarned === m.task.since) continue;
        if (nowS - m.task.since < STUCK_AFTER) continue;
        const got = t.items.some((i) => (i.kind === 'user' || i.kind === 'assistant') && (i.date ?? 0) >= m.task.since - 5);
        if (got) continue;
        m.stuckWarned = m.task.since;
        h.log?.(`equipo: ${m.name} tiene una tarea en curso desde las ${hhmm(m.task.since)} que nunca le llegó`);
        this._deliver(team, lead, `${m.name} figura con la tarea «${clip(m.task.text ?? '', 140)}» en curso desde las ${hhmm(m.task.since)}, pero no le ha llegado ni ha hecho nada desde entonces: está libre. Dásela otra vez si sigue valiendo.`, { name: 'Relevo', role: 'relevo', label: 'vigilante' });
      }
      if (members.some(({ t }) => busy(t))) continue;
      const lastActivity = Math.max(...members.map(({ t }) => t.items[t.items.length - 1]?.date ?? 0));
      if (nowS - lastActivity < IDLE_NUDGE || team.nudgedFor === lastActivity) continue;
      // Its last word was a question for you: the team is waiting for you, not stuck.
      const lastLead = [...leadThread.items].reverse().find((i) => i.kind === 'assistant' && i.text);
      const said = withoutOrders(lastLead?.text ?? '').trim();
      if (lastLead && !parseOrders(lastLead.text).some((o) => MESSAGE_ORDERS.includes(o.type)) && /[?¿][^\n]*$/.test(said.split('\n').filter(Boolean).pop() ?? '')) continue;
      team.nudgedFor = lastActivity;
      if ((team.nudges ?? 0) >= 2) {
        if (team.nudges === 2) {
          team.nudges = 3;
          h._append(leadThread, { id: h._uuid(), kind: 'notice', text: 'El equipo sigue parado tras dos avisos y el orquestador no reparte trabajo: mira si necesita algo de ti' });
          this._attention(leadThread, 'parado', 'El equipo está parado: el orquestador no reparte trabajo');
          h._push?.(leadThread, 'Equipo parado', 'Nadie trabaja y el orquestador no reparte trabajo', `parado${Math.round(lastActivity)}`);
          h._changed(leadThread);
        }
        continue;
      }
      team.nudges = (team.nudges ?? 0) + 1;
      const lines = members.filter(({ m }) => m !== lead).map(({ m, t }) => {
        const lastSaid = [...t.items].reverse().find((i) => i.kind === 'assistant' && i.text && !i.teamSkip);
        if (!lastSaid) return `- ${m.name}: no ha dicho nada aún`;
        const head = withoutOrders(lastSaid.text).split('\n').map((l) => l.trim()).filter(Boolean);
        const state = head.find((l) => /^\**ESTADO/i.test(l)) ?? head[0] ?? '';
        return `- ${m.name}: libre desde las ${hhmm(lastSaid.date ?? lastActivity)} · «${clip(state.replace(/\*/g, ''), 160)}»`;
      });
      const minutes = Math.round((nowS - lastActivity) / 60);
      h.log?.(`equipo: lleva ${minutes} min parado; se avisa a ${lead.name}`);
      this._deliver(team, lead, `El equipo lleva ${minutes} min parado: nadie trabaja ni espera un trabajo en segundo plano, y no hay mensajes en camino.\n${lines.join('\n')}\nSi queda trabajo hacia el objetivo, repártelo ahora. Si de verdad estáis esperando algo del usuario, dilo en una línea y no repartas.`, { name: 'Relevo', role: 'relevo', label: 'vigilante' });
    }
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
    const lead = team.members.find((m) => m.threadId === t.id);
    if (lead) this._maybeRefresh(team, lead, t);
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
    if (!lead) return null;
    // Its pending order comes back with its report: the orchestrator decides with fresh information.
    if (from.parked && !from.parked.offered) {
      const at = new Date(from.parked.at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      text += `\n\n(Pendiente para ${from.name} desde las ${at}, no se le pudo dar porque estaba trabajando: «${clip(from.parked.text.replace(/\s+/g, ' '), 300)}». Si en esta respuesta no le das otra orden, Relevo se la entrega tal cual al terminar tu turno.)`;
      from.parked.offered = true;
    }
    const res = this._deliver(team, lead, text, { threadId: from.threadId, name: from.name, role: from.role, label: kind });
    if (['sent', 'queued', 'held'].includes(res)) from.lastToLeadAt = Date.now() / 1000;
    this.host.log?.(`equipo: ${kind} de ${from.name} → ${lead.name}: ${res}`);
    return res;
  }

  /**
   * The outbox: each message the orchestrator sent and what became of it. Its next message carries what changed
   * («entregada», «en cola», «pendiente»…), so it never has to guess whether something arrived.
   */
  _sent(team, type, to, body, result) {
    const h = this.host;
    const entry = { id: (team.nextOut = (team.nextOut ?? 0) + 1), type, to: to.name, what: clip(String(body).replace(/\s+/g, ' '), 90), at: Date.now() / 1000, result };
    // In a queue: which entry, to tell when it's read.
    if (result === 'queued') entry.queueId = h.threads.get(to.threadId)?.queued.find((q) => q.team)?.id ?? null;
    if (result === 'parked' && to.parked) to.parked.outId = entry.id;
    team.outbox = [...(team.outbox ?? []), entry].slice(-30);
    if (['sent', 'queued', 'parked'].includes(result)) team.nudges = 0; // work is moving again
    h.log?.(`equipo: ${type} → ${to.name}: ${result}`);
    return { type, to: to.name, result };
  }

  /** Outbox lines the orchestrator hasn't read yet; a queued one reads «entregada» once its turn takes it. */
  _outboxNews(team) {
    const h = this.host;
    const lines = [];
    for (const e of team.outbox ?? []) {
      if (e.result === 'queued' || e.result === 'parked') {
        const m = findMember(team, e.to);
        const t = m && h.threads.get(m.threadId);
        const stillQueued = e.result === 'queued' && t?.queued.some((q) => q.id === e.queueId);
        const stillParked = e.result === 'parked' && m?.parked?.outId === e.id;
        if (!stillQueued && !stillParked) { e.result = 'sent'; e.shown = false; }
      }
      if (e.shown) continue;
      e.shown = true;
      lines.push(`${new Date(e.at * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} ${e.type} → ${e.to} («${e.what}»): ${RESULT[e.result] ?? e.result}`);
    }
    return lines.slice(-8);
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
        const res = this._deliver(team, to, `${notes}${o.body}`, { ...from, label: o.type === 'urgente' ? 'urgente' : 'tarea' }, false, o.type === 'urgente');
        // On the board only what really went out (not what bounced off someone busy or is held in a pause).
        if (res === 'sent' || res === 'queued') { to.stash = []; this._setTask(to, 'en curso', clip(o.body.replace(/\s+/g, ' '), 140)); }
        return this._sent(team, o.type, to, o.body, res);
      }
      case 'investigar': {
        if (!researcher) { complain('Este equipo no tiene investigador: busca tú o pide al usuario que lo añada.'); return; }
        // para= names who else gets the report: an executor. Naming the researcher itself (or you) adds no one,
        // or its own report would come back to it and cost a turn.
        const forWhom = o.to ? findMember(team, o.to) : null;
        researcher.reportFor = forWhom?.role === 'executor' ? forWhom.name : null;
        researcher.inquiry = clip(o.body.replace(/\s+/g, ' '), 300);
        // The list of what is already researched goes once, with its instructions when a session starts. An
        // order only adds what this agent hasn't been given since (usually nothing: it wrote those reports).
        const rt = h.threads.get(researcher.threadId);
        const unseen = rt?.teamPrimed ? (team.findings ?? []).filter((f) => f.id > (researcher.findingsSeen ?? 0)) : [];
        const extra = unseen.length ? `\n\n(Investigado desde tu última consulta:\n${unseen.map(findingLine).join('\n')})` : '';
        const res = this._deliver(team, researcher, `${o.body}${extra}`, { ...from, label: researcher.reportFor ? `investigación para ${researcher.reportFor}` : 'investigación' });
        if (res === 'sent' || res === 'queued') { researcher.findingsSeen = team.nextFinding ?? 0; this._setTask(researcher, 'en curso', clip(o.body.replace(/\s+/g, ' '), 140)); }
        return this._sent(team, 'investigar', researcher, o.body, res);
      }
      case 'aprobar':
      case 'denegar':
      case 'consultar': {
        // Without para=: whoever waits for one, if only one does.
        const waiting = team.members.filter((m) => m.role !== 'orchestrator' && this._permits(m).length);
        const to = o.to ? findMember(team, o.to) : waiting.length === 1 ? waiting[0] : null;
        if (!to || to.role === 'orchestrator') { complain(`No sé de quién es el permiso${o.to ? ` «${o.to}»` : ''}: pon para="…".`); return; }
        const t = h.threads.get(to.threadId);
        const list = this._permits(to);
        if (!t || !list.length) return this._sent(team, o.type, to, o.body || o.type, 'nothing');
        const why = o.body ? clip(o.body.replace(/\s+/g, ' '), 400) : '';
        for (const it of list) {
          const opts = it.options ?? [];
          const pick = o.type === 'aprobar'
            ? opts.find((x) => x.isAllow && !/always|siempre|session|sesi[oó]n/i.test(`${x.id} ${x.label}`)) ?? opts.find((x) => x.isAllow)
            : o.type === 'denegar' ? opts.find((x) => !x.isAllow) : null;
          if (!pick) { this._escalate(team, to, it, o.type === 'consultar' ? `${lead.name} prefiere que lo decidas tú${why ? `: ${why}` : ''}` : `${lead.name} no ha podido responderlo`); continue; }
          // Claude reads why in the denial itself; the others get it as a message when their turn ends.
          const pending = it.critical ? this._pendingDeletesFile(team) : null;
          const note = o.type === 'denegar' ? `${lead.name} (el orquestador) ha denegado esta acción${why ? `: ${why}${pending && !/[.!?…]$/.test(why) ? '.' : ''}` : '.'}${pending ? ` Busca otra forma de hacerlo; si no la hay, anótalo en ${pending} (qué borrarías, la ruta y por qué) para limpiarlo en otro momento, y sigue con tu tarea.` : ''}` : null;
          h._resolve(t, it.id, pick.id, null, note);
          it.resolution = o.type === 'aprobar' ? `Permitido por ${lead.name}` : `Denegado por ${lead.name}`;
          h._touch(t, it);
          if (note && h.accountsById.get(t.accountId)?.kind !== 'claude') this._deliver(team, to, note, { ...from, label: 'permiso denegado' });
        }
        h._append(t, { id: h._uuid(), kind: 'notice', text: o.type === 'aprobar' ? `${lead.name} lo ha permitido${why ? `: ${why}` : ''}` : o.type === 'denegar' ? `${lead.name} lo ha denegado${why ? `: ${why}` : ''}` : `${lead.name} te pasa la decisión${why ? `: ${why}` : ''}` });
        h._changed(t);
        return this._sent(team, o.type, to, o.body || '(sin comentario)', o.type === 'aprobar' ? 'approved' : o.type === 'denegar' ? 'denied' : 'escalated');
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
          return this._sent(team, 'respuesta', to, o.body, 'answered');
        }
        // A question, or a blocked or waiting agent: the answer is what it needs to go on, so it goes now.
        if (to.awaitingAnswer || ['bloqueado', 'esperando'].includes(to.task?.state)) {
          const res = this._deliver(team, to, o.body, { ...from, label: 'respuesta' });
          to.awaitingAnswer = false;
          return this._sent(team, 'respuesta', to, o.body, res);
        }
        // It hadn't asked anything (an acknowledgement, a comment): opening a turn for that costs its whole
        // context. It's kept and goes with its next task.
        to.stash = [...(to.stash ?? []), clip(o.body.replace(/\s+/g, ' '), 300)].slice(-4);
        h._append(leadThread, { id: h._uuid(), kind: 'notice', text: `Respuesta guardada para la próxima tarea de ${to.name} (no había preguntado nada)` });
        h._changed(leadThread);
        return this._sent(team, 'respuesta', to, o.body, 'stashed');
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
      case 'pedir': {
        if (o.body) this._attention(leadThread, 'pedir', o.body);
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
    // Mid-turn, that is. Something left running in the background doesn't count: the agent is idle, waiting
    // for it, and can read a message (and an answer to its own question always goes).
    const midTurn = target && h._rt(target).isRunning;
    const answer = from.label === 'respuesta' && member.awaitingAnswer;
    // Writing its handoff note for Relevo isn't work: what arrives meanwhile waits and goes to its new session.
    const handoff = member.noteRequested;
    if (midTurn && !urgent && !answer && !handoff && member.role !== 'orchestrator' && (from.role === 'orchestrator' || from.role === 'researcher')) {
      return this._bounce(team, member, text, from);
    }
    // No pause for «too many messages without you»: a team working through the night is the point. Your brakes
    // are the daily budget and the Pausar button.
    if (team.status === 'paused' && !resumed) { this._hold(team, member, text, from); return 'held'; }
    const t = h.threads.get(member.threadId);
    if (!t) return 'gone';
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
    // Everyone sees where the others stand: the orchestrator so it doesn't pile orders on someone busy, the rest
    // so they don't wait on someone out of quota or ask someone who is stuck.
    const status = `\n\n(${this._status(team, member)})`;
    const prompt = `${fresh}${header}\n${text}${status}`;
    const meta = { from: { threadId: from.threadId ?? null, name: from.name, role: from.role, label: from.label ?? null } };
    const r = h._rt(t);
    if (urgent && r.isRunning && member.role !== 'orchestrator') {
      h.sendNow(t, text, { ...meta, prompt: `${prompt}\n\n(Esto interrumpe lo que estabas haciendo: atiéndelo primero.)` });
      return 'sent';
    }
    // Busy, or seconds away from the model change you asked for: it reads this when it's ready.
    if (r.isRunning || r.approvals.size || h._switchSoon?.(t)) {
      // Whatever arrives for someone busy goes as one message when its turn ends, not one turn per message.
      const waiting = t.queued.find((q) => q.team);
      if (waiting) this._merge(waiting, header, text, prompt, member.role);
      else t.queued.push({ id: h._uuid(), text, prompt, header, from: meta.from, team: true });
      // An orchestrator only waiting on its own timer stops waiting when what it waits for arrives: a message
      // from the agent the timer names (any, if it names none), or anything that can't wait (a question, a
      // blocker, an error, Relevo).
      const pressing = ['pregunta', 'permiso', 'error', 'aviso', 'urgente'].includes(from.label) || from.role === 'relevo' || /^\s*\**ESTADO:?\**\s*bloqueado/im.test(text);
      const awaited = !r.waitingFor?.length || r.waitingFor.includes(from.name);
      if (member.role === 'orchestrator' && r.waitingTimer && !r.approvals.size && (awaited || pressing)) {
        r.waitingTimer = false;
        r.statusLine = `Llega un mensaje de ${from.name}: deja de esperar…`;
        h.agents.get(t.id)?.interrupt();
      }
      h._changed(t);
      return 'queued';
    }
    h._startTurn(t, text, false, { ...meta, prompt });
    return 'sent';
  }

  /**
   * While the team is paused a message is kept, not lost: you review each one (send it or drop it), and the
   * orchestrator is told its order is waiting, so it doesn't believe it went out.
   */
  _hold(team, member, text, from) {
    const h = this.host;
    team.held.push({ id: h._uuid(), toThread: member.threadId, text, from, at: Date.now() / 1000 });
    const lead = this._lead(team);
    if (lead && from.role === 'orchestrator') {
      h._append(lead, { id: h._uuid(), kind: 'notice', text: `Retenido (equipo en pausa): tu mensaje para ${member.name}. El usuario decide si se envía.` });
      h._changed(lead);
    }
    h._saveState();
    h._broadcastSnapshot();
  }

  /** The held messages as the apps show them (older entries get an id the first time). */
  heldList(team) {
    const h = this.host;
    return team.held.map((d) => {
      d.id ??= h._uuid();
      const to = team.members.find((m) => m.threadId === (d.toThread ?? d.to?.threadId));
      return { id: d.id, to: to?.name ?? d.to?.name ?? '?', toThread: to?.threadId ?? null, from: d.from?.name ?? '?', label: d.from?.label ?? null, text: clip(String(d.text ?? ''), 1500), at: d.at ?? null };
    });
  }

  /** The guard for every agent of the team (on, off, or null: as in the host's settings). */
  setGuard(teamId, on) {
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    for (const m of team.members) { const t = this.host.threads.get(m.threadId); if (t) this.host.setGuard(t, on); }
    team.guard = on === null || on === undefined ? null : !!on;
    this.host._saveState();
    this.host._broadcastSnapshot();
    return {};
  }

  /** You send or drop one held message (or all of them). The orchestrator hears what was dropped. */
  reviewHeld(teamId, id, action) {
    const h = this.host;
    const team = this.byId(teamId);
    if (!team) throw new Error('Equipo desconocido');
    const picked = id === '*' ? [...team.held] : team.held.filter((d) => (d.id ?? '') === id);
    if (!picked.length) throw new Error('Ese mensaje ya no está retenido');
    team.held = team.held.filter((d) => !picked.includes(d));
    const dropped = [];
    for (const d of picked) {
      const to = team.members.find((m) => m.threadId === (d.toThread ?? d.to?.threadId));
      if (!to) continue;
      if (action === 'send') {
        const res = this._deliver(team, to, d.text, d.from, true, d.from?.label === 'urgente');
        if (['sent', 'queued'].includes(res) && to.role !== 'orchestrator' && ['tarea', 'urgente'].includes(d.from?.label)) this._setTask(to, 'en curso', clip(String(d.text).replace(/\s+/g, ' '), 140));
      } else if (d.from?.role === 'orchestrator') dropped.push(`para ${to.name}: «${clip(String(d.text).replace(/\s+/g, ' '), 100)}»`);
    }
    if (dropped.length) team.notes = [...(team.notes ?? []), `El usuario ha descartado ${dropped.length === 1 ? 'tu mensaje retenido' : `${dropped.length} mensajes tuyos retenidos`} ${dropped.join('; ')}. No se entregó: vuelve a darlo solo si sigue valiendo.`];
    h._saveState();
    h._broadcastSnapshot();
    return {};
  }

  /**
   * An order for someone busy goes back: a line in the orchestrator's thread now (no extra turn), and a note
   * with its next message, so it gives that member what's next after reading its report.
   */
  _bounce(team, member, text, from) {
    const h = this.host;
    const lead = this._lead(team);
    // An order for someone mid-turn is kept (the latest one): the orchestrator sees it again with that agent's
    // report and either gives another order or lets Relevo deliver this one. It is never just dropped.
    if (from.role === 'orchestrator') {
      const prev = member.parked;
      const old = prev?.outId && team.outbox?.find((x) => x.id === prev.outId);
      if (old) { old.result = 'replaced'; old.shown = false; }
      member.parked = { text, from, label: from.label ?? null, at: Date.now() / 1000, offered: false };
      if (lead) {
        h._append(lead, { id: h._uuid(), kind: 'notice', text: `Pendiente para ${member.name} (está a mitad de un turno): se le entrega cuando termine, salvo que al leer su informe le des otra orden` });
        h._changed(lead);
      }
      h._saveState();
      return 'parked';
    }
    const what = clip(text.replace(/\s+/g, ' '), 140);
    team.notes = [...(team.notes ?? []), `No entregado a ${member.name}, que estaba a mitad de un turno: «${what}». No se le entregará solo: cuando llegue su informe, vuelve a dárselo si sigue valiendo (o usa urgente si no podía esperar).`].slice(-6);
    if (lead) {
      h._append(lead, { id: h._uuid(), kind: 'notice', text: `No entregado a ${member.name} (está a mitad de un turno): ${from.role === 'researcher' ? 'el informe del Investigador' : 'tu mensaje'} no le llega solo; dáselo de nuevo tras su informe` });
      h._changed(lead);
    }
    h._saveState();
    return 'bounced';
  }

  /**
   * After the orchestrator's turn: a pending order it was shown again goes now, unless it gave that agent
   * something else in this turn (then it's dropped: the new order replaces it).
   */
  _offerParked(team, sent) {
    for (const m of team.members) {
      if (!m.parked || m.role === 'orchestrator') continue;
      // Another order that reached it in this turn replaces the pending one (the pending one itself doesn't count).
      if (sent.some((x) => x.to === m.name && x.result !== 'parked' && ['tarea', 'urgente', 'investigar', 'respuesta'].includes(x.type))) {
        const e = team.outbox?.find((x) => x.id === m.parked.outId);
        if (e) { e.result = 'dropped'; e.shown = false; }
        m.parked = null;
      } else if (m.parked.offered) this._deliverParked(team, m);
    }
  }

  _deliverParked(team, m) {
    const p = m.parked;
    if (!p) return;
    m.parked = null;
    const res = this._deliver(team, m, p.text, p.from);
    const e = team.outbox?.find((x) => x.id === p.outId);
    if (e && res !== 'parked') { e.result = res; e.shown = false; }
    if ((res === 'sent' || res === 'queued') && ['tarea', 'urgente'].includes(p.label)) this._setTask(m, 'en curso', clip(p.text.replace(/\s+/g, ' '), 140));
    this.host.log?.(`equipo: orden pendiente → ${m.name}: ${res}`);
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
  /**
   * Where one member stands, for the others: waiting for the user, out of quota (and until when), renewing its
   * session, working (since when, on what), waiting for a background job, or free (since when).
   */
  _memberState(team, m) {
    const h = this.host;
    const t = h.threads.get(m.threadId);
    if (!t) return null;
    const r = h._rt(t);
    const at = (sec) => new Date(sec * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const nameOf = (id) => h.accountsById.get(id)?.name ?? 'otro modelo';
    let state;
    const asks = r.approvals.size ? [...r.approvals.keys()].map((id) => t.items?.find((i) => i.id === id)) : [];
    if (asks.length && asks.every((i) => i?.reviewBy && !i.escalated && !i.resolution)) state = `BLOQUEADO esperando un permiso del orquestador («${clip(String(asks[0].output || asks[0].title || '').split('\n')[0], 80)}»)`;
    else if (asks.length) state = 'BLOQUEADO esperando al usuario (una pregunta o un permiso)';
    else if (!r.isRunning && r.pendingRelay) state = `SIN CUOTA: pasa a ${nameOf(r.pendingRelay.accountId)} en unos segundos`;
    else if (!r.isRunning && r.resumeAt) state = r.resumeUnknown ? 'SIN CUOTA: retoma solo en cuanto vuelva (se comprueba cada pocos minutos)' : `SIN CUOTA: retoma solo hacia las ${at(r.resumeAt)}`;
    else if (!r.isRunning && r.limit) state = 'SIN CUOTA: parado hasta que el usuario decida';
    else if (m.noteRequested) state = 'renovando su sesión (escribe su nota de traspaso)';
    else if (r.isRunning) {
      const since = r.turnStartedAt ? ` desde las ${at(r.turnStartedAt)}` : '';
      const doing = r.statusLine && !/^Trabajando/.test(r.statusLine) ? `: ${clip(r.statusLine.replace(/\s+/g, ' '), 70)}` : '';
      state = `trabajando${since}${doing}`;
    } else if (r.backgroundTasks?.length) {
      const first = Math.min(...r.backgroundTasks.map((b) => b.startedAt ?? Infinity));
      state = `esperando un trabajo en segundo plano${Number.isFinite(first) ? ` desde las ${at(first)}` : ''} (${r.backgroundTasks.map((b) => clip(b.description ?? '', 50)).slice(0, 2).join(', ')})`;
    } else {
      const last = t.items?.at(-1)?.date;
      state = `libre${last ? ` desde las ${at(last)}` : ''}`;
    }
    const extra = [];
    if (r.pendingSwitch && !r.pendingSwitch.auto) extra.push(`cambiará a ${nameOf(r.pendingSwitch.accountId)} al quedar libre`);
    if (t.home) extra.push(`en un modelo de reserva hasta que vuelva la cuota de ${nameOf(t.home.accountId)}`);
    return { t, r, state: extra.length ? `${state}; ${extra.join('; ')}` : state };
  }

  /**
   * Where the team stands, as one member reads it (everyone but itself). The orchestrator also sees what waits
   * for each one and what became of the orders it sent.
   */
  _status(team, self) {
    const lead = self?.role === 'orchestrator';
    const parts = team.members.filter((m) => m !== self).map((m) => {
      const s = this._memberState(team, m);
      if (!s) return null;
      const label = m.role === 'orchestrator' ? `${m.name} (orquestador)` : m.name;
      const task = m.task?.text ? ` · tarea «${clip(m.task.text, lead ? 90 : 60)}» (${m.task.state} desde las ${new Date(m.task.since * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })})` : '';
      if (!lead) return `${label} ${s.state}${task}`;
      const waiting = s.t.queued.filter((q) => q.team).reduce((n, q) => n + (q.merged ? (q.text.match(/^\[/gm) ?? []).length : 1), 0);
      const parked = m.parked ? `, con una orden tuya pendiente de darle al terminar («${clip(m.parked.text.replace(/\s+/g, ' '), 60)}»)` : '';
      return `${label} ${s.state}${waiting ? `, con ${waiting} mensaje${waiting === 1 ? '' : 's'} en cola que leerá al terminar` : ''}${parked}${task}`;
    }).filter(Boolean);
    const paused = team.status === 'paused' ? (lead ? `EQUIPO EN PAUSA: tus órdenes se retienen sin entregar hasta que el usuario las revise (${team.held.length} retenidas). ` : 'EQUIPO EN PAUSA. ') : '';
    const news = lead ? this._outboxNews(team) : [];
    const out = news.length ? `\nQué ha sido de tus mensajes: ${news.join(' | ')}` : '';
    return `${paused}Estado del equipo: ${parts.join(' | ')}${out}`;
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

/**
 * A report as the orchestrator reads it: markdown made plain (no headings, bold or table borders; a table row
 * becomes «a · b · c»). Nothing is cut: brevity is asked of the agents, never imposed on what they found.
 */
export function compactReport(text) {
  let s = String(text ?? '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$\n?/gm, '')
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (m, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' · '))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

/**
 * Of what an agent wrote in a turn, its report: the last message that carries a status line, else its last
 * message. What came before is progress («voy a…», «ahora reviso…»), not for the orchestrator.
 */
export function finalMessage(messages) {
  const list = (messages ?? []).map((m) => String(m ?? '')).filter((m) => m.trim());
  if (!list.length) return '';
  for (let i = list.length - 1; i >= 0; i--) if (/^\s*\**ESTADO:?\**\s*(hecho|esperando|bloqueado)/im.test(withoutOrders(list[i]))) return list.slice(i).join('\n\n');
  return list[list.length - 1];
}

function headTail(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.35);
  return `${clip(s, head)}\n[…]\n${s.slice(-(n - head))}`;
}
