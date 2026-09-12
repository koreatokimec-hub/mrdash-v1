/**
 * 손익 대시보드 — 로그인 + 데이터 로더
 *
 * 기존 ui_rag.html은 파일 안의 암호화된 TKP_MODEL을 그대로 읽어 쓰던 구조였다.
 * 이 스크립트는 그 자리를 대신한다:
 *   1) 로그인 화면을 띄우고
 *   2) 성공하면 GAS에서 team/teamitem/problem/vendor를 한 번에 받아 TKP_MODEL 모양으로 조립하고
 *   3) 거래처(partner)만 화면에서 기간을 바꿀 때마다 그때그때 받아온다 (제일 크고, 이름+금액이 실려서
 *      "F12로 43개월 전부가 보이는" 문제의 핵심이었던 데이터라 여기만 지연 로딩한다)
 *
 * 기존 화면 코드(teamMonthRows/problemRowsRaw/customerTableRows/buildDATA)는 압축 배열 대신
 * 이름 있는 평범한 객체를 읽도록 그 4곳만 고친다. 나머지 렌더링 로직은 그대로 둔다.
 */

const GAS_URL = "https://script.google.com/macros/s/AKfycbx1rBiqSLllTjra733b7uqK-rJFPQIwmFnk7wKJkLmmQNSaAzOWSb0RDZYZPxh1A0mY1w/exec";

// 로그인 성공 시 채워진다. 화면 코드는 이 객체를 TKP_MODEL 대신 참조한다.
window.TKP = {
  ready: false,
  team: [],       // 43개월 × 팀 (한 번에 전부)
  teamitem: [],   // 43개월 × (팀 + 품목) (한 번에 전부)
  problem: [],    // 점검판매 5종 통합, 43개월 전부 (챗봇 담당자 인식 때문에 전부 필요)
  vendor: [],     // 43개월 × 협력업체 (한 번에 전부)
  partnerCache: new Map(), // key: "YYYY-MM" -> 그 달 거래처 배열. 한 번 받으면 재요청 안 함
};

let SESSION = sessionStorage.getItem('mrdash_session') || '';
let ME = sessionStorage.getItem('mrdash_name') || '';

/**
 * GAS가 가끔 순간적으로 오류(주로 404/503)를 낸다 — 재배포 지연 때문일 수도 있고
 * 구글 쪽 일시적 문제일 수도 있다. upload.py/test_auth.py에서도 겪은 문제라
 * 같은 방식(몇 번 재시도)으로 대응한다.
 */
async function gasCall(payload, attempt = 1) {
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORS 사전요청(preflight) 회피
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    return await res.json();
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return gasCall(payload, attempt + 1);
  }
}

/**
 * 로그인 시 한 번에 받는 것들. team/teamitem/vendor는 작아서 부담 없고,
 * problem은 크지만(23,238행) 챗봇의 담당자 인식이 전체를 요구해서 어차피 필요하다.
 * partner(거래처, 10,578행)만 여기서 안 받는다 — 그게 유일하게 진짜 지연 로딩 대상이다.
 */
// 화면 코드가 참조하는 전역 이름. dataset 키와 다르게 대문자로 둬서
// window.TKP(TKP_MODEL이 아니라 이 로더가 만든 객체)와 헷갈리지 않게 한다.
const GLOBAL_NAME = { team: 'TKP_TEAM', teamitem: 'TKP_TEAMITEM', problem: 'TKP_PROBLEM', vendor: 'TKP_VENDOR' };

async function loadFullDatasets(onProgress) {
  const datasets = ['team', 'teamitem', 'problem', 'vendor'];
  for (const ds of datasets) {
    onProgress?.(ds);
    const r = await gasCall({ action: 'data', session: SESSION, dataset: ds, month: null });
    if (!r.ok) throw new Error(r.error || `${ds} 로딩 실패`);
    window.TKP[ds] = r.rows;
    window[GLOBAL_NAME[ds]] = r.rows; // 화면 코드는 이 이름으로 참조한다 (예: window.TKP_TEAMITEM)
  }
}

/**
 * 거래처 데이터를 필요한 만큼만 받는다. 이미 받은 달은 다시 요청하지 않는다.
 * customerScopeIndices() 가 돌려주는 월 인덱스들을 M41(라벨 배열)로 변환해 넘겨받는다.
 *
 * @param {string[]} months  "YYYY-MM" 형식의 월 목록 (기간 선택에 해당하는 달들)
 * @returns {object[]}  그 달들의 거래처 행을 합친 배열 (customerTableRows가 바로 쓸 수 있는 모양)
 */
