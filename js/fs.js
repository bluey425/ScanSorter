/* File System Access API 래퍼 — 폴더 읽기, 이름 변경, 하위 폴더로 이동 */
const FS = (() => {

  const EXT = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    tif: 'image/tiff', tiff: 'image/tiff',
  };

  const supported = () => typeof window.showDirectoryPicker === 'function';

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }
  function mimeOf(name) { return EXT[extOf(name)] || null; }
  function isSupportedFile(name) {
    return !name.startsWith('.') && !name.startsWith('~$') && !!mimeOf(name);
  }

  async function pickDirectory() {
    return window.showDirectoryPicker({ id: 'scansorter', mode: 'readwrite', startIn: 'documents' });
  }

  /* 저장된 핸들 재사용 시 권한이 살아있는지 확인 */
  async function ensurePermission(handle, interactive = true) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  /* 최상위 파일 목록 (하위 폴더는 순회하지 않음) */
  async function listFiles(dirHandle) {
    const out = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file' || !isSupportedFile(name)) continue;
      const file = await handle.getFile();
      out.push({ name, handle, file, size: file.size, mime: mimeOf(name) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  /* 기존 하위 폴더 이름 — 분류 후보로 재사용 */
  async function listSubfolders(dirHandle) {
    const out = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'directory' && !name.startsWith('.')) out.push(name);
    }
    return out.sort((a, b) => a.localeCompare(b, 'ko'));
  }

  /* Windows/macOS 양쪽에서 안전한 파일·폴더명으로 정리 */
  const FORBIDDEN = /[\\/:*?"<>|]/g;
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

  function sanitize(name, maxLen = 120, fallback = '무제') {
    let s = String(name)
      .replace(CONTROL, '')
      .replace(FORBIDDEN, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');            // Windows: 끝의 마침표·공백 금지
    if (!s) return fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
    if (s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s;
  }

  async function fileExists(dirHandle, name) {
    try { await dirHandle.getFileHandle(name); return true; }
    catch { return false; }
  }

  /* 중복 시 " (2)", " (3)" ... 을 붙여 고유 이름 생성 */
  async function uniqueName(dirHandle, name, ignoreName = null) {
    if (name === ignoreName) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name, n = 1;
    while (await fileExists(dirHandle, candidate)) {
      if (candidate === ignoreName) break;
      n += 1;
      candidate = `${base} (${n})${ext}`;
    }
    return candidate;
  }

  /**
   * 파일을 새 이름으로 바꾸고, 필요하면 분류 폴더를 만들어 그 안으로 옮긴다.
   * 반환: { dir, name, moved, handle } 최종 위치
   */
  async function renameAndMove(rootHandle, entry, newName, folderName) {
    const destDir = folderName
      ? await rootHandle.getDirectoryHandle(folderName, { create: true })
      : rootHandle;

    const sameDir = !folderName;
    const finalName = await uniqueName(destDir, newName, sameDir ? entry.name : null);

    if (sameDir && finalName === entry.name) {
      return { dir: '', name: finalName, moved: false, handle: entry.handle };
    }

    // Chrome 111+ : 원자적 이동. 실패하면 복사 후 삭제로 대체.
    if (typeof entry.handle.move === 'function') {
      try {
        await entry.handle.move(destDir, finalName);
        return { dir: folderName || '', name: finalName, moved: true, handle: entry.handle };
      } catch (e) {
        if (e && e.name === 'NotAllowedError') throw e;
        /* 그 외 오류는 아래 폴백으로 처리 */
      }
    }

    const newHandle = await destDir.getFileHandle(finalName, { create: true });
    const writable = await newHandle.createWritable();
    try {
      await writable.write(await entry.handle.getFile());
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      try { await destDir.removeEntry(finalName); } catch (_) {}
      throw e;
    }
    await rootHandle.removeEntry(entry.name);
    return { dir: folderName || '', name: finalName, moved: true, handle: newHandle };
  }

  /* 파일 내용의 SHA-256 지문 — 이름이 달라도 같은 문서인지 판별하는 데 쓴다 */
  async function sha256(arrayBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* 대용량에서도 스택이 넘치지 않는 base64 변환 */
  function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  return {
    supported, pickDirectory, ensurePermission, listFiles, listSubfolders,
    sanitize, uniqueName, renameAndMove, toBase64, sha256, mimeOf, isSupportedFile,
  };
})();
