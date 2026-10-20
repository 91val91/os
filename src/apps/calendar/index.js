/**
 * Calendrier : vue mensuelle, événements du jour, création avec rappels
 * (planifiés dans le service d'alarmes du noyau).
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { pad2, capitalize, formatDate } from '../../lib/format.js';
import { iconButton, sheet, field, toggle, segmented, emptyState } from '../../lib/ui.js';
import { swipe } from '../../lib/gesture.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const COLORS = ['#ff3b30', '#ff9500', '#34c759', '#007aff', '#af52de', '#ff2d55'];
const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

const toKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function mount(root, ctx) {
  let events = ctx.storage.get('events', null);
  if (!events) {
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return toKey(d);
    };
    events = [
      { id: 'e1', title: 'Déjeuner avec Alice', date: day(0), start: '12:30', end: '14:00', location: 'Café du Coin', color: COLORS[3] },
      { id: 'e2', title: 'Séance de sport', date: day(1), start: '18:00', end: '19:00', color: COLORS[2] },
      { id: 'e3', title: 'Anniversaire de Maman 🎂', date: day(3), allDay: true, color: COLORS[5] },
      { id: 'e4', title: 'Réunion projet Orion', date: day(6), start: '10:00', end: '11:30', location: 'Visio', color: COLORS[4] },
    ];
    ctx.storage.set('events', events);
  }

  const today = new Date();
  let month = new Date(today.getFullYear(), today.getMonth(), 1);
  let selected = toKey(today);

  const save = () => ctx.storage.set('events', events);
  const eventsOn = (key) =>
    events.filter((e) => e.date === key).sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : (a.start ?? '').localeCompare(b.start ?? '')));

  const title = h('div.cal-title');
  const grid = h('div.cal-grid');
  const dayHeader = h('div.cal-day-header');
  const dayList = h('div.cal-events');

  const header = h(
    'header.cal-header',
    h(
      'div.cal-toolbar',
      h('button.appbar-text', { type: 'button', onclick: () => { month = new Date(today.getFullYear(), today.getMonth(), 1); selected = toKey(today); render(); } }, "Aujourd'hui"),
      h('div.cal-nav', iconButton('chevron-left', () => shift(-1), { label: 'Mois précédent' }), iconButton('chevron-right', () => shift(1), { label: 'Mois suivant' }), iconButton('plus', () => editEvent(null), { label: 'Nouvel événement', size: 24 })),
    ),
    title,
    h('div.cal-weekdays', WEEKDAYS.map((d) => h('span', d))),
  );

  function shift(delta) {
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    render();
  }

  function render() {
    title.textContent = capitalize(month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    const first = (month.getDay() + 6) % 7;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(h('span.cal-cell.empty'));
    for (let d = 1; d <= days; d++) {
      const date = new Date(month.getFullYear(), month.getMonth(), d);
      const key = toKey(date);
      const dots = eventsOn(key).slice(0, 3);
      cells.push(
        h(
          `button.cal-cell${key === toKey(today) ? '.today' : ''}${key === selected ? '.selected' : ''}${date.getDay() === 0 || date.getDay() === 6 ? '.weekend' : ''}`,
          { type: 'button', onclick: () => { selected = key; render(); } },
          h('span.cal-num', String(d)),
          h('span.cal-dots', dots.map((e) => h('i', { style: { background: e.color } }))),
        ),
      );
    }
    grid.replaceChildren(...cells);
    renderDay();
  }

  function renderDay() {
    const date = fromKey(selected);
    dayHeader.textContent = formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' });
    const list = eventsOn(selected);
    if (!list.length) {
      dayList.replaceChildren(emptyState({ icon: 'calendar', title: 'Aucun événement', message: 'Touchez + pour en ajouter un.' }));
      return;
    }
    dayList.replaceChildren(
      ...list.map((e) =>
        h(
          'button.cal-event',
          { type: 'button', style: { '--c': e.color }, onclick: () => editEvent(e) },
          h('div.cal-event-time', e.allDay ? h('span', 'Toute la', h('br'), 'journée') : [h('span', e.start), h('span.muted', e.end ?? '')]),
          h('div.cal-event-body', h('strong', e.title), e.location ? h('span', icon('location', { size: 12 }), e.location) : null, e.reminderId ? h('span', icon('bell', { size: 12 }), 'Rappel') : null),
        ),
      ),
    );
  }

  function scheduleReminder(event, minutes) {
    if (event.reminderId) ctx.alarms.cancel(event.reminderId);
    event.reminderId = null;
    event.reminder = minutes;
    if (minutes == null || event.allDay || !event.start) return;
    const [hour, minute] = event.start.split(':').map(Number);
    const at = fromKey(event.date);
    at.setHours(hour, minute - minutes, 0, 0);
    if (at.getTime() <= ctx.now()) return;
    event.reminderId = ctx.alarms.schedule({
      kind: 'reminder',
      at: at.getTime(),
      label: event.title,
      payload: { body: minutes ? `Dans ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`} · ${event.start}` : `Maintenant · ${event.start}`, intent: { app: 'calendar', action: 'view', data: { date: event.date } } },
    }).id;
  }

  function editEvent(event) {
    const draft = event ? { ...event } : { title: '', date: selected, start: '09:00', end: '10:00', allDay: false, location: '', color: COLORS[3], reminder: 10 };
    const titleField = field({ label: 'Titre', value: draft.title, placeholder: 'Nouvel événement', autofocus: !event });
    const locationField = field({ label: 'Lieu', value: draft.location ?? '' });
    const date = h('input.cal-input', { type: 'date', value: draft.date });
    const start = h('input.cal-input', { type: 'time', value: draft.start ?? '09:00' });
    const end = h('input.cal-input', { type: 'time', value: draft.end ?? '10:00' });
    const times = h('div.cal-times', h('label', 'Début', start), h('label', 'Fin', end));
    times.hidden = draft.allDay;
    const allDay = toggle(draft.allDay, (v) => { draft.allDay = v; times.hidden = v; });
    let color = draft.color;
    const colors = h('div.cal-colors');
    const renderColors = () => colors.replaceChildren(...COLORS.map((c) => h(`button.cal-color${c === color ? '.active' : ''}`, { type: 'button', style: { background: c }, onclick: () => { color = c; renderColors(); } })));
    renderColors();
    let reminder = draft.reminder ?? null;
    const content = [
      h('div.form-group', titleField, locationField),
      h('div.form-group.cal-form', h('div.cal-row', h('span', 'Toute la journée'), allDay), h('div.cal-row', h('span', 'Date'), date), times),
      h('div.list-header', 'Rappel'),
      h('div.cal-reminder', segmented([{ value: null, label: 'Aucun' }, { value: 0, label: "À l'heure" }, { value: 10, label: '10 min' }, { value: 60, label: '1 h' }], reminder, (v) => (reminder = v))),
      h('div.list-header', 'Couleur'),
      colors,
      event
        ? h('button.btn.btn-gray.block.destructive', { type: 'button', onclick: () => { if (event.reminderId) ctx.alarms.cancel(event.reminderId); events = events.filter((e) => e.id !== event.id); save(); render(); panel.close(); } }, "Supprimer l'événement")
        : null,
    ];
    const panel = sheet(root, {
      title: event ? "Modifier l'événement" : 'Nouvel événement',
      content,
      confirmLabel: event ? 'OK' : 'Ajouter',
      full: true,
      onConfirm: () => {
        const result = {
          ...draft,
          id: event?.id ?? `e${Date.now().toString(36)}`,
          title: titleField.input.value.trim() || 'Nouvel événement',
          location: locationField.input.value.trim(),
          date: date.value || selected,
          start: draft.allDay ? null : start.value,
          end: draft.allDay ? null : end.value,
          color,
        };
        scheduleReminder(result, reminder);
        events = events.filter((e) => e.id !== result.id).concat(result);
        save();
        selected = result.date;
        const d = fromKey(result.date);
        month = new Date(d.getFullYear(), d.getMonth(), 1);
        render();
      },
    });
  }

  const body = h('div.app-scroll.cal-scroll', h('div.cal-month', grid), h('div.cal-day', dayHeader, dayList));
  swipe(grid, (direction) => {
    if (direction === 'left') shift(1);
    if (direction === 'right') shift(-1);
  });
  root.classList.add('calendar');
  root.append(header, body);
  render();

  const handleIntent = (intent) => {
    const data = intent?.data;
    if (data?.date) {
      selected = data.date;
      const d = fromKey(data.date);
      month = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
    }
    if (data?.create) editEvent(null);
  };
  handleIntent(ctx.intent);
  return { onIntent: handleIntent };
}
