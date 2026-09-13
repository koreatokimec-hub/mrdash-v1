/**
 * 손익 대시보드 — 로그인 + 데이터 로더 (2차 개정)
 *
 * 1차 버전 대비 바뀐 것:
 *   - 로그인·요약·팀·거래처점검을 요청 1번(loginAndBoot)으로 합침
 *     (따로 부르면 왕복마다 고정 오버헤드가 붙어 그것만으로 수십 초가 든다)
 *   - 팀품목(teamitem)·점검판매(problem)도 거래처처럼 "연 화면의 달만" 받아온다
 *     (전체를 로그인 시 다 받던 걸 없앰 — 초기 로딩이 느렸던 진짜 원인)
 *   - 파일에 내장된 TKP_MODEL은 화면을 마지막으로 만들 때의 스냅샷이 박제돼 있어
 *     최신월이 항상 그 시점(예: 2026-05)으로 나온다. summary로 즉시 덮어쓴다.
 */

const GAS_URL = "https://script.google.com/macros/s/AKfycbx1rBiqSLllTjra733b7uqK-rJFPQIwmFnk7wKJkLmmQNSaAzOWSb0RDZYZPxh1A0mY1w/exec";

window.TKP = {
  ready: false,
  team: [], teamitem: [], problem: [], vendor: [], summary: [],
  partnerCache: new Map(),   // "YYYY-MM" -> 그 달 거래처 행
  teamitemCache: new Map(),  // "YYYY-MM" -> 그 달 팀품목 행
  problemCache: new Map(),   // "YYYY-MM" -> 그 달 점검판매 행
  problemFullyLoaded: false, // 챗봇 담당자 인식은 전체가 필요 — 첫 사용 시 한 번만 전부 받는다
};

let SESSION = sessionStorage.getItem('mrdash_session') || '';
let ME = sessionStorage.getItem('mrdash_name') || '';
const BOOT_CACHE_KEY = 'mrdash_boot_v1';

function saveBootCache(payload) {
  try {
    sessionStorage.setItem(BOOT_CACHE_KEY, JSON.stringify({
      session: SESSION, name: ME, delivery: payload.delivery,
      summary: payload.summary, team: payload.team, vendor: payload.vendor || []
    }));
  } catch (e) { /* 저장 공간이 부족하면 기존 서버 경로를 그대로 쓴다 */ }
}

function readBootCache() {
  try {
    const cached=JSON.parse(sessionStorage.getItem(BOOT_CACHE_KEY)||'null');
    return cached && cached.session===SESSION && cached.delivery && cached.summary?.length ? cached : null;
  } catch (e) { return null; }
}

function clearBootCache() { sessionStorage.removeItem(BOOT_CACHE_KEY); }

/**
 * GAS가 가끔 순간적으로 오류(404/503)를 낸다 — 몇 번 재시도한다.
 *
 * 그리고 로그인 직후엔 또 다른 종류의 일시적 문제가 있다: loginAndBoot가 세션을
 * 시트에 쓴 직후, 화면이 곧바로 여러 data 요청(팀품목·점검판매 등)을 동시에
 * 보내면 그중 일부가 "방금 만든 세션"을 아직 못 찾아 로그인 필요 오류를 준다
 * (시트 쓰기가 다른 요청에서 보이기까지의 아주 짧은 시차 때문). 이건 네트워크
 * 예외가 아니라 200 응답 안에 {ok:false} 로 담겨오므로 아래에서 따로 잡아야 한다.
 */
async function gasCall(payload, attempt = 1) {
  let body;
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORS 사전요청(preflight) 회피
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    body = await res.json();
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return gasCall(payload, attempt + 1);
  }

  const isSessionRace = !body.ok && payload.session && /로그인/.test(body.error || '');
  const isBusyLogin = !body.ok && body.retry === true;
  if (isBusyLogin && attempt < 4) {
    await new Promise(r => setTimeout(r, 500 * attempt));
    return gasCall(payload, attempt + 1);
  }
  if (isSessionRace && attempt < 4) {
    await new Promise(r => setTimeout(r, 500 * attempt));
    return gasCall(payload, attempt + 1);
  }
  return body;
}

