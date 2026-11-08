import { FFmpeg } from '@ffmpeg/ffmpeg';
import { Input, Output, BlobSource, BufferSource, BufferTarget, EncodedPacketSink, Mp4OutputFormat, ALL_FORMATS, Conversion, Quality } from 'mediabunny';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

/**
 * Encode a moving crop in the browser. `getCropAt` returns the upper-left
 * corner in source pixels at a given time in seconds, as { x, y }.
 * Dimensions must be even for broadly compatible H.264/yuv420p output.
 */
async function exportWithFFmpeg({
  file, width, height, cropWidth, cropHeight, duration, getCropAt,
  onProgress = () => {}, signal,
}) {
  if (!file || !Number.isFinite(duration) || duration <= 0 ||
      !Number.isInteger(cropWidth) || !Number.isInteger(cropHeight) ||
      cropWidth < 2 || cropHeight < 2 || cropWidth % 2 || cropHeight % 2 ||
      cropWidth > width || cropHeight > height) {
    throw new Error('Invalid video or crop dimensions.');
  }
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');

  const ffmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal?.addEventListener('abort', abort, { once: true });
  ffmpeg.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));

  const temporaryUrls = [];
  try {
    onProgress(0);
    // Browsers block file:// fetches from opaque origins. In a direct local
    // preview, load the same pinned core over CORS and pass blob URLs to the
    // worker. Served deployments use their locally bundled assets.
    let core = coreURL, wasm = wasmURL;
    if (location.protocol === 'file:') {
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/';
      const asBlobUrl = async (name, type) => {
        const response = await fetch(base + name);
        if (!response.ok) throw new Error('Could not download the video encoder. Check your connection.');
        const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
        temporaryUrls.push(url);
        return url;
      };
      core = await asBlobUrl('ffmpeg-core.js', 'text/javascript');
      wasm = await asBlobUrl('ffmpeg-core.wasm', 'application/wasm');
    }
    await ffmpeg.load({ coreURL: core, wasmURL: wasm });
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    await ffmpeg.writeFile('input.bin', new Uint8Array(await file.arrayBuffer()));

    // Send crop commands at 60 Hz. The source frames themselves are decoded
    // and encoded once; neither the crop nor the output is rescaled.
    const commands = [];
    const count = Math.ceil(duration * 60);
    for (let i = 0; i <= count; i++) {
      const t = i / 60;
      const point = getCropAt(t);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error('Tracking data is incomplete.');
      }
      const x = Math.round(Math.max(0, Math.min(width - cropWidth, point.x)));
      const y = Math.round(Math.max(0, Math.min(height - cropHeight, point.y)));
      commands.push(`${t.toFixed(6)} crop@follow x ${x}, crop@follow y ${y};`);
    }
    await ffmpeg.writeFile('movement.txt', new TextEncoder().encode(commands.join('\n')));
    const result = await ffmpeg.exec([
      '-i', 'input.bin', '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `sendcmd=f=movement.txt,crop@follow=${cropWidth}:${cropHeight}:0:0:exact=1`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'output.mp4',
    ]);
    if (result !== 0) throw new Error('Video encoding failed. The source format may not be supported.');
    const data = await ffmpeg.readFile('output.mp4');
    onProgress(1);
    return new Blob([data], { type: 'video/mp4' });
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    ffmpeg.terminate();
    temporaryUrls.forEach(url => URL.revokeObjectURL(url));
  }
}

