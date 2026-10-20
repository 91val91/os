/**
 * Dictaphone : enregistrement audio (MediaRecorder) avec forme d'onde en
 * direct, liste des mémos dans /home/Recordings, lecture, renommage.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { formatDuration, relativeTime } from '../../lib/format.js';
import { appBar, collapseOnScroll, emptyState, swipeToDelete } from '../../lib/ui.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const DIR = '/home/Recordings';

export function mount(root, ctx) {
  const fs = ctx.fs;
  if (!fs.exists(DIR)) fs.mkdir(DIR, { recursive: true });
  const meta = ctx.storage.get('durations', {});
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let analyser = null;
  let audioCtx = null;
  let activity = null;
  let playingPath = null;
  const player = new Audio();
  player.addEventListener('ended', () => {
    playingPath = null;
    renderList();
  });

  const list = h('div.list');
  const wave = h('canvas.rec-wave', { width: 600, height: 120 });
  const timer = h('div.rec-timer', '00:00');
  const recordBtn = h('button.rec-btn', { type: 'button', 'aria-label': 'Enregistrer', onclick: () => (recorder ? stop() : start()) }, h('span'));
  const bar = appBar({ title: 'Dictaphone' });
  const scroll = h('div.app-scroll', h('div.app-content', list));
  collapseOnScroll(bar, scroll);
  root.classList.add('recorder');
  root.append(bar, scroll, h('div.rec-panel', wave, timer, recordBtn));

  function recordings() {
    return fs.readdir(DIR).filter((e) => e.type === 'file').sort((a, b) => b.mtime - a.mtime);
  }

  function renderList() {
    const items = recordings();
    if (!items.length) {
      list.replaceChildren(emptyState({ icon: 'mic', title: 'Aucun enregistrement', message: 'Touchez le bouton rouge pour enregistrer un mémo vocal.' }));
      return;
    }
    list.replaceChildren(
      ...items.map((e) => {
        const playing = playingPath === e.path;
        const row = h(
          'div.list-item.rec-row',
          h('div.li-body', h('div.li-title', e.name.replace(/\.[^.]+$/, '')), h('div.li-sub', `${relativeTime(e.mtime, ctx.now())} · ${meta[e.path] ? formatDuration(meta[e.path]) : '—'}`)),
          h('button.rec-play', { type: 'button', 'aria-label': playing ? 'Pause' : 'Lecture', onclick: () => togglePlay(e.path) }, icon(playing ? 'pause' : 'play', { size: 18 })),
          h('button.rec-more', { type: 'button', 'aria-label': 'Options', onclick: () => options(e) }, icon('more', { size: 20 })),
        );
        return swipeToDelete(row, () => {
          fs.rm(e.path);
          delete meta[e.path];
          ctx.storage.set('durations', meta);
          renderList();
        });
      }),
    );
  }

  function togglePlay(path) {
    if (playingPath === path) {
      player.pause();
      playingPath = null;
    } else {
      player.src = fs.readFile(path);
      player.volume = ctx.settings.get('volume');
      player.play().catch((error) => ctx.ui.toast(`Lecture impossible : ${error.message}`));
      playingPath = path;
    }
    renderList();
  }

  async function options(entry) {
    const choice = await ctx.ui.actionSheet({
      title: entry.name,
      actions: [
        { label: 'Renommer', value: 'rename', icon: 'edit' },
        { label: 'Ouvrir dans Musique', value: 'music', icon: 'music' },
        { label: 'Supprimer', value: 'delete', icon: 'trash', destructive: true },
      ],
    });
    if (choice === 'rename') {
      const name = await ctx.ui.prompt({ title: 'Renommer', value: entry.name.replace(/\.[^.]+$/, '') });
      if (name?.trim()) {
        const ext = entry.name.split('.').pop();
        const target = fs.uniquePath(`${DIR}/${name.trim()}.${ext}`);
        fs.rename(entry.path, target);
        meta[target] = meta[entry.path];
        delete meta[entry.path];
        ctx.storage.set('durations', meta);
      }
    } else if (choice === 'music') {
      ctx.startActivity({ action: 'view', type: entry.mime, data: { path: entry.path } });
    } else if (choice === 'delete') {
      fs.rm(entry.path);
    }
    renderList();
  }

  async function start() {
    const allowed = await ctx.requestPermission('microphone');
    if (!allowed) {
      ctx.ui.alert({ title: 'Micro non autorisé', message: 'Autorisez le micro dans Réglages → Confidentialité.' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      ctx.ui.alert({ title: 'Enregistrement indisponible', message: "Ce navigateur ne permet pas d'enregistrer de l'audio." });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      ctx.ui.alert({ title: 'Micro indisponible', message: error.message });
      return;
    }
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    recorder.addEventListener('stop', save);
    recorder.start(250);
    startedAt = ctx.now();
    root.classList.add('recording');
    activity = ctx.ui.liveActivity({ id: 'rec', icon: 'record', color: '#ff453a', priority: 8, text: () => formatDuration(ctx.now() - startedAt) });
    ctx.ui.vibrate(20);
  }

  function stop() {
    if (!recorder) return;
    recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx?.close();
    analyser = null;
    root.classList.remove('recording');
    activity?.end();
    activity = null;
  }

  async function save() {
    const duration = ctx.now() - startedAt;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    const count = recordings().length + 1;
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'weba';
    const path = fs.uniquePath(`${DIR}/Mémo ${count}.${ext}`);
    fs.writeFile(path, data, { mime: blob.type.split(';')[0] || 'audio/webm' });
    meta[path] = duration;
    ctx.storage.set('durations', meta);
    timer.textContent = '00:00';
    renderList();
    ctx.ui.toast('Mémo enregistré');
  }

  const g = wave.getContext('2d');
  const samples = new Uint8Array(512);
  ctx.raf(() => {
    g.clearRect(0, 0, wave.width, wave.height);
    g.strokeStyle = recorder ? '#ff453a' : 'rgba(142,142,147,.6)';
    g.lineWidth = 3;
    g.beginPath();
    if (analyser) {
      analyser.getByteTimeDomainData(samples);
      for (let i = 0; i < samples.length; i++) {
        const x = (i / samples.length) * wave.width;
        const y = (samples[i] / 255) * wave.height;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      timer.textContent = formatDuration(ctx.now() - startedAt);
    } else {
      g.moveTo(0, wave.height / 2);
      g.lineTo(wave.width, wave.height / 2);
    }
    g.stroke();
  });

  renderList();
  return {
    onDestroy: () => {
      stop();
      player.pause();
    },
  };
}
