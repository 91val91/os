/**
 * Musique : morceaux génératifs (synthétiseur intégré) et fichiers audio
 * de /home/Music. Lecture en arrière-plan, session multimédia système
 * (centre de contrôle, écran verrouillé) et activité en direct.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { formatDuration } from '../../lib/format.js';
import { albumArtSVG, svgToDataUrl } from '../../lib/artwork.js';
import { page, sheet, slider, listGroup } from '../../lib/ui.js';
import { isTextMime, mimeFromName } from '../../kernel/vfs.js';
import { TRACKS, SynthPlayer, trackDuration } from './synth.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const MUSIC_DIR = '/home/Music';

export function mount(root, ctx) {
  const fs = ctx.fs;
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  const audio = AudioContext ? new AudioContext() : null;
  const master = audio?.createGain();
  if (master) {
    master.gain.value = ctx.settings.get('volume');
    master.connect(audio.destination);
  }
  const synth = audio ? new SynthPlayer(audio, master) : null;
  const element = new Audio();
  element.volume = ctx.settings.get('volume');

  const art = (seed) => svgToDataUrl(albumArtSVG(seed));
  let queue = [];
  let index = -1;
  let playing = false;
  let activity = null;

  function library() {
    const generated = TRACKS.map((t) => ({ ...t, kind: 'synth', duration: trackDuration(t), artwork: art(t.id) }));
    const files = fs.exists(MUSIC_DIR)
      ? fs
          .readdir(MUSIC_DIR)
          .filter((e) => e.type === 'file' && (e.mime?.startsWith('audio/') || e.mime?.startsWith('video/webm')))
          .map((e) => ({ id: e.path, title: e.name.replace(/\.[^.]+$/, ''), artist: 'Mes fichiers', kind: 'file', path: e.path, duration: 0, artwork: art(e.name) }))
      : [];
    return { generated, files };
  }

  const current = () => queue[index] ?? null;
  const position = () => {
    const t = current();
    if (!t) return 0;
    return t.kind === 'synth' ? synth?.position ?? 0 : element.currentTime;
  };
  const duration = () => {
    const t = current();
    if (!t) return 0;
    return t.kind === 'synth' ? t.duration : Number.isFinite(element.duration) ? element.duration : 0;
  };

  async function playIndex(i, offset = 0) {
    if (!queue.length) return;
    index = (i + queue.length) % queue.length;
    const track = current();
    synth?.stop();
    element.pause();
    if (track.kind === 'synth') {
      if (!synth) {
        ctx.ui.toast('Audio non pris en charge');
        return;
      }
      await audio.resume();
      synth.play(track, offset);
    } else {
      element.src = fs.readFile(track.path);
      element.currentTime = offset;
      try {
        await element.play();
      } catch (error) {
        ctx.ui.toast(`Lecture impossible : ${error.message}`);
        return;
      }
    }
    playing = true;
    sync();
  }

  function pause() {
    if (!playing) return;
    synth?.pause();
    element.pause();
    playing = false;
    sync();
  }

  function resume() {
    const t = current();
    if (!t) {
      queue = [...library().generated, ...library().files];
      playIndex(0);
      return;
    }
    if (t.kind === 'synth') playIndex(index, synth.offset);
    else {
      element.play();
      playing = true;
      sync();
    }
  }

  const toggle = () => (playing ? pause() : resume());
  const next = () => playIndex(index + 1);
  const previous = () => (position() > 3 ? playIndex(index) : playIndex(index - 1));

  if (synth) synth.onEnd = next;
  element.addEventListener('ended', next);
  element.addEventListener('loadedmetadata', () => sync());

  // Session multimédia système + API Media Session du navigateur.
  function sync() {
    const t = current();
    // iPhone : la musique continue même si l'interrupteur silencieux est activé.
    ctx.sound.setPlaybackSession('music', playing);
    renderMini();
    fullPlayer?.render();
    renderList();
    if (!t) {
      ctx.media.clear();
      return;
    }
    ctx.media.set({ title: t.title, artist: t.artist, artwork: t.artwork, playing, duration: duration(), position: position() }, { play: resume, pause, next, previous });
    if (playing) {
      const meta = { id: 'music', icon: 'music-note', color: '#ff375f', text: t.title, priority: 2, onClick: () => ctx.startActivity({ app: 'music', action: 'main' }) };
      if (activity) activity.update(meta);
      else activity = ctx.ui.liveActivity(meta);
    } else {
      activity?.end();
      activity = null;
    }
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({ title: t.title, artist: t.artist, album: 'Orion OS', artwork: [{ src: t.artwork, sizes: '400x400', type: 'image/svg+xml' }] });
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', resume);
        navigator.mediaSession.setActionHandler('pause', pause);
        navigator.mediaSession.setActionHandler('nexttrack', next);
        navigator.mediaSession.setActionHandler('previoustrack', previous);
      } catch {
        /* API partielle */
      }
    }
  }

  // ───────────── Bibliothèque ─────────────
  const listContent = h('div');
  const picker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
  picker.addEventListener('change', async () => {
    for (const file of picker.files) {
      const data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      const mime = file.type || mimeFromName(file.name);
      if (isTextMime(mime)) continue;
      fs.writeFile(fs.uniquePath(`${MUSIC_DIR}/${file.name}`), data, { mime, parents: true });
    }
    ctx.ui.toast('Musique importée');
    renderList();
  });
  const libPage = page({
    title: 'Musique',
    actions: [h('button.appbar-text', { type: 'button', onclick: () => picker.click() }, 'Importer')],
    content: listContent,
  });

  function trackRow(t, list, i) {
    const active = current()?.id === t.id;
    return h(
      `div.list-item.tappable.track-row${active ? '.active' : ''}`,
      { onclick: () => { queue = list; playIndex(i); } },
      h('div.track-art', { style: { backgroundImage: `url("${t.artwork}")` } }, active && playing ? h('div.eq', h('i'), h('i'), h('i')) : null),
      h('div.li-body', h('div.li-title', t.title), h('div.li-sub', t.artist)),
      t.duration ? h('div.li-detail', formatDuration(t.duration * 1000)) : null,
    );
  }

  function renderList() {
    const { generated, files } = library();
    listContent.replaceChildren(
      h(
        'div.music-hero',
        { style: { backgroundImage: `url("${art('orion-sessions')}")` } },
        h('div.music-hero-text', h('small', 'À LA UNE'), h('strong', 'Orion Sessions'), h('span', 'Musique générée en temps réel')),
        h('button.music-hero-play', { type: 'button', 'aria-label': 'Tout lire', onclick: () => { queue = [...generated, ...files]; playIndex(0); } }, icon('play', { size: 22 })),
      ),
      listGroup({ header: 'Morceaux génératifs', items: generated.map((t, i) => trackRow(t, generated, i)) }),
      files.length
        ? listGroup({ header: 'Mes fichiers', items: files.map((t, i) => trackRow(t, files, i)) })
        : listGroup({ header: 'Mes fichiers', footer: 'Importez des fichiers audio ou déposez-les dans Fichiers → Musique.', items: [h('div.list-item.muted', icon('music', { size: 18 }), 'Aucun fichier audio')] }),
    );
  }

  // ───────────── Mini-lecteur et lecteur plein écran ─────────────
  const mini = h('div.mini-player', { onclick: () => openPlayer() });
  function renderMini() {
    const t = current();
    mini.hidden = !t;
    if (!t) return;
    mini.replaceChildren(
      h('div.track-art', { style: { backgroundImage: `url("${t.artwork}")` } }),
      h('div.mini-title', t.title),
      h('button.mini-btn', { type: 'button', 'aria-label': playing ? 'Pause' : 'Lecture', onclick: (e) => { e.stopPropagation(); toggle(); } }, icon(playing ? 'pause' : 'play', { size: 22 })),
      h('button.mini-btn', { type: 'button', 'aria-label': 'Suivant', onclick: (e) => { e.stopPropagation(); next(); } }, icon('next', { size: 22 })),
    );
  }

  let fullPlayer = null;
  function openPlayer() {
    const body = h('div.player');
    const progress = slider({ min: 0, max: 1, step: 0.001, value: 0, label: 'Position', onInput: (v) => { seeking = true; seekValue = v; } });
    let seeking = false;
    let seekValue = 0;
    progress.input.addEventListener('change', () => {
      seeking = false;
      const target = seekValue * duration();
      if (current()?.kind === 'synth') playIndex(index, target);
      else element.currentTime = target;
    });
    const times = h('div.player-times');
    const render = () => {
      const t = current();
      if (!t) return;
      body.replaceChildren(
        h(`div.player-art${playing ? '.playing' : ''}`, { style: { backgroundImage: `url("${t.artwork}")` } }),
        h('div.player-meta', h('strong', t.title), h('span', t.artist)),
        progress,
        times,
        h(
          'div.player-controls',
          h('button', { type: 'button', 'aria-label': 'Précédent', onclick: previous }, icon('previous', { size: 34 })),
          h('button.big', { type: 'button', 'aria-label': playing ? 'Pause' : 'Lecture', onclick: toggle }, icon(playing ? 'pause' : 'play', { size: 50 })),
          h('button', { type: 'button', 'aria-label': 'Suivant', onclick: next }, icon('next', { size: 34 })),
        ),
        slider({ min: 0, max: 1, step: 0.05, value: ctx.settings.get('volume'), iconLeft: 'volume-low', iconRight: 'volume', label: 'Volume', onInput: (v) => ctx.system?.changeVolume(v - ctx.settings.get('volume')) }),
      );
      tick();
    };
    const tick = () => {
      const d = duration();
      const p = position();
      if (!seeking) progress.set(d ? p / d : 0);
      times.replaceChildren(h('span', formatDuration(p * 1000)), h('span', `-${formatDuration(Math.max(0, d - p) * 1000)}`));
    };
    fullPlayer = { render, tick };
    render();
    sheet(root, { title: '', content: body, cancelLabel: 'Fermer', onClose: () => (fullPlayer = null), full: true });
  }

  root.classList.add('music');
  root.append(libPage, mini, picker);
  libPage.classList.add('music-page');
  renderList();
  renderMini();

  ctx.setInterval(() => {
    if (!current()) return;
    fullPlayer?.tick();
    ctx.media.update({ position: position(), duration: duration() });
  }, 500);
  ctx.settings.watch('volume', (v) => {
    if (master) master.gain.setTargetAtTime(v, audio.currentTime, 0.05);
    element.volume = v;
  });
  ctx.subscribe('fs:change', ({ path }) => path.startsWith(MUSIC_DIR) && renderList());

  function handleIntent(intent) {
    const path = intent?.data?.path;
    if (intent?.action === 'view' && path && fs.exists(path)) {
      const track = { id: path, title: path.split('/').pop().replace(/\.[^.]+$/, ''), artist: 'Fichier', kind: 'file', path, artwork: art(path) };
      queue = [track];
      playIndex(0);
    }
  }
  handleIntent(ctx.intent);

  return {
    onIntent: handleIntent,
    onDestroy: () => {
      synth?.stop();
      element.pause();
      ctx.sound.setPlaybackSession('music', false);
      activity?.end();
      audio?.close();
      ctx.media.clear();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    },
  };
}
