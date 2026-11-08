import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// The package and WASM runtime are deliberately pinned to the same release.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const aborted = () => new DOMException('Analysis cancelled', 'AbortError');

function seek(video, time, signal) {
  if (signal?.aborted) return Promise.reject(aborted());
  if (Math.abs(video.currentTime - time) < 0.0001 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', cancel);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Could not read a frame from this video.')); };
    const cancel = () => { cleanup(); reject(aborted()); };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('Timed out while seeking through this video.')); }, 15000);
    video.currentTime = time;
  });
}

function midpoint(a, b) {
  if (!a || !b || (a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centers(landmarks) {
  if (!landmarks) return { trunk: null, mass: null };
  const shoulders = midpoint(landmarks[11], landmarks[12]);
  const hips = midpoint(landmarks[23], landmarks[24]);
  const trunk = shoulders && hips ? midpoint(shoulders, hips) : (hips || shoulders);
  // Approximate anatomical center of mass using visible segment midpoints.
  // Missing limbs are omitted and the remaining segment weights renormalized.
  const segments = [
    [midpoint(shoulders, hips), 0.50],
    [landmarks[0]?.visibility >= 0.35 ? landmarks[0] : null, 0.08],
    [midpoint(landmarks[11], landmarks[13]), 0.028], [midpoint(landmarks[12], landmarks[14]), 0.028],
    [midpoint(landmarks[13], landmarks[15]), 0.016], [midpoint(landmarks[14], landmarks[16]), 0.016],
    [midpoint(landmarks[23], landmarks[25]), 0.10], [midpoint(landmarks[24], landmarks[26]), 0.10],
    [midpoint(landmarks[25], landmarks[27]), 0.046], [midpoint(landmarks[26], landmarks[28]), 0.046],
  ];
  let x = 0, y = 0, weight = 0;
  for (const [point, w] of segments) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      x += point.x * w; y += point.y * w; weight += w;
    }
  }
  return { trunk, mass: weight > 0 ? { x: x / weight, y: y / weight } : trunk };
}

// Image mode supports arbitrary selection frames and tracking in both directions.
let landmarkerPromise;
async function getLandmarker() {
  if (!landmarkerPromise) landmarkerPromise = (async () => {
    const files = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = { runningMode: 'IMAGE', numPoses: 8,
      minPoseDetectionConfidence: 0.35, minPosePresenceConfidence: 0.35 };
    try {
      return await PoseLandmarker.createFromOptions(files, {
        ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      });
    } catch {
      return PoseLandmarker.createFromOptions(files, {
        ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      });
    }
  })().catch(error => { landmarkerPromise = undefined; throw error; });
  return landmarkerPromise;
}

function candidate(landmarks) {
  const points = landmarks.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 1) >= 0.35);
  if (!points.length) return null;
  const minX = clamp(Math.min(...points.map(p => p.x)) - 0.025, 0, 1);
  const maxX = clamp(Math.max(...points.map(p => p.x)) + 0.025, 0, 1);
  const minY = clamp(Math.min(...points.map(p => p.y)) - 0.025, 0, 1);
  const maxY = clamp(Math.max(...points.map(p => p.y)) + 0.025, 0, 1);
  const { trunk, mass } = centers(landmarks);
  const center = trunk || mass || { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return { center, box: { x: minX, y: minY, width: maxX-minX, height: maxY-minY }, trunk, mass };
}

/** Detect selectable people in the video element's current decoded frame. */
export async function detectPeople(video) {
  if (video.readyState < 2) throw new Error('Wait for the selected frame to load.');
  const landmarker = await getLandmarker();
  return (landmarker.detect(video).landmarks || []).map(candidate).filter(Boolean);
}