// Prepare the same conversion for both capability checks and actual exports.
async function prepareNative({ file, width, height, cropWidth, cropHeight, getCropAt }) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs is unavailable.');
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) throw new Error('No supported video track.');
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth; canvas.height = cropHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable.');
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: {
        codec: 'avc', quality: new Quality('very-high'), forceTranscode: true,
        allowTransformationMetadata: false,
        processedWidth: cropWidth, processedHeight: cropHeight,
        process: sample => {
          const point = getCropAt?.(sample.timestamp);
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            throw new Error('Tracking data is incomplete.');
          }
          const x = Math.round(Math.max(0, Math.min(width - cropWidth, point.x)));
          const y = Math.round(Math.max(0, Math.min(height - cropHeight, point.y)));
          sample.draw(context, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
          return canvas;
        },
      },
    });
    // A conversion can be valid even after silently discarding audio.
    if (!conversion.isValid || !conversion.utilizedTracks.includes(videoTrack) ||
        (audioTrack && !conversion.utilizedTracks.includes(audioTrack))) {
      throw new Error('Browser cannot encode the required video or audio track.');
    }
    return { input, conversion, target, hasAudio: !!audioTrack };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

// Decode and encode with WebCodecs, keeping each input timestamp and copying
// audio when the container permits it. No playback or real-time capture is used.
async function exportNative(options) {
  const { onProgress = () => {}, signal } = options;
  let prepared;
  let conversion;
  const cancel = () => { if (conversion) void conversion.cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    prepared = await prepareNative(options);
    ({ conversion } = prepared);
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    conversion.onProgress = progress => onProgress(Math.max(0, Math.min(1, progress)));
    await conversion.execute();
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    if (!prepared.target.buffer) throw new Error('Browser encoder did not produce a video.');
    // A successful conversion can still yield a valid MP4 container with no
    // media packets. Check the actual output before offering a download.
    const resultInput = new Input({ source: new BufferSource(prepared.target.buffer), formats: ALL_FORMATS });
    try {
      const video = await resultInput.getPrimaryVideoTrack();
      if (!video || !(await new EncodedPacketSink(video).getFirstPacket())) {
        throw new Error('The browser encoder produced no video frames. Try the x264 encoder.');
      }
      if (prepared.hasAudio) {
        const audio = await resultInput.getPrimaryAudioTrack();
        if (!audio || !(await new EncodedPacketSink(audio).getFirstPacket())) {
          throw new Error('The browser encoder produced no audio. Try the x264 encoder.');
        }
      }
    } finally {
      resultInput.dispose();
    }
    onProgress(1);
    return new Blob([prepared.target.buffer], { type: 'video/mp4' });
  } finally {
    signal?.removeEventListener('abort', cancel);
    prepared?.input.dispose();
  }
}

/** Check support for the selected source and crop without encoding the video. */
export async function probeExportOptions(options = {}) {
  const x264Available = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' &&
    typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function';
  const webcodecsAvailable = typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
  const result = {
    webcodecs: { available: webcodecsAvailable, reason: webcodecsAvailable ? '' : 'WebCodecs is not available in this browser.' },
    x264: { available: x264Available, reason: x264Available ? '' : 'WebAssembly or workers are not available in this browser.' },
  };
  if (webcodecsAvailable && options.file && options.cropWidth >= 2 && options.cropHeight >= 2) {
    let prepared;
    try {
      prepared = await prepareNative(options);
    } catch (error) {
      result.webcodecs = { available: false, reason: error?.message || 'This video or crop is not supported by WebCodecs.' };
    } finally {
      prepared?.input.dispose();
    }
  }
  return result;
}

/** Encode using the explicitly selected profile. */
export async function exportVideo(options) {
  const { file, width, height, cropWidth, cropHeight, duration, signal, onProgress = () => {}, encoder = 'webcodecs' } = options;
  if (!file || !Number.isFinite(duration) || duration <= 0 ||
      !Number.isInteger(cropWidth) || !Number.isInteger(cropHeight) ||
      cropWidth < 2 || cropHeight < 2 || cropWidth % 2 || cropHeight % 2 ||
      cropWidth > width || cropHeight > height) {
    throw new Error('Invalid video or crop dimensions.');
  }
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  onProgress(0);
  if (encoder === 'webcodecs') return exportNative(options);
  if (encoder === 'x264') return exportWithFFmpeg(options);
  throw new Error('Unknown export profile.');
}
