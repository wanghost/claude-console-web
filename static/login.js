document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('login-btn');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '登录中...';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      // 登录后默认进入会话视图（清除上次停留视图的记忆，避免落到预览等视图）
      try { localStorage.removeItem('cc_last_view'); localStorage.removeItem('cc_last_path'); } catch (e) {}
      window.location.href = '/';
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || '登录失败';
    }
  } catch (err) {
    errEl.textContent = '网络错误：' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
});
