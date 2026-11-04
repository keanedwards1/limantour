// ---------------------------------------------------------------------------
// Procedural audio: ambient score + spatial beach ambience (Web Audio API).
// The same musical clock drives the camera zooms in main.js.
// ---------------------------------------------------------------------------

export const BPM = 72;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const PHRASE = BAR * 4;
const STEP = BEAT / 2; // eighth notes
const VOLUME = 1.5;

// eight 4-bar sections, then the song loops
export const SECTIONS = [
  { name: "intro",     pad: 1.0, bass: 0, bells: 0.00, kick: 0, shaker: 0, cam: "push" },
  { name: "rise",      pad: 1.0, bass: 1, bells: 0.25, kick: 0, shaker: 0, cam: "pull" },
  { name: "pulse",     pad: 1.0, bass: 1, bells: 0.35, kick: 1, shaker: 0, cam: "punch" },
  { name: "peak",      pad: 1.0, bass: 1, bells: 0.50, kick: 1, shaker: 1, cam: "dolly" },
  { name: "breakdown", pad: 0.8, bass: 0, bells: 0.15, kick: 0, shaker: 0, cam: "push", dark: true },
  { name: "rebuild",   pad: 1.0, bass: 1, bells: 0.35, kick: 0, shaker: 1, cam: "pull" },
  { name: "pulse 2",   pad: 1.0, bass: 1, bells: 0.45, kick: 1, shaker: 1, cam: "punch" },
  { name: "finale",    pad: 1.0, bass: 1, bells: 0.55, kick: 1, shaker: 1, cam: "dolly", riser: true },
];
export const SONG = PHRASE * SECTIONS.length;

// D major: Dmaj9 – Bm9 – Gmaj9 – Asus
const CHORDS = [
  [50, 57, 61, 64, 66],
  [47, 54, 57, 61, 62],
  [43, 50, 54, 57, 61],
  [45, 52, 57, 59, 64],
];
const ROOTS = [38, 35, 31, 33];
const BELL_NOTES = [74, 76, 78, 81, 83, 86, 88, 90]; // D major pentatonic

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const hash = (n) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};

export function musicInfo(t) {
  const st = ((t % SONG) + SONG) % SONG;
  const phrase = Math.floor(st / PHRASE);
  const pt = st - phrase * PHRASE;
  return {
    phrase,
    p: pt / PHRASE,                 // progress through the section 0..1
    bar: Math.floor(pt / BAR),
    beat: (pt % BAR) / BEAT,        // 0..4 within the bar
    cfg: SECTIONS[phrase],
  };
}

// --- surf timing, matched to the breakers in the ocean shader (period 2π s)
export const SURF_PERIOD = Math.PI * 2;
const SURF_OFFSET = 4.86;
const crashStrength = (k) => 0.4 + 0.6 * hash(k * 3.1 + 1.7);
const crashTime = (k) => (k + 0.12) * SURF_PERIOD - SURF_OFFSET;

// 0..1 envelope that peaks right after each wave crashes
export function surfCrash(t) {
  const x = (t + SURF_OFFSET) / SURF_PERIOD - 0.12;
  const k = Math.floor(x);
  const f = (x - k) * SURF_PERIOD; // seconds since crash
  return crashStrength(k) * (1 - Math.exp(-f * 8)) * Math.exp(-f * 1.2);
}

// ---------------------------------------------------------------------------

export class BeachAudio {
  constructor({ shoreZ, washLevel }) {
    this.shoreZ = shoreZ;
    this.washLevel = washLevel;
    this.started = false;
    this.muted = false;
    this.gulls = [];
  }

  async start(sceneTime) {
    if (this.started) return;
    this.started = true;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    await ctx.resume();
    this.offset = ctx.currentTime - sceneTime + 0.15;

    // --- buses
    this.master = ctx.createGain();
    this.master.gain.setValueAtTime(0, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(VOLUME, ctx.currentTime + 3);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.55;
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);

    // reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.5, 2.2);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.6;
    this.reverb.connect(revOut).connect(this.master);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbSend.connect(this.reverb);

    // dotted-eighth echo for the bells
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const dlp = ctx.createBiquadFilter();
    dlp.type = "lowpass";
    dlp.frequency.value = 2600;
    this.delay.connect(dlp).connect(fb).connect(this.delay);
    dlp.connect(this.musicBus);
    dlp.connect(this.reverbSend);
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.35;
    this.delaySend.connect(this.delay);

    this.white = this.noiseBuffer(3, false);
    this.brown = this.noiseBuffer(4, true);

    this.buildAmbience();


    this.nextStep = Math.ceil((sceneTime + 0.15) / STEP);
    this.nextCrash = Math.ceil((sceneTime + 0.15 + SURF_OFFSET) / SURF_PERIOD - 0.12);
    this.nextGull = sceneTime + 3 + Math.random() * 5;
    this.timer = setInterval(() => this.schedule(), 40);
  }

