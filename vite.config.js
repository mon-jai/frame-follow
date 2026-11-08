import { defineConfig } from 'vite';

// A classic script and data-URL fonts also work from a file:// preview, where
// browsers reject module scripts and local font fetches for an opaque origin.
function filePreview() {
  return {
    name: 'file-preview',
    enforce: 'pre',
    transform(code, id) {
      if (id.replaceAll('\\', '/').includes('/@ffmpeg/ffmpeg/dist/esm/classes.js')) {
        const original = 'new Worker(new URL("./worker.js", import.meta.url), {\n                    type: "module",\n                })';
        if (!code.includes(original)) throw new Error('FFmpeg worker implementation changed; update file-preview plugin.');
        return `import InlineFFmpegWorker from '@ffmpeg/ffmpeg/worker?worker&inline';\n${code.replace(original, 'new InlineFFmpegWorker()')}`;
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) { return html.replace(/<script type="module" crossorigin /, '<script defer '); },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [filePreview()],
  build: { outDir: 'docs', emptyOutDir: true, assetsInlineLimit: 100000,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } } },
  worker: { format: 'es' },
});