// ── 초기 화면에 필요한 작은 데이터(요약/팀/거래처점검) ──────

/**
 * GAS가 아니라 GitHub Pages(CDN)에서 암호화된 JSON을 받아온다. 키/iv는 로그인한
 * 사람에게만 GAS가 내려주고, 실제 큰 데이터 본체는 CDN이 서빙한다 — GAS는
 * "누구인지 확인 + 열쇠 전달"만 하고 무거운 전송은 안 맡는다는 게 핵심이다.
 * 메인 모델과 점검판매 전체이력 둘 다 이 함수를 같이 쓴다.
 */
async function fetchEncryptedJson(delivery){
  const url = new URL(delivery.file, location.href);
  url.searchParams.set('v', delivery.hash);
  const response = await fetch(url, {cache:'force-cache'});
  if (!response.ok) throw new Error('암호화 데이터 파일을 불러오지 못했습니다.');
  const encrypted = await response.arrayBuffer();
  const keyBytes = Uint8Array.from(atob(delivery.key), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(delivery.iv), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, {name:'AES-GCM'}, false, ['decrypt']);
  const compressed = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv}, key, encrypted));
  const bytes = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
  if (hash !== delivery.hash) throw new Error('데이터 검증 실패');
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function applyBootPayload(r) {
  let model, hash;
  if (r.delivery) {
    model = await fetchEncryptedJson(r.delivery);
    hash = r.delivery.hash;
  } else if (r.model?.gzip) {
    const compressed = Uint8Array.from(atob(r.model.gzip), c => c.charCodeAt(0));
    const bytes = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
    if (hash !== r.model.hash) throw new Error('데이터 검증 실패');
    model = JSON.parse(new TextDecoder().decode(bytes));
  } else {
    throw new Error('서버 데이터가 준비되지 않았습니다.');
  }
  const latest = [...r.summary].map(row=>row.month).sort().pop();
  if (model.latest !== latest || model.months.length !== r.summary.length) throw new Error('자료 버전이 일치하지 않습니다. 관리자에게 문의해 주세요.');
  window.TKP_MODEL=model;
  window.TKP_MODEL_HASH=hash;
  window.TKP.team = r.team; window.TKP_TEAM = r.team;
  window.TKP.vendor = r.vendor; window.TKP_VENDOR = r.vendor;
  window.TKP.summary = r.summary; window.TKP_SUMMARY = r.summary;
}

/**
 * 파일 안에 내장된 TKP_MODEL의 months/labels/latest/sales/profit/rates 를
 * 실제 서버 데이터(summary)로 덮어쓴다. 이게 없으면 화면이 항상 파일 제작 시점의
 * 옛 스냅샷 월을 "최신월"로 표시한다.
 */
function patchModelWithLiveSummary(summaryRows) {
  const M = window.TKP_MODEL;
  if (!M || !summaryRows || !summaryRows.length) return;

  const rows = [...summaryRows].sort((a, b) => a.month < b.month ? -1 : 1);
  const won = v => +v || 0;
  const eok = v => won(v) / 1e8; // 원 -> 억

  M.months = rows.map(r => r.month);
  M.labels = rows.map(r => { const [y, m] = r.month.split('-'); return `${y.slice(2)}.${+m}`; });
  M.latest = M.months[M.months.length - 1];

  M.sales = {
    goods: rows.map(r => eok(r.sales_goods)),
    product: rows.map(r => eok(r.sales_product)),
    other: rows.map(r => eok(r.sales_etc)),
    all: rows.map(r => eok(r.sales_total)),
  };
  M.profit = {
    goods: rows.map(r => eok(r.profit_goods)),
    product: rows.map(r => eok(r.profit_product)),
    other: rows.map(r => eok(r.profit_etc)),
    all: rows.map(r => eok(r.profit_total)),
  };
  // salesWon/profitWon: sales/profit(억 단위)와 별개로 원 단위 그대로도 쓰는 곳이 있다
  // (팀별 손익 현황의 "당월 매출 구성" 등). 안 채우면 그쪽 계산이 NaN이 된다.
  M.salesWon = {
    goods: rows.map(r => won(r.sales_goods)),
    product: rows.map(r => won(r.sales_product)),
    other: rows.map(r => won(r.sales_etc)),
    all: rows.map(r => won(r.sales_total)),
  };
  M.profitWon = {
    goods: rows.map(r => won(r.profit_goods)),
    product: rows.map(r => won(r.profit_product)),
    other: rows.map(r => won(r.profit_etc)),
    all: rows.map(r => won(r.profit_total)),
  };
  M.rates = {
    all: rows.map(r => won(r.sales_total) ? won(r.profit_total) / won(r.sales_total) * 100 : 0),
  };
}

