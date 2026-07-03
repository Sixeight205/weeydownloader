const express = require('express');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YTDLP_COMMANDS = process.platform === 'win32'
  ? [
      { command: 'yt-dlp', args: [] },
      { command: 'py', args: ['-3', '-m', 'yt_dlp'] },
      { command: 'python', args: ['-m', 'yt_dlp'] }
    ]
  : [
      { command: 'yt-dlp', args: [] },
      { command: 'python3', args: ['-m', 'yt_dlp'] },
      { command: 'python', args: ['-m', 'yt_dlp'] }
    ];

let resolvedYtDlpLauncher = null;

function resolveYtDlpLauncher() {
  if (resolvedYtDlpLauncher) {
    return resolvedYtDlpLauncher;
  }

  for (const entry of YTDLP_COMMANDS) {
    const probe = spawnSync(entry.command, [...entry.args, '--version'], {
      shell: false,
      stdio: 'ignore'
    });

    if (!probe.error && probe.status === 0) {
      resolvedYtDlpLauncher = entry;
      return entry;
    }
  }

  return null;
}

function runYtDlp(args) {
  const launcher = resolveYtDlpLauncher();
  if (!launcher) {
    return null;
  }

  return spawn(launcher.command, [...launcher.args, ...args], { shell: false });
}

// ── Downloads temp directory ──────────────────────────────────────────────────
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Clean up leftover files older than 1 hour on startup
cleanOldFiles();
setInterval(cleanOldFiles, 30 * 60 * 1000); // every 30 min

function cleanOldFiles() {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(file => {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (_) {}
}

// ── In-memory job store ───────────────────────────────────────────────────────
// job: { status, progress, speed, eta, filePath, fileName, error }
const jobs = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  return 'unknown';
}

function isValidUrl(url) {
  try {
    new URL(url);
    return /youtube\.com|youtu\.be|tiktok\.com|instagram\.com/.test(url);
  } catch {
    return false;
  }
}

// Extra flags per platform (no-ffmpeg safe)
function getPlatformArgs(platform) {
  const args = [];
  if (platform === 'instagram') {
    args.push('--add-header', 'Referer:https://www.instagram.com/');
  }
  if (platform === 'tiktok') {
    const cookiesFile = process.env.TIKTOK_COOKIES_FILE || process.env.YTDLP_COOKIES_FILE;
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }
  }
  return args;
}

function getFriendlyYtDlpError(stderr, platform) {
  const text = String(stderr || '');

  if (/Your IP address is blocked/i.test(text) || /blocked from accessing this post/i.test(text)) {
    return platform === 'tiktok'
      ? 'TikTok is blocking requests from this server/IP. Try another network, VPN, or a different TikTok URL.'
      : 'The source is blocking requests from this server/IP.';
  }

  if (/Sign in to confirm your age/i.test(text) || /login required/i.test(text)) {
    return 'This video requires login or age confirmation and cannot be fetched publicly.';
  }

  if (/Unsupported URL/i.test(text)) {
    return 'Unsupported URL. Please try a different link.';
  }

  if (/Private/i.test(text) || /This video is private/i.test(text)) {
    return 'This video is private or unavailable.';
  }

  return 'Could not fetch video info. Check the URL and try again.';
}

function getCodecLabel(format) {
  const videoCodec = String(format.vcodec || '').toLowerCase();
  const audioCodec = String(format.acodec || '').toLowerCase();
  const pieces = [];

  if (videoCodec && videoCodec !== 'none') {
    pieces.push(videoCodec);
  }

  if (audioCodec && audioCodec !== 'none') {
    pieces.push(audioCodec);
  }

  return pieces.join(' + ');
}

function isWindowsMediaPlayerFriendlyFormat(format) {
  const videoCodec = String(format.vcodec || '').toLowerCase();
  const audioCodec = String(format.acodec || '').toLowerCase();

  return (
    format.ext === 'mp4' &&
    /^(avc1|h264)/.test(videoCodec) &&
    /^(mp4a|aac)/.test(audioCodec)
  );
}

