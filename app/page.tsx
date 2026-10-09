'use client';

import { ChangeEvent, useEffect, useRef, useState } from 'react';

type FfmpegInstance = {
  load: (config?: { coreURL?: string; wasmURL?: string; workerURL?: string }) => Promise<void>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  exec: (args: string[], timeout?: number) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  on: (event: string, callback: (event: { message: string; progress?: number }) => void) => void;
};

type Settings = { wet: number; decay: number; room: number; preDelay: number };
const defaults: Settings = { wet: 42, decay: 5.2, room: 82, preDelay: 24 };
const MAX_BYTES = 450 * 1024 * 1024;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createImpulse(context: OfflineAudioContext, seconds: number, decay: number, room: number) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  const roomFactor = room / 100;
  for (let i = 0; i < length; i++) {
    const envelope = Math.pow(1 - i / length, decay * 0.65);
    // A slightly diffuse, stereo impulse approximation; no external impulse file needed.
    const flutterL = (Math.random() * 2 - 1) * (0.7 + 0.3 * Math.sin(i * 0.011));
    const flutterR = (Math.random() * 2 - 1) * (0.7 + 0.3 * Math.sin(i * 0.013 + 1.7));
    left[i] = flutterL * envelope * roomFactor;
    right[i] = flutterR * envelope * roomFactor;
  }
  return impulse;
}

async function processAudio(input: Uint8Array, settings: Settings, onStatus: (s: string) => void) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser does not support Web Audio. Try the latest iOS Safari.');
  const live = new AudioContextClass();
  try {
    onStatus('Decoding audio…');
    const copy = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    const decoded = await live.decodeAudioData(copy);
    const tail = Math.min(8, Math.max(1.5, settings.decay * 0.8));
    const offline = new OfflineAudioContext(2, Math.ceil((decoded.duration + tail) * decoded.sampleRate), decoded.sampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    const dry = offline.createGain();
    dry.gain.value = 1 - settings.wet / 100;
    const convolver = offline.createConvolver();
    convolver.buffer = createImpulse(offline, settings.decay, 2.2, settings.room);
    const wet = offline.createGain();
    wet.gain.value = settings.wet / 100;
    const preDelay = offline.createDelay(0.25);
    preDelay.delayTime.value = settings.preDelay / 1000;
    source.connect(dry).connect(offline.destination);
    source.connect(convolver).connect(preDelay).connect(wet).connect(offline.destination);
    source.start(0);
    onStatus('Applying hall reverb…');
    const rendered = await offline.startRendering();
    onStatus('Preparing audio file…');
    return audioBufferToWav(rendered);
  } finally {
    await live.close().catch(() => undefined);
  }
}

