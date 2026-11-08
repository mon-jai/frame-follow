import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

/**
 * Encode a moving crop in the browser. `getCropAt` returns the upper-left
 * corner in source pixels at a given time in seconds, as { x, y }.
 * Dimensions must be even for broadly compatible H.264/yuv420p output.
 */
export async function exportVideo({
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
      '-c:v', 'libx264', '-preset', 'placebo', '-crf', '18', '-pix_fmt', 'yuv420p',
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