/**
 * 파일에 내장된 teamSeries는 팀 이름 표기까지 다른 더 오래된 스냅샷(41개월,
 * "산기시스템팀" 표기)이라 지금 팀명("산기 시스템팀")과 안 맞고 개월수도 부족하다.
 * 이미 전체 로딩된 team 데이터(44개월×전체 팀, 정확함)로 통째로 다시 만든다.
 */
const BU_SHORT_NAME = { 'HPC B.U': 'HPC', 'PMC B.U': 'PMC', '기획 생산 B.U': '기획/생산' };

function patchTeamSeries(teamRows) {
  const M = window.TKP_MODEL;
  if (!M || !teamRows || !teamRows.length) return;

  const months = M.months; // patchModelWithLiveSummary가 이미 정리해둔 최신 월 순서
  const byTeam = new Map();
  const byBu = new Map(); // 부문별 시계열(TKP.buSeries)도 같은 원본에서 같이 만든다
  teamRows.forEach(r => {
    if (!byTeam.has(r.team)) byTeam.set(r.team, new Map());
    byTeam.get(r.team).set(r.month, r);

    const short = BU_SHORT_NAME[r.bu] || r.bu;
    if (!byBu.has(short)) byBu.set(short, new Map());
    const bucket = byBu.get(short);
    const prev = bucket.get(r.month) || { sales: 0, profit: 0 };
    prev.sales += +r.m_sales_total || 0;
    prev.profit += +r.m_profit_total || 0;
    bucket.set(r.month, prev);
  });

  /**
   * teamSeries[팀명] 은 sales/profit 만으로 안 끝난다 — 팀 상세 팝업(openTeam)이
   * rate/gShare(상품비중)/gRate(상품이익률)/pRate(제품이익률)까지 요구한다.
   * 이게 없어서 팝업의 KPI 카드가 전부 "—"로 보이고 차트도 비어 있었다.
   * 전부 team 데이터(상품/제품/기타 4구분)에서 정확히 계산할 수 있다.
   *
   * bandProfit/loss/high18Share(이익률 구간 분포 관련) 는 team 데이터로는 못 만든다 —
   * 그건 padStaleArraysToCurrentLength가 패딩한 옛 값을 그대로 쓴다(부정확할 수 있음).
   */
  // 옛 teamSeries에 있던 loss/high18Share/bandProfit(밴드분포용, team 데이터로는 못 만듦)을
  // 이름으로 이어받는다 — 팀명 표기가 달라졌으므로(예: "산기시스템팀" -> "산기 시스템팀")
  // 공백을 지운 형태로 정규화해서 매칭한다.
  const norm = s => String(s || '').replace(/\s+/g, '');
  const staleByNormName = new Map();
  Object.entries(M.teamSeries || {}).forEach(([name, s]) => staleByNormName.set(norm(name), s));

  const teamSeries = {};
  byTeam.forEach((byMonth, teamName) => {
    const at = (m, field) => +(byMonth.get(m)?.[field]) || 0;
    const stale = staleByNormName.get(norm(teamName));
    teamSeries[teamName] = {
      loss: stale?.loss, high18Share: stale?.high18Share, bandProfit: stale?.bandProfit,
      sales: months.map(m => at(m, 'm_sales_total') / 1e8),
      profit: months.map(m => at(m, 'm_profit_total') / 1e8),
      rate: months.map(m => {
        const s = at(m, 'm_sales_total');
        return s ? at(m, 'm_profit_total') / s * 100 : 0;
      }),
      gShare: months.map(m => {
        const s = at(m, 'm_sales_total');
        return s ? at(m, 'm_sales_goods') / s * 100 : 0;
      }),
      gRate: months.map(m => {
        const s = at(m, 'm_sales_goods');
        return s ? at(m, 'm_profit_goods') / s * 100 : 0;
      }),
      pRate: months.map(m => {
        const s = at(m, 'm_sales_product');
        return s ? at(m, 'm_profit_product') / s * 100 : 0;
      }),
    };
  });
  M.teamSeries = teamSeries;

  const buSeries = {};
  byBu.forEach((byMonth, buName) => {
    buSeries[buName] = {
      sales: months.map(m => (byMonth.get(m)?.sales || 0) / 1e8),
      profit: months.map(m => (byMonth.get(m)?.profit || 0) / 1e8),
    };
  });
  M.buSeries = buSeries;
}

