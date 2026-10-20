/**
 * Météo : prévisions réelles via l'API Open-Meteo (sans clé), géolocalisation
 * avec permission, recherche de villes. Hors ligne : données simulées.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { describeWeather, weatherGradient } from '../../lib/weather-codes.js';
import { mulberry32, hashString } from '../../lib/artwork.js';
import { sheet, searchField, spinner, listItem } from '../../lib/ui.js';
import { capitalize } from '../../lib/format.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const DEFAULT_CITY = { name: 'Paris', country: 'France', latitude: 48.8566, longitude: 2.3522 };

async function fetchForecast(city) {
  const params = new URLSearchParams({
    latitude: city.latitude,
    longitude: city.longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,pressure_msl',
    hourly: 'temperature_2m,weather_code,is_day,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const now = Date.now();
    const hourIndex = Math.max(0, data.hourly.time.findIndex((t) => new Date(t).getTime() > now) - 1);
    return {
      simulated: false,
      current: {
        temp: data.current.temperature_2m,
        feels: data.current.apparent_temperature,
        humidity: data.current.relative_humidity_2m,
        wind: data.current.wind_speed_10m,
        pressure: data.current.pressure_msl,
        code: data.current.weather_code,
        isDay: Boolean(data.current.is_day),
      },
      hourly: data.hourly.time.slice(hourIndex, hourIndex + 24).map((t, i) => ({
        time: new Date(t).getTime(),
        temp: data.hourly.temperature_2m[hourIndex + i],
        code: data.hourly.weather_code[hourIndex + i],
        isDay: Boolean(data.hourly.is_day[hourIndex + i]),
        rain: data.hourly.precipitation_probability?.[hourIndex + i] ?? 0,
      })),
      daily: data.daily.time.map((t, i) => ({
        date: t,
        code: data.daily.weather_code[i],
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        sunrise: data.daily.sunrise[i],
        sunset: data.daily.sunset[i],
        uv: data.daily.uv_index_max?.[i] ?? 0,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Prévisions plausibles et déterministes quand le réseau est indisponible. */
function simulateForecast(city) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const random = mulberry32(hashString(city.name + day.toDateString()));
  const base = 8 + random() * 16;
  const codes = [0, 1, 2, 3, 61, 80, 3, 1];
  const now = new Date();
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(now);
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() + i);
    const hour = t.getHours();
    return { time: t.getTime(), temp: base + 5 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + random(), code: codes[Math.floor(random() * codes.length)], isDay: hour >= 7 && hour < 20, rain: Math.round(random() * 40) };
  });
  const daily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(day);
    d.setDate(d.getDate() + i);
    const max = base + 4 + random() * 6;
    return { date: d.toISOString().slice(0, 10), code: codes[Math.floor(random() * codes.length)], max, min: max - 6 - random() * 4, sunrise: `${d.toISOString().slice(0, 10)}T07:${String(Math.floor(random() * 50)).padStart(2, '0')}`, sunset: `${d.toISOString().slice(0, 10)}T19:${String(Math.floor(random() * 50)).padStart(2, '0')}`, uv: Math.round(random() * 7) };
  });
  return {
    simulated: true,
    current: { temp: hourly[0].temp, feels: hourly[0].temp - 1.5, humidity: Math.round(45 + random() * 40), wind: Math.round(5 + random() * 25), pressure: Math.round(1005 + random() * 20), code: hourly[0].code, isDay: hourly[0].isDay },
    hourly,
    daily,
  };
}

