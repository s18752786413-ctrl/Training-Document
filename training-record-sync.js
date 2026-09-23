(() => {
  // 在旧版本地渲染执行前遮住卡片，避免本机旧记录短暂显示给未登录访客。
  const guard = document.createElement('style');
  guard.textContent = `
    #grid { visibility: hidden; }
    .training-auth-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .training-auth-bar button, .training-auth-panel button {
      border:1px solid #bfdbfe; background:#eff6ff; color:#1d4ed8;
      border-radius:9px; padding:9px 12px; cursor:pointer;
    }
    .training-auth-bar button.primary, .training-auth-panel button.primary {
      background:#2563eb; color:#fff; border-color:#2563eb;
    }
    .training-auth-bar button:disabled, .training-auth-panel button:disabled {
      opacity:.55; cursor:not-allowed;
    }
    .training-auth-status, .training-access-hint { color:#6b7280; font-size:12px; }
    .training-auth-panel {
      display:flex; align-items:center; gap:8px; flex-wrap:wrap;
      background:#fff; border:1px solid #e8eaf0; padding:12px;
      border-radius:12px; margin:0 0 12px;
    }
    .training-auth-panel[hidden], .training-auth-bar [hidden] { display:none; }
    .training-auth-panel input {
      min-width:240px; flex:1; border:1px solid #e8eaf0;
      border-radius:8px; padding:10px;
    }
    .training-access-hint { margin:6px 2px 14px; }
    .training-save-status { color:#16803c; font-size:11px; margin-top:4px; }
    @media(max-width:600px) { .training-auth-bar { width:100%; } }
  `;
  document.head.appendChild(guard);

  document.addEventListener('DOMContentLoaded', initialize, { once: true });

  function initialize() {
    const toolbar = document.querySelector('.toolbar');
    const grid = document.getElementById('grid');
    if (!toolbar || !grid || !window.supabase?.createClient || typeof window.render !== 'function') {
      const hint = document.getElementById('hint');
      if (hint) hint.textContent = '云端记录组件加载失败，请刷新页面或联系管理员。';
      window.readRecord = () => ({});
      window.saveRecord = () => {};
      if (typeof window.render === 'function') window.render();
      grid.style.visibility = 'visible';
      grid.querySelectorAll('.record input, .record button').forEach(control => { control.disabled = true; });
      return;
    }
    const footer = document.querySelector('.foot');
    if (footer) footer.textContent = '资源来源：飞书云空间导航 · 培训记录仅授权邮箱登录后保存在 Supabase';

    const authBar = document.createElement('div');
    authBar.className = 'training-auth-bar';
    authBar.innerHTML = `
      <span id="trainingAuthStatus" class="training-auth-status">正在连接安全记录…</span>
      <button id="trainingLoginToggle" class="primary" type="button">邮箱登录</button>
      <button id="trainingRefresh" type="button" hidden>刷新记录</button>
      <button id="trainingImport" type="button" hidden>导入本机旧记录</button>
      <button id="trainingLogout" type="button" hidden>退出登录</button>`;
    toolbar.appendChild(authBar);

    const panel = document.createElement('div');
    panel.className = 'training-auth-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <label for="trainingEmail">授权邮箱</label>
      <input id="trainingEmail" type="email" autocomplete="email" placeholder="输入已加入白名单的邮箱">
      <button id="trainingSendLink" class="primary" type="button">发送登录链接</button>
      <span id="trainingAuthMessage" class="training-auth-status" role="status" aria-live="polite">仅白名单邮箱可查看和维护培训记录。</span>`;
    toolbar.insertAdjacentElement('afterend', panel);

    const accessHint = document.createElement('p');
    accessHint.className = 'training-access-hint';
    accessHint.id = 'trainingAccessHint';
    accessHint.textContent = '文档导航公开可浏览；培训记录仅授权邮箱登录后可见。记录自动保存至 Supabase。';
    panel.insertAdjacentElement('afterend', accessHint);

    const status = document.getElementById('trainingAuthStatus');
    const message = document.getElementById('trainingAuthMessage');
    const loginToggle = document.getElementById('trainingLoginToggle');
    const refreshButton = document.getElementById('trainingRefresh');
    const importButton = document.getElementById('trainingImport');
    const logoutButton = document.getElementById('trainingLogout');
    const sendLinkButton = document.getElementById('trainingSendLink');
    const authUrl = 'https://ziwxqeqefyisxwvgrhdw.supabase.co';
    const publishableKey = 'sb_publishable_uJQTEEMJIF4h8Vj_9vS0wg_cMmbRTA5';
    const client = window.supabase.createClient(authUrl, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const originalRender = window.render;
    let session = null;
    let hasAccess = false;
    let cloudRecords = Object.create(null);
    let savedRows = Object.create(null);
    const saveTimers = new Map();

    const safeClone = value => JSON.parse(JSON.stringify(value));
    const ownRecordKey = url => `training-record:${url}`;

    function recordSessions(record) {
      if (Array.isArray(record?.sessions)) return record.sessions;
      return record?.time || record?.people
        ? [{ time: record.time || '', people: record.people || '' }]
        : [];
    }

    function localLegacyRows() {
      const rows = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith('training-record:')) continue;
        const url = key.slice('training-record:'.length);
        try {
          const record = JSON.parse(localStorage.getItem(key) || '{}');
          for (const item of recordSessions(record)) {
            const time = String(item.time || '').trim();
            if (time) rows.push({
              document_url: url,
              training_time: time,
              participants: String(item.people || '')
            });
          }
        } catch {
          // 忽略损坏的本机旧记录；不更改或删除原值。
        }
      }
      return rows;
    }

    function renderCurrent() {
      originalRender();
      grid.style.visibility = 'visible';
      grid.querySelectorAll('.record input, .record button').forEach(control => {
        control.disabled = !hasAccess;
      });
      if (hasAccess) {
        grid.querySelectorAll('.record').forEach(record => {
          if (!record.querySelector('.training-save-status')) {
            const saveStatus = document.createElement('div');
            saveStatus.className = 'training-save-status';
            saveStatus.textContent = '自动保存';
            record.appendChild(saveStatus);
          }
        });
      }
    }

    // 覆盖旧版本地读写函数：展示数据来自云端；本地记录只用于用户主动导入。
    window.readRecord = url => hasAccess ? (cloudRecords[url] || {}) : ({});
    window.saveRecord = (url, record) => {
      if (!hasAccess) return;
      cloudRecords[url] = safeClone(record);
      queueSave(url);
    };
    window.render = renderCurrent;

    function setSignedOut(text = '未登录：培训记录已隐藏') {
      hasAccess = false;
      cloudRecords = Object.create(null);
      savedRows = Object.create(null);
      status.textContent = text;
      loginToggle.hidden = false;
      logoutButton.hidden = !session;
      refreshButton.hidden = true;
      importButton.hidden = true;
      accessHint.textContent = '文档导航公开可浏览；培训记录仅授权邮箱登录后可见。';
      renderCurrent();
    }

    function setNoAccess() {
      hasAccess = false;
      cloudRecords = Object.create(null);
      savedRows = Object.create(null);
      status.textContent = `当前登录：${session?.user?.email || '未知邮箱'} · 未授权`;
      loginToggle.hidden = false;
      logoutButton.hidden = !session;
      refreshButton.hidden = true;
      importButton.hidden = true;
      accessHint.textContent = '当前登录邮箱没有培训记录访问权限；请确认登录邮箱与白名单一致。';
      renderCurrent();
    }

    function setPermissionError(error) {
      hasAccess = false;
      cloudRecords = Object.create(null);
      savedRows = Object.create(null);
      status.textContent = `当前登录：${session?.user?.email || '未知邮箱'} · 权限检查失败`;
      loginToggle.hidden = true;
      logoutButton.hidden = false;
      refreshButton.hidden = false;
      importButton.hidden = true;
      accessHint.textContent = `权限接口出错：${error.code || '未知错误'} · ${error.message || '请刷新重试'}`;
      renderCurrent();
    }

    async function loadRows() {
      if (!session) return setSignedOut();
      status.textContent = '正在验证邮箱权限…';
      const permission = await client.rpc('can_access_training_records');
      if (permission.error) return setPermissionError(permission.error);
      if (permission.data !== true) return setNoAccess();

      const result = await client.from('training_sessions')
        .select('id,document_url,training_time,participants')
        .order('training_time', { ascending: true });
      if (result.error) {
        hasAccess = false;
        cloudRecords = Object.create(null);
        savedRows = Object.create(null);
        status.textContent = '云端读取失败，请检查网络后重试';
        accessHint.textContent = '读取失败时不会把本机记录发送到云端。可点击“刷新记录”重试。';
        refreshButton.hidden = false;
        renderCurrent();
        return;
      }

      cloudRecords = Object.create(null);
      savedRows = Object.create(null);
      for (const row of result.data || []) {
        if (!cloudRecords[row.document_url]) cloudRecords[row.document_url] = { sessions: [] };
        cloudRecords[row.document_url].sessions.push({ time: row.training_time, people: row.participants || '' });
        if (!savedRows[row.document_url]) savedRows[row.document_url] = Object.create(null);
        savedRows[row.document_url][row.training_time] = { id: row.id, people: row.participants || '' };
      }
      hasAccess = true;
      for (const value of Object.values(cloudRecords)) {
        value.sessions.sort((a, b) => a.time.localeCompare(b.time));
      }
      status.textContent = `已登录：${session.user.email || ''} · 云端记录已同步`;
      loginToggle.hidden = true;
      logoutButton.hidden = false;
      refreshButton.hidden = false;
      importButton.hidden = localLegacyRows().length === 0;
      accessHint.textContent = '培训记录自动保存至 Supabase。其他浏览器用同一白名单邮箱登录后，即可查看和维护。';
      renderCurrent();
    }

    async function syncRecord(url) {
      if (!hasAccess || !session) return;
      const record = cloudRecords[url] || {};
      const next = Object.create(null);
      for (const item of recordSessions(record)) {
        const time = String(item.time || '').trim();
        if (time) next[time] = String(item.people || '');
      }
      const previous = savedRows[url] || Object.create(null);
      const removed = Object.keys(previous).filter(time => !(time in next));
      if (removed.length) {
        const result = await client.from('training_sessions').delete()
          .eq('document_url', url).in('training_time', removed);
        if (result.error) return showSaveError(url, result.error);
      }

      for (const [time, people] of Object.entries(next)) {
        if (previous[time]) {
          if (previous[time].people === people) continue;
          const result = await client.from('training_sessions').update({ participants: people })
            .eq('id', previous[time].id);
          if (result.error) return showSaveError(url, result.error);
          previous[time].people = people;
        } else {
          const result = await client.from('training_sessions').insert({
            document_url: url,
            training_time: time,
            participants: people,
            created_by: session.user.id
          }).select('id').single();
          if (result.error) return showSaveError(url, result.error);
          previous[time] = { id: result.data.id, people };
        }
      }
      savedRows[url] = Object.fromEntries(Object.entries(next).map(([time, people]) => [
        time, { id: previous[time]?.id, people }
      ]));
      grid.querySelectorAll('.record').forEach(recordEl => {
        const timeInput = recordEl.querySelector('[data-role="session-time"]');
        if (timeInput?.dataset.url === url) {
          const saveStatus = recordEl.querySelector('.training-save-status');
          if (saveStatus) saveStatus.textContent = '已保存到云端';
        }
      });
    }

    function showSaveError(url, error) {
      status.textContent = '保存失败，正在保留当前输入并稍后重试';
      console.error('Training record save failed', error);
      grid.querySelectorAll('.record').forEach(recordEl => {
        const timeInput = recordEl.querySelector('[data-role="session-time"]');
        if (timeInput?.dataset.url === url) {
          const saveStatus = recordEl.querySelector('.training-save-status');
          if (saveStatus) saveStatus.textContent = '保存失败，稍后自动重试';
        }
      });
      clearTimeout(saveTimers.get(url));
      saveTimers.set(url, setTimeout(() => syncRecord(url), 5000));
    }

    function queueSave(url) {
      grid.querySelectorAll('.record').forEach(recordEl => {
        const timeInput = recordEl.querySelector('[data-role="session-time"]');
        if (timeInput?.dataset.url === url) {
          const saveStatus = recordEl.querySelector('.training-save-status');
          if (saveStatus) saveStatus.textContent = '正在保存…';
        }
      });
      clearTimeout(saveTimers.get(url));
      saveTimers.set(url, setTimeout(() => syncRecord(url), 500));
    }

    loginToggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById('trainingEmail').focus();
    });

    sendLinkButton.addEventListener('click', async () => {
      const email = document.getElementById('trainingEmail').value.trim().toLowerCase();
      if (!email) { message.textContent = '请先填写白名单邮箱。'; return; }
      sendLinkButton.disabled = true;
      message.textContent = '正在发送登录链接…';
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}${location.pathname}` }
      });
      sendLinkButton.disabled = false;
      message.textContent = error
        ? `发送失败：${error.message}`
        : '如果该邮箱已加入白名单，登录链接已发送。请查看邮箱并点击链接返回此网页；非白名单邮箱无法读取记录。';
    });

    refreshButton.addEventListener('click', loadRows);
    logoutButton.addEventListener('click', async () => {
      await client.auth.signOut();
      session = null;
      setSignedOut('已退出登录：培训记录已隐藏');
      panel.hidden = true;
    });

    importButton.addEventListener('click', async () => {
      if (!hasAccess || !session) return;
      const localRows = localLegacyRows();
      const pending = localRows.filter(row => !(cloudRecords[row.document_url]?.sessions || [])
        .some(item => item.time === row.training_time));
      if (!pending.length) {
        message.textContent = '本机旧记录已导入或与云端重合；没有覆盖云端数据。';
        importButton.hidden = true;
        return;
      }
      const approved = confirm(
        `将从当前浏览器导入 ${pending.length} 条旧培训记录到 Supabase 云端吗？` +
        '只上传培训时间、参与人员和对应文档链接；不会删除本机副本，也不会覆盖已有云端记录。'
      );
      if (!approved) return;
      importButton.disabled = true;
      const rows = pending.map(row => ({ ...row, created_by: session.user.id }));
      const { error } = await client.from('training_sessions').insert(rows);
      importButton.disabled = false;
      if (error) {
        message.textContent = `导入失败：${error.message}。本机记录仍保留。`;
        return;
      }
      message.textContent = `已导入 ${rows.length} 条记录；本机副本仍保留。`;
      await loadRows();
    });

    client.auth.onAuthStateChange((_event, nextSession) => {
      setTimeout(() => {
        session = nextSession;
        if (session) loadRows();
        else setSignedOut();
      }, 0);
    });

    client.auth.getSession().then(({ data, error }) => {
      if (error) return setSignedOut('认证状态读取失败，请刷新页面重试');
      session = data.session;
      if (session) loadRows();
      else setSignedOut();
    });

    // 页面切回前台时重新取云端值；也提供手动刷新，避免覆盖正在编辑的输入。
    document.addEventListener('visibilitychange', () => {
      if (hasAccess && !document.hidden && !grid.contains(document.activeElement)) loadRows();
    });
    renderCurrent();
  }
})();

