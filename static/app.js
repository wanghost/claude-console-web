const content = document.getElementById('content');
let currentView = 'sessions';
let currentPath = '';
let currentSessionId = null;
let pollTimer = null;
let sessionRefreshTimer = null;
let sessionRefreshInterval = 10; // 会话详情自动刷新间隔（秒），可从系统管理修改

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 轻量 Markdown 渲染（仅支持 Claude Code 常见语法）。
// 严格「先转义、再替换」，防止 XSS；所有用户输入先走 esc()。
function renderMarkdown(text) {
  if (!text) return '';
  let s = esc(text);

  // 1) 围栏代码块 ```lang\n...\n``` —— 必须最先处理（内部不解释其他语法）
  s = s.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    return '<pre class="md-pre"><code class="md-code-block" data-lang="' + esc(lang) + '">' + code + '</code></pre>';
  });

  // 2) 行内代码 `code`
  s = s.replace(/`([^`\n]+?)`/g, '<code class="md-code">$1</code>');

  // 3) 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 4) 粗体 **text** （非贪婪）
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

  // 5) 斜体 *text* / _text_ （避免匹配已经成对的 *）
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|\s)_([^_\n]+?)_(?=\s|$|[.,;:!?。，；：！？])/g, '$1<em>$2</em>');

  // 6) 标题 # / ## / ### / #### —— 按行处理（# 后必须有空格）
  s = s.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
  s = s.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
  s = s.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  s = s.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // 7) 无序列表 - item / * item
  //    把连续的 <li> 收集成 <ul>
  s = s.replace(/(^(?:[-*]\s+.+(?:\n|$))+)/gm, (block) => {
    const items = block.trim().split(/\n/).map((line) => {
      const m = line.match(/^[-*]\s+(.+)$/);
      return m ? '<li>' + m[1] + '</li>' : '';
    }).join('');
    return '<ul class="md-ul">' + items + '</ul>';
  });

  // 8) 有序列表 1. item
  s = s.replace(/(^(?:\d+\.\s+.+(?:\n|$))+)/gm, (block) => {
    const items = block.trim().split(/\n/).map((line) => {
      const m = line.match(/^\d+\.\s+(.+)$/);
      return m ? '<li>' + m[1] + '</li>' : '';
    }).join('');
    return '<ol class="md-ol">' + items + '</ol>';
  });

  // 9) 引用 > text
  s = s.replace(/^>\s+(.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

  // 10) 分隔线 ---（三个或更多 -）
  s = s.replace(/^-{3,}$/gm, '<hr class="md-hr">');

  // 11) 段落与换行：双换行 → <p>，单换行 → <br>
  s = s.split(/\n{2,}/).map((para) => {
    if (/^\s*<(h\d|ul|ol|pre|blockquote|hr)/.test(para)) return para;
    para = para.replace(/\n/g, '<br>');
    return '<p class="md-p">' + para + '</p>';
  }).join('\n');

  return s;
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function fmtTime(ts) {
  if (!ts) return '';
  return ts;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ---- 视图切换 ----
function setActiveTab(view) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === view);
  });
}

function switchView(view) {
  currentView = view;
  stopPoll();
  stopSessionRefresh();
  try { localStorage.setItem('cc_last_view', view); } catch (e) {}
  setActiveTab(view);
  if (view === 'files') {
    showFiles(currentPath || '');
  } else if (view === 'sessions') {
    showSessions();
  } else if (view === 'preview') {
    showPreview();
  } else if (view === 'admin') {
    showAdmin();
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchView(tab.dataset.view);
  });
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---- 预览（内嵌浏览器打开开发中的前端系统）----
let previewUrl = '';
try { previewUrl = localStorage.getItem('cc_preview_url') || ''; } catch (e) {}

function showPreview() {
  currentView = 'preview';
  stopSessionRefresh();
  content.classList.add('chat-mode');
  content.innerHTML = '<div class="preview-wrap">'
    + '<div class="preview-bar">'
    + '<input class="preview-input" id="preview-url" placeholder="http://127.0.0.1:8080" spellcheck="false">'
    + '<button class="primary" id="preview-go">打开</button>'
    + '<button class="secondary" id="preview-refresh">刷新</button>'
    + '<button class="secondary" id="preview-open">新窗口</button>'
    + '</div>'
    + '<div class="preview-body" id="preview-body">'
    + '<button class="fullscreen-btn" id="preview-fs" title="全屏">⛶</button>'
    + '<div class="preview-empty" id="preview-empty">输入开发服务的地址（如 http://127.0.0.1:8080），点击「打开」内嵌预览</div>'
    + '<iframe class="preview-frame" id="preview-frame" style="display:none" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>'
    + '</div>'
    + '</div>';

  const input = document.getElementById('preview-url');
  const frame = document.getElementById('preview-frame');
  const empty = document.getElementById('preview-empty');
  const body = document.getElementById('preview-body');
  const fsBtn = document.getElementById('preview-fs');
  input.value = previewUrl;

  function normalizeUrl(raw) {
    let u = (raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u;
  }
  // 将目标地址转换为走本服务 /proxy 的地址（公网下 127.0.0.1 由后端转发）
  function toProxyUrl(raw) {
    const url = normalizeUrl(raw);
    if (!url) return '';
    try {
      const u = new URL(url);
      const target = u.host; // host 含端口，如 127.0.0.1:8080
      return '/proxy/' + target + u.pathname + u.search;
    } catch (e) {
      return '';
    }
  }
  function loadPreview() {
    const url = normalizeUrl(input.value);
    if (!url) return;
    previewUrl = url;
    try { localStorage.setItem('cc_preview_url', url); } catch (e) {}
    input.value = url;
    empty.style.display = 'none';
    frame.style.display = 'block';
    frame.src = toProxyUrl(url);
  }
  function clearPreview() {
    frame.style.display = 'none';
    frame.src = 'about:blank';
    empty.style.display = 'block';
  }

  document.getElementById('preview-go').addEventListener('click', loadPreview);
  document.getElementById('preview-refresh').addEventListener('click', () => {
    if (!frame.src || frame.style.display === 'none') { loadPreview(); return; }
    frame.src = frame.src; // 重新加载当前 iframe
  });
  document.getElementById('preview-open').addEventListener('click', () => {
    const proxy = toProxyUrl(input.value);
    if (proxy) window.open(proxy, '_blank');
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPreview(); });

  // 系统级全屏切换（HTML5 Fullscreen API）
  let isFullscreen = false;
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const el = body.requestFullscreen ? body : document.documentElement;
      const p = el.requestFullscreen && el.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }
  function onFsChange() {
    isFullscreen = !!document.fullscreenElement;
    body.classList.toggle('fullscreen', isFullscreen);
    fsBtn.classList.toggle('active', isFullscreen);
    fsBtn.textContent = isFullscreen ? '✕' : '⛶';
    fsBtn.title = isFullscreen ? '退出全屏' : '全屏';
  }
  fsBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFsChange);

  // 恢复上次的预览地址
  if (previewUrl) loadPreview();
}

// ---- 文件浏览 ----
async function showFiles(path = '') {
  currentPath = path;
  currentView = 'files';
  stopSessionRefresh();
  try { localStorage.setItem('cc_last_path', path || ''); } catch (e) {}
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/fs/list?path=' + encodeURIComponent(path));
    renderFiles(data);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

function renderFiles(data) {
  const crumbs = buildBreadcrumb(data.path);
  let html = '<div class="fs-wrap">';
  html += '<div class="fs-breadcrumb">' + crumbs + '</div>';
  html += '<div class="fs-list">';
  if (!data.entries || data.entries.length === 0) {
    html += '<div class="fs-empty">空目录</div>';
  } else {
    for (const e of data.entries) {
      const icon = e.is_dir ? '📁' : '📄';
      const meta = e.is_dir ? '' : fmtSize(e.size);
      html += '<div class="fs-item ' + (e.is_dir ? 'dir' : 'file') + '" data-path="' + esc(e.path) + '" data-dir="' + e.is_dir + '">'
        + '<span class="icon">' + icon + '</span>'
        + '<span class="name">' + esc(e.name) + '</span>'
        + '<span class="meta">' + esc(meta) + '</span>'
        + '</div>';
    }
  }
  html += '</div>';
  html += '</div>'; // .fs-wrap
  content.classList.add('chat-mode');
  content.innerHTML = html;

  content.querySelectorAll('.fs-item').forEach((item) => {
    item.addEventListener('click', () => {
      const p = item.dataset.path;
      if (item.dataset.dir === 'true') {
        showFiles(p);
      } else {
        openFile(p);
      }
    });
  });
  content.querySelectorAll('.crumb').forEach((c) => {
    c.addEventListener('click', () => showFiles(c.dataset.path));
  });
}

function buildBreadcrumb(path) {
  if (!path) return '<span class="crumb" data-path="">根目录</span>';
  const segs = path.split('/').filter(Boolean);
  let acc = '';
  let html = '<span class="crumb" data-path="">根目录</span>';
  for (const s of segs) {
    acc = acc ? acc + '/' + s : s;
    html += '<span class="sep">/</span><span class="crumb" data-path="' + esc(acc) + '">' + esc(s) + '</span>';
  }
  return html;
}

async function openFile(path) {
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/fs/read?path=' + encodeURIComponent(path));
    if (data.encoding === 'binary') {
      content.classList.add('chat-mode');
      content.innerHTML = '<div class="editor-wrap">'
        + '<button class="back-btn" onclick="showFiles(currentPath)">← 返回</button>'
        + '<div class="file-head"><span class="path">' + esc(data.path) + '</span></div>'
        + '<div class="binary-note">二进制文件（' + fmtSize(data.size) + '），无法预览</div>'
        + '</div>';
      return;
    }
    renderEditor(data);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

function renderEditor(data) {
  let html = '<div class="editor-wrap">';
  html += '<button class="back-btn" onclick="showFiles(currentPath)">← 返回</button>';
  html += '<div class="file-head"><span class="path">' + esc(data.path) + '</span>'
    + '<button class="secondary" id="wrap-toggle" title="切换自动换行">自动换行</button>'
    + '<button class="secondary" id="edit-toggle">编辑</button>'
    + '<button id="save-btn" style="display:none">保存</button></div>';
  html += '<div class="editor-body">';
  // 编辑器（带行号）
  html += '<div class="editor-pane" id="editor-pane" style="display:none">'
    + '<div class="line-nums" id="editor-linenums"></div>'
    + '<textarea class="editor" id="editor"></textarea>'
    + '</div>';
  // 查看器（行号内联，每行独立，支持换行对齐）
  html += '<div class="viewer-pane" id="viewer-pane">'
    + '<div class="viewer" id="viewer"></div>'
    + '</div>';
  html += '</div>';
  if (data.truncated) {
    html += '<div class="truncate-note">文件过大，仅显示前 ' + fmtSize(data.size) + ' 中的一部分</div>';
  }
  html += '</div>'; // .editor-wrap
  content.classList.add('chat-mode');
  content.innerHTML = html;

  const viewer = document.getElementById('viewer');
  const editorPane = document.getElementById('editor-pane');
  const viewerPane = document.getElementById('viewer-pane');
  const editor = document.getElementById('editor');
  const editorNums = document.getElementById('editor-linenums');
  const editToggle = document.getElementById('edit-toggle');
  const saveBtn = document.getElementById('save-btn');
  const wrapToggle = document.getElementById('wrap-toggle');

  // 查看器：按行渲染，行号内联（每行独立，软换行时行号自动对齐行首）
  function renderViewerContent(text) {
    const lines = (text || '').split('\n');
    let html = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      html += '<div class="code-line">'
        + '<span class="ln">' + (i + 1) + '</span>'
        + '<span class="lc">' + (line === '' ? ' ' : esc(line)) + '</span>'
        + '</div>';
    }
    viewer.innerHTML = html;
  }
  renderViewerContent(data.content);

  // 自动换行切换
  let wrapEnabled = false;
  function applyWrap() {
    viewer.classList.toggle('wrap', wrapEnabled);
    editor.classList.toggle('wrap', wrapEnabled);
    wrapToggle.textContent = wrapEnabled ? '不换行' : '自动换行';
    wrapToggle.classList.toggle('active', wrapEnabled);
    renderEditorLineNums();
  }
  wrapToggle.addEventListener('click', () => {
    wrapEnabled = !wrapEnabled;
    applyWrap();
  });

  // 隐藏镜像：与 textarea 同宽同字体，用于测量软换行后的视觉行数
  const mirror = document.createElement('div');
  mirror.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
    + 'pointer-events:none;white-space:pre-wrap;word-break:break-word;'
    + 'overflow-y:scroll;box-sizing:border-box;padding:14px;'
    + 'font-family:"SF Mono",Consolas,monospace;font-size:13px;line-height:1.5;';
  document.body.appendChild(mirror);

  function measureLineHeight() {
    mirror.textContent = 'X';
    return mirror.getBoundingClientRect().height;
  }
  // 测量每个逻辑行软换行后占用的视觉行数
  function measureWrapLineCounts(text) {
    mirror.style.width = editor.clientWidth + 'px';
    const lineHeight = measureLineHeight();
    const lines = (text || '').split('\n');
    const counts = [];
    for (const line of lines) {
      mirror.textContent = line === '' ? ' ' : line;
      const h = mirror.getBoundingClientRect().height;
      counts.push(Math.max(1, Math.round(h / lineHeight)));
    }
    return counts;
  }

  // 生成编辑器行号（换行模式下按视觉行渲染，否则按逻辑行）
  function renderEditorLineNums() {
    if (wrapEnabled) {
      const counts = measureWrapLineCounts(editor.value);
      let html = '';
      let n = 1;
      for (const c of counts) {
        html += '<span>' + n + '</span>';
        for (let i = 1; i < c; i++) html += '<span></span>';
        n++;
      }
      editorNums.innerHTML = html;
    } else {
      const lines = editor.value ? editor.value.split('\n').length : 1;
      renderLineNums(editorNums, lines);
    }
  }
  renderEditorLineNums();

  // 宽度变化时（窗口缩放等）重算视觉行号
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (wrapEnabled) renderEditorLineNums(); }).observe(editor);
  }

  // 编辑模式切换
  editToggle.addEventListener('click', () => {
    const isEditing = editorPane.style.display !== 'none';
    editorPane.style.display = isEditing ? 'none' : 'flex';
    viewerPane.style.display = isEditing ? 'flex' : 'none';
    editToggle.textContent = isEditing ? '编辑' : '取消编辑';
    saveBtn.style.display = isEditing ? 'none' : 'inline-block';
    if (!isEditing) {
      editor.value = data.content || '';
      renderEditorLineNums();
      editor.scrollTop = 0;
    }
  });

  // 编辑器输入时同步行号
  editor.addEventListener('input', renderEditorLineNums);
  // 编辑器滚动时同步行号滚动
  editor.addEventListener('scroll', () => {
    editorNums.scrollTop = editor.scrollTop;
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: data.path, content: editor.value }),
      });
      data.content = editor.value;
      renderViewerContent(editor.value);
      editorPane.style.display = 'none';
      viewerPane.style.display = 'flex';
      editToggle.textContent = '编辑';
      saveBtn.style.display = 'none';
      alert('已保存');
    } catch (e) {
      alert('保存失败：' + e.message);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// 生成行号 DOM
function renderLineNums(container, count) {
  let html = '';
  for (let i = 1; i <= count; i++) {
    html += '<span>' + i + '</span>';
  }
  container.innerHTML = html;
}

// ---- 会话列表 ----
// 当前会话列表的项目筛选（null 表示全部）
let sessionFilterProject = null;
let currentSessionsCache = [];

async function showSessions() {
  currentView = 'sessions';
  stopSessionRefresh();
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/sessions');
    currentSessionsCache = data.sessions || [];
    renderSessions(currentSessionsCache);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

// 从 project_dir 提取短项目名（取路径最后一段）
function projectName(projectDir) {
  if (!projectDir) return '未分组';
  const parts = projectDir.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '未分组';
}

function renderSessions(sessions) {
  let html = '<div class="sess-wrap">';
  html += '<div class="sess-toolbar"><button class="new-sess-btn" id="new-sess-btn">＋ 新建会话</button></div>';
  if (!sessions.length) {
    html += '<div class="fs-empty">暂无会话</div>';
  } else {
    // 收集所有项目（去重，保持出现顺序）
    const projects = [];
    const seen = new Set();
    for (const s of sessions) {
      const key = s.project_dir || '';
      if (!seen.has(key)) {
        seen.add(key);
        projects.push(key);
      }
    }

    // 项目筛选器
    html += '<div class="project-filter">';
    html += '<button class="project-filter-btn' + (sessionFilterProject === null ? ' active' : '') + '" data-project="">全部（' + sessions.length + '）</button>';
    for (const p of projects) {
      const name = projectName(p);
      const count = sessions.filter((s) => (s.project_dir || '') === p).length;
      html += '<button class="project-filter-btn' + (sessionFilterProject === p ? ' active' : '') + '" data-project="' + esc(p) + '">' + esc(name) + '（' + count + '）</button>';
    }
    html += '</div>';

    // 按项目分组渲染
    const filtered = sessionFilterProject === null
      ? sessions
      : sessions.filter((s) => (s.project_dir || '') === sessionFilterProject);

    const groupOrder = sessionFilterProject === null
      ? projects
      : [sessionFilterProject];

    html += '<div class="sess-list">';
    for (const p of groupOrder) {
      const group = filtered.filter((s) => (s.project_dir || '') === p);
      if (!group.length) continue;
      html += '<div class="project-group">';
      html += '<div class="project-group-head"><span class="project-group-name">' + esc(projectName(p)) + '</span>'
        + '<span class="project-group-path">' + esc(p) + '</span>'
        + '<span class="project-group-count">' + group.length + ' 个会话</span></div>';
      for (const s of group) {
        html += '<div class="sess-item" data-id="' + esc(s.session_id) + '">'
          + '<div class="sess-item-main">'
          + '<div class="title">' + esc(s.title) + '</div>'
          + '<div class="meta">'
          + '<span class="badge">' + esc(s.session_id.slice(0, 8)) + '</span>'
          + '<button class="sess-msg-count" data-id="' + esc(s.session_id) + '" title="查看我的发言列表">发言 ' + s.user_msgs + ' 条</button>'
          + '<span>' + esc(fmtTime(s.last_ts)) + '</span>'
          + '</div></div>'
          + '<button class="sess-enter-btn" data-id="' + esc(s.session_id) + '" title="进入会话">进入</button>'
          + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>'; // .sess-wrap
  content.classList.add('chat-mode');
  content.innerHTML = html;

  // 只有点击「进入」按钮才进入会话；点击「发言 N 条」徽标进入发言列表
  content.querySelectorAll('.sess-enter-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSession(btn.dataset.id);
    });
  });
  content.querySelectorAll('.sess-msg-count').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showHistory(btn.dataset.id);
    });
  });
  // 项目筛选按钮
  content.querySelectorAll('.project-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sessionFilterProject = btn.dataset.project || null;
      renderSessions(currentSessionsCache);
    });
  });
  const newBtn = document.getElementById('new-sess-btn');
  if (newBtn) newBtn.addEventListener('click', showNewSessionForm);
}

async function showNewSessionForm() {
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载目录...</div>';
  let dirs = [];
  try {
    const data = await api('/api/sessions/dirs');
    dirs = data.dirs || [];
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
    return;
  }

  let options = '';
  for (const d of dirs) {
    options += '<option value="' + esc(d.path) + '">' + esc(d.name) + '（' + esc(d.rel) + '）</option>';
  }
  let html = '<button class="back-btn" onclick="showSessions()">← 返回会话列表</button>';
  html += '<div class="new-sess-form">';
  html += '<label>工作目录</label>';
  html += '<select id="new-cwd">' + options + '</select>';
  html += '<div class="new-sess-options" id="new-sess-options"></div>';
  html += '<label>第一条消息</label>';
  html += '<textarea id="new-prompt" placeholder="输入要开启新会话的问题..."></textarea>';
  html += '<button id="new-submit">开启新会话</button>';
  html += '</div>';
  html += '<div class="job-status" id="new-job-status" style="display:none"></div>';
  content.innerHTML = html;

  document.getElementById('new-submit').addEventListener('click', submitNewSession);
  loadNewSessionOptions();
}

async function loadNewSessionOptions() {
  const container = document.getElementById('new-sess-options');
  if (!container) return;
  try {
    const opts = await getSessionOptions();
    container.innerHTML =
      buildOptionSelect('new-model', '模型', opts.models, 'default') +
      buildOptionSelect('new-perm', '权限模式', opts.permission_modes, 'default') +
      buildOptionSelect('new-effort', 'Effort', opts.efforts, 'default');
  } catch (e) {
    container.innerHTML = '<div class="fs-empty">加载会话选项失败：' + esc(e.message) + '</div>';
  }
}

function readNewSessionOptions() {
  const model = document.getElementById('new-model');
  const perm = document.getElementById('new-perm');
  const effort = document.getElementById('new-effort');
  return {
    model: model ? model.value : 'default',
    permission_mode: perm ? perm.value : 'default',
    effort: effort ? effort.value : 'default',
  };
}

async function submitNewSession() {
  const cwd = document.getElementById('new-cwd').value;
  const prompt = document.getElementById('new-prompt').value.trim();
  const btn = document.getElementById('new-submit');
  const statusEl = document.getElementById('new-job-status');
  if (!cwd || !prompt) { alert('请选择目录并输入消息'); return; }

  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = '正在开启新会话...';

  try {
    const opts = readNewSessionOptions();
    const job = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd, prompt,
        model: opts.model,
        permission_mode: opts.permission_mode,
        effort: opts.effort,
      }),
    });
    pollNewSessionJob(job.job_id, job.session_id);
  } catch (e) {
    statusEl.textContent = '创建失败：' + e.message;
    btn.disabled = false;
  }
}

function pollNewSessionJob(jobId, sessionId) {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const job = await api('/api/jobs/' + jobId);
      const statusEl = document.getElementById('new-job-status');
      if (job.status === 'done') {
        stopPoll();
        if (statusEl) statusEl.textContent = '已完成';
        openSession(sessionId);
      } else if (job.status === 'error' || job.status === 'timeout') {
        stopPoll();
        if (statusEl) statusEl.textContent = '出错：' + (job.error || job.status);
        const btn = document.getElementById('new-submit');
        if (btn) btn.disabled = false;
      } else {
        if (statusEl) statusEl.textContent = 'Claude 正在处理...';
      }
    } catch (e) {
      stopPoll();
      const statusEl = document.getElementById('new-job-status');
      if (statusEl) statusEl.textContent = '查询失败：' + e.message;
    }
  }, 2000);
}

// ---- 会话详情 ----
let pendingScrollMsgId = null; // 打开会话后需要定位到的消息 id（用于“跳到发言”）

async function openSession(id, opts = {}) {
  currentSessionId = id;
  currentView = 'session';
  pendingScrollMsgId = opts.scrollToMsgId || null;
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/sessions/' + id);
    renderChat(data);
    startSessionRefresh();
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

// 会话详情定时自动刷新（间隔由 sessionRefreshInterval 秒决定）
function startSessionRefresh() {
  stopSessionRefresh();
  sessionRefreshTimer = setInterval(() => {
    refreshChat(currentSessionId);
  }, sessionRefreshInterval * 1000);
}

// 仅刷新消息区，保留输入框内容与已选择的模型/权限/Effort 选项
async function refreshChat(id, opts = {}) {
  if (!id || currentView !== 'session' || currentSessionId !== id) {
    stopSessionRefresh();
    return;
  }
  try {
    const data = await api('/api/sessions/' + id);
    updateChatMessages(data);
  } catch (e) {
    // 手动刷新（force）失败不停止自动刷新；自动刷新失败才静默停止，避免刷屏
    if (!opts.force) {
      stopSessionRefresh();
    }
  }
}

// 只更新消息列表 DOM，不动输入框与选项框
function updateChatMessages(data) {
  const chatEl = content.querySelector('.chat');
  if (!chatEl) return;
  const msgs = data.messages || [];
  if (msgs.length === 0) {
    chatEl.innerHTML = '<div class="fs-empty">无消息</div>';
    updateUserStrip();
    return;
  }
  let html = '';
  for (const m of msgs) {
    html += renderMessage(m);
  }
  chatEl.innerHTML = html;
  // 更新“我的发言”浮动条
  updateUserStrip();
  // 若用户正在底部，随新内容自动滚底；否则保持位置并显示“回到底部”按钮
  if (isChatAtBottom()) {
    scrollChatToBottom(false);
  } else {
    showScrollToBottomBtn();
  }
}

// 渲染单条消息（user 消息附复制/编辑按钮）
function renderMessage(m) {
  let html = '<div class="msg ' + m.role + ' md-body" id="msg-' + esc(m.id || '') + '">' + renderMarkdown(m.text) + '</div>';
  if (m.role === 'user') {
    html += '<div class="msg-actions">'
      + '<button class="msg-action-btn" data-action="copy" data-text="' + esc(m.text) + '">复制</button>'
      + '<button class="msg-action-btn" data-action="edit" data-text="' + esc(m.text) + '">编辑</button>'
      + '</div>';
  }
  return html;
}

function renderChat(data) {
  content.classList.add('chat-mode');
  let html = '<div class="chat-wrap">';
  html += '<div class="chat-topbar">'
    + '<button class="back-btn" onclick="showSessions()">← 返回会话列表</button>'
    + '<div class="chat-topbar-actions">'
    + '<button class="refresh-sess-btn" id="history-btn" title="查看本会话的对话历史">对话历史</button>'
    + '<button class="refresh-sess-btn" id="refresh-sess-btn" title="手动刷新会话内容">⟳ 刷新</button>'
    + '</div>'
    + '</div>';
  if (data.cwd) {
    html += '<div class="file-head"><span class="path">工作目录：' + esc(data.cwd) + '</span>'
      + '<button class="secondary" id="open-cwd-btn">打开所在目录</button></div>';
  }
  // “我的发言”浮动条（会话窗口最上方）
  html += '<div class="user-strip" id="user-strip"></div>';
  html += '<div class="chat-area">';
  html += '<div class="chat" id="chat-scroll">';
  if (!data.messages || data.messages.length === 0) {
    html += '<div class="fs-empty">无消息</div>';
  } else {
    for (const m of data.messages) {
      html += renderMessage(m);
    }
  }
  html += '</div>';
  html += '<button class="scroll-bottom-btn" id="scroll-bottom-btn" title="回到最新回复">↓ 回到最底部</button>';
  html += '</div>';
  html += '<div class="chat-input-area">';
  html += '<div class="reply-options" id="reply-options"></div>';
  html += '<div class="reply-bar"><textarea id="reply-input" placeholder="输入回复，继续此会话..."></textarea>'
    + '<button id="send-btn">发送</button></div>';
  html += '<div class="job-status" id="job-status" style="display:none"></div>';
  html += '</div>';
  html += '</div>';
  content.innerHTML = html;

  document.getElementById('send-btn').addEventListener('click', sendReply);
  document.getElementById('reply-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  });
  loadReplyOptions();
  const cwdBtn = document.getElementById('open-cwd-btn');
  if (cwdBtn) {
    cwdBtn.addEventListener('click', () => openSessionDir(currentSessionId));
  }
  const refreshBtn = document.getElementById('refresh-sess-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        await refreshChat(currentSessionId, { force: true });
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.addEventListener('click', () => showHistory(currentSessionId));
  }
  // 消息操作按钮（复制/编辑）事件委托
  const chatEl = content.querySelector('.chat');
  if (chatEl) {
    chatEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.msg-action-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const text = btn.dataset.text;
      if (action === 'copy') {
        copyText(text);
      } else if (action === 'edit') {
        editMessage(text);
      }
    });
    // 用户滚动时：判断是否处于底部，决定“回到底部”按钮显隐；并同步“我的发言”浮动条
    chatEl.addEventListener('scroll', () => {
      if (isChatAtBottom()) {
        hideScrollToBottomBtn();
      } else {
        showScrollToBottomBtn();
      }
      updateUserStrip();
    });
  }
  // “回到最底部”按钮
  const scrollBtn = document.getElementById('scroll-bottom-btn');
  if (scrollBtn) {
    scrollBtn.addEventListener('click', () => scrollChatToBottom(true));
  }
  // 填充“我的发言”浮动条
  updateUserStrip();
  // 定位：若指定了目标消息（“跳到发言”）则滚到该消息，否则定位到最新回复处
  if (pendingScrollMsgId) {
    const targetId = pendingScrollMsgId;
    pendingScrollMsgId = null;
    requestAnimationFrame(() => {
      const target = document.getElementById('msg-' + targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // 高亮目标消息，便于识别
        target.classList.add('msg-highlight');
        setTimeout(() => target.classList.remove('msg-highlight'), 1800);
      }
    });
  } else {
    scrollChatToBottom(false);
  }
}

// 是否处于消息区底部（容差 24px）
function isChatAtBottom() {
  const chatEl = content.querySelector('.chat');
  if (!chatEl) return true;
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 24;
}

// 滚动到消息区底部；scrollMode=true 时平滑滚动，false 时瞬间定位
function scrollChatToBottom(smooth) {
  const chatEl = content.querySelector('.chat');
  if (!chatEl) return;
  const doScroll = () => {
    if (smooth) {
      chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
    } else {
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  };
  if (smooth) {
    doScroll();
  } else {
    requestAnimationFrame(() => {
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }
}

function showScrollToBottomBtn() {
  const btn = document.getElementById('scroll-bottom-btn');
  if (btn) btn.classList.add('show');
}

function hideScrollToBottomBtn() {
  const btn = document.getElementById('scroll-bottom-btn');
  if (btn) btn.classList.remove('show');
}

// ---- “我的发言”浮动条（会话窗口最上方） ----
// 跟随滚动位置，同步显示“当前这一条”发言；点击跳转到对应消息
function updateUserStrip() {
  const strip = document.getElementById('user-strip');
  if (!strip) return;
  const chatEl = content.querySelector('.chat');
  const msgs = content.querySelectorAll('.msg.user');
  if (!msgs.length) {
    strip.innerHTML = '';
    strip.classList.remove('has-items');
    return;
  }

  // 找出“当前这一条”：最后一条顶部已滚过参考线的 user 消息，否则取第一条
  const line = chatEl ? chatEl.getBoundingClientRect().top + 40 : 0;
  let current = msgs[0];
  for (const el of msgs) {
    if (el.getBoundingClientRect().top <= line) {
      current = el;
    } else {
      break;
    }
  }

  const text = current.textContent.trim();
  const label = text.length > 80 ? text.slice(0, 80) + '…' : text;
  const html = '<div class="user-strip-label">我的发言</div>'
    + '<button class="user-strip-chip" data-target="' + esc(current.id) + '" title="' + esc(text) + '">' + esc(label) + '</button>';
  strip.innerHTML = html;
  strip.classList.add('has-items');

  const chip = strip.querySelector('.user-strip-chip');
  if (chip) {
    chip.addEventListener('click', () => {
      const target = document.getElementById(chip.dataset.target);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
}

// ---- 消息复制/编辑 ----
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // 兼容不支持 clipboard API 的环境
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    // 短暂提示
    flashHint('已复制');
  } catch (e) {
    alert('复制失败：' + e.message);
  }
}

function editMessage(text) {
  const input = document.getElementById('reply-input');
  if (!input) return;
  if (input.value.trim() === '') {
    input.value = text;
    input.focus();
    return;
  }
  // 输入框已有内容，询问是否清空
  if (confirm('输入框已有内容，是否清空后再编辑？')) {
    input.value = text;
    input.focus();
  }
}

function flashHint(msg) {
  let hint = document.getElementById('flash-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'flash-hint';
    document.body.appendChild(hint);
  }
  hint.textContent = msg;
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 1200);
}

// ---- 对话历史（当前会话中我说过的话）----
let historyData = null;

async function showHistory(sessionId) {
  const sid = sessionId || currentSessionId;
  if (!sid) return;
  try {
    const data = await api('/api/sessions/' + sid);
    const userMsgs = (data.messages || []).filter((m) => m.role === 'user');
    historyData = {
      sessionId: sid,
      title: userMsgs.length ? userMsgs[0].text.slice(0, 40) : '会话',
      messages: userMsgs,
    };
    renderHistory();
  } catch (e) {
    alert('加载对话历史失败：' + e.message);
  }
}

function renderHistory() {
  const msgs = historyData ? historyData.messages : [];
  const sid = historyData ? historyData.sessionId : null;
  content.classList.add('chat-mode');
  let html = '<div class="history-wrap">';
  html += '<div class="chat-topbar">'
    + '<button class="back-btn" id="history-back-btn">← 返回</button>'
    + '</div>';
  html += '<div class="history-head"><span class="history-title">我的发言（共 ' + msgs.length + ' 条）</span>'
    + '<div class="history-actions">'
    + '<button class="secondary" id="history-copy-all">全部复制</button>'
    + '<button id="history-download">下载 MD</button>'
    + '</div></div>';
  html += '<div class="history-list">';
  if (!msgs.length) {
    html += '<div class="fs-empty">本会话还没有你说过的话</div>';
  } else {
    for (const m of msgs) {
      html += '<div class="history-item" data-msg-id="' + esc(m.id || '') + '">'
        + '<div class="history-item-main">'
        + '<div class="history-ts">' + esc(m.ts || '') + '</div>'
        + '<div class="history-text">' + esc(m.text) + '</div>'
        + '</div>'
        + '<div class="history-item-actions">'
        + '<button class="history-action-btn" data-action="copy" data-text="' + esc(m.text) + '">复制</button>'
        + '<button class="history-action-btn" data-action="jump" data-id="' + esc(m.id || '') + '">跳到发言</button>'
        + '</div>'
        + '</div>';
    }
  }
  html += '</div>';
  html += '</div>';
  content.innerHTML = html;

  document.getElementById('history-back-btn').addEventListener('click', () => {
    // 若从会话详情进入，返回会话；否则返回会话列表
    if (currentSessionId && currentSessionId === sid) {
      openSession(currentSessionId);
    } else {
      showSessions();
    }
  });
  document.getElementById('history-copy-all').addEventListener('click', () => {
    copyText(historyText());
  });
  document.getElementById('history-download').addEventListener('click', () => {
    downloadHistoryMd();
  });
  // 单条发言操作（复制/跳到发言）事件委托
  content.querySelectorAll('.history-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'copy') {
        copyText(btn.dataset.text);
      } else if (btn.dataset.action === 'jump') {
        // 打开会话详情并定位到对应消息
        openSession(sid, { scrollToMsgId: btn.dataset.id });
      }
    });
  });
}

function historyText() {
  const msgs = historyData ? historyData.messages : [];
  return msgs.map((m) => (m.ts ? '[' + m.ts + '] ' : '') + m.text).join('\n\n');
}

function historyMd() {
  const msgs = historyData ? historyData.messages : [];
  const title = historyData ? historyData.title : '会话';
  let md = '# ' + title + '\n\n';
  md += '> 本文件由 Claude Console 导出\n\n';
  for (const m of msgs) {
    md += (m.ts ? '**' + m.ts + '**\n\n' : '') + m.text + '\n\n---\n\n';
  }
  return md;
}

function downloadHistoryMd() {
  const blob = new Blob([historyMd()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const title = historyData ? historyData.title : '会话历史';
  a.href = url;
  a.download = '对话历史_' + sanitizeFilename(title) + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || '会话';
}

async function openSessionDir(sessionId) {
  const btn = document.getElementById('open-cwd-btn');
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/sessions/' + sessionId + '/cwd');
    if (!data.rel_path) {
      alert('该会话目录不在文件浏览根目录内：' + (data.cwd || '未知'));
      return;
    }
    // 切到「文件」标签并定位到会话目录
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelector('.tab[data-view="files"]').classList.add('active');
    currentView = 'files';
    showFiles(data.rel_path);
  } catch (e) {
    alert('打开目录失败：' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function sendReply() {
  const input = document.getElementById('reply-input');
  const btn = document.getElementById('send-btn');
  const statusEl = document.getElementById('job-status');
  const prompt = input.value.trim();
  if (!prompt) return;

  input.value = '';
  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = '正在等待 Claude 回复...';
  // 发送期间暂停自动刷新，避免与 job 轮询相互干扰
  stopSessionRefresh();

  try {
    const opts = readReplyOptions();
    const job = await api('/api/sessions/' + currentSessionId + '/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: opts.model,
        permission_mode: opts.permission_mode,
        effort: opts.effort,
      }),
    });
    pollJob(job.job_id);
  } catch (e) {
    statusEl.textContent = '发送失败：' + e.message;
    btn.disabled = false;
  }
}

function pollJob(jobId) {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const job = await api('/api/jobs/' + jobId);
      const statusEl = document.getElementById('job-status');
      const btn = document.getElementById('send-btn');
      if (job.status === 'done') {
        stopPoll();
        statusEl.textContent = '已完成';
        if (btn) btn.disabled = false;
        // 重新加载会话，展示新消息
        openSession(currentSessionId);
      } else if (job.status === 'error' || job.status === 'timeout') {
        stopPoll();
        statusEl.textContent = '出错：' + (job.error || job.status);
        if (btn) btn.disabled = false;
      } else {
        statusEl.textContent = '处理中...';
      }
    } catch (e) {
      stopPoll();
      const statusEl = document.getElementById('job-status');
      if (statusEl) statusEl.textContent = '查询失败：' + e.message;
      const btn = document.getElementById('send-btn');
      if (btn) btn.disabled = false;
    }
  }, 2000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function stopSessionRefresh() {
  if (sessionRefreshTimer) { clearInterval(sessionRefreshTimer); sessionRefreshTimer = null; }
}

// ---- 会话参数（模型/权限/Effort）----
let sessionOptionsCache = null;

async function getSessionOptions() {
  if (sessionOptionsCache) return sessionOptionsCache;
  sessionOptionsCache = await api('/api/sessions/options');
  return sessionOptionsCache;
}

function buildOptionSelect(selectId, label, options, defaultVal) {
  let html = '<div class="opt-field"><label>' + label + '</label><select id="' + selectId + '">';
  for (const o of options) {
    const selected = o === defaultVal ? ' selected' : '';
    html += '<option value="' + esc(o) + '"' + selected + '>' + esc(o) + '</option>';
  }
  html += '</select></div>';
  return html;
}

async function loadReplyOptions() {
  const container = document.getElementById('reply-options');
  if (!container) return;
  try {
    const opts = await getSessionOptions();
    container.innerHTML =
      buildOptionSelect('opt-model', '模型', opts.models, 'default') +
      buildOptionSelect('opt-perm', '权限模式', opts.permission_modes, 'default') +
      buildOptionSelect('opt-effort', 'Effort', opts.efforts, 'default');
  } catch (e) {
    container.innerHTML = '<div class="fs-empty">加载会话选项失败：' + esc(e.message) + '</div>';
  }
}

function readReplyOptions() {
  const model = document.getElementById('opt-model');
  const perm = document.getElementById('opt-perm');
  const effort = document.getElementById('opt-effort');
  return {
    model: model ? model.value : 'default',
    permission_mode: perm ? perm.value : 'default',
    effort: effort ? effort.value : 'default',
  };
}

// ---- 系统管理 ----
async function showAdmin() {
  currentView = 'admin';
  stopSessionRefresh();
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/admin/settings');
    renderAdmin(data);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

function renderAdmin(data) {
  let html = '<div class="admin-section">';
  html += '<h2>系统设置</h2>';

  // 账号信息
  html += '<div class="admin-card">';
  html += '<div class="admin-card-title">账号信息</div>';
  html += '<div class="admin-row"><span>用户名</span><span>' + esc(data.username) + '</span></div>';
  html += '</div>';

  // 修改密码
  html += '<div class="admin-card">';
  html += '<div class="admin-card-title">修改密码</div>';
  html += '<label>当前密码</label><input type="password" id="old-password" autocomplete="current-password">';
  html += '<label>新密码（至少 6 位）</label><input type="password" id="new-password" autocomplete="new-password">';
  html += '<button id="change-pwd-btn">修改密码</button>';
  html += '<div class="admin-msg" id="pwd-msg"></div>';
  html += '</div>';

  // 默认工作目录
  html += '<div class="admin-card">';
  html += '<div class="admin-card-title">默认工作目录</div>';
  html += '<label>当前：' + esc(data.root_dir) + '</label>';
  html += '<input type="text" id="root-input" placeholder="例如 D:\\Workspace" value="' + esc(data.root_dir) + '">';
  html += '<button id="save-root-btn">保存目录</button>';
  html += '<div class="admin-msg" id="root-msg"></div>';
  html += '</div>';

  // 会话刷新间隔
  html += '<div class="admin-card">';
  html += '<div class="admin-card-title">会话内容刷新间隔</div>';
  html += '<label>打开会话后，消息列表自动刷新的时间间隔（单位：秒，最小 2 秒）</label>';
  html += '<input type="number" id="refresh-interval-input" min="2" step="1" value="' + esc(String(data.session_refresh_interval || 10)) + '">';
  html += '<button id="save-refresh-interval-btn">保存间隔</button>';
  html += '<div class="admin-msg" id="refresh-interval-msg"></div>';
  html += '</div>';

  // 登录会话超时
  html += '<div class="admin-card">';
  html += '<div class="admin-card-title">登录会话超时时长</div>';
  html += '<label>登录后无操作超过此时长将自动退出（单位：分钟，最小 1 分钟）</label>';
  html += '<input type="number" id="session-timeout-input" min="1" step="1" value="' + esc(String(data.session_timeout || 30)) + '">';
  html += '<button id="save-session-timeout-btn">保存时长</button>';
  html += '<div class="admin-msg" id="session-timeout-msg"></div>';
  html += '</div>';

  html += '</div>';
  content.innerHTML = html;

  // 修改密码
  document.getElementById('change-pwd-btn').addEventListener('click', async () => {
    const oldPwd = document.getElementById('old-password').value;
    const newPwd = document.getElementById('new-password').value;
    const msg = document.getElementById('pwd-msg');
    if (!oldPwd || !newPwd) { msg.textContent = '请填写完整'; return; }
    const btn = document.getElementById('change-pwd-btn');
    btn.disabled = true;
    try {
      await api('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      msg.textContent = '密码已修改，下次登录请用新密码';
      msg.style.color = 'var(--accent-dark)';
      document.getElementById('old-password').value = '';
      document.getElementById('new-password').value = '';
    } catch (e) {
      msg.textContent = '修改失败：' + e.message;
      msg.style.color = '#d64545';
    } finally {
      btn.disabled = false;
    }
  });

  // 保存目录
  document.getElementById('save-root-btn').addEventListener('click', async () => {
    const rootDir = document.getElementById('root-input').value.trim();
    const msg = document.getElementById('root-msg');
    if (!rootDir) { msg.textContent = '请输入目录'; return; }
    const btn = document.getElementById('save-root-btn');
    btn.disabled = true;
    try {
      await api('/api/admin/root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_dir: rootDir }),
      });
      msg.textContent = '工作目录已更新，文件浏览将立即生效';
      msg.style.color = 'var(--accent-dark)';
      currentPath = '';
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
      msg.style.color = '#d64545';
    } finally {
      btn.disabled = false;
    }
  });

  // 保存刷新间隔
  document.getElementById('save-refresh-interval-btn').addEventListener('click', async () => {
    const input = document.getElementById('refresh-interval-input');
    const msg = document.getElementById('refresh-interval-msg');
    const val = parseInt(input.value, 10);
    if (!val || val < 2) { msg.textContent = '请输入不小于 2 的整数秒数'; msg.style.color = '#d64545'; return; }
    const btn = document.getElementById('save-refresh-interval-btn');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/refresh-interval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: val }),
      });
      sessionRefreshInterval = res.session_refresh_interval;
      msg.textContent = '已保存，下次打开会话生效';
      msg.style.color = 'var(--accent-dark)';
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
      msg.style.color = '#d64545';
    } finally {
      btn.disabled = false;
    }
  });

  // 保存登录会话超时
  document.getElementById('save-session-timeout-btn').addEventListener('click', async () => {
    const input = document.getElementById('session-timeout-input');
    const msg = document.getElementById('session-timeout-msg');
    const val = parseInt(input.value, 10);
    if (!val || val < 1) { msg.textContent = '请输入不小于 1 的整数分钟数'; msg.style.color = '#d64545'; return; }
    const btn = document.getElementById('save-session-timeout-btn');
    btn.disabled = true;
    try {
      await api('/api/admin/session-timeout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: val }),
      });
      msg.textContent = '已保存，新超时对后续登录会话生效';
      msg.style.color = 'var(--accent-dark)';
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
      msg.style.color = '#d64545';
    } finally {
      btn.disabled = false;
    }
  });
}

// 启动：加载刷新间隔设置后，默认进入会话视图
async function init() {
  try {
    const data = await api('/api/admin/settings');
    if (data.session_refresh_interval) {
      sessionRefreshInterval = data.session_refresh_interval;
    }
  } catch (e) {
    // 忽略，使用默认 10 秒
  }
  // 恢复上次停留的视图（刷新后不跳回会话列表）
  let lastView = 'sessions';
  try { lastView = localStorage.getItem('cc_last_view') || 'sessions'; } catch (e) {}
  if (!['files', 'sessions', 'preview', 'admin'].includes(lastView)) lastView = 'sessions';
  if (lastView === 'files') {
    try { currentPath = localStorage.getItem('cc_last_path') || ''; } catch (e) {}
  }
  setActiveTab(lastView);
  switchView(lastView);
}
init();