function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const writeString = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeString(0, 'RIFF'); view.setUint32(4, 36 + frames * channels * 2, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); writeString(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const channelData = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const sample = Math.max(-1, Math.min(1, channelData[c][i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2;
  }
  return new Uint8Array(bytes);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [settings, setSettings] = useState(defaults);
  const [status, setStatus] = useState('Choose a video to begin');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState('');
  const [outputName, setOutputName] = useState('');
  const [error, setError] = useState('');
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FfmpegInstance | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
  }, [previewUrl, outputUrl]);

  const updateSetting = (key: keyof Settings, value: number) => setSettings((old) => ({ ...old, [key]: value }));

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setError(''); setOutputUrl(''); setOutputName(''); setProgress(0);
    if (!selected.type.startsWith('video/')) { setError('Please choose a video file.'); return; }
    if (selected.size > MAX_BYTES) { setError('This first version supports videos up to 450 MB. For iPhone Safari, shorter and smaller clips are more reliable.'); return; }
    setFile(selected); setPreviewUrl(URL.createObjectURL(selected)); setStatus('Video ready');
    event.target.value = '';
  }

  async function getFfmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current;
    setStatus('Loading export engine (first use)…');
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg() as unknown as FfmpegInstance;
    ffmpeg.on('progress', ({ progress: p }) => setProgress(Math.max(0, Math.min(100, Math.round((p || 0) * 100)))));
    const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpeg.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm') });
    ffmpegRef.current = ffmpeg; setFfmpegReady(true); return ffmpeg;
  }

  async function exportVideo() {
    if (!file) return;
    setBusy(true); setError(''); setProgress(0);
    let ffmpeg: FfmpegInstance | null = null;
    try {
      ffmpeg = await getFfmpeg();
      const ext = file.name.split('.').pop()?.toLowerCase() || 'mp4';
      const inputName = `input.${ext.replace(/[^a-z0-9]/g, '')}`;
      const safeBase = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || 'video';
      const audioName = 'source-audio.wav';
      const reverbName = 'hall-reverb.wav';
      const outName = 'reverb-output.mp4';
      setStatus('Reading video…');
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      setStatus('Extracting audio…');
      await ffmpeg.exec(['-i', inputName, '-vn', '-ac', '2', '-ar', '44100', '-f', 'wav', audioName]);
      const sourceAudio = await ffmpeg.readFile(audioName);
      const renderedWav = await processAudio(sourceAudio, settings, setStatus);
      await ffmpeg.writeFile(reverbName, renderedWav);
      setStatus('Muxing audio with original video…');
      // Video stream is copied without re-encoding; only audio is AAC-encoded.
      await ffmpeg.exec(['-i', inputName, '-i', reverbName, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', outName]);
      const output = await ffmpeg.readFile(outName);
      const blob = new Blob([output as BlobPart], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      setOutputUrl(url); setOutputName(`${safeBase}-hall-reverb.mp4`); setStatus('Export ready'); setProgress(100);
      for (const path of [inputName, audioName, reverbName, outName]) await ffmpeg.deleteFile(path).catch(() => undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Export failed: ${message}. Try a smaller MP4/MOV video, close other Safari tabs, and retry.`);
      setStatus('Export failed');
    } finally { setBusy(false); }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark" aria-hidden="true">H</div><div><div className="brand">HALLWAY</div><div className="brand-sub">VIDEO REVERB STUDIO</div></div><span className="local-pill"><span /> LOCAL ONLY</span></header>
    <section className="intro"><div className="eyebrow">SPACIAL AUDIO · SIMPLE WORKFLOW</div><h1>Give your video<br/><em>room to echo.</em></h1><p>Add a rich, spacious hall reverb to your video's sound. Your files stay on this device.</p></section>

    <section className="panel source-panel">
      <div className="section-heading"><span className="step">01</span><div><h2>Your video</h2><p>MP4 or MOV recommended</p></div></div>
      <input ref={fileInput} className="hidden-input" type="file" accept="video/*,.mp4,.mov,.m4v,.webm" onChange={selectFile}/>
      {file && previewUrl ? <div className="selected-video"><video ref={videoRef} src={previewUrl} controls playsInline preload="metadata"/><div className="file-row"><div className="file-icon">▶</div><div className="file-info"><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div><button className="text-button" onClick={() => fileInput.current?.click()} disabled={busy}>Change</button></div></div> : <button className="dropzone" onClick={() => fileInput.current?.click()} disabled={busy}><span className="upload-icon">↑</span><strong>Choose a video</strong><span>Browse Photos or Files on your iPhone</span><small>Up to 450 MB · Nothing uploads</small></button>}
    </section>

    <section className="panel effects-panel">
      <div className="section-heading"><span className="step">02</span><div><h2>Hall reverb</h2><p>Shape the space around your sound</p></div><span className="preset">LARGE HALL</span></div>
      <div className="effect-visual"><div className="echo-rings"><span/><span/><span/><span/><span/></div><div className="visual-label"><span>HALL SIZE</span><strong>{settings.room}%</strong></div><div className="mini-wave"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div></div>
      <Slider label="Reverb mix" value={settings.wet} min={0} max={100} suffix="%" hint="Dry" rightHint="Soaked" onChange={(v) => updateSetting('wet', v)}/>
      <Slider label="Decay time" value={settings.decay} min={1} max={8} step={0.1} suffix=" s" hint="Short tail" rightHint="Long tail" onChange={(v) => updateSetting('decay', v)}/>
      <Slider label="Hall size" value={settings.room} min={20} max={100} suffix="%" hint="Compact" rightHint="Grand" onChange={(v) => updateSetting('room', v)}/>
      <Slider label="Pre-delay" value={settings.preDelay} min={0} max={100} suffix=" ms" hint="Close" rightHint="Distant" onChange={(v) => updateSetting('preDelay', v)}/>
      <button className="reset-button" onClick={() => setSettings(defaults)} disabled={busy}>↺ Reset settings</button>
      <p className="hint-box"><span>✦</span> Tip: Try 35–50% mix and a 4–6 second decay for a spacious, cinematic tail.</p>
    </section>

    <section className="panel export-panel">
      <div className="section-heading"><span className="step">03</span><div><h2>Export video</h2><p>Keep the original video stream</p></div></div>
      <div className="export-facts"><div><span className="fact-icon">◇</span><span><strong>Video unchanged</strong><small>No video re-encoding</small></span></div><div><span className="fact-icon">⌁</span><span><strong>New audio track</strong><small>AAC · 192 kbps</small></span></div></div>
      <div className="status-row"><span className={`status-dot ${busy ? 'working' : ''}`}/><span>{status}</span>{busy && <span className="percent">{progress}%</span>}</div>
      {busy && <div className="progress-track"><div style={{ width: `${progress}%` }}/></div>}
      <button className="primary-button" onClick={exportVideo} disabled={!file || busy}>{busy ? <><span className="spinner"/> Processing on this device…</> : <><span>✦</span> Create reverb video <span className="button-arrow">↗</span></>}</button>
      {outputUrl && <div className="download-card"><div className="download-check">✓</div><div className="download-copy"><strong>Your video is ready</strong><span>{outputName}</span></div><a className="download-button" href={outputUrl} download={outputName}>Download</a><button className="share-button" onClick={async () => { const blob = await fetch(outputUrl).then(r => r.blob()); const resultFile = new File([blob], outputName, { type: 'video/mp4' }); if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [resultFile] }))) { try { await navigator.share({ files: [resultFile], title: outputName }); } catch { /* User cancelled share sheet. */ } } else { setError('Use Download, then open the file in Files and use Share → Save Video if available.'); } }}>Share / Save</button></div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      <p className="privacy-note"><span>♧</span> Your video is processed locally. The export engine downloads once from a public CDN; your media is never sent to our server.</p>
      <p className="compat-note">Best with recent iOS Safari and shorter clips. Browser memory limits can affect large videos. Exported audio includes the reverb tail, but this prototype does not preserve subtitles or extra audio tracks.</p>
    </section>
    <footer><div className="footer-mark">H</div><span>MADE FOR THE SPACE BETWEEN NOTES.</span><button onClick={() => { setFile(null); setPreviewUrl(''); setOutputUrl(''); setOutputName(''); setSettings(defaults); setError(''); setStatus('Choose a video to begin'); }}>Clear session</button></footer>
    <div className="bottom-safe"/>
  </main>;
}

function Slider({ label, value, min, max, step = 1, suffix, hint, rightHint, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix: string; hint: string; rightHint: string; onChange: (value: number) => void }) {
  const percent = ((value - min) / (max - min)) * 100;
  return <div className="slider-block"><div className="slider-top"><label>{label}</label><strong>{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</strong></div><input aria-label={label} type="range" min={min} max={max} step={step} value={value} style={{ '--range-progress': `${percent}%` } as React.CSSProperties} onChange={(event) => onChange(Number(event.target.value))}/><div className="slider-hints"><span>{hint}</span><span>{rightHint}</span></div></div>;
}
