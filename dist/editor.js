const byId = id => document.getElementById(id);
const video = byId('video');
const settings = byId('settings');
const start = byId('start');
const end = byId('end');
const source = byId('import');
const file = byId('file');
const choose = byId('choose');
const message = byId('message');
const result = byId('result');
let localUrl;
let gifUrl;
let previewEnd;
let busy = false;

function status(text) {
  message.textContent = text;
}

function loadVideo(url, local = false) {
  if (busy) return;
  video.pause();
  previewEnd = undefined;
  if (localUrl) URL.revokeObjectURL(localUrl);
  localUrl = local ? url : undefined;
  settings.disabled = true;
  result.hidden = true;
  video.hidden = true;
  byId('empty').hidden = false;
  video.crossOrigin = 'anonymous';
  video.src = url;
  status('Loading video…');
}

choose.onclick = () => file.click();
file.onchange = () => {
  if (!busy && file.files.length) loadVideo(URL.createObjectURL(file.files[0]), true);
  file.value = '';
};

source.onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const url = new URL(byId('link').value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    status('Enter an HTTPS or HTTP video link.');
    return;
  }
  if (/(^|\.)instagram\.com$/i.test(url.hostname)) {
    const code = url.pathname.match(/^\/reels?\/([A-Za-z0-9_-]{5,30})\/?$/)?.[1];
    if (!code) {
      status('Paste the full Instagram Reel link.');
      return;
    }
    busy = true;
    const previous = settings.disabled;
    settings.disabled = choose.disabled = true;
    for (const control of source.elements) control.disabled = true;
    status('Loading Reel…');
    try {
      const response = await fetch('/api/reel?code=' + encodeURIComponent(code));
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Could not load this Reel.');
      }
      const blob = await response.blob();
      busy = false;
      loadVideo(URL.createObjectURL(blob), true);
    } catch (error) {
      settings.disabled = previous;
      status(error.message);
    } finally {
      busy = choose.disabled = false;
      for (const control of source.elements) control.disabled = false;
    }
    return;
  }
  loadVideo(url.href);
};

video.addEventListener('loadeddata', () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) {
    status('Choose a video with a finite duration.');
    return;
  }
  video.hidden = false;
  byId('empty').hidden = true;
  settings.disabled = false;
  start.max = end.max = String(video.duration);
  start.value = '0';
  end.value = String(Math.min(5, video.duration));
  status('');
});
video.addEventListener('error', () => {
  status('The video could not be loaded. Try choosing a saved video file.');
});

function trim() {
  const from = start.valueAsNumber;
  const to = end.valueAsNumber;
  if (!(from >= 0 && to > from && to <= video.duration)) {
    throw new Error('Set an end time after the start and within the video.');
  }
  return { from, to };
}

video.addEventListener('timeupdate', () => {
  if (previewEnd !== undefined && video.currentTime >= previewEnd) {
    video.pause();
    previewEnd = undefined;
  }
});

byId('preview').onclick = async () => {
  try {
    const { from, to } = trim();
    video.pause();
    video.currentTime = from;
    video.playbackRate = Number(byId('speed').value);
    previewEnd = to;
    await video.play();
    status('');
  } catch (error) {
    status(error.message);
  }
};

function seek(time) {
  if (video.currentTime === time && !video.seeking) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Could not read a video frame.')); };
    const timeout = setTimeout(failed, 10000);
    video.addEventListener('seeked', done);
    video.addEventListener('error', failed);
    video.currentTime = time;
  });
}

byId('make').onclick = async () => {
  if (busy) return;
  busy = true;
  settings.disabled = choose.disabled = true;
  for (const control of source.elements) control.disabled = true;
  video.pause();
  video.controls = false;
  previewEnd = undefined;
  try {
    const { from, to } = trim();
    const fps = Number(byId('fps').value);
    const speed = Number(byId('speed').value);
    const count = Math.max(1, Math.ceil((to - from) * fps));
    if (count > 240) throw new Error('Select a shorter trim or lower FPS. GIFs are limited to 240 frames.');
    const canvas = document.createElement('canvas');
    const width = Math.min(Number(byId('width').value), video.videoWidth);
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    if (canvas.width * canvas.height * count * 4 > 180_000_000) {
      throw new Error('Use a smaller width, shorter trim, or lower FPS.');
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const encoder = new GIF({ workers: 2, workerScript: 'gif.worker.js', width, height: canvas.height });
    for (let frame = 0; frame < count; frame++) {
      const time = from + frame / fps;
      status('Reading frame ' + (frame + 1) + ' of ' + count + '…');
      await seek(time);
      context.drawImage(video, 0, 0, width, canvas.height);
      const delay = Math.max(20, Math.round(1000 * Math.min(1 / fps, to - time) / speed));
      encoder.addFrame(context, { copy: true, delay });
    }
    const blob = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        encoder.abort();
        reject(new Error('GIF encoding timed out.'));
      }, 120000);
      encoder.on('progress', progress => status('Making GIF… ' + Math.round(progress * 100) + '%'));
      encoder.on('finished', output => { clearTimeout(timeout); resolve(output); });
      try {
        encoder.render();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    if (gifUrl) URL.revokeObjectURL(gifUrl);
    gifUrl = URL.createObjectURL(blob);
    byId('gif').src = byId('download').href = gifUrl;
    result.hidden = false;
    status('GIF ready.');
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    video.controls = true;
    settings.disabled = choose.disabled = false;
    for (const control of source.elements) control.disabled = false;
  }
};
