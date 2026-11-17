import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const videoLimit = 80 * 1024 * 1024;
const instagram = 'https://www.instagram.com';

function publicMediaUrl(html) {
  const normalized = html.replace(/\\{1,5}"/g, '"');
  const values = [
    ...normalized.matchAll(/"(?:video_url|playback_url|playable_url(?:_quality_hd)?)"\s*:\s*"(https:[^"]+)"/gi),
    ...html.matchAll(/<meta\s+property=["']og:video(?::(?:url|secure_url))?["']\s+content=["'](https:[^"']+)["']/gi),
  ];
  for (const [, value] of values) {
    const url = URL.parse(value.replace(/\\+\//g, '/')
      .replace(/\\+u0026|&amp;|&#38;/gi, '&')
      .replace(/\\+u00253d|\\+u003d/gi, '='));
    if (url?.protocol === 'https:' && !url.username && !url.password && !url.port &&
        /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)) return url;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Use GET.' });
  }

  const code = req.query.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,30}$/.test(code)) {
    return res.status(400).json({ error: 'Paste an Instagram Reel link.' });
  }

  try {
    const signal = AbortSignal.timeout(15000);
    const pages = await Promise.allSettled(['embed/', ''].map(async suffix => {
      const response = await fetch(`${instagram}/reel/${code}/${suffix}`, {
        redirect: 'error',
        signal,
      });
      if (response.ok) return publicMediaUrl(await response.text());
      await response.body?.cancel();
    }));
    const urls = new Map();
    for (const page of pages) {
      if (page.status === 'fulfilled' && page.value) urls.set(page.value.href, page.value);
    }
    let oversized = false;
    for (const url of urls.values()) {
      const video = await fetch(url, { redirect: 'error', signal }).catch(() => null);
      const type = video?.headers.get('content-type')?.split(';')[0];
      const size = Number(video?.headers.get('content-length'));
      if (video?.ok && type?.startsWith('video/') && size > videoLimit) oversized = true;
      if (!video?.ok || !type?.startsWith('video/') || !video.body || size <= 0 || size > videoLimit) {
        await video?.body?.cancel();
        continue;
      }
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', size);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await pipeline(Readable.fromWeb(video.body), res);
      return;
    }
    if (oversized) return res.status(413).json({ error: 'This Reel exceeds the 80 MiB import limit.' });
    return res.status(422).json({ error: 'Instagram did not serve a video for this link. Try another public Reel.' });
  } catch {
    if (res.headersSent) return res.destroy();
    return res.status(502).json({ error: 'Could not reach Instagram. Try again.' });
  }
}