/** Analyze an independently loaded video element; never uploads the video. */
export async function analyzeVideo(video, { onProgress = () => {}, signal, sampleRate = 10, selection } = {}) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video does not have a readable duration.');
  if (!selection?.center || !Number.isFinite(selection.time)) throw new Error('Select a person to track first.');
  if (signal?.aborted) throw aborted();
  onProgress(0, 'Loading pose model');
  const landmarker = await getLandmarker();
  const rate = clamp(sampleRate, 1, 30);
  const total = Math.max(1, Math.ceil(video.duration * rate));
  const times = Array.from({length: total}, (_, i) => Math.min(i / rate, Math.max(0, video.duration - 0.001)));
  const selectedTime = clamp(selection.time, 0, Math.max(0, video.duration - 0.001));
  // Include the selected frame exactly so that either traversal starts there.
  if (!times.some(t => Math.abs(t - selectedTime) < 0.00001)) times.push(selectedTime);
  times.sort((a,b) => a-b);
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    if (signal?.aborted) throw aborted();
    await seek(video, times[i], signal);
    const poses = (landmarker.detect(video).landmarks || []).map(candidate).filter(Boolean);
    frames.push({ time: times[i], poses });
    onProgress((i + 1) / times.length, 'Tracking movement');
    if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const anchor = times.findIndex(t => Math.abs(t - selectedTime) < 0.00001);
  const samples = frames.map(({time}) => ({time, trunk: null, mass: null}));
  const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const match = (poses, reference) => {
    let closest = null, best = Infinity;
    for (const pose of poses) {
      const d = distance(pose.center, reference.center);
      if (d < best) { best = d; closest = pose; }
    }
    const b = reference.box || {width: 0, height: 0};
    return best <= Math.max(0.12, Math.min(0.35, Math.hypot(b.width, b.height) * 0.7)) ? closest : null;
  };
  const first = match(frames[anchor].poses, selection);
  if (!first) throw new Error('Could not find the selected person in that frame. Try selecting them again.');
  const setSample = (i, pose) => { samples[i].trunk = pose.trunk; samples[i].mass = pose.mass; };
  setSample(anchor, first);
  for (const direction of [-1, 1]) {
    let previous = first;
    for (let i = anchor + direction; i >= 0 && i < frames.length; i += direction) {
      const pose = match(frames[i].poses, previous);
      if (pose) { setSample(i, pose); previous = pose; }
    }
  }
  return { samples, detected: samples.filter(s => s.trunk).length, total: samples.length };
}

/** Fill gaps by linear interpolation, then apply a symmetric Gaussian camera filter. */
export function buildCropPath(samples, mode = 'trunk', smoothness = 0.5) {
  if (!samples.length) return [];
  const key = mode === 'mass' ? 'mass' : 'trunk';
  const valid = samples.map((sample, index) => sample[key] ? index : -1).filter(index => index >= 0);
  if (!valid.length) return samples.map(({ time }) => ({ time, x: 0.5, y: 0.5 }));
  let next = 0;
  const points = samples.map((sample, index) => {
    while (next < valid.length - 1 && valid[next] < index) next++;
    const right = valid[next];
    const left = right > index && next > 0 ? valid[next - 1] : right;
    const a = samples[left][key], b = samples[right][key];
    const span = samples[right].time - samples[left].time;
    const t = span > 0 ? clamp((sample.time - samples[left].time) / span, 0, 1) : 0;
    return { time: sample.time, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
  const sigma = Math.max(0, Number(smoothness) || 0);
  if (sigma < 0.001) return points;
  let start = 0, end = 0;
  return points.map(point => {
    while (start < points.length - 1 && points[start].time < point.time - sigma * 3) start++;
    while (end < points.length && points[end].time <= point.time + sigma * 3) end++;
    let x = 0, y = 0, weight = 0;
    for (let i = start; i < end; i++) {
      const d = (points[i].time - point.time) / sigma;
      const w = Math.exp(-0.5 * d * d);
      x += points[i].x * w; y += points[i].y * w; weight += w;
    }
    return { time: point.time, x: x / weight, y: y / weight };
  });
}

export function cropAtTime(path, time) {
  if (!path.length) return { x: 0.5, y: 0.5 };
  let low = 0, high = path.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (path[mid].time < time) low = mid + 1; else high = mid;
  }
  const b = path[low], a = path[Math.max(0, low - 1)];
  const t = b.time === a.time ? 0 : clamp((time - a.time) / (b.time - a.time), 0, 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
