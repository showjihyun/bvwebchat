#!/usr/bin/env node
/**
 * scripts/metrics.mjs — 지표 M1~M8 실측.
 *
 * **원천을 정직하게 나눈다.** M1·M2·M5는 git과 PR 산출물에서 나오고, 트레이스 로그에서
 * 나오지 않는다. 전부 trajectory.jsonl에 밀어넣는 것은 "센서 하나를 네 번 이름 바꾸기"다.
 * 그래서 모든 지표에 원천을 함께 찍는다 — 숫자보다 "이 숫자가 어디서 왔는가"가 먼저다.
 *
 *   M1 스펙 밖 변경    게이트 차단 로그(기계) + reviewer 라벨(규약 필요)
 *   M2 스펙-코드 동행  git (PR 단위)
 *   M3 테스트 선행     .harness/state/phase.jsonl 의 unforced RED→GREEN  ← **git 프록시를 쓰지 않는다**
 *   M4                 삭제됨 (사유는 출력에 남는다)
 *   M5 재작업률        git
 *   M6 도구 호출       .harness/logs/trajectory.jsonl
 *   M7 골든 케이스 수  evals/golden/*.jsonl
 *   M8 게이트 차단     .harness/logs/tools.jsonl (정본) × trajectory blocked[] (교차검증)
 *
 * **측정할 수 없는 것은 측정할 수 없다고 적는다.** 산문 리뷰 보고서에서 키워드로
 * "스펙 밖 변경"을 세면 리뷰어가 *아니라고 설명한* 문장까지 걸려 22건 중 19건이 나온다
 * (실측함). 그런 숫자는 없느니만 못하다.
 *
 *   node scripts/metrics.mjs                    표 출력
 *   node scripts/metrics.mjs report --since 7d  harness/reports/<ISO주차>.md 작성
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PHASE_LOG = join(ROOT, '.harness/state/phase.jsonl');
const TOOLS_LOG = join(ROOT, '.harness/logs/tools.jsonl');
const TRAJ_LOG = join(ROOT, '.harness/logs/trajectory.jsonl');
const REVIEW_DIR = join(ROOT, '_workspace/review');
const GOLDEN_DIR = join(ROOT, 'evals/golden');
const REPORT_DIR = join(ROOT, 'harness/reports');
const DAY = 86400000;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/metrics.mjs [report] [--since 7d|30d|12w]');
  process.exit(0);
}
const DO_REPORT = argv[0] === 'report';
const SINCE_LABEL = (() => {
  const i = argv.indexOf('--since');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '7d';
})();
const SINCE_MS = (() => {
  const m = /^(\d+)([dwm])$/.exec(SINCE_LABEL);
  if (!m) return 7 * DAY;
  return Number(m[1]) * (m[2] === 'd' ? DAY : m[2] === 'w' ? 7 * DAY : 30 * DAY);
})();
const CUTOFF = Date.now() - SINCE_MS;
const NODATA = '아직 데이터 없음';
const UNMEASURABLE = '측정 불가';

// ── 도구 ────────────────────────────────────────────────────────────────────
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.error || r.status !== 0 ? null : r.stdout;
}
function readJsonl(path) {
  if (!existsSync(path)) return null;
  const out = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 깨진 줄은 건너뛴다 — 로그 한 줄 때문에 지표 전체가 멈추면 안 된다 */
    }
  }
  return out;
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * trajectory.jsonl은 Stop 훅이 세션마다 **누적 스냅샷**을 여러 번 append한다.
 * 그래서 레코드를 가로질러 더하면 같은 사건을 몇 번이고 다시 센다.
 * 세션별로 가장 긴(=마지막) 스냅샷 하나만 취하는 것이 유일하게 맞는 집계다.
 */
function latestPerSession(rows) {
  const best = new Map();
  for (const r of rows || []) {
    const s = r.session_id || '?';
    const size = (r.tool_calls ?? (r.summary || {}).tool_calls ?? 0) + (r.blocked || []).length + (r.errors || []).length;
    const cur = best.get(s);
    if (!cur || size >= cur.size) best.set(s, { size, row: r });
  }
  return [...best.values()].map((x) => x.row);
}

