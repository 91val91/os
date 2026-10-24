/**
 * Moteur de musique générative (Web Audio) : batterie, basse, nappes et
 * mélodie produites à la volée à partir d'une graine. Chaque morceau est
 * déterministe : même graine, même musique.
 */
import { mulberry32 } from '../../lib/artwork.js';

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9, 12, 14],
};

export const TRACKS = [
  { id: 'aube', title: 'Aube sur Orion', artist: 'Orion Sessions', bpm: 92, root: 57, scale: 'minor', progression: [0, 5, 3, 4], seed: 11 },
  { id: 'nebuleuse', title: 'Nébuleuse', artist: 'Orion Sessions', bpm: 78, root: 50, scale: 'dorian', progression: [0, 3, 4, 3], seed: 23 },
  { id: 'trajectoire', title: 'Trajectoire', artist: 'Orion Sessions', bpm: 118, root: 55, scale: 'major', progression: [0, 4, 5, 3], seed: 37 },
  { id: 'gravite', title: 'Gravité zéro', artist: 'Les Satellites', bpm: 84, root: 53, scale: 'pentatonic', progression: [0, 2, 3, 1], seed: 41 },
  { id: 'retour', title: 'Retour sur Terre', artist: 'Les Satellites', bpm: 104, root: 52, scale: 'major', progression: [0, 5, 1, 4], seed: 59 },
];

const BARS = 32;

export function trackDuration(track) {
  return (BARS * 4 * 60) / track.bpm;
}

const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

export class SynthPlayer {
  constructor(audio, destination) {
    this.audio = audio;
    this.destination = destination;
    this.track = null;
    this.bus = null;
    this.timer = null;
    this.startTime = 0;
    this.offset = 0;
    this.playing = false;
    this.onEnd = null;
    const length = audio.sampleRate;
    this.noise = audio.createBuffer(1, length, audio.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  get position() {
    if (!this.track) return 0;
    return this.playing ? this.audio.currentTime - this.startTime : this.offset;
  }

  play(track, offset = 0) {
    this.stop();
    this.track = track;
    this.playing = true;
    const audio = this.audio;
    this.bus = audio.createGain();
    this.bus.gain.value = 0.8;
    // Écho léger sur la mélodie.
    this.delay = audio.createDelay(1);
    this.delay.delayTime.value = (60 / track.bpm) * 0.75;
    const feedback = audio.createGain();
    feedback.gain.value = 0.28;
    this.delay.connect(feedback).connect(this.delay);
    this.delay.connect(this.bus);
    this.bus.connect(this.destination);

    const stepDur = 60 / track.bpm / 4;
    let step = Math.floor(offset / stepDur);
    this.startTime = audio.currentTime + 0.05 - step * stepDur;
    let nextTime = this.startTime + step * stepDur;
    const total = BARS * 16;
    this.timer = setInterval(() => {
      while (nextTime < audio.currentTime + 0.15) {
        if (step >= total) {
          clearInterval(this.timer);
          this.timer = null;
          setTimeout(() => {
            if (this.track === track && this.playing) {
              this.stop();
              this.onEnd?.();
            }
          }, Math.max(0, (nextTime - audio.currentTime) * 1000));
          return;
        }
        this.#schedule(track, step, nextTime, stepDur);
        step++;
        nextTime += stepDur;
      }
    }, 25);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.stop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.bus) {
      const bus = this.bus;
      bus.gain.setTargetAtTime(0, this.audio.currentTime, 0.02);
      setTimeout(() => bus.disconnect(), 120);
    }
    this.bus = null;
    this.playing = false;
  }

  #schedule(track, step, time, stepDur) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const scale = SCALES[track.scale];
    const degree = track.progression[bar % track.progression.length];
    const note = (deg, octave = 0) => track.root + scale[((deg % scale.length) + scale.length) % scale.length] + 12 * (octave + Math.floor(deg / scale.length));
    const section = bar < 4 ? 'intro' : bar < 16 ? 'main' : bar < 20 ? 'break' : bar < 28 ? 'main' : 'outro';
    const random = mulberry32(track.seed * 1000 + bar * 16 + s);

    if (s === 0) this.#pad([note(degree), note(degree + 2), note(degree + 4)], time, stepDur * 16, section === 'outro' ? 0.04 : 0.055);
    if (section === 'main') {
      if (s === 0 || s === 8 || (track.bpm > 100 && s === 10)) this.#kick(time);
      if (s === 4 || s === 12) this.#snare(time);
      if ([0, 6, 8, 14].includes(s)) this.#bass(note(degree, -2), time, stepDur * 2);
    }
    if (section !== 'outro' && s % 2 === 0) this.#hat(time, s % 4 === 2 ? 0.09 : 0.05);
    if ((section === 'main' || section === 'break') && random() < (s % 4 === 0 ? 0.55 : 0.22)) {
      const deg = degree + [0, 2, 4, 1, 3, 5, 7][Math.floor(random() * 7)];
      this.#lead(note(deg, 1), time, stepDur * (random() < 0.3 ? 3 : 1.5));
    }
  }

  #env(gainNode, time, peak, attack, duration, release) {
    const g = gainNode.gain;
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(peak, time + attack);
    g.setValueAtTime(peak, time + Math.max(attack, duration - release));
    g.linearRampToValueAtTime(0, time + duration);
  }

  #kick(time) {
    const a = this.audio;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    gain.gain.setValueAtTime(0.9, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    osc.connect(gain).connect(this.bus);
    osc.start(time);
    osc.stop(time + 0.35);
  }

  #noiseHit(time, { type, frequency, gain: level, duration }) {
    const a = this.audio;
    const src = a.createBufferSource();
    src.buffer = this.noise;
    const filter = a.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const gain = a.createGain();
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
    src.connect(filter).connect(gain).connect(this.bus);
    src.start(time, Math.random() * 0.5);
    src.stop(time + duration + 0.02);
  }

  #snare(time) {
    this.#noiseHit(time, { type: 'bandpass', frequency: 1800, gain: 0.35, duration: 0.18 });
  }

  #hat(time, level) {
    this.#noiseHit(time, { type: 'highpass', frequency: 7500, gain: level, duration: 0.05 });
  }

  #bass(midi, time, duration) {
    const a = this.audio;
    const osc = a.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    const gain = a.createGain();
    this.#env(gain, time, 0.32, 0.01, duration, 0.06);
    osc.connect(gain).connect(this.bus);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  #pad(notes, time, duration, level) {
    const a = this.audio;
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    filter.Q.value = 0.8;
    const gain = a.createGain();
    this.#env(gain, time, level, 0.6, duration + 0.4, 0.8);
    filter.connect(gain).connect(this.bus);
    for (const midi of notes) {
      for (const detune of [-7, 7]) {
        const osc = a.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiToFreq(midi);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(time);
        osc.stop(time + duration + 0.5);
      }
    }
  }

  #lead(midi, time, duration) {
    const a = this.audio;
    const osc = a.createOscillator();
    osc.type = 'square';
    osc.frequency.value = midiToFreq(midi);
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    const gain = a.createGain();
    this.#env(gain, time, 0.07, 0.01, duration, duration * 0.5);
    osc.connect(filter).connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delay);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }
}