export function mount(root, ctx) {
  let cities = ctx.storage.get('cities', [DEFAULT_CITY]);
  let index = Math.min(ctx.storage.get('index', 0), cities.length - 1);
  let located = ctx.storage.get('located', null);
  const view = h('div.weather-view');
  root.classList.add('weather');
  root.append(view, h('div.weather-toolbar', h('button', { type: 'button', 'aria-label': 'Ma position', onclick: locate }, icon('location-fill', { size: 20 })), h('div.weather-dots'), h('button', { type: 'button', 'aria-label': 'Villes', onclick: cityList }, icon('list', { size: 22 }))));

  const current = () => (index === -1 && located ? located : cities[index] ?? DEFAULT_CITY);

  function renderDots() {
    const dots = root.querySelector('.weather-dots');
    const total = cities.length + (located ? 1 : 0);
    dots.replaceChildren(
      ...(located ? [h(`span.loc${index === -1 ? '.active' : ''}`, icon('location-fill', { size: 9 }))] : []),
      ...cities.map((_, i) => h(`span${i === index ? '.active' : ''}`)),
    );
    dots.hidden = total < 2;
  }

  async function load() {
    const city = current();
    renderDots();
    const cached = ctx.storage.get(`forecast:${city.name}`);
    if (cached) render(city, cached);
    else view.replaceChildren(h('div.weather-loading', spinner(32), `Chargement de ${city.name}…`));
    let data;
    try {
      data = await fetchForecast(city);
    } catch {
      data = cached && !cached.simulated && Date.now() - cached.fetchedAt < 6 * 3_600_000 ? cached : simulateForecast(city);
    }
    data.fetchedAt = data.fetchedAt ?? Date.now();
    ctx.storage.set(`forecast:${city.name}`, data);
    if (current() !== city) return;
    render(city, data);
    const today = data.daily[0];
    ctx.storage.set('cache', { city: city.name, temp: data.current.temp, code: data.current.code, isDay: data.current.isDay, max: today.max, min: today.min, located: index === -1, updatedAt: Date.now() });
  }

  function render(city, data) {
    const c = data.current;
    const d = describeWeather(c.code, c.isDay);
    root.style.setProperty('--sky', weatherGradient(c.code, c.isDay));
    const today = data.daily[0];
    const allMin = Math.min(...data.daily.map((x) => x.min));
    const allMax = Math.max(...data.daily.map((x) => x.max));
    const hourLabel = (t, i) => (i === 0 ? 'Maint.' : `${new Date(t).getHours()} h`);
    const sunrise = new Date(today.sunrise).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const sunset = new Date(today.sunset).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    view.replaceChildren(
      h(
        'div.weather-hero',
        h('div.weather-city', index === -1 ? h('span.weather-loc', icon('location-fill', { size: 12 }), 'Ma position') : null, city.name),
        h('div.weather-temp', `${Math.round(c.temp)}°`),
        h('div.weather-desc', d.label),
        h('div.weather-range', `H : ${Math.round(today.max)}°  B : ${Math.round(today.min)}°`),
        data.simulated ? h('div.weather-badge', icon('wifi-off', { size: 12 }), 'Données simulées (hors ligne)') : null,
      ),
      h(
        'section.weather-card',
        h('div.weather-card-title', icon('clock', { size: 13 }), 'Prévisions horaires'),
        h(
          'div.weather-hours',
          data.hourly.map((hr, i) =>
            h('div.weather-hour', h('span', hourLabel(hr.time, i)), hr.rain >= 30 ? h('small', `${hr.rain} %`) : h('small', ' '), icon(describeWeather(hr.code, hr.isDay).icon, { size: 22 }), h('strong', `${Math.round(hr.temp)}°`)),
          ),
        ),
      ),
      h(
        'section.weather-card',
        h('div.weather-card-title', icon('calendar', { size: 13 }), 'Prévisions sur 7 jours'),
        data.daily.map((day, i) => {
          const name = i === 0 ? "Aujourd'hui" : capitalize(new Date(day.date).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''));
          const left = ((day.min - allMin) / (allMax - allMin || 1)) * 100;
          const width = ((day.max - day.min) / (allMax - allMin || 1)) * 100;
          return h(
            'div.weather-day',
            h('span.wd-name', name),
            h('span.wd-icon', icon(describeWeather(day.code, true).icon, { size: 22 })),
            h('span.wd-min', `${Math.round(day.min)}°`),
            h('span.wd-bar', h('i', { style: { left: `${left}%`, width: `${Math.max(width, 6)}%` } })),
            h('span.wd-max', `${Math.round(day.max)}°`),
          );
        }),
      ),
      h(
        'div.weather-grid',
        tile('thermometer', 'Ressenti', `${Math.round(c.feels)}°`, c.feels < c.temp ? 'Le vent rafraîchit la température.' : 'Proche de la température réelle.'),
        tile('droplet', 'Humidité', `${Math.round(c.humidity)} %`, c.humidity > 70 ? 'Air humide.' : 'Air plutôt sec.'),
        tile('wind', 'Vent', `${Math.round(c.wind)} km/h`, c.wind > 30 ? 'Rafales possibles.' : 'Vent faible.'),
        tile('sun', 'Indice UV', String(Math.round(today.uv)), today.uv >= 6 ? 'Élevé : protégez-vous.' : 'Faible à modéré.'),
        tile('sun', 'Lever / coucher', sunrise, `Coucher à ${sunset}`),
        tile('compass', 'Pression', `${Math.round(c.pressure)} hPa`, ''),
      ),
      h('div.weather-credit', data.simulated ? 'Prévisions simulées' : 'Données : Open-Meteo.com', ` · Mis à jour ${new Date(data.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`),
    );
  }

  function tile(iconName, label, value, note) {
    return h('div.weather-tile', h('div.weather-card-title', icon(iconName, { size: 13 }), label), h('strong', value), h('span', note));
  }

  async function locate() {
    const allowed = await ctx.requestPermission('location');
    if (!allowed) {
      ctx.ui.toast('Accès à la position refusé');
      return;
    }
    if (!navigator.geolocation) {
      ctx.ui.toast('Géolocalisation indisponible');
      return;
    }
    ctx.ui.toast('Localisation…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        let name = 'Ma position';
        try {
          const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=fr`);
          const place = await r.json();
          name = place.city || place.locality || name;
        } catch {
          /* nom par défaut */
        }
        located = { name, latitude, longitude };
        ctx.storage.set('located', located);
        index = -1;
        ctx.storage.set('index', index);
        load();
      },
      () => ctx.ui.toast('Position introuvable'),
      { timeout: 10_000, maximumAge: 600_000 },
    );
  }

  function cityList() {
    const results = h('div.list');
    const savedList = h('div.list');
    const renderSaved = () =>
      savedList.replaceChildren(
        ...cities.map((c, i) =>
          listItem({
            title: c.name,
            subtitle: c.country ?? '',
            detail: (() => {
              const f = ctx.storage.get(`forecast:${c.name}`);
              return f ? `${Math.round(f.current.temp)}°` : '';
            })(),
            trailing: cities.length > 1 ? h('button.weather-remove', { type: 'button', 'aria-label': 'Retirer', onclick: (e) => { e.stopPropagation(); cities.splice(i, 1); index = Math.min(index, cities.length - 1); ctx.storage.set('cities', cities); renderSaved(); } }, icon('minus', { size: 14, stroke: 3 })) : null,
            onClick: () => { index = i; ctx.storage.set('index', i); panel.close(); load(); },
          }),
        ),
      );
    let timer;
    const search = searchField({
      placeholder: 'Rechercher une ville',
      onInput: (q) => {
        clearTimeout(timer);
        if (q.trim().length < 2) {
          results.replaceChildren();
          return;
        }
        timer = setTimeout(async () => {
          try {
            const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=8&language=fr`);
            const found = (await r.json()).results ?? [];
            results.replaceChildren(
              ...(found.length
                ? found.map((c) =>
                    listItem({
                      title: c.name,
                      subtitle: [c.admin1, c.country].filter(Boolean).join(', '),
                      onClick: () => {
                        cities.push({ name: c.name, country: c.country, latitude: c.latitude, longitude: c.longitude });
                        index = cities.length - 1;
                        ctx.storage.set('cities', cities);
                        ctx.storage.set('index', index);
                        panel.close();
                        load();
                      },
                    }),
                  )
                : [listItem({ title: 'Aucune ville trouvée' })]),
            );
          } catch {
            results.replaceChildren(listItem({ title: 'Recherche indisponible hors ligne' }));
          }
        }, 300);
      },
    });
    renderSaved();
    const panel = sheet(root, { title: 'Villes', content: [search, h('div.weather-results', results), h('div.list-header', 'Mes villes'), savedList], full: true, cancelLabel: 'OK' });
  }

  // Balayage horizontal entre les villes.
  let startX = null;
  view.addEventListener('pointerdown', (e) => (startX = e.clientX));
  view.addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    const min = located ? -1 : 0;
    if (Math.abs(dx) < 70) return;
    const next = index + (dx < 0 ? 1 : -1);
    if (next < min || next >= cities.length) return;
    index = next;
    ctx.storage.set('index', index);
    load();
  });

  load();
  ctx.setInterval(() => ctx.foreground && load(), 15 * 60_000);
  return { onResume: () => load() };
}
