/* 설정 · 폴더 핸들 · 처리 기록 저장소 */
const Store = (() => {
  const SETTINGS_KEY = 'scansorter.settings';
  const PROCESSED_KEY = 'scansorter.processed';
  const HASHES_KEY = 'scansorter.hashes';
  const DB_NAME = 'scansorter';
  const DB_STORE = 'handles';

  const defaults = {
    apiKey: '',
    model: 'gemini-2.5-flash',
    rpm: 10,
    lang: 'ko',
    template: '{date}_{issuer}_{title}',
    categories: '',
    useFolders: true,
    skipProcessed: true,
    dupCheck: true,
    autoWatch: false,
    autoApply: false,
  };

  function loadSettings() {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch { return { ...defaults }; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  /* 처리 기록: "이름:크기:수정시각" 키 집합 — 같은 파일 재분석 방지 */
  function fileKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }
  function loadProcessed() {
    try { return new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveProcessed(set) {
    // 무한 증가 방지: 최근 3000건만 유지
    const arr = [...set].slice(-3000);
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
  }

  /* 정리를 마친 파일의 내용 지문 → 최종 위치.
     이름이 달라도 내용이 같으면 중복으로 잡아내기 위해 남긴다. */
  function loadHashes() {
    try { return JSON.parse(localStorage.getItem(HASHES_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveHashes(map) {
    const entries = Object.entries(map);
    const trimmed = entries.length > 5000
      ? Object.fromEntries(entries.slice(-5000))   // 무한 증가 방지
      : map;
    localStorage.setItem(HASHES_KEY, JSON.stringify(trimmed));
  }

  /* 디렉터리 핸들은 IndexedDB에만 저장 가능 (구조화 복제 대상) */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    defaults, loadSettings, saveSettings,
    fileKey, loadProcessed, saveProcessed, loadHashes, saveHashes,
    saveDirHandle: h => idbSet('scanDir', h),
    loadDirHandle: () => idbGet('scanDir').catch(() => null),
  };
})();