function pickDefaultFormatId(info) {
  const mergedFormats = (info.formats || []).filter(format => {
    const hasVideo = format.vcodec && format.vcodec !== 'none';
    const hasAudio = format.acodec && format.acodec !== 'none';
    return hasVideo && hasAudio;
  });

  const rankedFormats = mergedFormats
    .map(format => ({
      ...format,
      height: format.height || 0,
      compatibilityScore: isWindowsMediaPlayerFriendlyFormat(format) ? 1 : 0
    }))
    .sort((a, b) => {
      if (b.compatibilityScore !== a.compatibilityScore) {
        return b.compatibilityScore - a.compatibilityScore;
      }

      if ((b.height || 0) !== (a.height || 0)) {
        return (b.height || 0) - (a.height || 0);
      }

      return (b.tbr || 0) - (a.tbr || 0);
    });

  const compatible = rankedFormats.find(isWindowsMediaPlayerFriendlyFormat);
  if (compatible) {
    return compatible.format_id;
  }

  const mp4Format = rankedFormats.find(format => String(format.ext || '').toLowerCase() === 'mp4');
  if (mp4Format) {
    return mp4Format.format_id;
  }

  return rankedFormats[0] ? rankedFormats[0].format_id : 'best';
}

// Parse yt-dlp progress line → { percent, speed, eta }
function parseProgress(line) {
  const match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+[\d.]+\S+\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/);
  if (match) {
    return {
      percent: parseFloat(match[1]),
      speed: match[2],
      eta: match[3]
    };
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/info — fetch video metadata
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid or unsupported URL. We support YouTube, TikTok and Instagram.' });
  }

  const platform = detectPlatform(url);
  const platformArgs = getPlatformArgs(platform);

  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    ...platformArgs,
    url
  ];

  let stdout = '';
  let stderr = '';
  const proc = runYtDlp(args);
  if (!proc) {
    return res.status(500).json({ error: 'yt-dlp is not installed. Install it with pip or make sure it is on PATH.' });
  }

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', code => {
    if (code !== 0) {
      const msg = getFriendlyYtDlpError(stderr, platform);
      return res.status(500).json({ error: msg });
    }

    try {
      // yt-dlp may output multiple JSON lines for playlists; take first
      const info = JSON.parse(stdout.trim().split('\n')[0]);

      // Only show pre-merged formats (no ffmpeg needed)
      const rawFormats = (info.formats || []).filter(f => {
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        return hasVideo && hasAudio;
      });

      const formats = rawFormats
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext || 'mp4',
          resolution: f.resolution || (f.height ? `${f.height}p` : 'Best'),
          filesize: f.filesize || f.filesize_approx || null,
          note: f.format_note || '',
          height: f.height || 0,
          vcodec: f.vcodec || '',
          acodec: f.acodec || '',
          codecLabel: getCodecLabel(f),
          compatible: isWindowsMediaPlayerFriendlyFormat(f)
        }))
        .sort((a, b) => {
          if (b.compatible !== a.compatible) {
            return Number(b.compatible) - Number(a.compatible);
          }
          return b.height - a.height;
        });

      // Deduplicate by resolution label
      const seen = new Set();
      const uniqueFormats = formats.filter(f => {
        const key = f.resolution;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      res.json({
        title: info.title || 'Video',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        platform,
        uploader: info.uploader || info.channel || '',
        recommendedFormatId: pickDefaultFormatId(info),
        formats: uniqueFormats.length > 0
          ? uniqueFormats
          : [{ format_id: 'best', ext: 'mp4', resolution: 'Best Available', filesize: null, note: '', height: 0 }]
      });
    } catch (_) {
      res.status(500).json({ error: 'Failed to parse video information.' });
    }
  });
});