  toggleMute() {
    if (!this.started) return this.muted;
    this.muted = !this.muted;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : VOLUME, now + 0.4);
    return this.muted;
  }

  sceneNow() {
    return this.ctx.currentTime - this.offset;
  }

  // ------------------------------------------------------------- utilities
  noiseBuffer(seconds, brown) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  noise(at, dur, buffer = this.white) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(at, Math.random() * (buffer.duration - 0.1));
    src.stop(at + dur);
    return src;
  }

  env(param, at, peak, attack, release, hold = 0) {
    // silent from now until the envelope starts (a GainNode defaults to full volume)
    param.setValueAtTime(0.0001, this.ctx.currentTime);
    param.setValueAtTime(0.0001, at);
    param.exponentialRampToValueAtTime(peak, at + attack);
    if (hold) param.setValueAtTime(peak, at + attack + hold);
    param.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  }

  filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  // ------------------------------------------------------------- ambience
  buildAmbience() {
    const ctx = this.ctx;

    // distant surf roar
    const roarSrc = this.noise(ctx.currentTime, 1e6, this.brown);
    this.roarFilter = this.filter("lowpass", 550);
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    roarSrc.connect(this.roarFilter).connect(this.roarGain).connect(this.sfxBus);

    // foam hiss as the water draws back down the sand
    const hissSrc = this.noise(ctx.currentTime, 1e6);
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    hissSrc.connect(this.filter("highpass", 2800)).connect(this.hissGain).connect(this.sfxBus);

    // gusty onshore wind
    const windSrc = this.noise(ctx.currentTime, 1e6);
    this.windFilter = this.filter("bandpass", 500, 0.6);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.sfxBus);
  }

  // called every frame with the scene state
  update(t, camera, birds) {
    if (!this.started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = camera.position;
    this.camX = p.x;

    // listener follows the drone
    const l = ctx.listener;
    const f = camera.getWorldDirection(this._fwd || (this._fwd = p.clone()));
    const up = camera.up;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, now, 0.05);
      l.positionY.setTargetAtTime(p.y, now, 0.05);
      l.positionZ.setTargetAtTime(p.z, now, 0.05);
      l.forwardX.setTargetAtTime(f.x, now, 0.05);
      l.forwardY.setTargetAtTime(f.y, now, 0.05);
      l.forwardZ.setTargetAtTime(f.z, now, 0.05);
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, up.x, up.y, up.z);
    }

    // ambience levels from distance to the surf and altitude
    const shoreDist = Math.hypot(p.z - (this.shoreZ(p.x) + 15), p.y);
    const near = 1 / (1 + shoreDist / 45);
    const wash = this.washLevel(t), washPrev = this.washLevel(t - 0.1);
    const receding = Math.max(0, (washPrev - wash) / 0.1);
    this.roarGain.gain.setTargetAtTime(0.1 + 0.32 * near, now, 0.3);
    this.roarFilter.frequency.setTargetAtTime(380 + 500 * near, now, 0.3);
    this.hissGain.gain.setTargetAtTime((0.008 + 0.09 * receding) * near, now, 0.2);

    const gust = 0.5 + 0.5 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1.3);
    const alt = Math.min(1, Math.max(0, (p.y - 8) / 20));
    this.windGain.gain.setTargetAtTime(0.025 + 0.06 * gust + 0.05 * alt, now, 0.4);
    this.windFilter.frequency.setTargetAtTime(320 + 420 * gust + 200 * alt, now, 0.4);

    // gulls follow the bird they belong to
    this.gulls = this.gulls.filter((g) => g.end > now);
    for (const g of this.gulls) this.placePanner(g.panner, g.bird.position, now);
    this.birds = birds;
  }

  placePanner(panner, v, now) {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(v.x, now, 0.05);
      panner.positionY.setTargetAtTime(v.y, now, 0.05);
      panner.positionZ.setTargetAtTime(v.z, now, 0.05);
    } else panner.setPosition(v.x, v.y, v.z);
  }

  panner(pos, ref, rolloff) {
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    this.placePanner(p, pos, this.ctx.currentTime);
    return p;
  }

  // ------------------------------------------------------------- scheduler
  schedule() {
    const ahead = this.sceneNow() + 0.3;
    const late = this.sceneNow() - 0.05;

    while (this.nextStep * STEP < ahead) {
      const t = this.nextStep * STEP;
      if (t > late) this.step(this.nextStep, t);
      this.nextStep++;
    }
    while (crashTime(this.nextCrash) < ahead) {
      const t = crashTime(this.nextCrash);
      if (t > late) this.crash(t + this.offset, crashStrength(this.nextCrash));
      this.nextCrash++;
    }
    if (this.nextGull < ahead) {
      if (this.birds && this.birds.length) {
        this.gull(this.nextGull + this.offset, this.birds[Math.floor(Math.random() * this.birds.length)]);
      }
      this.nextGull += 6 + Math.random() * 12;
    }
  }

  step(i, t) {
    const at = t + this.offset;
    const m = musicInfo(t);
    const cfg = m.cfg;
    const s = Math.round(m.beat * 2) % 8; // eighth within the bar
    const barGlobal = Math.floor((t + 1e-4) / BAR);
    const chord = Math.floor(barGlobal / 2) % 4;

    if (s === 0) {
      if (barGlobal % 2 === 0 && cfg.pad) this.pad(at, CHORDS[chord], BAR * 2, cfg.pad, cfg.dark ? 650 : 1500);
      if (cfg.bass) this.bass(at, ROOTS[chord], BAR * 0.95);
      if (m.phrase === 0 && m.bar === 0) this.impact(at);
      if (cfg.riser && m.bar === 2) this.riser(at, BAR * 2);
    }
    if (cfg.kick && (s === 0 || s === 5)) this.kick(at, s === 0 ? 1 : 0.65);
    if (cfg.shaker && s % 2 === 1) this.shaker(at + 0.03, 0.6 + 0.4 * hash(i));
    if (hash(i * 1.37) < cfg.bells) {
      const n = BELL_NOTES[Math.floor(hash(i * 7.1) * BELL_NOTES.length)];
      this.bell(at, n, 0.5 + 0.5 * hash(i * 2.3));
    }
  }

  // ------------------------------------------------------------- instruments
  pad(at, notes, dur, level, cutoff) {
    const ctx = this.ctx;
    const f = this.filter("lowpass", cutoff * 0.4, 0.4);
    f.frequency.setValueAtTime(cutoff * 0.4, at);
    f.frequency.linearRampToValueAtTime(cutoff, at + dur * 0.5);
    f.frequency.linearRampToValueAtTime(cutoff * 0.5, at + dur + 2.5);
    const g = ctx.createGain();
    const peak = 0.045 * level;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 1.8);
    g.gain.setValueAtTime(peak, at + dur - 0.2);
    g.gain.linearRampToValueAtTime(0, at + dur + 2.5);
    f.connect(g);
    g.connect(this.musicBus);
    g.connect(this.reverbSend);
    for (const n of notes) {
      for (const d of [-9, 9]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = mtof(n);
        o.detune.value = d + (Math.random() - 0.5) * 5;
        o.connect(f);
        o.start(at);
        o.stop(at + dur + 2.6);
      }
    }
  }

  bass(at, midi, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.16, at + 0.12);
    g.gain.setValueAtTime(0.16, at + dur - 0.3);
    g.gain.linearRampToValueAtTime(0, at + dur);
    const lp = this.filter("lowpass", 420);
    lp.connect(g).connect(this.musicBus);
    for (const [mul, type, lvl] of [[1, "sine", 1], [2, "triangle", 0.25]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(midi + 12) * mul;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(lp);
      o.start(at);
      o.stop(at + dur + 0.05);
    }
  }

  bell(at, midi, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g.gain, at, 0.05 * vel, 0.004, 2.4);
    g.connect(this.musicBus);
    g.connect(this.delaySend);
    g.connect(this.reverbSend);
    for (const [ratio, lvl] of [[1, 1], [2.76, 0.25], [5.4, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = mtof(midi) * ratio;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(at);
      o.stop(at + 2.5);
    }
  }

  kick(at, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(115, at);
    o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
    const g = ctx.createGain();
    this.env(g.gain, at, 0.42 * vel, 0.004, 0.5);
    o.connect(g).connect(this.musicBus);
    o.start(at);
    o.stop(at + 0.6);
  }

  shaker(at, vel) {
    const g = this.ctx.createGain();
    this.env(g.gain, at, 0.035 * vel, 0.006, 0.07);
    this.noise(at, 0.1).connect(this.filter("highpass", 7000)).connect(g).connect(this.musicBus);
    g.connect(this.reverbSend);
  }

  riser(at, dur) {
    const f = this.filter("bandpass", 200, 2.5);
    f.frequency.setValueAtTime(200, at);
    f.frequency.exponentialRampToValueAtTime(5000, at + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.12, at + dur);
    g.gain.linearRampToValueAtTime(0, at + dur + 0.05);
    this.noise(at, dur + 0.1).connect(f).connect(g);
    g.connect(this.musicBus);
    g.connect(this.reverbSend);
  }

  impact(at) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(70, at);
    o.frequency.exponentialRampToValueAtTime(30, at + 1.4);
    const g = ctx.createGain();
    this.env(g.gain, at, 0.45, 0.01, 2.6);
    o.connect(g).connect(this.musicBus);
    o.start(at);
    o.stop(at + 2.8);

    const ng = ctx.createGain();
    this.env(ng.gain, at, 0.12, 0.02, 3.0);
    this.noise(at, 3.2).connect(this.filter("lowpass", 1100)).connect(ng);
    ng.connect(this.reverbSend);
    ng.connect(this.musicBus);
  }

  // a wave breaking on the shoreline nearest the drone
  crash(at, strength) {
    const ctx = this.ctx;
    const lx = this.camX || 0;
    const pos = { x: lx, y: 0, z: this.shoreZ(lx) + 14 };
    const pan = this.panner(pos, 35, 0.7);
    pan.connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.15;
    pan.connect(send).connect(this.reverbSend);

    // body: a broad roar that sweeps down as the wave collapses
    const body = this.filter("bandpass", 900, 0.6);
    body.frequency.setValueAtTime(1100, at);
    body.frequency.exponentialRampToValueAtTime(300, at + 2.2);
    const bg = ctx.createGain();
    this.env(bg.gain, at, 1.0 * strength, 0.35, 3.6);
    this.noise(at, 4.5).connect(body).connect(bg).connect(pan);

    // low thump of the lip hitting the water
    const tg = ctx.createGain();
    this.env(tg.gain, at + 0.15, 0.8 * strength, 0.05, 0.8);
    this.noise(at + 0.15, 1.0, this.brown).connect(this.filter("lowpass", 160)).connect(tg).connect(pan);

    // fizzing whitewater rushing up the sand
    const fg = ctx.createGain();
    this.env(fg.gain, at + 0.3, 0.22 * strength, 0.5, 4.5);
    this.noise(at + 0.3, 5.2).connect(this.filter("highpass", 3200)).connect(fg).connect(pan);
  }

  // a "kee-ow" gull call sequence, positioned on one of the birds
  gull(at, bird) {
    const ctx = this.ctx;
    const pan = this.panner(bird.position, 25, 1.0);
    pan.connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    pan.connect(send).connect(this.reverbSend);

    const calls = 2 + Math.floor(Math.random() * 3);
    const base = 1150 + Math.random() * 350;
    for (let c = 0; c < calls; c++) {
      const t0 = at + c * (0.38 + Math.random() * 0.12);
      const len = 0.24 + Math.random() * 0.1;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(base * 0.9, t0);
      o.frequency.linearRampToValueAtTime(base * 1.55, t0 + 0.05);
      o.frequency.exponentialRampToValueAtTime(base * 0.85, t0 + len);
      const vib = ctx.createOscillator();
      vib.frequency.value = 28;
      const vibG = ctx.createGain();
      vibG.gain.value = 35;
      vib.connect(vibG).connect(o.frequency);
      const g = ctx.createGain();
      this.env(g.gain, t0, 0.06, 0.02, len, 0.02);
      o.connect(this.filter("bandpass", 2300, 2.5)).connect(this.filter("lowpass", 4200)).connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + len + 0.1);
      vib.start(t0);
      vib.stop(t0 + len + 0.1);
    }
    this.gulls.push({ panner: pan, bird, end: at + calls * 0.5 + 0.5 });
  }
}
