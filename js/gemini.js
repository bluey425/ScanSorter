/* Gemini API 클라이언트 — 브라우저에서 Google로 직접 요청 */
const Gemini = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /* 인라인 첨부 한도(요청 전체 20MB)를 넘지 않도록 여유를 둔 값 */
  const MAX_INLINE_BYTES = 15 * 1024 * 1024;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 무료 플랜 RPM에 맞춰 요청 간격을 벌리는 간단한 토큰 버킷 */
  class RateLimiter {
    constructor(rpm) { this.setRpm(rpm); this.last = 0; }
    setRpm(rpm) { this.interval = 60000 / Math.max(1, Number(rpm) || 10); }
    async wait() {
      const gap = this.last + this.interval - Date.now();
      if (gap > 0) await sleep(gap);
      this.last = Date.now();
    }
  }

  const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      date:       { type: 'string', description: '문서의 핵심 날짜 YYYY-MM-DD, 없으면 빈 문자열' },
      docType:    { type: 'string', description: '문서 종류' },
      issuer:     { type: 'string', description: '발행처/기관/회사명, 없으면 빈 문자열' },
      title:      { type: 'string', description: '문서 핵심 내용을 나타내는 짧은 제목' },
      category:   { type: 'string', description: '분류 폴더 이름' },
      summary:    { type: 'string', description: '한 문장 요약' },
      confidence: { type: 'number', description: '0.0~1.0 확신도' },
    },
    required: ['date', 'docType', 'issuer', 'title', 'category', 'summary', 'confidence'],
    propertyOrdering: ['date', 'docType', 'issuer', 'title', 'category', 'summary', 'confidence'],
  };

  function buildPrompt({ categories, lang }) {
    const catLine = categories.length
      ? `아래 기존 분류 중 가장 알맞은 것을 **글자 그대로** 골라 category에 넣으세요. 어느 것에도 해당하지 않을 때만 새 분류를 만드세요.\n기존 분류: ${categories.join(', ')}`
      : '문서 성격에 맞는 분류를 2~6글자의 간결한 명사로 직접 정하세요. (예: 세금계산서, 계약서, 의료, 금융, 공문서, 영수증)';

    const langLine = lang === 'en'
      ? 'Write every field in English.'
      : lang === 'auto'
        ? '문서에 쓰인 주요 언어로 각 항목을 작성하세요.'
        : '모든 항목을 한국어로 작성하세요.';

    return [
      '당신은 문서를 정리하는 사서입니다. 첨부된 스캔 문서(이미지 기반일 수 있음)를 끝까지 읽고 아래 정보를 추출하세요.',
      '',
      '- date: 문서의 가장 중요한 날짜(발행일·계약일·진료일 등)를 YYYY-MM-DD 형식으로. 판단이 안 되면 빈 문자열.',
      '- docType: 문서 종류를 짧은 명사로. (예: 세금계산서, 계약서, 영수증, 진단서, 성적증명서, 공문, 안내문, 청구서)',
      '- issuer: 발행한 기관·회사·병원·관공서 이름. 없으면 빈 문자열. 법인격 표기(주식회사 등)는 생략.',
      '- title: 이 문서가 무엇인지 한눈에 알 수 있는 20자 이내의 제목. 문서 제목을 그대로 베끼기보다 핵심 대상·용건이 드러나게.',
      `- category: ${catLine}`,
      '- summary: 문서 내용을 한 문장으로.',
      '- confidence: 내용을 얼마나 확실하게 읽었는지 0.0~1.0.',
      '',
      langLine,
      '중요: date를 제외한 모든 값에 \\ / : * ? " < > | 문자와 줄바꿈을 절대 쓰지 마세요. 파일 이름으로 사용됩니다.',
      '문서가 비어 있거나 판독 불가능하면 title은 "판독불가", confidence는 0으로 하세요.',
    ].join('\n');
  }

  function parseError(status, body) {
    const msg = body?.error?.message || '';
    if (status === 400 && /API key not valid/i.test(msg)) return 'API 키가 유효하지 않습니다.';
    if (status === 401 || status === 403) return 'API 키 권한이 없습니다. 키를 다시 확인하세요.';
    if (status === 429) return '무료 플랜 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나 RPM을 낮추세요.';
    if (status === 404) return '선택한 모델을 사용할 수 없습니다. 다른 모델을 골라보세요.';
    return `${status} ${msg || '알 수 없는 오류'}`;
  }

  async function request(url, options, { retries = 4, onRetry } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(url, options);
      } catch (e) {
        lastErr = new Error('네트워크 오류: ' + e.message);
        if (attempt === retries) break;
        const delay = 3000 * (attempt + 1);
        onRetry?.(lastErr.message, delay);
        await sleep(delay);
        continue;
      }

      if (res.ok) return res.json();

      let body = null;
      try { body = await res.json(); } catch (_) {}
      const message = parseError(res.status, body);

      // 재시도 가치가 있는 상태 코드만 다시 시도
      const retryable = res.status === 429 || res.status === 500 || res.status === 503;
      if (!retryable || attempt === retries) throw new Error(message);

      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const delay = retryAfter > 0 ? retryAfter : Math.min(60000, 5000 * Math.pow(2, attempt));
      onRetry?.(message, delay);
      await sleep(delay);
      lastErr = new Error(message);
    }
    throw lastErr;
  }

  /* 키 유효성만 가볍게 확인 */
  async function testKey(apiKey) {
    const data = await request(`${BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
      { method: 'GET' }, { retries: 0 });
    return Array.isArray(data.models);
  }

  /**
   * 문서 한 건을 분석한다.
   * @returns {{date,docType,issuer,title,category,summary,confidence}}
   */
  async function analyzeDocument({ apiKey, model, base64, mimeType, categories, lang, onRetry }) {
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: buildPrompt({ categories, lang }) },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    // 2.5 계열은 사고 예산을 최소화해 무료 할당량을 아낀다.
    if (model.startsWith('gemini-2.5')) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const data = await request(
      `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { onRetry },
    );

    const cand = data.candidates?.[0];
    if (!cand) {
      const blocked = data.promptFeedback?.blockReason;
      throw new Error(blocked ? `요청이 차단되었습니다 (${blocked})` : '응답이 비어 있습니다.');
    }
    if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
      throw new Error(`응답이 중단되었습니다 (${cand.finishReason})`);
    }

    const text = (cand.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('응답 본문이 비어 있습니다.');

    try {
      return JSON.parse(text);
    } catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('응답을 JSON으로 해석하지 못했습니다.');
    }
  }

  return { RateLimiter, analyzeDocument, testKey, MAX_INLINE_BYTES };
})();