/**
 * M.bu 는 시계열이 아니라 "화면을 만든 시점의 당월/누계 스냅샷"이다
 * ({M:[[부문,매출,이익률],...], Y:[...]}) — 그래서 패딩(마지막 값 복제)으로는
 * 못 고친다. team 데이터로 최신월 기준 부문별 합계를 다시 계산해서 덮어쓴다.
 */
function patchBuSnapshot(teamRows) {
  const M = window.TKP_MODEL;
  if (!M || !teamRows || !teamRows.length) return;

  const latest = M.months[M.months.length - 1];
  const year = latest.slice(0, 4);

  const snapshot = scope => {
    const acc = new Map(); // 짧은 이름 -> {sales, profit}
    teamRows.forEach(r => {
      if (scope === 'M' && r.month !== latest) return;
      if (scope === 'Y' && !(r.month.startsWith(year) && r.month <= latest)) return;
      const short = BU_SHORT_NAME[r.bu] || r.bu;
      const a = acc.get(short) || { sales: 0, profit: 0 };
      a.sales += +r.m_sales_total || 0;
      a.profit += +r.m_profit_total || 0;
      acc.set(short, a);
    });
    return [...acc.entries()].map(([name, a]) => {
      const salesEok = a.sales / 1e8, profitEok = a.profit / 1e8;
      const rate = a.sales ? a.profit / a.sales * 100 : 0;
      return [name, +salesEok.toFixed(4), +rate.toFixed(3)];
    });
  };

  M.bu = { M: snapshot('M'), Y: snapshot('Y') };
}

/**
 * M.teams 는 [[팀명, 부문축약, 매출(억), 이익률], ...] 형태의 "당월 스냅샷"이고,
 * 화면 상수 TEAMS(=M.teams)가 페이지 전체에서 팀 이름의 기준(진실의 원천)으로 쓰인다.
 * 이게 옛 스냅샷 이름("공압사업팀", 공백 없음)이면 teamSeries 조회 키
 * ("공압 사업팀", 공백 있음, team 데이터의 실제 표기)와 어긋나 팀 상세 팝업이 깨진다.
 * 반드시 patchTeamSeries보다 먼저(또는 같이) 호출해 이름 기준을 통일해야 한다.
 */
function patchTeamsSnapshot(teamRows) {
  const M = window.TKP_MODEL;
  if (!M || !teamRows || !teamRows.length) return;

  const BU_SHORT2 = { 'HPC B.U': 'HPC', 'PMC B.U': 'PMC', '기획 생산 B.U': '기획 생산' };
  const latest = M.months[M.months.length - 1];

  M.teams = teamRows
    .filter(r => r.month === latest)
    .map(r => {
      const sales = +r.m_sales_total || 0, profit = +r.m_profit_total || 0;
      const rate = sales ? profit / sales * 100 : 0;
      return [r.team, BU_SHORT2[r.bu] || r.bu, +(sales / 1e8).toFixed(4), +rate.toFixed(3)];
    });
}