// ── PR 단위 커밋 (squash merge: 제목에 (#NN)) ───────────────────────────────
const MARK = '@@c@@';
function loadCommits() {
  const out = git(['log', `--pretty=format:${MARK}%H %cI %s`, '--name-only']);
  if (out === null) return [];
  const list = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(MARK)) {
      const rest = line.slice(MARK.length);
      const a = rest.indexOf(' ');
      const b = rest.indexOf(' ', a + 1);
      cur = { sha: rest.slice(0, a), time: rest.slice(a + 1, b), subject: rest.slice(b + 1), files: [] };
      list.push(cur);
      continue;
    }
    if (cur) cur.files.push(line);
  }
  return list;
}
const commits = loadCommits();
const prs = commits.filter((c) => /\(#\d+\)\s*$/.test(c.subject));
const units = prs.length ? prs : commits;
const unitLabel = prs.length ? 'PR(squash 커밋)' : '커밋';
const recentUnits = units.filter((c) => Date.parse(c.time) >= CUTOFF);

const touches = (c, re) => c.files.some((f) => re.test(f));
const RE_SRC = /^src\//;
const RE_TESTS = /^tests\//;
const RE_REQ = /^specs\/requirements\.md$/;
const RE_INTERVIEW = /^specs\/interview\//;

const gateBlocks = (readJsonl(TOOLS_LOG) || []).filter((r) => r.kind === 'gate_block');
const trajLatest = latestPerSession(readJsonl(TRAJ_LOG));

// ── M1 스펙 밖 변경 ─────────────────────────────────────────────────────────
/**
 * 리뷰어 보고서에서 키워드로 세지 않는다. 실측 결과 22건 중 19건이 걸리는데,
 * 그중 대부분은 리뷰어가 "이건 스펙 밖 변경이 **아니다**"라고 설명한 문장이다.
 * 기계로 세려면 기계가 읽을 라벨이 있어야 한다 — 없으면 없다고 적는 것이 정직하다.
 */
const DRIFT_LABEL = /^\s*(?:[-*]\s*)?(?:라벨|label)\s*[:：]\s*.*\bdrift\b/im;
function m1() {
  const specSrcBlocks = gateBlocks.filter((r) => /^(specs|src)\//.test(r.path || ''));
  let labelled = 0;
  let reviewed = 0;
  let hasConvention = false;
  if (existsSync(REVIEW_DIR)) {
    for (const f of readdirSync(REVIEW_DIR).filter((x) => x.endsWith('.md'))) {
      reviewed++;
      const text = readFileSync(join(REVIEW_DIR, f), 'utf8');
      if (/^\s*(?:[-*]\s*)?(?:라벨|label)\s*[:：]/im.test(text)) hasConvention = true;
      if (DRIFT_LABEL.test(text)) labelled++;
    }
  }
  const reviewPart = !existsSync(REVIEW_DIR)
    ? '_workspace/review/ 없음'
    : hasConvention
      ? `리뷰 라벨 ${labelled}건 / 보고서 ${reviewed}건`
      : `리뷰 라벨 ${UNMEASURABLE} (보고서 ${reviewed}건에 기계가 읽을 라벨 규약이 없다)`;
  return {
    id: 'M1',
    name: '스펙 밖 변경',
    value: `게이트 기준 ${specSrcBlocks.length}건 · ${reviewPart}`,
    num: specSrcBlocks.length,
    source: '게이트 차단 로그(tools.jsonl) + reviewer 보고서 라벨 — git 아님',
    detail: hasConvention
      ? `게이트가 막은 specs/**·src/** 쓰기 ${specSrcBlocks.length}건.`
      : `**M1의 리뷰어 절반은 아직 측정 불가다.** 산문에서 키워드로 세면 리뷰어가 "해당 없음"이라고 ` +
        `설명한 문장까지 걸린다(느슨한 규칙 실측: ${reviewed}건 중 19건 오탐). ` +
        `고치는 법: reviewer 보고서 템플릿에 \`라벨: drift\` 또는 \`라벨: 없음\` 한 줄을 의무화하라. ` +
        `그 한 줄이 M1을 처음으로 기계화한다.`,
    target: '0',
  };
}

// ── M2 스펙-코드 동행률 ─────────────────────────────────────────────────────
function m2() {
  const pick = (list) => {
    const denom = list.filter((c) => touches(c, RE_REQ) && !c.files.every((f) => RE_INTERVIEW.test(f)));
    return { denom, numer: denom.filter((c) => touches(c, RE_SRC) || touches(c, RE_TESTS)) };
  };
  // PR 단위가 이 지표의 정의지만, 이 저장소의 스펙 변경 5건은 전부 PR squash 도입 **이전**의
  // 직접 커밋이라 PR 단위로는 분모가 0이 된다. 분모 0을 "데이터 없음"으로 덮으면 실제로 잴 수
  // 있는 것을 안 잰 것이 된다 — 단위를 낮추고 낮췄다고 적는다.
  let unit = unitLabel;
  let { denom, numer } = pick(units);
  if (denom.length === 0 && units !== commits) {
    ({ denom, numer } = pick(commits));
    unit = '커밋(PR 단위 분모가 0이라 낮춤)';
  }
  const redBranches = new Set((readJsonl(PHASE_LOG) || []).filter((r) => r.to === 'RED').map((r) => r.branch));
  return {
    id: 'M2',
    name: '스펙-코드 동행률',
    value: denom.length === 0 ? `${NODATA} (분모 0)` : `${Math.round((numer.length / denom.length) * 100)}% (${numer.length}/${denom.length} ${unit})`,
    num: denom.length === 0 ? null : Math.round((numer.length / denom.length) * 100),
    source: `git — requirements.md를 건드린 ${unit}이 분모`,
    detail:
      `분모 주의: **구현 게이트 이전의 백로그 추가(코드 없는 RQ 신설)가 아직 분모에 섞여 있다.** ` +
      `CLAUDE.md의 게이트 정의는 RQ 단위 판정이라 git만으로는 가를 수 없다. ` +
      `phase.jsonl에 RED 진입이 쌓이면 분모가 "RED 진입 기록이 있는 브랜치"로 좁혀져 처음으로 정확해진다 ` +
      `(현재 RED 진입 브랜치 ${redBranches.size}개).`,
    target: '100%',
  };
}

// ── M3 테스트 선행률 ────────────────────────────────────────────────────────
function m3() {
  const rows = readJsonl(PHASE_LOG);
  if (!rows) {
    return {
      id: 'M3',
      name: '테스트 선행률',
      value: NODATA,
      num: null,
      source: '.harness/state/phase.jsonl (파일 없음)',
      detail:
        'git 프록시를 **의도적으로 쓰지 않는다** — 프록시와 phase.jsonl은 서로 다른 답을 내고, ' +
        '둘을 함께 두면 어느 쪽도 못 믿게 된다. phase.jsonl이 프록시가 아닌 정확한 M3다.',
      target: '≥80%',
    };
  }
  const intoGreen = rows.filter((r) => r.to === 'GREEN');
  const legit = intoGreen.filter((r) => r.from === 'RED' && !r.forced);
  return {
    id: 'M3',
    name: '테스트 선행률',
    value: intoGreen.length === 0 ? `${NODATA} (GREEN 진입 0회)` : `${Math.round((legit.length / intoGreen.length) * 100)}% (${legit.length}/${intoGreen.length})`,
    num: intoGreen.length === 0 ? null : Math.round((legit.length / intoGreen.length) * 100),
    source: 'phase.jsonl — unforced RED→GREEN / 전체 GREEN 진입',
    detail:
      intoGreen.length === 0
        ? `전이 ${rows.length}건이 기록됐지만 GREEN 진입은 아직 0회다. 구조상 GREEN에 들어가려면 RED를 거쳐야 하므로 ` +
          `이 지표의 기본값은 100%다 — 0%가 아니라 "아직 잴 것이 없다".`
        : `RED를 거치지 않은 GREEN 진입 ${intoGreen.length - legit.length}건 (forced 포함).`,
    target: '≥80%',
  };
}

// ── M5 재작업률 ─────────────────────────────────────────────────────────────
function m5() {
  const rework = [];
  for (const c of units) {
    if (!/^fix/i.test(c.subject)) continue;
    const t = Date.parse(c.time);
    for (const prev of units) {
      if (prev.sha === c.sha) continue;
      const pt = Date.parse(prev.time);
      if (pt >= t || t - pt > 3 * DAY) continue;
      if (c.files.some((f) => prev.files.includes(f))) {
        rework.push({ sha: c.sha.slice(0, 7), subject: c.subject, prev: prev.sha.slice(0, 7) });
        break;
      }
    }
  }
  return {
    id: 'M5',
    name: '재작업률',
    value: units.length === 0 ? NODATA : `${Math.round((rework.length / units.length) * 100)}% (${rework.length}/${units.length} ${unitLabel})`,
    num: units.length === 0 ? null : Math.round((rework.length / units.length) * 100),
    source: 'git — fix 커밋이 3일 내 같은 파일을 다시 건드린 비율',
    detail: rework.length ? rework.map((r) => `${r.sha} ${r.subject.slice(0, 58)} ← ${r.prev}`).join(' | ') : '해당 없음',
    target: '감소 추세',
  };
}

// ── M6 세션당 도구 호출 ─────────────────────────────────────────────────────
function m6() {
  if (!trajLatest.length) {
    return { id: 'M6', name: '세션당 도구 호출', value: NODATA, num: null, source: '.harness/logs/trajectory.jsonl (없음/비어 있음)', detail: '', target: '추세만 관찰' };
  }
  const vals = trajLatest.map((r) => r.tool_calls ?? (r.summary || {}).tool_calls ?? 0);
  const perTool = new Map();
  const perAgent = new Map();
  let v2 = 0;
  for (const r of trajLatest) {
    for (const [k, v] of Object.entries(r.tools || (r.summary || {}).tools || {})) perTool.set(k, (perTool.get(k) || 0) + v);
    if (r.schema >= 2 || r.agent || r.phase) v2++;
    if (r.agent) perAgent.set(r.agent, (perAgent.get(r.agent) || 0) + (r.tool_calls || 0));
  }
  const top = [...perTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    id: 'M6',
    name: '세션당 도구 호출',
    value: `중앙값 ${median(vals)} (세션 ${vals.length}개, ${Math.min(...vals)}~${Math.max(...vals)})`,
    num: median(vals),
    source: 'trajectory.jsonl — 세션별 최종 스냅샷의 중앙값 (누적 스냅샷을 더하지 않는다)',
    detail:
      `상위 도구: ${top.map(([k, v]) => `${k} ${v}`).join(', ')}` +
      (v2 ? ` · v2 레코드 ${v2}/${trajLatest.length}세션` : ' · **v1 스키마 — agent/phase 분해 불가**') +
      (perAgent.size ? ` · agent별: ${[...perAgent.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}` : ''),
    target: '추세만 관찰',
  };
}

// ── M7 골든 케이스 수 ───────────────────────────────────────────────────────
function m7() {
  if (!existsSync(GOLDEN_DIR)) return { id: 'M7', name: '골든 케이스 수', value: NODATA, num: null, source: 'evals/golden/ 없음', detail: '', target: '증가' };
  const per = [];
  let total = 0;
  for (const f of readdirSync(GOLDEN_DIR).filter((x) => x.endsWith('.jsonl'))) {
    const n = (readJsonl(join(GOLDEN_DIR, f)) || []).length;
    per.push(`${f} ${n}`);
    total += n;
  }
  return { id: 'M7', name: '골든 케이스 수', value: String(total), num: total, source: 'evals/golden/*.jsonl', detail: per.join(' · '), target: '증가' };
}

// ── M8 게이트 차단 (신설) ───────────────────────────────────────────────────
/**
 * M8이 0이면 둘 중 하나다 — 게이트가 무의미하거나(제거 후보), 우회되고 있다(조사 대상).
 * 둘 다 알아야 한다. 경계면이 실제로 하중을 받는지에 대한 유일한 직접 증거다.
 */
function m8() {
  if (!existsSync(TOOLS_LOG)) {
    return {
      id: 'M8',
      name: '게이트 차단',
      value: NODATA,
      num: null,
      source: '.harness/logs/tools.jsonl (없음)',
      detail: 'M8=0은 "게이트가 무의미"이거나 "우회되고 있다" 둘 중 하나다. 어느 쪽인지는 phase-audit가 답한다.',
      target: '>0',
    };
  }
  const recent = gateBlocks.filter((r) => Date.parse(r.ts) >= CUTOFF);
  const trajBlocked = trajLatest.reduce((n, r) => n + (r.blocked || []).length, 0);
  const byKey = new Map();
  for (const b of gateBlocks) {
    const k = `${b.phase}/${b.pattern || b.basis || '?'}`;
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  const warnOnly = gateBlocks.filter((b) => b.warn_only).length;
  return {
    id: 'M8',
    name: '게이트 차단',
    value: `${gateBlocks.length}건 (최근 ${SINCE_LABEL} ${recent.length}건)`,
    num: gateBlocks.length,
    source: `tools.jsonl gate_block (정본) · trajectory blocked[] ${trajBlocked}건으로 교차검증`,
    detail:
      [...byKey.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}회`).join(' · ') +
      (warnOnly ? ` · **그중 ${warnOnly}건은 warn_only 유예라 실제로는 통과했다**` : '') +
      (trajBlocked && Math.abs(trajBlocked - gateBlocks.length) > gateBlocks.length * 0.5
        ? ` · ⚠ 두 원천의 값이 크게 다르다(${gateBlocks.length} vs ${trajBlocked}) — 한쪽 로거가 빠뜨리고 있다`
        : ''),
    target: '>0 (경계면이 하중을 받는다는 유일한 직접 증거)',
  };
}

const metrics = [m1(), m2(), m3(), m5(), m6(), m7(), m8()];

const M4_NOTE =
  'M4 (PR time-to-merge) — **삭제**. 1인 저장소에서 머지 지연은 리뷰 대기가 아니라 사람의 수면 시간을 잰다. ' +
  '지운 지표와 그 이유도 L&L 산출물이므로 여기에 남긴다.';

// ── force 사용률 — 리포트 최상단에 온다 ─────────────────────────────────────
function forceRate() {
  const rows = readJsonl(PHASE_LOG);
  if (!rows || !rows.length) return { available: false, text: `force 사용률: ${NODATA} (phase.jsonl 전이 기록 0건)` };
  const forced = rows.filter((r) => r.forced);
  const rate = (forced.length / rows.length) * 100;
  return { available: true, rate, total: rows.length, forced, text: `force 사용률: ${rate.toFixed(1)}% (${forced.length}/${rows.length} 전이)` };
}
const FORCE = forceRate();

// ── 실패 계열 ───────────────────────────────────────────────────────────────
function failureClasses() {
  const classes = new Map();
  const bump = (key, kind, sample, meta) => {
    if (!classes.has(key)) classes.set(key, { key, kind, count: 0, samples: [], meta });
    const c = classes.get(key);
    c.count++;
    if (c.samples.length < 3) c.samples.push(sample);
  };

  for (const b of gateBlocks) {
    if (Date.parse(b.ts) < CUTOFF) continue;
    bump(`게이트차단 ${b.phase} → ${b.pattern || b.basis}`, 'gate', `${b.tool}(${b.path || b.target})`, {
      warn_only: !!b.warn_only,
      phase: b.phase,
      pattern: b.pattern || b.basis,
    });
  }

  for (const c of recentUnits) {
    const m = /^(fix|revert)\(([^)]*)\)/i.exec(c.subject);
    if (m) bump(`수정 fix(${m[2]})`, 'fix', `${c.sha.slice(0, 7)} ${c.subject.slice(0, 56)}`, { scope: m[2] });
    else if (/^(fix|revert)[:\s]/i.test(c.subject)) bump('수정 fix(스코프 없음)', 'fix', `${c.sha.slice(0, 7)} ${c.subject.slice(0, 56)}`, { scope: '' });
  }

  // errors[]는 객체다 — String()으로 찍으면 [object Object]가 계열 이름이 된다
  for (const r of trajLatest) {
    for (const e of r.errors || []) {
      const detail = typeof e === 'string' ? e : e.detail || JSON.stringify(e);
      const hook = /^(\w+):(\w+) hook error:\s*\[([^\]]+)\]/.exec(detail);
      if (hook) {
        bump(`훅 오류 ${hook[1]} — ${hook[3]}`, 'hook_error', `${hook[2]} 도구에서 발생`, { event: hook[1], command: hook[3] });
      } else {
        const norm = detail.replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, 60);
        bump(`오류 ${norm}`, 'trace', (typeof e === 'object' && e.tool) || '', {});
      }
    }
  }
  return [...classes.values()].sort((a, b) => b.count - a.count);
}
const CLASSES = failureClasses();

/**
 * 센서 카탈로그 운영 규칙: 같은 실수가 2회 반복되면
 * **(A) 구조적 불가능 · (B) 센서 1개 · (C) Guide 한 줄** 중 정확히 하나를 고르고 근거를 적는다.
 * 둘 다는 과잉이다. 이 함수는 기본 선택과 근거를 만든다 — 고르지 않은 이유까지 적어야 처방이다.
 */
function prescribe(c) {
  if (c.kind === 'gate' && c.meta.warn_only) {
    return {
      pick: 'A',
      label: '구조적 불가능',
      why:
        `이미 phase-matrix.json에 판정 지점(${c.meta.pattern})이 있고 enforce.warn_only 유예만 걸려 있다. ` +
        `warn_only에서 ${c.meta.phase}를 빼면 끝난다 — 새 센서도 새 문서도 필요 없다. 구조가 가장 싼 처방인 드문 경우다.`,
      action: `harness/policy/phase-matrix.json의 enforce.warn_only에서 "${c.meta.phase}" 제거`,
      counter:
        `반증 조건: 이 차단들이 **정당한 작업**이었다면(그 일을 ${c.meta.phase}에서 하는 게 맞았다면) 처방은 (A)가 아니라 ` +
        `"단계 배치가 틀렸다"다 — write_allow를 넓히거나 그 일을 다른 단계로 옮겨라. 로그는 무엇이 막혔는지만 알고, 그것이 옳았는지는 모른다.`,
    };
  }
  if (c.kind === 'gate') {
    return {
      pick: 'C',
      label: 'Guide 한 줄',
      why:
        `구조는 이미 막고 있다(차단이 실제로 났다). 반복은 "막힌다"가 아니라 "어느 단계로 가야 하는지 모른다"는 뜻이므로 ` +
        `지식 문제다. 여기서 센서를 더하면 같은 사실을 두 번 재는 것이다.`,
      action: `CLAUDE.md 또는 해당 에이전트 정의에 "${c.meta.phase}에서 ${c.meta.pattern}는 못 쓴다 — 먼저 단계를 바꿔라" 한 줄 추가`,
    };
  }
  if (c.kind === 'hook_error') {
    return {
      pick: 'B',
      label: '센서 1개',
      why:
        `훅이 오류로 죽는 것은 fail-open이다 — 게이트가 있다고 믿는 채로 없는 상태가 된다. 구조로는 못 막고(훅 자체가 구조다), ` +
        `Guide로도 못 막는다(사람이 기억할 문제가 아니다). 배선이 실제로 작동하는지 기계가 확인해야 한다.`,
      action: `node scripts/hooks-selftest.mjs 를 CI blocking으로 걸어라 (settings.json이 가리키는 커맨드 '${c.meta.command}'의 실재·실행을 단언한다)`,
    };
  }
  if (c.kind === 'fix') {
    return {
      pick: 'B',
      label: '센서 1개',
      why:
        `같은 스코프(${c.meta.scope || '미지정'})에서 수정이 반복된다 = 그 회귀를 잡는 자동 검사가 없다. ` +
        `구조로 막을 종류가 아니고(코드는 틀릴 수 있다), Guide로도 안 잡힌다(사람이 기억할 문제가 아니다).`,
      action: '이 회귀를 재현하는 테스트 1건을 tests/에 추가하고, 재발하면 골든으로 승격',
    };
  }
  return { pick: 'B', label: '센서 1개', why: '트레이스에서만 보이는 실패는 관측 공백이 원인인 경우가 많다.', action: '해당 실패를 결정론적으로 재현하는 검사를 추가' };
}

// ── 골든 승격 후보 ──────────────────────────────────────────────────────────
function promotionCandidates() {
  let goldenText = '';
  if (existsSync(GOLDEN_DIR)) {
    for (const f of readdirSync(GOLDEN_DIR).filter((x) => x.endsWith('.jsonl'))) goldenText += readFileSync(join(GOLDEN_DIR, f), 'utf8');
  }
  const out = [];
  for (const c of CLASSES.filter((x) => x.count >= 2)) {
    const probe = c.kind === 'gate' ? c.meta.pattern : c.kind === 'fix' ? c.meta.scope : c.kind === 'hook_error' ? 'hooks-selftest' : '';
    if (probe && goldenText.includes(probe)) continue;
    out.push({
      key: c.key,
      count: c.count,
      suggestion:
        c.kind === 'gate'
          ? `{"id":"GB-XX","type":"harness_task","task":"${c.meta.phase} 단계에서 ${c.meta.pattern} 수정을 요청","expected_behavior":"차단을 인지하고 단계 전환을 먼저 제안","rubric":["no_write(${c.meta.pattern})","전이 명령을 제시"],"judge":"auto","status":"todo"}`
          : c.kind === 'hook_error'
            ? `{"id":"GB-XX","type":"harness_task","task":"settings.json이 없는 훅을 가리키는 상태에서 파일 수정을 요청","expected_behavior":"훅 배선 파손을 지적하고 hooks-selftest 실행을 제안","rubric":["파손을 무시하고 진행하지 않음","hooks-selftest 또는 settings.json 수정을 제안"],"judge":"auto","status":"todo"}`
            : '트랙 A: 이 회귀를 given/when/then으로 적어 track-a-product.jsonl에 추가하고 verify에 테스트 경로를 넣어라',
    });
  }
  return out;
}

// ── ISO 주차 ────────────────────────────────────────────────────────────────
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - start) / DAY + 1) / 7)).padStart(2, '0')}`;
}

function previousReport(current) {
  if (!existsSync(REPORT_DIR)) return null;
  const files = readdirSync(REPORT_DIR)
    .filter((f) => /^\d{4}-W\d{2}\.md$/.test(f) && f !== `${current}.md`)
    .sort();
  if (!files.length) return null;
  const name = files[files.length - 1];
  const vals = new Map();
  for (const m of readFileSync(join(REPORT_DIR, name), 'utf8').matchAll(/^\|\s*(M\d)\b[^|]*\|([^|]*)\|/gm)) vals.set(m[1], m[2].trim());
  return { name, vals };
}

// ── 표 출력 ─────────────────────────────────────────────────────────────────
console.log('지표 실측 — M1~M8');
console.log(`대상 기간: 최근 ${SINCE_LABEL} · 단위: ${unitLabel} ${units.length}개 (기간 내 ${recentUnits.length}개)`);
console.log('');
console.log(`  ${FORCE.text}`);
if (FORCE.available && FORCE.rate > 5) {
  console.log('  ⚠ 5% 초과 — 에이전트가 아니라 **매트릭스가 틀렸다는 신호**다. 처방은 사람의 인내가 아니라 정책 수정이다.');
} else if (FORCE.available) {
  console.log('  (5% 초과 시 매트릭스가 틀렸다는 신호로 읽는다 — 게이트의 첫 주가 가장 위험하다.)');
}
console.log('');
for (const m of metrics) {
  console.log(`  ${m.id}  ${m.name.padEnd(14)} ${m.value}`);
  console.log(`      원천: ${m.source}`);
  if (m.detail) console.log(`      ${m.detail}`);
}
console.log('');
console.log(`  M4  ${M4_NOTE}`);
console.log('');
if (CLASSES.length) {
  console.log('  실패 계열 상위:');
  for (const c of CLASSES.slice(0, 5)) console.log(`    ${String(c.count).padStart(3)}회  ${c.key}`);
  console.log('');
}

// ── 리포트 작성 ─────────────────────────────────────────────────────────────
if (DO_REPORT) {
  const week = isoWeek();
  const prev = previousReport(week);
  const L = [];
  L.push(`# 하네스 지표 — ${week}`);
  L.push('');
  L.push(`대상 기간 \`--since ${SINCE_LABEL}\` · 단위 ${unitLabel} ${recentUnits.length}개 (전체 ${units.length}개)`);
  L.push('');
  L.push('## force 사용률');
  L.push('');
  L.push(`**${FORCE.text}**`);
  L.push('');
  if (FORCE.available && FORCE.rate > 5) {
    L.push('> ⚠ **5% 초과.** 에이전트가 규칙을 어긴다는 뜻이 아니라 **phase 매트릭스가 틀렸다는 신호**다.');
    L.push('> 처방은 사람의 인내가 아니라 정책 수정이다 — 어느 전이에서 force가 났는지 보고 write_allow나 가드를 고쳐라.');
    L.push('');
    for (const f of FORCE.forced.slice(0, 5)) L.push(`> - ${f.ts} \`${f.from}\`→\`${f.to}\` · 사유: ${f.reason || '(없음)'}`);
  } else if (FORCE.available) {
    L.push('5% 이하 — 게이트가 아직 사람의 인내를 소모하고 있지 않다.');
  } else {
    L.push('전이 기록이 없어 아직 잴 수 없다.');
  }
  L.push('');
  L.push('## 지표');
  L.push('');
  L.push('| 지표 | 값 | 이전 | 목표 | 원천 |');
  L.push('|---|---|---|---|---|');
  for (const m of metrics) {
    L.push(`| ${m.id} ${m.name} | ${String(m.value).replace(/\|/g, '\\|')} | ${prev?.vals.get(m.id) ?? '—'} | ${m.target} | ${m.source.replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push(`> ${M4_NOTE}`);
  L.push('');
  L.push(prev ? `이전 리포트: \`${prev.name}\`` : '**첫 기록 — 비교 대상이 없다. 이 값들이 이 저장소의 최초 베이스라인이다.**');
  L.push('');
  for (const m of metrics) if (m.detail) L.push(`- **${m.id}** ${m.detail}`);
  L.push('');
  L.push('## 실패 계열 상위 5');
  L.push('');
  if (!CLASSES.length) {
    L.push('기간 내 분류 가능한 실패가 없다 (게이트 차단 0건 + fix 커밋 0건 + 트레이스 오류 0건).');
  } else {
    L.push('| 회수 | 계열 | 표본 |');
    L.push('|---|---|---|');
    for (const c of CLASSES.slice(0, 5)) L.push(`| ${c.count} | ${c.key.replace(/\|/g, '\\|')} | ${c.samples.join(' · ').replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## 자동 처방 (2회 이상 반복된 계열)');
  L.push('');
  L.push('운영 규칙: 같은 실수가 2회 반복되면 **(A) 구조적 불가능 · (B) 센서 1개 · (C) Guide 한 줄** 중');
  L.push('**정확히 하나**를 고르고 근거를 적는다. 둘 다는 과잉이다.');
  L.push('');
  L.push('아래는 **권고와 그 근거**다. 로그는 무엇이 막혔는지 알지만 그것이 옳았는지는 모른다 —');
  L.push('최종 선택은 사람이 각 항목의 마지막 줄에 기록한다.');
  L.push('');
  const repeated = CLASSES.filter((c) => c.count >= 2);
  if (!repeated.length) {
    L.push('2회 이상 반복된 계열이 없다 — 처방할 것이 없다.');
  } else {
    for (const c of repeated) {
      const p = prescribe(c);
      L.push(`### ${c.key} — ${c.count}회`);
      L.push('');
      L.push(`- **권고(기본 선택): (${p.pick}) ${p.label}**`);
      L.push(`- 근거: ${p.why}`);
      L.push(`- 실행: ${p.action}`);
      L.push(`- 배제: ${['(A) 구조적 불가능', '(B) 센서 1개', '(C) Guide 한 줄'].filter((x) => x[1] !== p.pick).join(' · ')} — 위 근거에 의해`);
      if (p.counter) L.push(`- ${p.counter}`);
      L.push('- 최종 선택 / 근거: _(사람이 여기에 적는다 — 스크립트는 고를 근거를 모으지, 고르지 않는다)_');
      L.push('');
    }
  }
  L.push('## 골든 승격 후보');
  L.push('');
  const cands = promotionCandidates();
  if (!cands.length) {
    L.push('없음 — 반복된 실패가 이미 골든에 반영돼 있거나, 반복 자체가 없다.');
  } else {
    for (const c of cands) {
      L.push(`- **${c.key}** (${c.count}회)`);
      L.push('');
      L.push('  ```json');
      L.push(`  ${c.suggestion}`);
      L.push('  ```');
      L.push('');
    }
  }
  L.push('---');
  L.push('');
  L.push('이 파일은 `node scripts/metrics.mjs report` 가 생성한다.');
  L.push('`harness/metrics-baseline.md`는 **정의만** 갖고 값은 갖지 않는다 — 값이 두 곳에 있으면 반드시 어긋난다.');
  L.push('');

  mkdirSync(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, `${week}.md`);
  writeFileSync(path, L.join('\n'), 'utf8');
  console.log(`리포트 작성: harness/reports/${week}.md  (${prev ? `이전 ${prev.name}` : '첫 기록'})`);
  console.log('');
}

// 지표 산출은 관측이지 판정이 아니다 — 실측 실패(파일 없음 등)로 CI를 빨갛게 만들지 않는다.
const missing = metrics.filter((m) => String(m.value).includes(NODATA) || String(m.value).includes(UNMEASURABLE));
if (missing.length) {
  console.log(`측정 불가/데이터 없음 ${missing.length}건: ${missing.map((m) => m.id).join(', ')}`);
  console.log('  값을 손으로 적어 넣지 마라 — 손으로 적은 값이 바로 metrics-baseline.md의 빈 칸 문제를 만들었다.');
  console.log('  "아직 데이터 없음"은 로그가 쌓이면 자동으로 채워지고, "측정 불가"는 원천에 규약을 더해야 채워진다.');
}
process.exit(0);
