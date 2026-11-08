import '@fontsource-variable/inter';
import './style.css';
import { analyzeVideo, buildCropPath, cropAtTime, detectPeople, preloadPoseModel } from './tracking.js';
import { exportVideo, probeExportOptions } from './exportVideo.js';
import { cropDimensions } from './cropDimensions.js';

const $ = s => document.querySelector(s);
$('#app').innerHTML = `
<header class="topbar"><a class="brand" href="."><span class="brand-icon">✳</span><span>frame<span class="brand-slash">/</span>follow</span></a></header>
<main><section class="intro"><div><h1>Keep the movement<br><em>in frame.</em></h1><p>Turn a wide choreography video into a closer look. Follow the dancer, fine-tune the camera, and take your edit with you.</p></div><div class="intro-mark" aria-hidden="true">↗</div></section>
<section class="workspace"><div class="stage-column"><div class="section-head"><div><span class="section-num">01</span><h2>Your canvas</h2></div><span class="subtle">LIVE PREVIEW <span class="live-dot"></span></span></div><div class="stage" id="drop"><div class="stage-grid"></div><div class="empty" id="empty"><div class="upload-icon">↥</div><h3>Every move starts here.</h3><p>Drop your choreography video here<br>or choose a file to get started.</p><button class="upload-btn" id="choose">Choose a video <span>↗</span></button><small>VIDEO FILES · PROCESSED ON YOUR DEVICE</small></div><div class="preview" hidden><canvas id="canvas"></canvas><div class="preview-tag" id="previewTag"><span class="live-dot"></span> LIVE CROP</div><div class="people-layer" id="peopleLayer"></div></div><input id="file" type="file" accept="video/*" hidden></div><div class="transport"><button id="play" aria-label="Play" disabled>▶</button><span id="current">00:00</span><input type="range" id="seek" min="0" max="1" step="0.001" value="0" aria-label="Seek video" disabled><span id="duration">00:00</span><button id="replace" disabled>Replace video ↗</button></div><div class="stage-foot"><span id="dimensions">NO VIDEO SELECTED</span></div></div>
<aside class="controls"><div class="section-head"><div><span class="section-num">02</span><h2>Camera settings</h2></div><span class="subtle">MAKE IT YOURS</span></div><div class="control-body"><div class="select-person"><span class="control-index">SUBJECT / TRACKING</span><h3>Choose your dancer</h3><p class="hint">Scrub to a clear frame, then select a person to follow.</p><button id="selectPerson" disabled>Select a person <span>↗</span></button><div class="selected-person" id="selectedPersonPreview" hidden><canvas id="personThumbnail" width="96" height="96" aria-label="Selected dancer preview"></canvas><div><strong>Selected dancer</strong><p class="hint">Tracking this person</p></div></div></div><div class="divider"></div><div class="ratio-controls"><span class="control-index">OUTPUT / SHAPE</span><h3>Aspect ratio</h3><label for="aspectRatio" class="hint">Choose the shape of your video.</label><select id="aspectRatio"><option value="9:16" selected>9:16 · Vertical</option><option value="16:9">16:9 · Widescreen</option><option value="1:1">1:1 · Square</option><option value="4:5">4:5 · Portrait</option><option value="4:3">4:3 · Standard</option><option value="custom">Custom</option></select><div id="customRatio" class="custom-ratio" hidden><label>Width<input id="ratioWidth" type="number" min="1" max="1000" step="1" value="9"></label><span>:</span><label>Height<input id="ratioHeight" type="number" min="1" max="1000" step="1" value="16"></label></div><p id="ratioError" class="hint" role="status" hidden>Enter a valid ratio that fits the source video.</p></div><div class="divider"></div><div class="control-title"><div><span class="control-index">01 / FRAMING</span><h3>Zoom level</h3></div><output id="zoomValue">1.5×</output></div><p class="hint">Get closer to the details, or leave room to move.</p><input type="range" id="zoom" min="1" max="3" step="0.05" value="1.5"><div class="range-labels"><span>WIDER</span><span>CLOSER</span></div><div class="divider"></div><div class="control-title"><div><span class="control-index">02 / SUBJECT</span><h3>Follow point</h3></div></div><p class="hint">Choose the part of the body the camera follows.</p><div class="segments"><button data-mode="trunk" class="active">Trunk</button><button data-mode="mass">Center of mass</button></div><div class="divider"></div><div class="control-title"><div><span class="control-index">03 / MOTION</span><h3>Camera smoothness</h3></div><output id="smoothValue">0.5s</output></div><p class="hint">Soften the camera’s movement between steps.</p><input type="range" id="smooth" min="0" max="2" step="0.1" value="0.5"><div class="range-labels"><span>RESPONSIVE</span><span>SMOOTHER</span></div><div class="info"><span>✳</span><p>Choose a clear frame where your dancer is visible. Center of mass is an estimate.</p></div></div><div class="export-area"><div class="encoder-controls"><span class="control-index">EXPORT / ENCODER</span><h3>Encoding quality</h3><div class="segments"><button type="button" data-encoder="webcodecs" disabled>WebCodecs</button><button type="button" data-encoder="x264" disabled>x264 · CRF 18</button></div><p id="encoderTip" class="hint">Checking available encoders…</p></div><div class="export-meta"><span>OUTPUT</span><span id="outputSize">—</span></div><button id="export" disabled>Export video <span>↗</span></button><div id="progressPanel"><p id="status" role="status">Add a video to get started.</p><progress id="progress" aria-label="Processing progress" max="1" value="0" hidden></progress></div></div></aside></section><footer><span>© 2026 <a href="https://github.com/mon-jai">陸嘉康</a></span><a href="https://github.com/mon-jai/frame-follow">GitHub ↗</a></footer></main><video id="video" playsinline hidden></video><video id="analysisVideo" muted playsinline preload="auto" hidden></video>`;
const video = $('#video'), analysisVideo = $('#analysisVideo'), canvas = $('#canvas'), ctx = canvas.getContext('2d');
let file, url, samples = [], path = [], mode = 'trunk', busy = false, controller, downloadUrl, selecting = false, dragging = false, people = [];
let encoder = 'webcodecs', encoderOptions = null, probeGeneration = 0, probeTimer; 
const format = n => { n = Number.isFinite(n) ? Math.floor(n) : 0; return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`; };
function dimensions() { const ratio=$('#aspectRatio').value; const [rw,rh]=ratio === 'custom' ? [Number($('#ratioWidth').value),Number($('#ratioHeight').value)] : ratio.split(':').map(Number); return cropDimensions(video.videoWidth,video.videoHeight,rw,rh,+$('#zoom').value); }
function getCropAt(t) { const {w,h} = dimensions(); const c = cropAtTime(path,t); return {x: Math.max(0, Math.min(video.videoWidth-w, c.x*video.videoWidth-w/2)), y: Math.max(0, Math.min(video.videoHeight-h, c.y*video.videoHeight-h/2))}; }
function draw() { if (!video.videoWidth || video.readyState < 2) return; const size = selecting ? {w:video.videoWidth,h:video.videoHeight} : dimensions(); if (!size) return; const {w,h} = size; if(canvas.width !== w || canvas.height !== h) { canvas.width=w; canvas.height=h; } if(selecting) ctx.drawImage(video,0,0,w,h); else { const p=getCropAt(video.currentTime); ctx.drawImage(video,p.x,p.y,w,h,0,0,w,h); } $('#current').textContent=format(video.currentTime); if(!dragging) $('#seek').value=video.currentTime; if(selecting) renderPeople(); }
function renderPeople() { const layer=$('#peopleLayer'); layer.replaceChildren(); const r=canvas.getBoundingClientRect(), parent=layer.getBoundingClientRect(); people.forEach((person,i)=>{const b=document.createElement('button'); b.className='person-box'; b.setAttribute('aria-label',`Track person ${i+1}`); b.textContent=`TRACK ${i+1}`; Object.assign(b.style,{left:`${r.left-parent.left+person.box.x*r.width}px`,top:`${r.top-parent.top+person.box.y*r.height}px`,width:`${person.box.width*r.width}px`,height:`${person.box.height*r.height}px`}); b.onclick=()=>trackPerson(person); layer.append(b);}); }
function clearSelection() { selecting=false; people=[]; $('#peopleLayer').replaceChildren(); $('#previewTag').innerHTML='<span class="live-dot"></span> LIVE CROP'; }
function showSelectedPerson(person) { const box=person.box, thumb=$('#personThumbnail'), context=thumb.getContext('2d'); const sx=Math.max(0,box.x*video.videoWidth), sy=Math.max(0,box.y*video.videoHeight); const sw=Math.min(video.videoWidth-sx,box.width*video.videoWidth), sh=Math.min(video.videoHeight-sy,box.height*video.videoHeight); context.fillStyle='#eaf0e9'; context.fillRect(0,0,thumb.width,thumb.height); if(sw>0 && sh>0) { const scale=Math.min(thumb.width/sw,thumb.height/sh), w=sw*scale,h=sh*scale; context.drawImage(video,sx,sy,sw,sh,(thumb.width-w)/2,(thumb.height-h)/2,w,h); } $('#selectedPersonPreview').hidden=false; }
async function trackPerson(person) { const selection={...person,time:video.currentTime}; showSelectedPerson(person); samples=[]; path=[{time:video.currentTime,x:person.center.x,y:person.center.y}]; clearSelection(); draw(); setBusy(true); $('#progressPanel').classList.add('tracking'); status('Preparing tracking…',0); try { controller=new AbortController(); const result=await analyzeVideo(analysisVideo,{selection,signal:controller.signal,onProgress:(p,label)=>status(`${label}… ${Math.round(p*100)}%`,p)}); samples=result.samples; refresh(); status(result.detected ? `Tracking ready · dancer found in ${Math.round(result.detected/result.total*100)}% of sampled frames.` : 'No dancer detected. Choose another frame.'); } catch(e) {status(e.message || 'Could not analyze this video.');} finally {$('#progressPanel').classList.remove('tracking'); setBusy(false); draw();} }
async function choosePerson() { if(busy) return; video.pause(); clearSelection(); setBusy(true); status('Finding people in this frame…',0); try { people=await detectPeople(video); if (!people.length) {status('No people found in this frame. Scrub to another frame and try again.'); return;} selecting=true; $('#previewTag').textContent='SELECT A PERSON'; status('Select a highlighted person in the video.'); draw(); } catch(e) {status(e.message || 'Could not detect people.');} finally {setBusy(false);} }

function refresh() { if(samples.length) path=buildCropPath(samples, mode, +$('#smooth').value); $('#zoomValue').textContent=`${(+$('#zoom').value).toFixed(2).replace(/0$/, '')}×`; $('#smoothValue').textContent=`${(+$('#smooth').value).toFixed(1)}s`; if(video.videoWidth) { const size=dimensions(); $('#ratioError').hidden=!!size; $('#outputSize').textContent=size ? `${size.w} × ${size.h} PX` : '—'; if(size) draw(); } }
function status(message, progress) { $('#status').textContent=message; $('#progress').hidden=progress == null; if(progress != null) $('#progress').value=progress; }
status('Loading pose model…');
preloadPoseModel().then(() => { if (!file) status('Add a video to get started.'); }).catch(() => { if (!file) status('Could not load the pose model. It will retry when you select a person.'); });
function setBusy(value) { busy=value; $('#export').disabled=value || !samples.length || !encoderOptions?.[encoder]?.available || !dimensions(); $('#replace').disabled=value || !file; $('#file').disabled=value; $('#selectPerson').disabled=value || !file; $('#seek').disabled=value || !file; $('#play').disabled=value || !file; document.querySelectorAll('[data-encoder]').forEach(b=>{b.disabled=value || !encoderOptions?.[b.dataset.encoder]?.available;}); }
function setEncoding(value) {
  $('#zoom').disabled = value;
  $('#smooth').disabled = value;
  $('#aspectRatio').disabled=value; $('#ratioWidth').disabled=value; $('#ratioHeight').disabled=value;
  document.querySelectorAll('[data-encoder]').forEach(button => { button.disabled=value || !encoderOptions?.[button.dataset.encoder]?.available; });
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = value; });
}
async function load(f) { if (!f || busy) return; if (url) URL.revokeObjectURL(url); if(downloadUrl) URL.revokeObjectURL(downloadUrl); clearSelection(); $('#selectedPersonPreview').hidden=true; file=f; samples=[]; path=[]; encoderOptions=null; ++probeGeneration; url=URL.createObjectURL(f); video.preload='auto'; analysisVideo.preload='auto'; video.src=url; analysisVideo.src=url; setBusy(true); $('#empty').hidden=true; $('.preview').hidden=false; status('Opening video…',0); try { await Promise.all([video,analysisVideo].map(v=>new Promise((resolve,reject)=>{ v.onloadeddata=resolve; v.onerror=()=>reject(new Error('This video could not be opened by your browser.')); v.load(); }))); if(video.videoWidth < 2 || video.videoHeight < 2 || !Number.isFinite(video.duration)) throw new Error('This video has invalid dimensions or duration.'); $('#play').disabled=false; $('#seek').disabled=false; $('#seek').max=video.duration; $('#duration').textContent=format(video.duration); $('#dimensions').textContent=`${video.videoWidth} × ${video.videoHeight} PX · ${format(video.duration)}`; refresh(); draw(); scheduleEncoderProbe(); status('Scrub to a clear frame, then select a person.'); } catch(e) { status(e.message || 'Could not open this video.'); } finally { setBusy(false); } }
$('#selectPerson').onclick=choosePerson;

$('#choose').onclick=()=>$('#file').click(); $('#replace').onclick=()=>$('#file').click(); $('#file').onchange=e=>{load(e.target.files[0]); e.target.value='';};
for(const type of ['dragenter','dragover']) $('#drop').addEventListener(type,e=>{e.preventDefault(); $('#drop').classList.add('dragging');}); for(const type of ['dragleave','drop']) $('#drop').addEventListener(type,e=>{e.preventDefault(); $('#drop').classList.remove('dragging');}); $('#drop').addEventListener('drop',e=>load(e.dataTransfer.files[0]));
function scheduleEncoderProbe() {
  const generation=++probeGeneration; clearTimeout(probeTimer); encoderOptions=null; setBusy(busy);
  const size=dimensions(); if(!file || !size) { $('#encoderTip').textContent='Choose a valid crop to check encoders.'; document.querySelectorAll('[data-encoder]').forEach(b=>b.classList.remove('active')); return; }
  $('#encoderTip').textContent='Checking available encoders…';
  document.querySelectorAll('[data-encoder]').forEach(b=>{b.disabled=true;});
  const probeFile=file; probeTimer=setTimeout(async()=>{
    let result; try { result=await probeExportOptions({file:probeFile,width:video.videoWidth,height:video.videoHeight,cropWidth:size.w,cropHeight:size.h}); }
    catch(e) { result={webcodecs:{available:false,reason:e.message},x264:{available:false,reason:e.message}}; }
    if(generation!==probeGeneration) return; encoderOptions=result;
    if(!result[encoder]?.available) encoder=result.webcodecs?.available?'webcodecs':'x264';
    renderEncoderOptions(); setBusy(busy);
  },200);
}
function renderEncoderOptions() { document.querySelectorAll('[data-encoder]').forEach(b=>{const option=encoderOptions?.[b.dataset.encoder]; b.disabled=busy || !option?.available; b.classList.toggle('active',b.dataset.encoder===encoder && !!option?.available); b.setAttribute('aria-pressed', String(b.dataset.encoder===encoder && !!option?.available)); b.title=option?.reason || '';});
  const web=encoderOptions?.webcodecs?.available, x=encoderOptions?.x264?.available;
  $('#encoderTip').textContent=web && x ? 'For consistent high quality, choose x264 CRF 18. WebCodecs is typically faster; quality depends on your browser.' : web ? 'WebCodecs is available and requests the highest standard browser quality.' : x ? 'x264 CRF 18 is available for consistent high quality.' : 'No supported encoder is available for this video.';
}
document.querySelectorAll('[data-encoder]').forEach(b=>b.onclick=()=>{encoder=b.dataset.encoder;renderEncoderOptions();setBusy(busy);});
$('#aspectRatio').onchange=()=>{$('#customRatio').hidden=$('#aspectRatio').value!=='custom';refresh();scheduleEncoderProbe();};
for(const el of [$('#ratioWidth'),$('#ratioHeight')]) el.oninput=()=>{refresh();scheduleEncoderProbe();};
$('#zoom').oninput=()=>{refresh(); scheduleEncoderProbe();}; $('#smooth').oninput=refresh; document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode; document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b)); refresh();});
$('#play').onclick=()=>{ if(selecting) clearSelection(); video.paused?video.play():video.pause(); }; video.onplay=()=>{$('#play').textContent='Ⅱ';}; video.onpause=()=>{$('#play').textContent='▶'; draw();}; video.ontimeupdate=draw; video.onseeked=draw; video.onloadeddata=draw; $('#seek').addEventListener('pointerdown',()=>{dragging=true; video.pause(); if(selecting) {clearSelection(); status('Scrub to a clear frame, then select a person.');}}); window.addEventListener('pointerup',()=>{dragging=false;}); $('#seek').oninput=e=>{ if(selecting) {clearSelection(); status('Scrub to a clear frame, then select a person.');} video.currentTime=+e.target.value; }; window.addEventListener('resize',()=>{if(selecting) renderPeople();}); function tick(){if(!video.paused && video.readyState>=2) draw(); requestAnimationFrame(tick);} tick();

$('#export').onclick=async()=>{
  if(!file||busy)return;
  video.pause();
  if(selecting) { clearSelection(); draw(); }
  const exportFile = file;
  const width = video.videoWidth, height = video.videoHeight, duration = video.duration;
  const size = dimensions(); if(!size || !encoderOptions?.[encoder]?.available) return;
  const {w,h} = size;
  const exportEncoder = encoder;
  const exportPath = path.map(point => ({...point}));
  const exportCropAt = time => {
    const center = cropAtTime(exportPath, time);
    return { x: Math.max(0, Math.min(width-w, center.x*width-w/2)),
      y: Math.max(0, Math.min(height-h, center.y*height-h/2)) };
  };
  setBusy(true);
  setEncoding(true);
  controller=new AbortController();
  try {
    status('Preparing encoder…',0);
    const blob=await exportVideo({file:exportFile,width,height,cropWidth:w,cropHeight:h,duration,getCropAt:exportCropAt,encoder:exportEncoder,onProgress:p=>status(`Encoding video… ${Math.round(p*100)}%`,p),signal:controller.signal});
    if(downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=downloadUrl;
    a.download=`${exportFile.name.replace(/\.[^.]+$/, '')}-follow.mp4`;
    a.click();
    status('Your video is ready. Download started.');
  } catch(e){status(e.message || 'Export failed.');}
  finally{setEncoding(false); setBusy(false);}
};