/**
 * customerHistory/itemHistory/bandTeamSeries 등은 원본 규모가 커서(거래처 610개 ×
 * 44개월 등) 이번엔 아직 손대지 못했다 — 그래도 최소한 "배열 길이가 달라 마지막
 * 달을 읽다 죽는" 사고는 막아야 한다. 부족한 개월 수만큼 마지막 값을 그대로
 * 복제해 채운다. 주의: 이러면 그 화면들의 "최신월" 값은 실제 최신이 아니라
 * 직전에 있던 값의 반복이다 — 부정확할 수 있다는 뜻이지, 실제 데이터가 아니다.
 */
// ── 지연 로딩 (거래처 / 팀품목 / 점검판매) ──────────────────
//
// 셋 다 같은 모양이라 함수 하나로 공유한다: 없는 달만 서버에 물어보고,
// 있는 달은 그대로 캐시에서 돌려준다.

// 완료 캐시와 별도로 진행 중인 월 요청을 공유한다.
const monthRequests = new Map();
const datasetRenderSequence = new Map();
async function ensureMonths(dataset, cache, globalName, months) {
  months = [...new Set(months)];
  const sequence = (datasetRenderSequence.get(dataset) || 0) + 1;
  datasetRenderSequence.set(dataset, sequence);
  const fresh = months.filter(m => !cache.has(m) && !monthRequests.has(dataset + ':' + m));
  if (fresh.length) {
    const task = (async () => {
      const r = await gasCall({ action: 'data', session: SESSION, dataset, months: fresh });
      // ok:true인데 rows가 없는(응답이 깨졌거나 잘린) 드문 경우도 방어한다 —
      // 안 그러면 forEach에서 그대로 죽어서 "불러오기 실패: undefined
      // forEach" 같은 원인 모를 에러로 화면에 뜬다.
      if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || `${dataset} 로딩 실패`);
      const byMonth = new Map(fresh.map(m => [m, []]));
      r.rows.forEach(row => byMonth.get(row.month)?.push(row));
      byMonth.forEach((rows, m) => cache.set(m, rows));
    })().finally(() => fresh.forEach(m => monthRequests.delete(dataset + ':' + m)));
    fresh.forEach(m => monthRequests.set(dataset + ':' + m, task));
  }
  await Promise.all([...new Set(months.map(m => monthRequests.get(dataset + ':' + m)).filter(Boolean))]);
  const merged = months.flatMap(m => cache.get(m) || []);
  // 늦게 끝난 이전 화면 요청이 최신 화면의 전역 데이터를 덮어쓰지 않는다.
  if (globalName && datasetRenderSequence.get(dataset) === sequence) window[globalName] = merged;
  return merged;
}

const ensurePartnerMonths = months => ensureMonths('partner', window.TKP.partnerCache, null, months);
const ensureTeamitemMonths = months => ensureMonths('teamitem', window.TKP.teamitemCache, 'TKP_TEAMITEM', months);
const ensureProblemMonths = months => ensureMonths('problem', window.TKP.problemCache, 'TKP_PROBLEM', months);

/**
 * 챗봇의 담당자 이름 인식은 43개월 전체를 훑어야 해서(누가 있었는지 미리 알아야 함)
 * 특정 달만으로는 안 된다. 그래서 이것만 예외적으로 "첫 사용 시 전체를 한 번" 받고,
 * 그 뒤로는 캐시를 재사용한다 — 로그인 때 항상 받는 게 아니라 챗봇을 실제로 열 때만.
 */
