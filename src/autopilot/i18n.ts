/** What the person and the orchestrator read about the autopilot from the service (launch refusals reach both). */
import type { Locale } from '../harness/i18n.ts';
import type { BindCheck } from './binding.ts';

type Reason = Exclude<BindCheck, { ok: true }>['reason'];

const EN: Record<Reason | 'exhausted' | 'provider' | 'planUnusable', string> = {
  'wrong-model': 'Auto (Jev): this subagent asks for another model than its route. Call canvastty-assistant__pick_route again and pass its spawn values to spawn_agent unchanged, with no model of your own.',
  'wrong-effort': 'Auto (Jev): this subagent asks for another effort than its route. Call canvastty-assistant__pick_route again and pass its spawn values to spawn_agent unchanged, with no effort of your own.',
  'wrong-account': 'Auto (Jev): this subagent\'s model account is not the one its route chose. Call canvastty-assistant__pick_route again and pass its launchOptions unchanged.',
  'wrong-options': 'Auto (Jev): this subagent\'s launch options are not the ones its route chose. Call canvastty-assistant__pick_route again and pass its spawn values unchanged.',
  leaf: 'Auto (Jev): you were routed as one task, not to split it. Do the work yourself; if it must be split, your orchestrator routes it with canvastty-assistant__pick_route and orchestrate: true.',
  unrouted: 'Auto (Jev) routes every subagent: call canvastty-assistant__pick_route with this subtask and pass its spawn values to spawn_agent unchanged.',
  unknown: 'Auto (Jev): this route value is not one pick_route gave out. Call canvastty-assistant__pick_route again and pass its spawn values unchanged.',
  used: 'Auto (Jev): this route was already used for another subagent. Call canvastty-assistant__pick_route again for this subtask.',
  expired: 'Auto (Jev): this route is older than 10 minutes. Call canvastty-assistant__pick_route again for this subtask.',
  'wrong-parent': 'Auto (Jev): this route was given to another orchestrator. Call canvastty-assistant__pick_route yourself.',
  'wrong-cli': 'Auto (Jev): this route was for another CLI. Pass pick_route\'s spawn values unchanged, provider included.',
  'over-plan': 'Auto (Jev): your plan has no room for another subagent now. Wait for one to finish, or call canvastty-assistant__autopilot_plan again.',
  exhausted: 'Auto (Jev): this CLI\'s subscription has no room left now ({why}). Choose another CLI, or start it without Auto.',
  provider: 'Model: Auto (Jev) works on Claude Code and Codex (their own sign-in) and on OpenCode. Choose the agent\'s own model for this CLI.',
  planUnusable: 'Auto (Jev): this OpenCode plan model cannot be pinned. Call canvastty-assistant__pick_route again.'
};

const RU: typeof EN = {
  'wrong-model': '«Авто (Jev)»: этот субагент просит не ту модель, что выбрал маршрут. Вызовите canvastty-assistant__pick_route ещё раз и передайте его значения spawn в spawn_agent без изменений, без своей модели.',
  'wrong-effort': '«Авто (Jev)»: этот субагент просит не то усилие, что выбрал маршрут. Вызовите canvastty-assistant__pick_route ещё раз и передайте его значения spawn в spawn_agent без изменений, без своего усилия.',
  'wrong-account': '«Авто (Jev)»: у этого субагента не тот аккаунт модели, что выбрал маршрут. Вызовите canvastty-assistant__pick_route ещё раз и передайте его launchOptions без изменений.',
  'wrong-options': '«Авто (Jev)»: у этого субагента не те параметры запуска, что выбрал маршрут. Вызовите canvastty-assistant__pick_route ещё раз и передайте его значения spawn без изменений.',
  leaf: '«Авто (Jev)»: вас направили как одну задачу, без разбиения. Сделайте работу сами; если её нужно разбить, ваш оркестратор направит её через canvastty-assistant__pick_route с orchestrate: true.',
  unrouted: '«Авто (Jev)» распределяет каждого субагента: вызовите canvastty-assistant__pick_route с этой подзадачей и передайте его значения spawn в spawn_agent без изменений.',
  unknown: '«Авто (Jev)»: это значение маршрута выдал не pick_route. Вызовите canvastty-assistant__pick_route ещё раз и передайте его значения spawn без изменений.',
  used: '«Авто (Jev)»: этот маршрут уже использован для другого субагента. Вызовите canvastty-assistant__pick_route для этой подзадачи ещё раз.',
  expired: '«Авто (Jev)»: этому маршруту больше 10 минут. Вызовите canvastty-assistant__pick_route для этой подзадачи ещё раз.',
  'wrong-parent': '«Авто (Jev)»: этот маршрут выдан другому оркестратору. Вызовите canvastty-assistant__pick_route сами.',
  'wrong-cli': '«Авто (Jev)»: этот маршрут был для другого CLI. Передайте значения spawn из pick_route без изменений, вместе с provider.',
  'over-plan': '«Авто (Jev)»: в вашем плане сейчас нет места для ещё одного субагента. Дождитесь окончания одного или вызовите canvastty-assistant__autopilot_plan ещё раз.',
  exhausted: '«Авто (Jev)»: у подписки этого CLI сейчас не осталось запаса ({why}). Выберите другой CLI или запустите без «Авто».',
  provider: '«Модель: Авто (Jev)» работает в Claude Code и Codex (на их собственном входе) и в OpenCode. Для этого CLI выберите собственную модель агента.',
  planUnusable: '«Авто (Jev)»: эту модель плана OpenCode нельзя закрепить. Вызовите canvastty-assistant__pick_route ещё раз.'
};

export const AUTOPILOT_STRINGS: Readonly<Record<Locale, typeof EN>> = { en: EN, ru: RU };