// POST /api/download/start — queue a download job, return jobId
app.post('/api/download/start', (req, res) => {
  const { url, format_id } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = uuidv4();
  const platform = detectPlatform(url);
  const platformArgs = getPlatformArgs(platform);
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  let formatArg = format_id && format_id !== 'best' ? format_id : null;

  if (!formatArg) {
    const metadataArgs = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      ...platformArgs,
      url
    ];

    const metadataProc = runYtDlp(metadataArgs);
    if (!metadataProc) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = 'yt-dlp is not installed. Install it with pip or make sure it is on PATH.';
      }
      return;
    }

    let metadataStdout = '';
    let metadataStderr = '';

    metadataProc.stdout.on('data', d => { metadataStdout += d.toString(); });
    metadataProc.stderr.on('data', d => { metadataStderr += d.toString(); });

    metadataProc.on('close', code => {
      if (code !== 0) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = getFriendlyYtDlpError(metadataStderr, platform);
        }
        return;
      }

      try {
        const info = JSON.parse(metadataStdout.trim().split('\n')[0]);
        formatArg = pickDefaultFormatId(info);
        startDownloadJob(formatArg);
      } catch (_) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = 'Failed to parse video information.';
        }
      }
    });

    return;
  }

  startDownloadJob(formatArg);

  function startDownloadJob(selectedFormatId) {
    const args = [
      '-f', selectedFormatId,
      '--no-playlist',
      '--no-part',
      '--restrict-filenames',
      '--no-warnings',
      '--newline',          // one progress line per line (needed for parsing)
      '-o', outputTemplate,
      ...platformArgs,
      url
    ];

    jobs.set(jobId, { status: 'pending', progress: 0, speed: '', eta: '', filePath: null, fileName: null, error: null });
    res.json({ jobId });

    // Start download asynchronously
    const proc = runYtDlp(args);
    if (!proc) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = 'yt-dlp is not installed. Install it with pip or make sure it is on PATH.';
      }
      return;
    }

    let stderr = '';

    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        const p = parseProgress(line);
        if (p) {
          const job = jobs.get(jobId);
          if (job) {
            job.status = 'downloading';
            job.progress = p.percent;
            job.speed = p.speed;
            job.eta = p.eta;
          }
        }
      });
    });

    proc.stderr.on('data', d => {
      stderr += d.toString();
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        const p = parseProgress(line);
        if (p) {
          const job = jobs.get(jobId);
          if (job) {
            job.status = 'downloading';
            job.progress = p.percent;
            job.speed = p.speed;
            job.eta = p.eta;
          }
        }
      });
    });

    proc.on('close', code => {
      const job = jobs.get(jobId);
      if (!job) return;

      if (code !== 0) {
        job.status = 'error';
        job.error = getFriendlyYtDlpError(stderr, platform) || 'Download failed. Please try again.';
        return;
      }

      // Find the output file
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
      if (files.length === 0) {
        job.status = 'error';
        job.error = 'Output file not found after download.';
        return;
      }

      const filePath = path.join(DOWNLOADS_DIR, files[0]);
      const ext = path.extname(files[0]);
      job.status = 'done';
      job.progress = 100;
      job.filePath = filePath;
      job.fileName = `WeeYDownloader_video${ext}`;
    });
  }
});

// GET /api/download/progress/:jobId — SSE stream
app.get('/api/download/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx compatibility

  const { jobId } = req.params;

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const job = jobs.get(jobId);
    if (!job) {
      send({ status: 'error', error: 'Job not found' });
      clearInterval(interval);
      return res.end();
    }
    send(job);
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 400);

  req.on('close', () => clearInterval(interval));
});

// GET /api/download/file/:jobId — stream completed file to browser
app.get('/api/download/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).json({ error: 'File not ready or not found.' });
  }

  const filePath = job.filePath;
  const fileName = job.fileName || 'video.mp4';

  res.download(filePath, fileName, err => {
    // Clean up regardless
    try { fs.unlinkSync(filePath); } catch (_) {}
    jobs.delete(jobId);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  🎬  WeeY Downloader                 ║`);
  console.log(`  ║  Running at http://localhost:${PORT}   ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
