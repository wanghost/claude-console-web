const content = document.getElementById('content');
let currentView = 'sessions';
let currentPath = '';
let currentSessionId = null;
let pollTimer = null;
let sessionRefreshTimer = null;
const SESSION_REFRESH_INTERVAL = 10000; // 会话详情自动刷新间隔（毫秒）

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    currentView = view;
    stopPoll();
    stopSessionRefresh();
    if (view === 'files') {
      showFiles(currentPath || '');
    } else if (view === 'sessions') {
      showSessions();
    } else if (view === 'admin') {
      showAdmin();
    }
  });
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---- 文件浏览 ----
async function showFiles(path = '') {
  currentPath = path;
  currentView = 'files';
  stopSessionRefresh();
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
  let html = '<div class="fs-breadcrumb">' + crumbs + '</div>';
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
      content.innerHTML = '<button class="back-btn" onclick="showFiles(currentPath)">← 返回</button>'
        + '<div class="file-head"><span class="path">' + esc(data.path) + '</span></div>'
        + '<div class="binary-note">二进制文件（' + fmtSize(data.size) + '），无法预览</div>';
      return;
    }
    renderEditor(data);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

function renderEditor(data) {
  let html = '<button class="back-btn" onclick="showFiles(currentPath)">← 返回</button>';
  html += '<div class="file-head"><span class="path">' + esc(data.path) + '</span>'
    + '<button class="secondary" id="edit-toggle">编辑</button>'
    + '<button id="save-btn" style="display:none">保存</button></div>';
  html += '<textarea class="editor" id="editor" style="display:none"></textarea>';
  html += '<pre class="viewer" id="viewer"></pre>';
  if (data.truncated) {
    html += '<div class="truncate-note">文件过大，仅显示前 ' + fmtSize(data.size) + ' 中的一部分</div>';
  }
  content.innerHTML = html;

  const viewer = document.getElementById('viewer');
  const editor = document.getElementById('editor');
  const editToggle = document.getElementById('edit-toggle');
  const saveBtn = document.getElementById('save-btn');
  viewer.textContent = data.content || '';

  editToggle.addEventListener('click', () => {
    const isEditing = editor.style.display !== 'none';
    editor.style.display = isEditing ? 'none' : 'block';
    viewer.style.display = isEditing ? 'block' : 'none';
    editToggle.textContent = isEditing ? '编辑' : '取消编辑';
    saveBtn.style.display = isEditing ? 'none' : 'inline-block';
    if (!isEditing) editor.value = data.content || '';
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
      viewer.textContent = editor.value;
      editor.style.display = 'none';
      viewer.style.display = 'block';
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

// ---- 会话列表 ----
async function showSessions() {
  currentView = 'sessions';
  stopSessionRefresh();
  content.classList.remove('chat-mode');
  content.innerHTML = '<div class="fs-empty">加载中...</div>';
  try {
    const data = await api('/api/sessions');
    renderSessions(data.sessions || []);
  } catch (e) {
    content.innerHTML = '<div class="fs-empty">' + esc(e.message) + '</div>';
  }
}

function renderSessions(sessions) {
  let html = '<div class="sess-toolbar"><button class="new-sess-btn" id="new-sess-btn">＋ 新建会话</button></div>';
  if (!sessions.length) {
    html += '<div class="fs-empty">暂无会话</div>';
  } else {
    html += '<div class="sess-list">';
    for (const s of sessions) {
      html += '<div class="sess-item" data-id="' + esc(s.session_id) + '">'
        + '<div class="title">' + esc(s.title) + '</div>'
        + '<div class="meta">'
        + '<span class="badge">' + esc(s.session_id.slice(0, 8)) + '</span>'
        + '<span>' + esc(s.project_dir || '') + '</span>'
        + '<span>' + s.user_msgs + ' 条消息</span>'
        + '<span>' + esc(fmtTime(s.last_ts)) + '</span>'
        + '</div></div>';
    }
    html += '</div>';
  }
  content.innerHTML = html;
  content.querySelectorAll('.sess-item').forEach((item) => {
    item.addEventListener('click', () => openSession(item.dataset.id));
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
async function openSession(id) {
  currentSessionId = id;
  currentView = 'session';
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

// 会话详情定时自动刷新（间隔 SESSION_REFRESH_INTERVAL 毫秒）
function startSessionRefresh() {
  stopSessionRefresh();
  sessionRefreshTimer = setInterval(() => {
    refreshChat(currentSessionId);
  }, SESSION_REFRESH_INTERVAL);
}

// 仅刷新消息区，保留输入框内容与已选择的模型/权限/Effort 选项
async function refreshChat(id) {
  if (!id || currentView !== 'session' || currentSessionId !== id) {
    stopSessionRefresh();
    return;
  }
  try {
    const data = await api('/api/sessions/' + id);
    updateChatMessages(data);
  } catch (e) {
    // 网络异常或会话被删：静默停止，避免刷屏
    stopSessionRefresh();
  }
}

// 只更新消息列表 DOM，不动输入框与选项框
function updateChatMessages(data) {
  const chatEl = content.querySelector('.chat');
  if (!chatEl) return;
  const msgs = data.messages || [];
  if (msgs.length === 0) {
    chatEl.innerHTML = '<div class="fs-empty">无消息</div>';
    return;
  }
  let html = '';
  for (const m of msgs) {
    html += '<div class="msg ' + m.role + '">' + esc(m.text) + '</div>';
  }
  chatEl.innerHTML = html;
  // 出现新内容时始终滚动到底部
  scrollChatToBottom();
}

function renderChat(data) {
  content.classList.add('chat-mode');
  let html = '<div class="chat-wrap">';
  html += '<button class="back-btn" onclick="showSessions()">← 返回会话列表</button>';
  if (data.cwd) {
    html += '<div class="file-head"><span class="path">工作目录：' + esc(data.cwd) + '</span>'
      + '<button class="secondary" id="open-cwd-btn">打开所在目录</button></div>';
  }
  html += '<div class="chat">';
  if (!data.messages || data.messages.length === 0) {
    html += '<div class="fs-empty">无消息</div>';
  } else {
    for (const m of data.messages) {
      html += '<div class="msg ' + m.role + '">' + esc(m.text) + '</div>';
    }
  }
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
  // 滚动消息区到底部（等下一帧布局完成后再滚，确保移动端 scrollHeight 已更新）
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const chatEl = content.querySelector('.chat');
  if (!chatEl) return;
  requestAnimationFrame(() => {
    chatEl.scrollTop = chatEl.scrollHeight;
  });
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
}

// 启动：默认会话视图
showSessions();