let allProblemRequest = null;
function ensureAllProblemLoaded() {
  if (!allProblemRequest) allProblemRequest = loadAllProblem().finally(() => { allProblemRequest = null; });
  return allProblemRequest;
}
async function loadAllProblem() {
  if (window.TKP.problemFullyLoaded) return window.TKP_PROBLEM;
  // 전체(2만 건 이상)를 CDN 암호화 파일로 한 번에 주는 방식은 써봤지만,
  // 로그인한 사람이면 누구나 F12로 전체 이력을 다 볼 수 있게 되는 문제가
  // 있어 되돌렸다 — 점검판매를 월별 시트로 쪼갠 뒤로는(2026-09) GAS로 직접
  // 받아도 이전만큼 느리진 않다. 이 전체 로딩은 챗봇 담당자 검색 때만 쓰여
  // 드물다.
  const r = await gasCall({ action: 'data', session: SESSION, dataset: 'problem', month: null });
  if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || 'problem 전체 로딩 실패');
  const rows = r.rows;

  const byMonth = new Map();
  rows.forEach(row => {
    if (!byMonth.has(row.month)) byMonth.set(row.month, []);
    byMonth.get(row.month).push(row);
  });
  byMonth.forEach((monthRows, m) => window.TKP.problemCache.set(m, monthRows));

  window.TKP_PROBLEM = rows;
  window.TKP.problemFullyLoaded = true;
  return rows;
}

// ── 로그인 화면 ──────────────────────────────────────────

function renderLoginScreen() {
  const box = document.createElement('div');
  box.id = 'mrdashLogin';
  box.innerHTML = `
    <style>
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
  if ($btn.disabled) return;
  const $msg = document.getElementById('mrdashMsg');
  if (!name || !password) { $msg.textContent = '이름과 비밀번호를 입력하세요'; return; }

  $btn.disabled = true;
  $msg.style.color = '#555';
  $msg.textContent = '확인 중...';
  try {
    let login = await gasCall({ action: 'loginAndBootLite', name, password });
    // 드물게 ok:true인데 session이 비어 오는 응답이 관찰됐다 — 원인 불명(GAS 쪽
    // 순간 이상)이라 코드로 재현·확정은 못 했지만, 재시도 한 번으로 보통 넘어간다.
    if (login.ok && !login.session) login = await gasCall({ action: 'loginAndBootLite', name, password });
    if (!login.ok) { $msg.style.color = '#c62828'; $msg.textContent = login.error; return; }
    if (!login.session) throw new Error('서버 로그인 응답이 올바르지 않습니다. 다시 시도해 주세요.');

    SESSION = login.session; ME = login.name;
    sessionStorage.setItem('mrdash_session', SESSION);
    sessionStorage.setItem('mrdash_name', ME);

    $msg.textContent = '데이터 불러오는 중...';
    const r = login;

    await applyBootPayload(r);
    saveBootCache(r);
    finishBoot();
  } catch (e) {
    $msg.style.color = '#c62828';
    $msg.textContent = '연결 실패: ' + e.message;
  } finally {
    if ($btn) $btn.disabled = false; // 로그인 성공 시 이 시점엔 이미 로그인 화면이 제거돼 있다
  }
}

function finishBoot() {
  window.TKP.ready = true;
  document.getElementById('mrdashLogin')?.remove();
  window.dispatchEvent(new CustomEvent('mrdash:ready')); // 화면 코드가 이 시점부터 그리기 시작
}

// 이미 로그인된 세션이 있으면(같은 탭, 새로고침) 로그인 화면 없이 boot만 다시 부른다.
// 세션이 만료됐으면 서버가 오류를 주므로 그때는 로그인 화면으로 되돌린다.
async function boot() {
  if (SESSION) {
    const cached=readBootCache();
    if(cached){
      try{
        await applyBootPayload(cached);
        finishBoot();
        gasCall({action:'bootLite',session:SESSION}).then(r=>{
          if(!r.ok)throw new Error(r.error||'로그인이 만료되었습니다.');
          saveBootCache(r);
        }).catch(()=>{
          clearBootCache();
          sessionStorage.removeItem('mrdash_session');
          sessionStorage.removeItem('mrdash_name');
          location.reload();
        });
        return;
      }catch(e){ clearBootCache(); }
    }
    try {
      const r = await gasCall({ action: 'bootLite', session: SESSION });
      if (!r.ok) throw new Error(r.error);
      await applyBootPayload(r);
      saveBootCache(r);
      finishBoot();
      return;
    } catch (e) {
      sessionStorage.removeItem('mrdash_session');
      sessionStorage.removeItem('mrdash_name');
      clearBootCache();
      SESSION = '';
    }
  }
  renderLoginScreen();
}

// 로그아웃/비밀번호 변경은 사이드바 "로그인 설정" 메뉴로 일원화했다 — 화면 맨 위를
// 가로로 잡아먹던 계정 표시줄은 없앴다 (openLoginSettingsMenu 참고).

async function doLogout() {
  try { await gasCall({ action: 'logout', session: SESSION }); } catch (e) { /* 실패해도 로컬은 지운다 */ }
  sessionStorage.removeItem('mrdash_session');
  sessionStorage.removeItem('mrdash_name');
  clearBootCache();
  location.reload();
}

// 사이드바 "로그인 설정"을 누르면 바로 비밀번호 변경창으로 가지 않고,
// 로그아웃/비밀번호 변경 중 고르는 작은 메뉴를 먼저 보여준다.
function openLoginSettingsMenu() {
  document.getElementById('mrdashSettingsMenu')?.remove();
  const box = document.createElement('div');
  box.id = 'mrdashSettingsMenu';
  box.innerHTML = `
    <style>
      #mrdashSettingsMenu{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99999;
        display:flex;align-items:center;justify-content:center;
        font-family:system-ui,"Malgun Gothic",sans-serif}
      #mrdashSettingsMenu .card{background:#fff;padding:20px;border-radius:10px;width:240px}
      #mrdashSettingsMenu h3{margin:0 0 4px;font-size:15px}
      #mrdashSettingsMenu .who{margin:0 0 14px;font-size:12px;color:#666}
      #mrdashSettingsMenu button{width:100%;padding:10px;margin-bottom:8px;border-radius:7px;
        font-size:13px;cursor:pointer;border:1px solid #ccc;background:#fff}
      #mrdashSettingsMenu button:last-child{margin-bottom:0}
    </style>
    <div class="card">
      <h3>로그인 설정</h3>
      <p class="who">${ME} 님으로 로그인됨</p>
      <button id="mrdashGoChangePw">비밀번호 변경</button>
      <button id="mrdashGoLogout">로그아웃</button>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', e => { if (e.target === box) box.remove(); });
  document.getElementById('mrdashGoChangePw').addEventListener('click', () => { box.remove(); openChangePasswordDialog(); });
  document.getElementById('mrdashGoLogout').addEventListener('click', () => { box.remove(); doLogout(); });
}

