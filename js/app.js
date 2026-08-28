/* ScanSorter — 화면 제어와 작업 흐름 */
(() => {
  const $ = id => document.getElementById(id);
  const el = {
    unsupported: $('unsupported'),
    apiKey: $('apiKey'), btnToggleKey: $('btnToggleKey'), btnTestKey: $('btnTestKey'),
    keyStatus: $('keyStatus'),
    model: $('model'), rpm: $('rpm'), lang: $('lang'),
    btnLoadModels: $('btnLoadModels'), modelStatus: $('modelStatus'),
    template: $('template'), categories: $('categories'),
    useFolders: $('useFolders'), skipProcessed: $('skipProcessed'), dupCheck: $('dupCheck'),
    autoWatch: $('autoWatch'), autoApply: $('autoApply'),
    btnPick: $('btnPick'), btnRescan: $('btnRescan'), folderName: $('folderName'),
    btnAnalyze: $('btnAnalyze'), btnStop: $('btnStop'), btnApply: $('btnApply'),
    progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressText: $('progressText'),
    tbody: $('tbody'), checkAll: $('checkAll'), categoryList: $('categoryList'),
    log: $('log'), btnClearLog: $('btnClearLog'), btnSettings: $('btnSettings'),
    settings: $('settings'),
  };

  const state = {
    settings: Store.loadSettings(),
    processed: Store.loadProcessed(),
    hashes: Store.loadHashes(),
    dirHandle: null,
    items: [],                       // { id, entry, status, result, newName, category, error, checked }
    running: false,
    cancel: false,
    watchTimer: null,
    limiter: new Gemini.RateLimiter(Store.loadSettings().rpm),
  };

  let nextId = 1;

  /* ── 로그 ─────────────────────────────────────── */
  function log(msg, kind = '') {
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const prefix = kind === 'error' ? '✖' : kind === 'ok' ? '✔' : '·';
    el.log.textContent += `[${t}] ${prefix} ${msg}\n`;
    el.log.scrollTop = el.log.scrollHeight;
  }

  /* ── 설정 바인딩 ──────────────────────────────── */
  const FIELDS = {
    apiKey: 'value', model: 'value', rpm: 'value', lang: 'value',
    template: 'value', categories: 'value',
    useFolders: 'checked', skipProcessed: 'checked', dupCheck: 'checked',
    autoWatch: 'checked', autoApply: 'checked',
  };

  function settingsToForm() {
    for (const [key, prop] of Object.entries(FIELDS)) el[key][prop] = state.settings[key];

    // 저장된 모델이 목록에 없으면(새 이름으로 바뀌었거나 직접 넣은 경우)
    // 선택이 통째로 풀리므로 항목을 만들어 붙인다.
    if (state.settings.model && el.model.value !== state.settings.model) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = state.settings.model;
      el.model.prepend(opt);
      el.model.value = state.settings.model;
    }
  }
  function formToSettings() {
    for (const [key, prop] of Object.entries(FIELDS)) state.settings[key] = el[key][prop];
    state.settings.rpm = Math.min(60, Math.max(1, Number(state.settings.rpm) || 10));
    state.limiter.setRpm(state.settings.rpm);
    Store.saveSettings(state.settings);
  }

  /* ── 분류 후보 ────────────────────────────────── */
  function userCategories() {
    return state.settings.categories.split('\n').map(s => s.trim()).filter(Boolean);
  }
  let folderCategories = [];
  function knownCategories() {
    return [...new Set([...userCategories(), ...folderCategories,
                        ...state.items.map(i => i.category).filter(Boolean)])];
  }
  function refreshCategoryList() {
    el.categoryList.innerHTML = knownCategories()
      .map(c => `<option value="${escapeAttr(c)}">`).join('');
  }

  const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escapeAttr = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 파일명 만들기 ────────────────────────────── */
  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i) : '';
  }

  function buildName(result, entry) {
    const origBase = entry.name.replace(/\.[^.]+$/, '');
    const values = {
      date: normalizeDate(result.date),
      type: FS.sanitize(result.docType || '', 30, ''),
      issuer: FS.sanitize(result.issuer || '', 40, ''),
      title: FS.sanitize(result.title || '', 60, ''),
      category: FS.sanitize(result.category || '', 30, ''),
      orig: origBase,
    };

    // 빈 값은 표식으로 바꿔 두었다가, 중복 구분자와 함께 정리한다.
    const MARK = String.fromCharCode(1);
    let name = state.settings.template.replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(values, k) ? (values[k] || MARK) : m);

    name = name
      .split(MARK).join('')
      .replace(/[_\-.]{2,}/g, m => m[0])       // 빈 값 자리에 남은 구분자 정리
      .replace(/^[_\-.\s]+|[_\-.\s]+$/g, '');

    if (!name) name = values.title || values.orig;
    return FS.sanitize(name) + extOf(entry.name);
  }

  function normalizeDate(raw) {
    if (!raw) return '';
    const m = String(raw).match(/(\d{4})\D?(\d{1,2})?\D?(\d{1,2})?/);
    if (!m) return '';
    const [, y, mo, d] = m;
    if (!mo) return y;
    const pad = n => String(n).padStart(2, '0');
    return d ? `${y}-${pad(mo)}-${pad(d)}` : `${y}-${pad(mo)}`;
  }

  /* ── 표 그리기 ────────────────────────────────── */
  const STATUS = {
    pending: ['pending', '대기'],
    working: ['working', '분석 중'],
    ready:   ['ready', '확인 대기'],
    done:    ['done', '완료'],
    dup:     ['skip', '중복'],
    skip:    ['skip', '건너뜀'],
    error:   ['error', '오류'],
  };

  function render() {
    if (!state.items.length) {
      el.tbody.innerHTML = `<tr class="empty"><td colspan="6">${
        state.dirHandle ? '처리할 새 파일이 없습니다.' : '폴더를 선택하면 파일 목록이 여기에 표시됩니다.'
      }</td></tr>`;
      updateButtons();
      return;
    }

    el.tbody.innerHTML = state.items.map(item => {
      const [cls, label] = STATUS[item.status] || STATUS.pending;
      const editable = item.status === 'ready';
      const note = item.error ? `<span class="muted">${escapeHtml(item.error)}</span>`
                              : escapeHtml(item.result?.summary || '');
      return `<tr data-id="${item.id}" class="${item.status === 'done' ? 'done' : ''}">
        <td><input type="checkbox" class="rowcheck" ${item.checked ? 'checked' : ''}
             ${editable ? '' : 'disabled'}></td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td class="orig" title="${escapeAttr(item.entry.name)}">${escapeHtml(item.entry.name)}</td>
        <td>${editable
              ? `<input class="cat" list="categoryList" value="${escapeAttr(item.category || '')}">`
              : escapeHtml(item.finalDir ?? item.category ?? '')}</td>
        <td>${editable
              ? `<input class="nm" value="${escapeAttr(item.newName || '')}">`
              : escapeHtml(item.finalName ?? item.newName ?? '')}</td>
        <td class="sum">${note}</td>
      </tr>`;
    }).join('');

    updateButtons();
  }

  function updateButtons() {
    const hasPending = state.items.some(i => i.status === 'pending');
    const hasReady = state.items.some(i => i.status === 'ready' && i.checked);
    el.btnAnalyze.disabled = state.running || !state.dirHandle || !hasPending;
    el.btnStop.disabled = !state.running;
    el.btnApply.disabled = state.running || !hasReady;
    el.btnRescan.disabled = !state.dirHandle || state.running;
  }

  el.tbody.addEventListener('input', e => {
    const tr = e.target.closest('tr');
    const item = state.items.find(i => i.id === Number(tr?.dataset.id));
    if (!item) return;
    if (e.target.classList.contains('nm')) item.newName = e.target.value;
    if (e.target.classList.contains('cat')) item.category = e.target.value;
  });

  el.tbody.addEventListener('change', e => {
    if (!e.target.classList.contains('rowcheck')) return;
    const tr = e.target.closest('tr');
    const item = state.items.find(i => i.id === Number(tr.dataset.id));
    if (item) item.checked = e.target.checked;
    updateButtons();
  });

  el.checkAll.addEventListener('change', () => {
    state.items.forEach(i => { if (i.status === 'ready') i.checked = el.checkAll.checked; });
    render();
  });

  /* ── 폴더 선택 & 스캔 ─────────────────────────── */
  async function useDirectory(handle, { announce = true } = {}) {
    state.dirHandle = handle;
    el.folderName.textContent = handle.name;
    el.folderName.classList.remove('muted');
    await Store.saveDirHandle(handle);
    if (announce) log(`폴더 선택: ${handle.name}`, 'ok');
    await scan();
  }

  async function scan() {
    if (!state.dirHandle) return;
    let files;
    try {
      files = await FS.listFiles(state.dirHandle);
      folderCategories = await FS.listSubfolders(state.dirHandle);
    } catch (e) {
      log('폴더를 읽지 못했습니다: ' + e.message, 'error');
      return 0;
    }

    // 이미 목록에 있는 파일(진행 중·완료 포함)은 다시 넣지 않는다.
    const known = new Set(state.items.map(i => Store.fileKey(i.entry.file)));
    let added = 0, skipped = 0;

    for (const entry of files) {
      const key = Store.fileKey(entry.file);
      if (known.has(key)) continue;
      if (state.settings.skipProcessed && state.processed.has(key)) { skipped++; continue; }
      state.items.push({
        id: nextId++, entry, status: 'pending',
        result: null, newName: '', category: '', error: '', checked: true,
      });
      added++;
    }

    refreshCategoryList();
    render();
    if (added || skipped) {
      log(`새 파일 ${added}건 발견${skipped ? ` (이미 처리한 ${skipped}건 제외)` : ''}`);
    }

    if (added && state.settings.dupCheck) {
      const dups = await markDuplicates();
      if (dups) log(`내용이 같은 중복 파일 ${dups}건 — 분석하지 않습니다`);
      return added - dups;
    }
    return added;
  }

  /**
   * 내용 지문(SHA-256)으로 중복을 잡아낸다. 이름이 달라도 바이트가 같으면 중복이다.
   * AI에 보내기 전에 걸러내야 할당량이 낭비되지 않는다.
   */
  async function markDuplicates() {
    const fresh = state.items.filter(i => i.status === 'pending' && !i.hash);
    if (!fresh.length) return 0;
    if (fresh.length > 5) log(`중복 검사 중… ${fresh.length}건`);

    // 이번 목록에서 이미 자리를 잡은 지문들 (같은 배치 안의 중복 판별용)
    const seen = new Map();
    for (const i of state.items) {
      if (i.hash && i.status !== 'dup') seen.set(i.hash, i.entry.name);
    }

    let dups = 0;
    for (const item of fresh) {
      try {
        const buf = await item.entry.handle.getFile().then(f => f.arrayBuffer());
        item.hash = await FS.sha256(buf);
      } catch (e) {
        log(`${item.entry.name}: 중복 검사 실패 — ${e.message}`, 'error');
        continue;
      }

      // 같은 배치 안의 원본이 먼저, 없으면 예전에 정리해 둔 파일과 대조
      const origin = seen.get(item.hash) || state.hashes[item.hash];
      if (origin) {
        item.status = 'dup';
        item.checked = false;
        item.error = `내용이 같은 파일이 이미 있습니다 → ${origin}`;
        dups++;
        log(`중복: ${item.entry.name} = ${origin}`);
      } else {
        seen.set(item.hash, item.entry.name);
      }
    }

    render();
    return dups;
  }

  el.btnPick.addEventListener('click', async () => {
    if (!FS.supported()) return;
    try {
      const handle = await FS.pickDirectory();
      state.items = [];
      await useDirectory(handle);
    } catch (e) {
      if (e.name !== 'AbortError') log('폴더 선택 실패: ' + e.message, 'error');
    }
  });

  el.btnRescan.addEventListener('click', () => scan());

  /* ── 분석 ─────────────────────────────────────── */
  async function analyzeAll() {
    formToSettings();
    if (!state.settings.apiKey) {
      log('먼저 Gemini API 키를 입력하세요.', 'error');
      el.apiKey.focus();
      return;
    }

    const queue = state.items.filter(i => i.status === 'pending');
    if (!queue.length) return;

    state.running = true; state.cancel = false;
    el.progressWrap.hidden = false;
    updateButtons();

    let done = 0;
    for (const item of queue) {
      if (state.cancel) { log('사용자가 중지했습니다.'); break; }

      item.status = 'working';
      progress(done, queue.length, item.entry.name);
      render();

      try {
        if (item.entry.size > Gemini.MAX_INLINE_BYTES) {
          throw new Error(`파일이 너무 큽니다 (${(item.entry.size / 1048576).toFixed(1)}MB / 최대 15MB)`);
        }

        await state.limiter.wait();
        if (state.cancel) { item.status = 'pending'; break; }

        const buf = await item.entry.handle.getFile().then(f => f.arrayBuffer());
        const result = await Gemini.analyzeDocument({
          apiKey: state.settings.apiKey,
          model: state.settings.model,
          base64: FS.toBase64(buf),
          mimeType: item.entry.mime,
          categories: knownCategories(),
          lang: state.settings.lang,
          onRetry: (msg, delay) => log(`재시도 대기 ${Math.round(delay / 1000)}초 — ${msg}`),
        });

        item.result = result;
        item.category = state.settings.useFolders ? FS.sanitize(result.category || '', 40, '기타') : '';
        item.newName = buildName(result, item.entry);
        item.status = 'ready';
        item.checked = true;
        log(`${item.entry.name} → ${item.category ? item.category + '/' : ''}${item.newName}`, 'ok');
      } catch (e) {
        item.status = 'error';
        item.error = e.message;
        item.checked = false;
        log(`${item.entry.name}: ${e.message}`, 'error');
      }

      done++;
      progress(done, queue.length);
      refreshCategoryList();
      render();
    }

    state.running = false;
    el.progressWrap.hidden = true;
    render();
    return state.items.filter(i => i.status === 'ready').length;
  }

  function progress(done, total, current = '') {
    el.progressBar.style.width = `${(done / total) * 100}%`;
    el.progressText.textContent = current
      ? `${done + 1} / ${total} — ${current} 분석 중…`
      : `${done} / ${total} 완료`;
  }

  el.btnAnalyze.addEventListener('click', () => analyzeAll());
  el.btnStop.addEventListener('click', () => { state.cancel = true; log('중지 요청됨…'); });

  /* ── 적용 ─────────────────────────────────────── */
  async function applySelected() {
    const targets = state.items.filter(i => i.status === 'ready' && i.checked);
    if (!targets.length) return 0;

    state.running = true;
    updateButtons();

    let ok = 0;
    for (const item of targets) {
      try {
        const name = FS.sanitize(item.newName.replace(/\.[^.]+$/, '')) + extOf(item.entry.name);
        const folder = state.settings.useFolders && item.category
          ? FS.sanitize(item.category, 60) : '';

        const res = await FS.renameAndMove(state.dirHandle, item.entry, name, folder);

        item.status = 'done';
        item.finalName = res.name;
        item.finalDir = res.dir;
        item.checked = false;
        // 원본 키와 결과 파일 키를 모두 기록해야, 이름만 바뀐 파일이
        // 다음 스캔에서 새 파일로 다시 잡히지 않는다.
        state.processed.add(Store.fileKey(item.entry.file));
        try { state.processed.add(Store.fileKey(await res.handle.getFile())); } catch (_) {}
        // 지문을 최종 위치와 함께 남겨야 나중에 같은 문서가 또 들어와도 잡힌다.
        if (item.hash) state.hashes[item.hash] = (res.dir ? res.dir + '/' : '') + res.name;
        ok++;
        log(`저장: ${res.dir ? res.dir + '/' : ''}${res.name}`, 'ok');
      } catch (e) {
        item.status = 'error';
        item.error = '적용 실패: ' + e.message;
        item.checked = false;
        log(`${item.entry.name} 적용 실패: ${e.message}`, 'error');
      }
    }

    Store.saveProcessed(state.processed);
    Store.saveHashes(state.hashes);
    state.running = false;

    try { folderCategories = await FS.listSubfolders(state.dirHandle); } catch (_) {}
    refreshCategoryList();
    render();
    return ok;
  }

  el.btnApply.addEventListener('click', () => applySelected());

  /* ── 자동 감시 ────────────────────────────────── */
  const WATCH_INTERVAL = 30000;

  async function watchTick() {
    if (state.running || !state.dirHandle) return;
    const added = await scan();
    if (!added) return;
    log(`자동 감시: 새 파일 ${added}건 처리 시작`);
    await analyzeAll();
    if (state.settings.autoApply && !state.cancel) {
      const n = await applySelected();
      log(`자동 적용 완료: ${n}건`, 'ok');
    }
  }

  function syncWatch() {
    clearInterval(state.watchTimer);
    state.watchTimer = null;
    if (state.settings.autoWatch) {
      state.watchTimer = setInterval(() => watchTick().catch(e => log(e.message, 'error')), WATCH_INTERVAL);
      log(`자동 감시 시작 (${WATCH_INTERVAL / 1000}초 간격)`);
    }
  }

  /* ── 기타 UI ──────────────────────────────────── */
  el.btnToggleKey.addEventListener('click', () => {
    const hidden = el.apiKey.type === 'password';
    el.apiKey.type = hidden ? 'text' : 'password';
    el.btnToggleKey.textContent = hidden ? '숨기기' : '보기';
  });

  el.btnTestKey.addEventListener('click', async () => {
    formToSettings();
    if (!state.settings.apiKey) { el.keyStatus.textContent = '키를 입력하세요.'; return; }
    el.keyStatus.textContent = '확인 중…';
    try {
      await Gemini.testKey(state.settings.apiKey);
      el.keyStatus.textContent = '✔ 키가 정상입니다.';
      log('API 키 확인 완료', 'ok');
    } catch (e) {
      el.keyStatus.textContent = '✖ ' + e.message;
      log('API 키 확인 실패: ' + e.message, 'error');
    }
  });

  /* 이 키로 실제 쓸 수 있는 모델로 목록을 갈아끼운다.
     모델 이름은 계속 바뀌므로 하드코딩 목록보다 이쪽이 정확하다. */
  el.btnLoadModels.addEventListener('click', async () => {
    formToSettings();
    if (!state.settings.apiKey) { el.modelStatus.textContent = '먼저 API 키를 입력하세요.'; return; }

    el.btnLoadModels.disabled = true;
    el.modelStatus.textContent = '불러오는 중…';
    try {
      const models = await Gemini.listModels(state.settings.apiKey);
      if (!models.length) throw new Error('사용 가능한 모델이 없습니다.');

      const current = state.settings.model;
      el.model.innerHTML = models
        .map(m => `<option value="${escapeAttr(m.id)}">${escapeHtml(m.id)}</option>`).join('');

      // 쓰던 모델이 목록에 없으면 첫 번째로 대체하고 알린다.
      if (models.some(m => m.id === current)) {
        el.model.value = current;
        el.modelStatus.textContent = `✔ ${models.length}개 확인 — 현재 ${current}`;
      } else {
        el.model.value = models[0].id;
        formToSettings();
        el.modelStatus.textContent = `✔ ${models.length}개 확인 — ${current}는 쓸 수 없어 ${models[0].id}로 변경했습니다.`;
      }
      log(`사용 가능한 모델 ${models.length}개 확인`, 'ok');
    } catch (e) {
      el.modelStatus.textContent = '✖ ' + e.message;
      log('모델 목록 불러오기 실패: ' + e.message, 'error');
    } finally {
      el.btnLoadModels.disabled = false;
    }
  });

  el.btnSettings.addEventListener('click', () => {
    el.settings.hidden = !el.settings.hidden;
  });

  el.btnClearLog.addEventListener('click', () => { el.log.textContent = ''; });

  for (const key of Object.keys(FIELDS)) {
    el[key].addEventListener('change', () => {
      formToSettings();
      if (key === 'autoWatch') syncWatch();
      if (key === 'categories') refreshCategoryList();
    });
  }

  window.addEventListener('beforeunload', e => {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ── 시작 ─────────────────────────────────────── */
  (async function init() {
    if (!FS.supported()) {
      el.unsupported.hidden = false;
      el.btnPick.disabled = true;
      return;
    }
    settingsToForm();
    refreshCategoryList();
    render();
    syncWatch();

    // 지난번 폴더를 권한이 살아있으면 조용히 다시 연결
    const saved = await Store.loadDirHandle();
    if (saved && await FS.ensurePermission(saved, false)) {
      await useDirectory(saved, { announce: false });
      log(`지난 폴더 다시 연결: ${saved.name}`);
    } else if (saved) {
      el.folderName.textContent = `${saved.name} (권한 필요 — 폴더 선택을 다시 눌러주세요)`;
    }
  })();
})();