async function ensurePartnerMonths(months) {
  const missing = months.filter(m => !window.TKP.partnerCache.has(m));
  if (missing.length) {
    // 없는 달들을 한 번의 요청으로 묶어서 받는다 ("전체" 선택 시 43번 나눠 부르지 않도록).
    const r = await gasCall({ action: 'data', session: SESSION, dataset: 'partner', months: missing });
    if (!r.ok) throw new Error(r.error || '거래처 데이터 로딩 실패');

    // 받은 걸 달별로 다시 나눠 캐시에 저장한다. 서버가 그 달 자료를 아예 안 줬다면(원본에
    // 없는 달) 빈 배열로 표시해 다음에 또 요청하지 않게 한다.
    const byMonth = new Map(missing.map(m => [m, []]));
    r.rows.forEach(row => byMonth.get(row.month)?.push(row));
    byMonth.forEach((rows, m) => window.TKP.partnerCache.set(m, rows));
  }
  return months.flatMap(m => window.TKP.partnerCache.get(m) || []);
}

// ── 로그인 화면 ──────────────────────────────────────────

function renderLoginScreen() {
  const box = document.createElement('div');
  box.id = 'mrdashLogin';
  box.innerHTML = `
    <style>
      /* html.dashboard-loading body{visibility:hidden} 규칙이 이 오버레이까지 숨기므로
         명시적으로 되돌린다 — visibility는 조상이 hidden이어도 자손에서 visible로 뒤집을 수 있다 */
      #mrdashLogin{position:fixed;inset:0;background:#f4f4f6;z-index:99999;visibility:visible;
        display:flex;align-items:center;justify-content:center;
        font-family:system-ui,"Malgun Gothic",sans-serif}
      #mrdashLogin .card{background:#fff;padding:24px;border-radius:12px;width:300px;
        box-shadow:0 2px 10px rgba(0,0,0,.08)}
      #mrdashLogin h1{font-size:16px;margin:0 0 14px}
      #mrdashLogin input{width:100%;padding:9px;margin-bottom:9px;border:1px solid #ccc;
        border-radius:7px;font-size:14px;box-sizing:border-box}
      #mrdashLogin button{width:100%;padding:10px;background:#1a73e8;color:#fff;
        border:none;border-radius:7px;font-weight:600;cursor:pointer}
      #mrdashLogin button:disabled{opacity:.5}
      #mrdashLogin .msg{font-size:12.5px;color:#c62828;min-height:18px;margin-top:4px}
    </style>
    <div class="card">
      <h1>손익 대시보드 로그인</h1>
      <input id="mrdashName" placeholder="이름" autocomplete="username">
      <input id="mrdashPw" type="password" placeholder="비밀번호" autocomplete="current-password">
      <button id="mrdashBtn">로그인</button>
      <div class="msg" id="mrdashMsg"></div>
    </div>`;
  document.body.appendChild(box);

  const $ = id => document.getElementById(id);
  const submit = () => doLogin($('mrdashName').value.trim(), $('mrdashPw').value);
  $('mrdashBtn').addEventListener('click', submit);
  $('mrdashPw').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function doLogin(name, password) {
  const $btn = document.getElementById('mrdashBtn');
  const $msg = document.getElementById('mrdashMsg');
  if (!name || !password) { $msg.textContent = '이름과 비밀번호를 입력하세요'; return; }

  $btn.disabled = true;
  $msg.style.color = '#555';
  $msg.textContent = '확인 중...';
  try {
    const r = await gasCall({ action: 'login', name, password });
    if (!r.ok) { $msg.style.color = '#c62828'; $msg.textContent = r.error; return; }

    SESSION = r.session; ME = r.name;
    sessionStorage.setItem('mrdash_session', SESSION);
    sessionStorage.setItem('mrdash_name', ME);

    $msg.style.color = '#555';
    $msg.textContent = '데이터를 불러오는 중...';
    await loadFullDatasets(ds => { $msg.textContent = `불러오는 중... (${ds})`; });

    window.TKP.ready = true;
    document.getElementById('mrdashLogin').remove();
    window.dispatchEvent(new CustomEvent('mrdash:ready')); // 화면 코드가 이 시점부터 그리기 시작
  } catch (e) {
    $msg.style.color = '#c62828';
    $msg.textContent = '연결 실패: ' + e.message;
  } finally {
    $btn.disabled = false;
  }
}

// 이미 로그인된 세션이 있으면(같은 탭, 새로고침) 다시 로그인 화면을 안 띄우고 바로 데이터만 받는다.
// 세션이 만료됐으면 서버가 401 성격의 에러를 주므로 그때는 로그인 화면으로 되돌린다.
async function boot() {
  if (SESSION) {
    try {
      await loadFullDatasets();
      window.TKP.ready = true;
      window.dispatchEvent(new CustomEvent('mrdash:ready'));
      return;
    } catch (e) {
      sessionStorage.removeItem('mrdash_session');
      sessionStorage.removeItem('mrdash_name');
      SESSION = '';
    }
  }
  renderLoginScreen();
}

boot();
