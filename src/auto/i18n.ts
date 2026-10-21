/** What the person reads about Auto (Jev) from the service: launch refusals and the card badge's tooltip. */
import type { Locale } from '../harness/i18n.ts';
import type { AutoTier } from './settings.ts';

export type AutoRefusal = 'provider' | 'environment' | 'project' | 'projectUnreadable' | 'noUpstream' | 'listLoading' | 'dataClass' | 'router' | 'unknownValue';

const EN: Record<AutoRefusal, string> & { badgeTip(tier: AutoTier, source: string): string; tiers: Record<AutoTier, string>; sources: Record<string, string>; noProvider: string; jevOnly: string } = {
  provider: 'Model: Auto (Jev) works with OpenCode for now. Choose Off for this agent.',
  environment: 'Auto (Jev) runs on this computer; it cannot reach a container or a remote host yet. Choose Off, or run the card on this computer.',
  project: 'This project\'s OpenCode config chooses its own model or providers, so Auto (Jev) cannot guarantee where prompts go. Remove model/provider settings from it, or choose Off.',
  projectUnreadable: 'This project\'s OpenCode config could not be read, so Auto (Jev) cannot check where prompts go. Choose Off, or fix the file.',
  noUpstream: 'Auto (Jev) has no model provider (OpenRouter serves only Jev). Add one on the Decision models page, or start this card on its agent\'s own model.',
  noProvider: 'Auto (Jev): no allowed model provider (OpenRouter serves only Jev). Add one on the Decision models page, or start this card on its agent\'s own model.',
  jevOnly: 'OpenRouter serves only Jev\'s own decisions: Auto cannot send model calls there. Use another provider.',
  listLoading: 'Auto (Jev) is still loading OpenRouter\'s model list (prices and limits from openrouter.ai). Try again in a few seconds; the Decision models page shows its state.',
  dataClass: 'No Auto (Jev) upstream is trusted with this card\'s data class. Raise an upstream\'s trust on the Decision models page, or lower the card\'s class.',
  router: 'Auto (Jev) could not open its local port on 127.0.0.1. Try again; the plugin log has the details.',
  unknownValue: 'This Model value is not known to the Assistant. Choose Off or Auto (Jev).',
  badgeTip: (tier, source) => `Auto (Jev): ${EN.tiers[tier]} model, chosen by ${EN.sources[source] ?? source}. It can change at the next turn.`,
  tiers: { small: 'small', medium: 'medium', large: 'large' },
  sources: { jev: 'Jev', rules: 'word rules (Jev did not answer)', lease: 'the turn\'s earlier decision', small: 'the small-model rule' }
};

const RU: typeof EN = {
  provider: 'Модель «Авто (Jev)» пока работает только с OpenCode. Выберите «Выкл» для этого агента.',
  environment: '«Авто (Jev)» работает на этом компьютере и пока не достаёт до контейнера или удалённого хоста. Выберите «Выкл» или запустите окно на этом компьютере.',
  project: 'Конфиг OpenCode этого проекта сам выбирает модель или провайдеров, поэтому «Авто (Jev)» не может обещать, куда уйдут запросы. Уберите из него model/provider или выберите «Выкл».',
  projectUnreadable: 'Конфиг OpenCode этого проекта не читается, поэтому «Авто (Jev)» не может проверить, куда уйдут запросы. Выберите «Выкл» или исправьте файл.',
  noUpstream: 'У «Авто (Jev)» нет поставщика моделей (OpenRouter — только для Jev). Добавьте его на странице «Модели решений» или запустите окно на модели агента.',
  noProvider: '«Авто (Jev)»: нет разрешённого поставщика моделей (OpenRouter — только для Jev). Добавьте его на странице «Модели решений» или запустите окно на модели агента.',
  jevOnly: 'OpenRouter служит только для решений самого Jev: «Авто» не может отправлять туда вызовы моделей. Выберите другого поставщика.',
  listLoading: '«Авто (Jev)» ещё загружает список моделей OpenRouter (цены и пределы с openrouter.ai). Повторите через несколько секунд; состояние видно на странице «Модели решений».',
  dataClass: 'Ни одному поставщику «Авто (Jev)» не доверен класс данных этого окна. Повысьте доверие поставщику на странице «Модели решений» или понизьте класс окна.',
  router: '«Авто (Jev)» не смог открыть локальный порт на 127.0.0.1. Попробуйте ещё раз; подробности — в журнале плагина.',
  unknownValue: 'Такое значение «Модели» Ассистенту неизвестно. Выберите «Выкл» или «Авто (Jev)».',
  badgeTip: (tier, source) => `Авто (Jev): ${RU.tiers[tier]} модель, выбрал ${RU.sources[source] ?? source}. На следующем ходе может смениться.`,
  tiers: { small: 'маленькая', medium: 'средняя', large: 'большая' },
  sources: { jev: 'Jev', rules: 'словесные правила (Jev не ответил)', lease: 'прежнее решение этого хода', small: 'правило маленькой модели' }
};

export const AUTO_STRINGS: Readonly<Record<Locale, typeof EN>> = { en: EN, ru: RU };

/** The short model name for a 24-character badge: the part after the vendor, cut. */
export function badgeText(model: string): string {
  const name = model.split('/').at(-1) ?? model;
  return name.length <= 24 ? name : `${name.slice(0, 23)}…`;
}
