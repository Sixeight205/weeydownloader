/* WeeY Downloader — Frontend Logic */
'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput     = document.getElementById('videoUrl');
const fetchBtn     = document.getElementById('fetchBtn');
const pasteBtn     = document.getElementById('pasteBtn');
const errorMsg     = document.getElementById('errorMsg');
const resultCard   = document.getElementById('resultCard');
const thumbnail    = document.getElementById('thumbnail');
const durationBadge= document.getElementById('duration');
const platformTag  = document.getElementById('platform-tag');
const videoTitle   = document.getElementById('videoTitle');
const uploader     = document.getElementById('uploader');
const formatSelect = document.getElementById('formatSelect');
const downloadBtn  = document.getElementById('downloadBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const progressPct  = document.getElementById('progressPct');
const progressSpeed= document.getElementById('progressSpeed');
const progressEta  = document.getElementById('progressEta');
const toast        = document.getElementById('toast');

// ── State ─────────────────────────────────────────────────────────────────────
let currentVideoUrl = '';
let evtSource = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function clearError() {
  errorMsg.textContent = '';
  errorMsg.hidden = true;
}

function setFetchLoading(on) {
  fetchBtn.classList.toggle('loading', on);
  fetchBtn.disabled = on;
  urlInput.disabled = on;
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatFilesize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  return null;
}

const PLATFORM_LABELS = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram'
};

// ── Platform Badge Highlight ───────────────────────────────────────────────────
function highlightBadge(platform) {
  document.querySelectorAll('.badge').forEach(b => {
    b.classList.toggle('active', b.dataset.platform === platform);
  });
}

urlInput.addEventListener('input', () => {
  const p = detectPlatform(urlInput.value.trim());
  highlightBadge(p);
});

// ── Paste Button ──────────────────────────────────────────────────────────────
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    highlightBadge(detectPlatform(text));
    showToast('📋 URL pasted!');
  } catch {
    showToast('⚠️ Clipboard access denied. Paste manually.');
  }
});

// ── Fetch Video Info ───────────────────────────────────────────────────────────
async function fetchInfo() {
  const url = urlInput.value.trim();
  clearError();

  if (!url) { showError('Please paste a video URL first.'); return; }

  const platform = detectPlatform(url);
  if (!platform) {
    showError('Unsupported URL. Please paste a YouTube, TikTok or Instagram link.');
    return;
  }

  setFetchLoading(true);
  resultCard.hidden = true;
  currentVideoUrl = url;

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await res.json();

    if (!res.ok) { showError(data.error || 'Something went wrong. Try again.'); return; }

    // Populate result card
    thumbnail.src    = data.thumbnail || '';
    thumbnail.alt    = data.title || 'Video thumbnail';
    durationBadge.textContent = formatDuration(data.duration);
    platformTag.textContent   = PLATFORM_LABELS[data.platform] || data.platform;
    videoTitle.textContent    = data.title || 'Video';
    uploader.textContent      = data.uploader ? `by ${data.uploader}` : '';

    // Populate format selector
    formatSelect.innerHTML = '';
    (data.formats || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.format_id;
      const size = f.filesize ? ` — ${formatFilesize(f.filesize)}` : '';
      const codec = f.codecLabel ? ` • ${f.codecLabel}` : '';
      const compatible = f.compatible ? ' • compatible' : '';
      opt.textContent = `${f.resolution} ${f.ext.toUpperCase()}${codec}${compatible}${size}`;
      formatSelect.appendChild(opt);
    });

    if (data.recommendedFormatId) {
      formatSelect.value = data.recommendedFormatId;
    }

    resultCard.hidden = false;
    progressWrap.hidden = true;
    resetProgress();
    downloadBtn.disabled = false;
    downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';

  } catch (err) {
    showError('Network error. Make sure the server is running.');
  } finally {
    setFetchLoading(false);
  }
}

fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchInfo(); });

// ── Download ───────────────────────────────────────────────────────────────────
function resetProgress() {
  progressBar.style.width = '0%';
  progressPct.textContent = '0%';
  progressSpeed.textContent = '';
  progressEta.textContent = '';
  document.querySelector('.progress-bar-track').setAttribute('aria-valuenow', 0);
}

downloadBtn.addEventListener('click', async () => {
  const formatId = formatSelect.value;
  if (!currentVideoUrl) return;

  downloadBtn.disabled = true;
  downloadBtn.querySelector('.dl-btn-text').textContent = 'Preparing…';
  progressWrap.hidden = false;
  resetProgress();

  // Close any existing SSE
  if (evtSource) { evtSource.close(); evtSource = null; }

  try {
    const res = await fetch('/api/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentVideoUrl, format_id: formatId })
    });

    const { jobId, error } = await res.json();
    if (!res.ok || !jobId) {
      showError(error || 'Failed to start download.');
      downloadBtn.disabled = false;
      downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';
      return;
    }

    // Listen for SSE progress
    evtSource = new EventSource(`/api/download/progress/${jobId}`);

    evtSource.onmessage = (e) => {
      const job = JSON.parse(e.data);

      if (job.status === 'error') {
        evtSource.close();
        showError(job.error || 'Download failed.');
        downloadBtn.disabled = false;
        downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';
        progressWrap.hidden = true;
        return;
      }

      if (job.status === 'downloading' || job.status === 'done') {
        const pct = Math.min(100, Math.round(job.progress || 0));
        progressBar.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;
        progressSpeed.textContent = job.speed ? `${job.speed}` : '';
        progressEta.textContent   = job.eta   ? `ETA ${job.eta}` : '';
        document.querySelector('.progress-bar-track').setAttribute('aria-valuenow', pct);
      }

      if (job.status === 'done') {
        evtSource.close();
        evtSource = null;
        progressBar.style.width = '100%';
        progressPct.textContent = '100%';
        progressSpeed.textContent = '';
        progressEta.textContent = '';
        downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';
        downloadBtn.disabled = false;

        showToast('✅ Download complete!', 4000);

        // Trigger file download
        const anchor = document.createElement('a');
        anchor.href = `/api/download/file/${jobId}`;
        anchor.click();
      }
    };

    evtSource.onerror = () => {
      if (evtSource) evtSource.close();
      showError('Connection error during download. Please try again.');
      downloadBtn.disabled = false;
      downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';
    };

  } catch (err) {
    showError('Network error. Please try again.');
    downloadBtn.disabled = false;
    downloadBtn.querySelector('.dl-btn-text').textContent = 'Download';
  }
});