function openChangePasswordDialog() {
  // 비밀번호가 틀려 실패한 뒤 "비밀번호 변경"을 다시 누르면 예전 다이얼로그가 안 지워진 채
  // 새 다이얼로그가 또 생겨, getElementById가 화면에 안 보이는 예전 것을 잡는 문제가 있었다
  // ("비밀번호를 잘못 넣으면 창이 닫힌 것처럼 보이고 다시 눌러야 하던" 증상의 원인).
  document.getElementById('mrdashPwDialog')?.remove();

  const box = document.createElement('div');
  box.id = 'mrdashPwDialog';
  box.innerHTML = `
    <style>
      #mrdashPwDialog{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99999;
        display:flex;align-items:center;justify-content:center;
        font-family:system-ui,"Malgun Gothic",sans-serif}
      #mrdashPwDialog .card{background:#fff;padding:20px;border-radius:10px;width:280px}
      #mrdashPwDialog h3{margin:0 0 12px;font-size:15px}
      #mrdashPwDialog input{width:100%;padding:8px;margin-bottom:8px;border:1px solid #ccc;
        border-radius:6px;font-size:13px;box-sizing:border-box}
      #mrdashPwDialog .row{display:flex;gap:8px;margin-top:6px}
      #mrdashPwDialog button{flex:1;padding:8px;border-radius:6px;font-size:13px;cursor:pointer}
      #mrdashPwDialog .ok{background:#1a73e8;color:#fff;border:none}
      #mrdashPwDialog .cancel{background:#fff;border:1px solid #ccc}
      #mrdashPwDialog .msg{font-size:12px;color:#c62828;min-height:16px}
    </style>
    <div class="card">
      <h3>비밀번호 변경</h3>
      <input id="pwOld" type="password" placeholder="현재 비밀번호" autocomplete="current-password">
      <input id="pwNew" type="password" placeholder="새 비밀번호" autocomplete="new-password">
      <input id="pwNew2" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password">
      <div class="msg" id="pwMsg"></div>
      <div class="row">
        <button class="cancel" id="pwCancel">취소</button>
        <button class="ok" id="pwOk">변경</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  const $ = id => document.getElementById(id);
  $('pwCancel').addEventListener('click', () => box.remove());
  box.addEventListener('click', e => { if (e.target === box) box.remove(); });

  $('pwOk').addEventListener('click', async () => {
    const oldPassword = $('pwOld').value, newPassword = $('pwNew').value, confirm = $('pwNew2').value;
    if (!oldPassword || !newPassword) { $('pwMsg').textContent = '빈칸을 채워주세요'; return; }
    if (newPassword !== confirm) { $('pwMsg').textContent = '새 비밀번호가 서로 다릅니다'; return; }
    if (newPassword.length < 4) { $('pwMsg').textContent = '4자 이상으로 설정하세요'; return; }

    $('pwOk').disabled = true;
    $('pwMsg').style.color = '#555';
    $('pwMsg').textContent = '처리 중...';
    try {
      const r = await gasCall({ action: 'changePassword', session: SESSION, oldPassword, newPassword });
      if (!r.ok) { $('pwMsg').style.color = '#c62828'; $('pwMsg').textContent = r.error; return; }
      sessionStorage.removeItem('mrdash_session');
      sessionStorage.removeItem('mrdash_name');
      alert('비밀번호가 변경되었습니다. 다시 로그인해 주세요.');
      location.reload();
    } catch (e) {
      $('pwMsg').style.color = '#c62828';
      $('pwMsg').textContent = '연결 실패: ' + e.message;
    } finally {
      $('pwOk').disabled = false;
    }
  });
}

// 사이드바 "로그인 설정" 메뉴 — 원래 화면엔 이 자리가 없어서 nav에 링크 하나만 얹었다.
// 로그인 전엔 화면 전체가 로그인창에 가려져 있어 눌릴 일이 없다.
document.getElementById('mrdashPwNavLink')?.addEventListener('click', openLoginSettingsMenu);

/**
 * boot() 도중 예상 못한 곳에서 예외가 나면(캐시 손상, GAS 응답 이상 등) 로그인
 * 화면도 없고 대시보드도 없는 "백지" 상태로 남을 수 있다. 일정 시간 후에도
 * 둘 다 없으면 그냥 새로고침을 안내하는 최소한의 화면을 대신 띄운다.
 */
function showBootRecovery(){
  if(document.getElementById('mrdashLogin')||document.getElementById('mrdashBootRecovery'))return;
  if(window.TKP&&window.TKP.ready)return;
  const box=document.createElement('div');
  box.id='mrdashBootRecovery';
  box.innerHTML=`<style>#mrdashBootRecovery{position:fixed;inset:0;background:#f4f4f6;z-index:99999;
    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;
    font-family:system-ui,"Malgun Gothic",sans-serif;color:#333;text-align:center;padding:20px}
    #mrdashBootRecovery button{padding:10px 22px;background:#1a73e8;color:#fff;border:none;
    border-radius:7px;font-weight:600;cursor:pointer}</style>
    <div>화면을 불러오는 데 문제가 생겼습니다.<br>새로고침해 주세요.</div>
    <button id="mrdashBootRetry">새로고침</button>`;
  document.body.appendChild(box);
  document.getElementById('mrdashBootRetry').addEventListener('click',()=>location.reload());
}
window.addEventListener('unhandledrejection',showBootRecovery);
window.addEventListener('error',showBootRecovery);
setTimeout(showBootRecovery,20000);

try { boot(); } catch (e) { showBootRecovery(); }
