/**
 * Horloge : horloge mondiale, réveils (service d'alarmes du noyau),
 * chronomètre avec tours, minuteur (sonne même si l'app est fermée).
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { formatDuration, pad2 } from '../../lib/format.js';
import { tabBar, appBar, collapseOnScroll, toggle, sheet, field, swipeToDelete, emptyState, iconButton, listItem } from '../../lib/ui.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const CITIES = [
  ['Paris', 'Europe/Paris'], ['Londres', 'Europe/London'], ['New York', 'America/New_York'], ['Los Angeles', 'America/Los_Angeles'],
  ['Montréal', 'America/Toronto'], ['Tokyo', 'Asia/Tokyo'], ['Sydney', 'Australia/Sydney'], ['Dubaï', 'Asia/Dubai'],
  ['Pékin', 'Asia/Shanghai'], ['Bombay', 'Asia/Kolkata'], ['Moscou', 'Europe/Moscow'], ['Le Caire', 'Africa/Cairo'],
  ['Dakar', 'Africa/Dakar'], ['Rio de Janeiro', 'America/Sao_Paulo'], ['Mexico', 'America/Mexico_City'], ['Reykjavik', 'Atlantic/Reykjavik'],
  ['Berlin', 'Europe/Berlin'], ['Singapour', 'Asia/Singapore'], ['Honolulu', 'Pacific/Honolulu'], ['Nouméa', 'Pacific/Noumea'],
];
const DAYS = [['L', 1], ['M', 2], ['M', 3], ['J', 4], ['V', 5], ['S', 6], ['D', 0]];
const DAY_NAMES = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

function zoneOffset(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function repeatLabel(days) {
  if (!days?.length) return 'Une fois';
  if (days.length === 7) return 'Tous les jours';
  const sorted = [...days].sort();
  if (sorted.join() === '1,2,3,4,5') return 'En semaine';
  if (sorted.join() === '0,6') return 'Le week-end';
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(' ');
}

export function mount(root, ctx) {
  const use24h = () => ctx.settings.get('use24h');
  const views = {};
  const container = h('div.clock-views');
  let tab = ctx.storage.get('tab', 'alarms');

  const fmt = (hours, minutes) => {
    if (use24h()) return `${pad2(hours)}:${pad2(minutes)}`;
    return `${hours % 12 || 12}:${pad2(minutes)}`;
  };

  function pageView(title, content, actions = [], leading = null) {
    const bar = appBar({ title, actions, leading });
    const scroll = h('div.app-scroll', h('div.app-content', content));
    collapseOnScroll(bar, scroll);
    return h('div.clock-page', bar, scroll);
  }

  // ───────────── Horloge mondiale ─────────────
  let cities = ctx.storage.get('cities', ['Europe/Paris', 'America/New_York', 'Asia/Tokyo']);
  const worldList = h('div.list');
  views.world = pageView('Horloge mondiale', worldList, [iconButton('plus', addCity, { label: 'Ajouter une ville', size: 24 })]);

  function renderWorld() {
    const local = -new Date().getTimezoneOffset();
    if (!cities.length) {
      worldList.replaceChildren(emptyState({ icon: 'globe', title: 'Aucune ville', message: 'Touchez + pour ajouter une ville.' }));
      return;
    }
    worldList.replaceChildren(
      ...cities.map((zone) => {
        const name = CITIES.find(([, z]) => z === zone)?.[0] ?? zone;
        const offset = zoneOffset(zone);
        const diff = (offset - local) / 60;
        const now = new Date(Date.now() + (offset - local) * 60_000);
        const today = new Date();
        const dayLabel = now.getDate() === today.getDate() ? "Aujourd'hui" : now > today ? 'Demain' : 'Hier';
        const row = h(
          'div.list-item.world-row',
          h('div.li-body', h('div.li-sub', `${dayLabel}, ${diff === 0 ? 'même heure' : `${diff > 0 ? '+' : ''}${String(diff).replace('.', ',')} h`}`), h('div.world-city', name)),
          h('div.world-time', fmt(now.getHours(), now.getMinutes())),
        );
        return swipeToDelete(row, () => {
          cities = cities.filter((c) => c !== zone);
          ctx.storage.set('cities', cities);
          renderWorld();
        });
      }),
    );
  }

  function addCity() {
    const list = h(
      'div.list',
      CITIES.filter(([, zone]) => !cities.includes(zone)).map(([name, zone]) =>
        listItem({ title: name, detail: zone.split('/')[0], onClick: () => { cities.push(zone); ctx.storage.set('cities', cities); renderWorld(); panel.close(); } }),
      ),
    );
    const panel = sheet(root, { title: 'Choisir une ville', content: list, full: true });
  }

  // ───────────── Réveils ─────────────
  const alarmList = h('div.list');
  views.alarms = pageView('Réveils', alarmList, [iconButton('plus', () => editAlarm(null), { label: 'Ajouter un réveil', size: 24 })]);

  function alarms() {
    return ctx.alarms.list().filter((a) => a.kind === 'alarm' && !a.payload?.snoozed);
  }

  function renderAlarms() {
    const items = alarms().sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    if (!items.length) {
      alarmList.replaceChildren(emptyState({ icon: 'alarm', title: 'Aucun réveil', message: 'Touchez + pour créer un réveil.' }));
      return;
    }
    alarmList.replaceChildren(
      ...items.map((a) => {
        const row = h(
          `div.list-item.tappable.alarm-row${a.enabled ? '' : '.off'}`,
          { onclick: () => editAlarm(a) },
          h('div.li-body', h('div.alarm-time-big', fmt(a.hour, a.minute)), h('div.li-sub', [a.label || 'Réveil', repeatLabel(a.days)].join(', '))),
          toggle(a.enabled, (v) => { ctx.alarms.update(a.id, { enabled: v }); renderAlarms(); if (v) toastNext(a.id); }),
        );
        return swipeToDelete(row, () => { ctx.alarms.cancel(a.id); renderAlarms(); });
      }),
    );
  }

  function toastNext(id) {
    const alarm = ctx.alarms.list().find((a) => a.id === id);
    if (!alarm) return;
    const ms = alarm.at - ctx.now();
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    if (!hours && !minutes) ctx.ui.toast("Réveil réglé dans moins d'une minute");
    else ctx.ui.toast(`Réveil réglé dans ${hours ? `${hours} h ` : ''}${minutes} min`);
  }

  function editAlarm(alarm) {
    // Par défaut : la prochaine heure pile (ex. 7 h 42 → 8 h 00).
    const next = new Date(ctx.now() + 3_600_000);
    const time = h('input.alarm-input', { type: 'time', value: alarm ? `${pad2(alarm.hour)}:${pad2(alarm.minute)}` : `${pad2(next.getHours())}:00` });
    const days = new Set(alarm?.days ?? []);
    const dayRow = h('div.day-chips');
    const renderDays = () =>
      dayRow.replaceChildren(
        ...DAYS.map(([label, d]) => h(`button.day-chip${days.has(d) ? '.active' : ''}`, { type: 'button', onclick: () => { days.has(d) ? days.delete(d) : days.add(d); renderDays(); } }, label)),
      );
    renderDays();
    const label = field({ label: 'Libellé', value: alarm?.label ?? '', placeholder: 'Réveil' });
    const content = [
      h('div.alarm-picker', time),
      h('div.list-header', 'Répéter'),
      dayRow,
      h('div.form-group', label),
      alarm ? h('button.btn.btn-gray.block.destructive', { type: 'button', onclick: () => { ctx.alarms.cancel(alarm.id); renderAlarms(); panel.close(); } }, 'Supprimer le réveil') : null,
    ];
    const panel = sheet(root, {
      title: alarm ? 'Modifier le réveil' : 'Nouveau réveil',
      content,
      confirmLabel: 'Enregistrer',
      onConfirm: () => {
        const [hour, minute] = (time.value || '07:00').split(':').map(Number);
        const data = { hour, minute, days: [...days], label: label.input.value.trim(), enabled: true };
        let id = alarm?.id;
        if (alarm) ctx.alarms.update(alarm.id, data);
        else id = ctx.alarms.schedule({ kind: 'alarm', ...data }).id;
        renderAlarms();
        toastNext(id);
      },
    });
  }

  // ───────────── Chronomètre ─────────────
  const sw = { running: false, startedAt: 0, elapsed: 0, laps: [], ...ctx.storage.get('stopwatch', {}) };
  const swDisplay = h('div.sw-display');
  const swLeft = h('button.round-action.gray', { type: 'button', onclick: () => (sw.running ? lap() : resetSw()) });
  const swRight = h('button.round-action', { type: 'button', onclick: () => (sw.running ? stopSw() : startSw()) });
  const lapList = h('div.lap-list');
  views.stopwatch = h('div.clock-page.sw-page', h('div.sw-top', swDisplay), h('div.sw-buttons', swLeft, swRight), h('div.app-scroll', lapList));

  const swElapsed = () => sw.elapsed + (sw.running ? ctx.now() - sw.startedAt : 0);
  const saveSw = () => ctx.storage.set('stopwatch', sw);
  function startSw() {
    sw.running = true;
    sw.startedAt = ctx.now();
    saveSw();
    renderSw();
  }
  function stopSw() {
    sw.elapsed = swElapsed();
    sw.running = false;
    saveSw();
    renderSw();
  }
  function resetSw() {
    Object.assign(sw, { running: false, elapsed: 0, laps: [] });
    saveSw();
    renderSw();
  }
  function lap() {
    sw.laps.unshift(swElapsed());
    saveSw();
    renderSw();
  }
  function renderSwDisplay() {
    swDisplay.textContent = formatDuration(swElapsed(), { tenths: true });
  }
  function renderSw() {
    renderSwDisplay();
    const total = swElapsed();
    swLeft.textContent = sw.running ? 'Tour' : 'Réinitialiser';
    swLeft.disabled = !sw.running && !total;
    swRight.textContent = sw.running ? 'Arrêter' : 'Démarrer';
    swRight.className = `round-action ${sw.running ? 'red' : 'green'}`;
    const splits = sw.laps.map((t, i) => t - (sw.laps[i + 1] ?? 0));
    const current = total - (sw.laps[0] ?? 0);
    const best = splits.length > 1 ? Math.min(...splits) : null;
    const worst = splits.length > 1 ? Math.max(...splits) : null;
    lapList.replaceChildren(
      ...(total ? [h('div.lap-row', h('span', `Tour ${sw.laps.length + 1}`), h('span.lap-current', formatDuration(current, { tenths: true })))] : []),
      ...splits.map((split, i) => h(`div.lap-row${split === best ? '.best' : split === worst ? '.worst' : ''}`, h('span', `Tour ${sw.laps.length - i}`), h('span', formatDuration(split, { tenths: true })))),
    );
  }

  // ───────────── Minuteur ─────────────
  let timerPaused = ctx.storage.get('timerPaused', null); // ms restants
  let timerDuration = ctx.storage.get('timerDuration', 5 * 60_000);
  const pickers = { h: h('select.timer-select'), m: h('select.timer-select'), s: h('select.timer-select') };
  for (let i = 0; i < 24; i++) pickers.h.append(h('option', { value: i }, `${i} h`));
  for (let i = 0; i < 60; i++) pickers.m.append(h('option', { value: i }, `${i} min`));
  for (let i = 0; i < 60; i++) pickers.s.append(h('option', { value: i }, `${i} s`));
  const setPickers = (ms) => {
    const s = Math.round(ms / 1000);
    pickers.h.value = String(Math.floor(s / 3600));
    pickers.m.value = String(Math.floor((s % 3600) / 60));
    pickers.s.value = String(s % 60);
  };
  setPickers(timerDuration);
  const ring = h('div.timer-ring', h('div.timer-remaining'), h('div.timer-end'));
  const presets = h(
    'div.timer-presets',
    [1, 3, 5, 10, 15, 30].map((m) => h('button.chip', { type: 'button', onclick: () => { setPickers(m * 60_000); } }, `${m} min`)),
  );
  const timerSetup = h('div.timer-setup', h('div.timer-pickers', pickers.h, pickers.m, pickers.s), presets);
  const timerLeft = h('button.round-action.gray', { type: 'button', onclick: () => cancelTimer() }, 'Annuler');
  const timerRight = h('button.round-action.green', { type: 'button', onclick: () => toggleTimer() });
  views.timer = h('div.clock-page.timer-page', h('div.timer-body', timerSetup, ring), h('div.sw-buttons', timerLeft, timerRight));

  const activeTimer = () => ctx.alarms.list().find((a) => a.kind === 'timer') ?? null;

  function toggleTimer() {
    const running = activeTimer();
    if (running) {
      timerPaused = running.at - ctx.now();
      ctx.alarms.cancel(running.id);
    } else {
      let ms = timerPaused;
      if (ms == null) {
        ms = (Number(pickers.h.value) * 3600 + Number(pickers.m.value) * 60 + Number(pickers.s.value)) * 1000;
        if (!ms) return;
        timerDuration = ms;
        ctx.storage.set('timerDuration', ms);
      }
      ctx.alarms.schedule({ kind: 'timer', at: ctx.now() + ms, duration: timerDuration, label: 'Minuteur' });
      timerPaused = null;
    }
    ctx.storage.set('timerPaused', timerPaused);
    renderTimer();
  }

  function cancelTimer() {
    const running = activeTimer();
    if (running) ctx.alarms.cancel(running.id);
    timerPaused = null;
    ctx.storage.set('timerPaused', null);
    renderTimer();
  }

  function renderTimer() {
    const running = activeTimer();
    const active = Boolean(running) || timerPaused != null;
    timerSetup.hidden = active;
    ring.hidden = !active;
    timerLeft.disabled = !active;
    timerRight.textContent = running ? 'Pause' : timerPaused != null ? 'Reprendre' : 'Démarrer';
    timerRight.className = `round-action ${running ? 'orange' : 'green'}`;
    if (!active) return;
    const remaining = running ? Math.max(0, running.at - ctx.now()) : timerPaused;
    const total = running?.duration ?? timerDuration;
    ring.style.setProperty('--progress', String(1 - remaining / total));
    ring.querySelector('.timer-remaining').textContent = formatDuration(Math.ceil(remaining / 1000) * 1000);
    const end = running ? new Date(running.at) : null;
    ring.querySelector('.timer-end').replaceChildren(end ? h('span', icon('bell', { size: 12 }), ` ${fmt(end.getHours(), end.getMinutes())}`) : 'En pause');
  }

  // ───────────── Onglets ─────────────
  const renderers = { world: renderWorld, alarms: renderAlarms, stopwatch: renderSw, timer: renderTimer };
  const tabs = tabBar(
    [
      { id: 'world', label: 'Monde', icon: 'globe' },
      { id: 'alarms', label: 'Réveils', icon: 'alarm' },
      { id: 'stopwatch', label: 'Chrono', icon: 'stopwatch' },
      { id: 'timer', label: 'Minuteur', icon: 'timer' },
    ],
    { value: tab, onChange: (id) => show(id) },
  );

  function show(id) {
    tab = id;
    ctx.storage.set('tab', id);
    tabs.select(id);
    container.replaceChildren(views[id]);
    renderers[id]();
  }

  root.classList.add('with-tabbar', 'clock');
  root.append(container, tabs);

  ctx.setInterval(() => {
    if (!ctx.foreground) return;
    if (tab === 'stopwatch' && sw.running) renderSwDisplay();
    if (tab === 'timer') renderTimer();
    if (tab === 'world' && new Date().getSeconds() === 0) renderWorld();
  }, 50);
  ctx.subscribe('alarm:change', () => {
    if (tab === 'alarms') renderAlarms();
    if (tab === 'timer') renderTimer();
  });
  ctx.subscribe('settings:change', ({ key }) => key === 'use24h' && renderers[tab]());

  function handleIntent(intent) {
    const data = intent?.data;
    if (data?.tab && views[data.tab]) show(data.tab);
    else show(tab);
    if (data?.tab === 'alarms' && data.create) editAlarm(null);
    if (data?.tab === 'stopwatch' && data.start && !sw.running) startSw();
  }
  handleIntent(ctx.intent);
  return { onIntent: handleIntent };
}
