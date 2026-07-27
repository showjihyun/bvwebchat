#!/usr/bin/env node
/**
 * scripts/policy-lint.mjs — 정책 파일 린터 겸 README 생성기.
 *
 * 통제면(Plane 2)의 진실 공급원인 harness/policy/*.json 자체를 검사한다.
 * 정책이 틀리면 게이트는 틀린 것을 정확하게 강제한다 — 그래서 정책이 첫 번째 검사 대상이다.
 *
 *   node scripts/policy-lint.mjs           검증. 실패 시 exit 1
 *   node scripts/policy-lint.mjs --print   harness/policy/README.md 생성(사람용 표)
 *
 * README를 손으로 쓰지 않고 생성하는 이유: 표와 정책은 반드시 어긋난다.
 * 생성물이면 어긋날 자리가 없다. 생성 결과에 날짜를 넣지 않는 것도 같은 이유다
 * (재생성마다 diff가 나면 아무도 재생성하지 않는다).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX = join(ROOT, 'harness/policy/phase-matrix.json');
const RISK = join(ROOT, 'harness/policy/tool-risk.json');
const README = join(ROOT, 'harness/policy/README.md');

const problems = [];
const notes = [];

/** 문제 1건 = 무엇이 틀렸는가 + 어떻게 고치는가. 후자가 없으면 센서가 아니라 잔소리다. */
function fail(id, what, how) {
  problems.push({ id, what, how });
}
function note(id, what) {
  notes.push({ id, what });
}

/** glob → RegExp. `**`는 경로 구분자를 넘고 `*`는 넘지 않는다. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** glob이 대표하는 경로 1개를 만든다. deny가 allow를 가리는지 판정하는 데 쓴다. */
function sampleFromGlob(glob) {
  return glob.replace(/\*\*\/?/g, 'x/').replace(/\*/g, 'x').replace(/\/+$/, '');
}

function loadJson(path, label) {
  if (!existsSync(path)) {
    fail(
      'P1',
      `${label} 파일이 없다: ${path.slice(ROOT.length + 1)}`,
      `harness/policy/ 아래에 파일을 만들어라. 이 저장소의 통제면은 이 파일 없이는 존재하지 않는다.`
    );
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(
      'P1',
      `${label} JSON 파싱 실패: ${e.message}`,
      `node -e "JSON.parse(require('fs').readFileSync('${path.slice(ROOT.length + 1)}','utf8'))" 로 위치를 확인하고 고쳐라. 파싱 실패는 게이트 전체의 fail-closed를 뜻한다.`
    );
    return null;
  }
}

// ── P1 스키마 ────────────────────────────────────────────────────────────────
const matrix = loadJson(MATRIX, 'phase-matrix.json');
const risk = loadJson(RISK, 'tool-risk.json');

function checkMatrixSchema(m) {
  for (const key of ['schema', 'enforce', 'phases', 'transitions', 'guards']) {
    if (!(key in m)) {
      fail('P1', `phase-matrix.json에 최상위 키 '${key}'가 없다`, `'${key}'를 추가하라. 5개 키(schema/enforce/phases/transitions/guards)가 이 파일의 최소 계약이다.`);
    }
  }
  if (!m.phases || typeof m.phases !== 'object') return;

  const names = Object.keys(m.phases);
  for (const [name, p] of Object.entries(m.phases)) {
    for (const key of ['purpose', 'write_allow', 'write_deny', 'exit_hint']) {
      if (!(key in p)) {
        fail('P1', `phases.${name}에 '${key}'가 없다`, `phases.${name}에 '${key}'를 추가하라. exit_hint가 없으면 차단당한 에이전트가 나갈 길을 모른다.`);
      }
    }
    if (p.exit_hint !== undefined && !String(p.exit_hint).trim()) {
      fail('P1', `phases.${name}.exit_hint가 비어 있다`, `다음 단계로 가는 실제 명령을 적어라 (예: "python harness/phase.py enter GREEN").`);
    }
  }

  const enf = m.enforce || {};
  if (!['block', 'warn'].includes(enf.default)) {
    fail('P1', `enforce.default가 'block'|'warn'이 아니다: ${JSON.stringify(enf.default)}`, `enforce.default를 "block" 또는 "warn"으로 고쳐라.`);
  }
  for (const ph of enf.warn_only || []) {
    if (!names.includes(ph)) {
      fail('P1', `enforce.warn_only에 없는 단계 '${ph}'가 있다`, `오타이거나 삭제된 단계다. phases에 정의된 단계명(${names.join(', ')}) 중 하나로 고치거나 목록에서 빼라.`);
    }
  }
  if ((enf.warn_only || []).length > 0) {
    note('P1', `enforce: default=${enf.default}, warn_only=[${(enf.warn_only || []).join(', ')}] — 이 단계들은 차단 대신 경고만 낸다`);
  }
}

// ── P2 IDLE 도달성 / P4 전이 그래프 연결성 ──────────────────────────────────
function checkReachability(m) {
  const names = Object.keys(m.phases || {});
  if (!names.length) return;

  const edges = new Map(names.map((n) => [n, new Set()]));
  const wildcardTargets = new Set();

  for (const t of m.transitions || []) {
    const tos = Array.isArray(t.to) ? t.to : [t.to];
    for (const to of tos) {
      if (!names.includes(to)) {
        fail('P1', `transitions에 정의되지 않은 목적지 단계 '${to}'가 있다 (from: ${t.from})`, `phases에 '${to}'를 정의하거나 이 전이를 지워라.`);
        continue;
      }
      if (t.from === '*') {
        wildcardTargets.add(to);
      } else if (!names.includes(t.from)) {
        fail('P1', `transitions에 정의되지 않은 출발 단계 '${t.from}'가 있다`, `phases에 '${t.from}'를 정의하거나 이 전이를 지워라.`);
      } else {
        edges.get(t.from).add(to);
      }
    }
  }
  for (const n of names) for (const to of wildcardTargets) edges.get(n).add(to);

  // P2: IDLE에서 전 단계 도달 가능한가
  const seen = new Set(['IDLE']);
  const queue = ['IDLE'];
  if (!names.includes('IDLE')) {
    fail('P2', `단계 'IDLE'이 정의되지 않았다`, `IDLE은 상태 파일 부재·손상 시의 fail-closed 기본값이다. 반드시 존재해야 한다.`);
    return;
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const to of edges.get(cur) || []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  for (const n of names) {
    if (!seen.has(n)) {
      fail('P2', `단계 '${n}'에 IDLE에서 도달할 수 없다 — 죽은 단계다`, `transitions에 '${n}'로 가는 간선을 추가하라. 도달 불가 단계는 phase.py가 절대 만들 수 없으므로, 그 단계의 write_allow는 영원히 죽은 규칙이다.`);
    }
  }

  // P4: 모든 단계가 IDLE로 되돌아갈 수 있는가 (역방향 도달성 = 그래프 연결)
  const rev = new Map(names.map((n) => [n, new Set()]));
  for (const [from, tos] of edges) for (const to of tos) rev.get(to).add(from);
  const back = new Set(['IDLE']);
  const q2 = ['IDLE'];
  while (q2.length) {
    const cur = q2.shift();
    for (const from of rev.get(cur) || []) {
      if (!back.has(from)) {
        back.add(from);
        q2.push(from);
      }
    }
  }
  for (const n of names) {
    if (!back.has(n)) {
      fail('P4', `단계 '${n}'에서 IDLE로 돌아갈 수 없다 — 흡수 상태(트랩)다`, `'${n}' → IDLE 중단 경로를 추가하라. 나갈 수 없는 단계에 들어간 세션은 상태 파일을 손으로 고치는 수밖에 없고, 그 순간 통제면이 무의미해진다.`);
    }
  }
}

// ── P3 빈 write_allow ────────────────────────────────────────────────────────
function checkWriteAllow(m) {
  for (const [name, p] of Object.entries(m.phases || {})) {
    const allow = p.write_allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      fail('P3', `phases.${name}.write_allow가 비어 있다`, `단계 '${name}'에서는 어떤 파일도 쓸 수 없다는 뜻이다. 의도한 것이면 그 단계는 존재할 이유가 없다. 최소한 "_workspace/**"를 넣어 기록이라도 남길 수 있게 하라.`);
    }
  }
}

// ── P5 가드 참조 무결성 ─────────────────────────────────────────────────────
function checkGuards(m) {
  const defined = new Set(Object.keys(m.guards || {}));
  const referenced = new Set();
  for (const t of m.transitions || []) for (const g of t.guards || []) referenced.add(g);

  for (const g of referenced) {
    if (!defined.has(g)) {
      fail('P5', `전이가 정의되지 않은 가드 '${g}'를 참조한다`, `guards.${g}를 정의하거나 전이에서 이 가드를 빼라. 미정의 가드는 phase.py에서 조용히 통과되거나(가장 나쁨) 크래시한다.`);
    }
  }
  for (const g of defined) {
    if (!referenced.has(g)) {
      note('P5', `가드 '${g}'가 정의만 되고 아무 전이도 쓰지 않는다 — 죽은 가드다 (advisory)`);
    }
  }
  for (const [name, g] of Object.entries(m.guards || {})) {
    if (!g.fail_hint || !String(g.fail_hint).trim()) {
      fail('P5', `guards.${name}에 fail_hint가 없다`, `가드가 막았을 때 "무엇을 어떻게 하면 통과하는지"를 적어라 (센서 카탈로그 운영 규칙 2). 이유 없는 차단은 force 습관으로 이어진다.`);
    }
    if (!g.kind) {
      fail('P5', `guards.${name}에 kind가 없다`, `kind를 지정하라 (grep_count | state_field | git | exec | file_contains).`);
    }
  }
}

// ── P6 deny가 자기 allow를 가림 ──────────────────────────────────────────────
function checkShadowing(m) {
  for (const [name, p] of Object.entries(m.phases || {})) {
    const denies = (p.write_deny || []).map((d) => ({ glob: d, re: globToRegExp(d) }));
    for (const a of p.write_allow || []) {
      const sample = sampleFromGlob(a);
      for (const d of denies) {
        if (d.re.test(sample)) {
          fail(
            'P6',
            `phases.${name}: deny '${d.glob}'가 자기 allow '${a}'를 가린다 (예: ${sample})`,
            `둘 중 하나를 지워라. deny가 allow를 덮으면 그 allow는 문서상으로만 존재하고 실제로는 절대 허용되지 않는다 — 에이전트가 "허용됐다는데 막힌다"를 겪는 순간 게이트 신뢰가 무너진다.`
          );
        }
      }
    }
  }
}

// ── P7 tool-risk 무결성 ─────────────────────────────────────────────────────
function checkRisk(r) {
  const tiers = Object.keys(r.tiers || {});
  if (!tiers.length) {
    fail('P1', `tool-risk.json에 tiers가 없다`, `R0~R3 등급 정의를 추가하라.`);
    return;
  }
  for (const [tier, t] of Object.entries(r.tiers)) {
    for (const key of ['label', 'definition', 'policy', 'enforced_by']) {
      if (!t[key]) fail('P1', `tiers.${tier}에 '${key}'가 없다`, `tiers.${tier}.${key}를 채워라. enforced_by가 없으면 "누가 강제하는가"가 불명확해져 훅과 permissions가 서로 미룬다.`);
    }
  }
  for (const group of ['file_tools', 'bash_prefixes']) {
    for (const tier of Object.keys(r[group] || {})) {
      if (!tiers.includes(tier)) {
        fail('P7', `${group}에 정의되지 않은 등급 '${tier}'가 있다`, `tiers에 '${tier}'를 정의하거나 오타를 고쳐라 (정의된 등급: ${tiers.join(', ')}).`);
      }
    }
  }

  // 같은 접두사가 두 등급에 있으면 판정이 비결정적이 된다
  const seen = new Map();
  for (const [tier, list] of Object.entries(r.bash_prefixes || {})) {
    for (const p of list) {
      if (seen.has(p)) {
        fail('P7', `bash 접두사 '${p}'가 ${seen.get(p)}와 ${tier} 두 등급에 중복 정의됐다`, `한쪽에서 지워라. 중복은 판정 순서에 따라 결과가 달라지는 비결정 게이트를 만든다.`);
      } else {
        seen.set(p, tier);
      }
    }
  }
  // 더 긴(더 구체적인) 접두사가 더 낮은 위험 등급에 있으면 최장일치가 위험을 낮춘다
  const rank = { R0: 0, R1: 1, R2: 2, R3: 3 };
  for (const [a, ta] of seen) {
    for (const [b, tb] of seen) {
      if (a !== b && b.startsWith(a + ' ') && rank[tb] < rank[ta]) {
        fail('P7', `'${b}'(${tb})가 '${a}'(${ta})보다 구체적인데 위험 등급이 더 낮다`, `최장일치 판정에서 '${b}'가 '${a}'의 통제를 무력화한다. '${b}'의 등급을 ${ta} 이상으로 올려라.`);
      }
    }
  }

  const pp = r.protected_paths || {};
  if (!Array.isArray(pp.deny_redirect) || pp.deny_redirect.length === 0) {
    fail('P7', `protected_paths.deny_redirect가 비어 있다`, `최소한 ".harness/state/", "evals/golden/", ".claude/settings.json", "harness/policy/"를 넣어라. 이 목록이 비면 Bash 리다이렉트로 통제면을 통째로 덮어쓸 수 있다.`);
  }
  const decision = (r.unknown_prefix_policy || {}).decision;
  if (!['allow', 'deny', 'ask'].includes(decision)) {
    fail('P7', `unknown_prefix_policy.decision이 allow|deny|ask가 아니다: ${JSON.stringify(decision)}`, `"ask"를 권장한다. "allow"는 미지 명령을 전부 통과시키고, "deny"는 범용 셸을 버려 전용 도구 폭증으로 간다.`);
  }
  if (decision === 'allow') {
    note('P7', `unknown_prefix_policy.decision="allow" — 미지의 셸 명령이 전부 통과한다. 경계면의 가장 큰 구멍이다 (advisory)`);
  }
}


// ── P8 매칭 불가능한 패턴 ────────────────────────────────────────────────────
/**
 * 문법도 배선도 완벽한데 **의미만 죽은** 가드를 잡는다.
 *
 * 실제 사례 (2026-07-27, W2a 발견): no_pending_spec의 패턴이
 *   "^- \\*\\*RQ-[0-9]+\\*\\* .*\\ud83d\\udfe1"
 * 였다. JSON의 \\u는 리터럴 '\u' 두 글자를 낳고, 파이썬 re는 그것을 **짝 없는
 * 서로게이트 2개**로 읽는다. 그런데 파이썬 문자열에서 🟡는 단일 코드포인트 U+1F7E1이라
 * 서로게이트 쌍으로 쪼개지지 않는다 → **어떤 입력에도 매칭되지 않는다.**
 * 가드는 늘 0건을 돌려주고 expect:0과 일치해 **항상 통과**했다.
 * SPEC→PLAN과 PLAN→RED 양쪽에서 스펙 동결이 전혀 강제되지 않고 있었다.
 * gate_spec_freeze.py를 "영구 no-op"이라고 지우고 기능을 이 가드로 흡수했는데,
 * 그 가드가 다른 이유로 똑같이 no-op였다.
 *
 * **반드시 정적 검사여야 한다.** JS 문자열은 UTF-16이라 /\ud83d\udfe1/는 🟡와 실제로
 * 매칭된다 — 정규식을 JS에서 돌려 확인하면 통과하는데 파이썬 가드는 여전히 죽어 있다.
 * 검사가 검사 대상의 언어를 잘못 고르면 검사 자체가 위양성 통과를 만든다.
 * P1~P7이 전부 PASS인 상태에서 이 결함이 살아 있었다는 것이 이 검사의 존재 이유다.
 */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}|\\U0000[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** 문자열 안의 짝 없는 서로게이트 코드 유닛 위치. 쌍을 이룬 것은 정상이므로 건너뛴다. */
function unpairedSurrogates(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else out.push(i);
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(i);
    }
  }
  return out;
}

function checkPatterns(m) {
  for (const [name, g] of Object.entries(m.guards || {})) {
    const pat = g.pattern;
    if (typeof pat !== 'string' || !pat) continue;

    const esc = SURROGATE_ESCAPE.exec(pat);
    if (esc) {
      fail(
        'P8',
        `guards.${name}의 패턴에 서로게이트 이스케이프 '${esc[0]}'가 있다 — 파이썬 re에서 이 패턴은 어떤 입력에도 매칭되지 않는다`,
        `이스케이프를 지우고 **문자를 그대로** 써라 (예: \\ud83d\\udfe1 → 🟡). 파이썬 문자열의 이모지는 단일 코드포인트라 ` +
          `서로게이트 쌍으로 쪼개지지 않는다. 지금 이 가드는 늘 0건을 돌려주고 expect와 일치해 **항상 통과**한다 — ` +
          `즉 게이트가 꺼져 있는데 초록으로 보인다. JS에서 같은 정규식을 돌리면 매칭되므로 실행으로는 확인되지 않는다.`
      );
    }

    const lone = unpairedSurrogates(pat);
    if (lone.length) {
      fail(
        'P8',
        `guards.${name}의 패턴에 짝 없는 서로게이트 문자가 ${lone.length}개 있다 (위치 ${lone.join(', ')})`,
        `패턴을 UTF-8로 다시 저장하고 해당 문자를 올바른 코드포인트로 써라. 짝 없는 서로게이트는 파이썬과 JS가 다르게 해석해 ` +
          `양쪽에서 다른 판정이 나온다 — 같은 정책 파일이 언어마다 다르게 집행되는 상태다.`
      );
    }

    // ── 부가 신호 (권위 없음): "0건이라 통과"와 "매칭 능력이 없어 통과"를 구별한다
    if (g.expect !== 0 || !g.file || g.file.includes('${')) continue;
    const abs = join(ROOT, g.file);
    if (!existsSync(abs)) {
      note('P8', `guards.${name}의 대상 파일 ${g.file}이 없다 — 판정할 대상 자체가 없다 (advisory)`);
      continue;
    }
    let re;
    try {
      re = new RegExp(pat);
    } catch {
      note('P8', `guards.${name}의 패턴을 JS로 컴파일할 수 없다 (파이썬 전용 문법일 수 있다) — 정적 검사만 적용했다 (advisory)`);
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    if (lines.some((l) => re.test(l))) continue; // 매칭이 있으면 살아 있는 패턴이다

    // 매칭 0건 — 위반이 없어서인가, 노릴 대상이 아예 없어서인가
    const head = pat.split('.*')[0];
    let relaxed = null;
    if (head && head !== pat) {
      try {
        const rre = new RegExp(head);
        relaxed = lines.filter((l) => rre.test(l)).length;
      } catch {
        relaxed = null;
      }
    }
    if (relaxed === 0) {
      note(
        'P8',
        `guards.${name}: 패턴이 0건인데 완화 패턴('${head}')도 0건이다 — '위반이 없다'인지 '검사 대상이 없다'인지 구별되지 않는다 (advisory)`
      );
    }
  }
}

// ── README 생성 ─────────────────────────────────────────────────────────────
function cell(v) {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => '`' + x + '`').join(' ') : '—';
  return String(v).replace(/\|/g, '\\|');
}

function renderReadme(m, r) {
  const L = [];
  L.push('# 정책 표 — 생성물 (손으로 고치지 마라)');
  L.push('');
  L.push('이 파일은 `node scripts/policy-lint.mjs --print` 가 `harness/policy/*.json`에서 생성한다.');
  L.push('손으로 고치면 다음 생성에서 지워진다. 표를 바꾸고 싶으면 **JSON을 바꾸고 다시 생성**하라 —');
  L.push('표와 정책이 어긋날 자리를 없애는 것이 이 파일이 생성물인 유일한 이유다.');
  L.push('');
  L.push('> 갱신일을 여기 적지 않는다. 날짜는 `git log -1 --format=%cI -- harness/policy/README.md` 가 안다.');
  L.push('');

  const enf = m.enforce || {};
  L.push('## 집행 수준');
  L.push('');
  L.push('| 항목 | 값 |');
  L.push('|---|---|');
  L.push(`| 기본 | \`${enf.default}\` |`);
  L.push(`| 경고만(warn_only) | ${cell(enf.warn_only)} |`);
  L.push('');
  L.push('`warn_only` 단계는 차단 대신 stderr 경고만 낸다. 게이트의 첫 주가 가장 위험하므로');
  L.push('(차단이 잦으면 `force`가 습관이 되고 그 순간 전체가 장식이 된다) 일부 단계를 유예한다.');
  L.push('**`force` 비율이 5%를 넘으면 에이전트가 아니라 이 매트릭스가 틀렸다는 신호다.**');
  L.push('');

  L.push('## 단계 × 경로 (R1 — 로컬 변경)');
  L.push('');
  L.push('기본값은 default-deny. `write_allow`에 걸리지 않으면 막힌다. `write_deny`는 메시지 품질용');
  L.push('명시 목록이다 — "왜 막혔는가"를 정확히 말하기 위해 존재한다.');
  L.push('');
  L.push('| 단계 | 목적 | write_allow | write_deny |');
  L.push('|---|---|---|---|');
  for (const [name, p] of Object.entries(m.phases || {})) {
    L.push(`| \`${name}\` | ${cell(p.purpose)} | ${cell(p.write_allow)} | ${cell(p.write_deny)} |`);
  }
  L.push('');

  L.push('### 나가는 길 (exit_hint)');
  L.push('');
  L.push('| 단계 | 다음 |');
  L.push('|---|---|');
  for (const [name, p] of Object.entries(m.phases || {})) {
    L.push(`| \`${name}\` | ${cell(p.exit_hint)} |`);
  }
  L.push('');

  L.push('## 전이와 가드');
  L.push('');
  L.push('합법적 간선도 **직전 단계만 만들 수 있는 산출물**을 요구한다.');
  L.push('단계를 뒤집는 것은 막을 수 없지만, 뒤집어도 얻는 게 없다.');
  L.push('');
  L.push('| from | to | 가드 |');
  L.push('|---|---|---|');
  for (const t of m.transitions || []) {
    const tos = (Array.isArray(t.to) ? t.to : [t.to]).map((x) => '`' + x + '`').join(' · ');
    L.push(`| \`${t.from}\` | ${tos} | ${cell(t.guards)} |`);
  }
  L.push('');

  L.push('### 가드 정의');
  L.push('');
  L.push('| 가드 | 종류 | 판정 대상 | 막혔을 때 |');
  L.push('|---|---|---|---|');
  for (const [name, g] of Object.entries(m.guards || {})) {
    const target =
      g.cmd ? '`' + g.cmd.join(' ') + '`' :
      g.file ? '`' + g.file + '`' :
      g.expr ? '`' + g.expr + '`' : '—';
    L.push(`| \`${name}\` | ${cell(g.kind)} | ${target} | ${cell(g.fail_hint)} |`);
  }
  L.push('');

  L.push('## 위험 등급 (도구)');
  L.push('');
  L.push('축은 "가역성 × 경계 이탈"이다 — 파일 경로가 아니라 도구의 성질로 나눈다.');
  L.push('');
  L.push('| 등급 | 이름 | 정의 | 정책 | 강제 주체 |');
  L.push('|---|---|---|---|---|');
  for (const [tier, t] of Object.entries(r.tiers || {})) {
    // enforced_by는 경로가 아니라 라벨이다 — 백틱으로 감싸면 doc-freshness C4가 경로로 오인한다
    L.push(`| **${tier}** | ${cell(t.label)} | ${cell(t.definition)} | ${cell(t.policy)} | ${cell(t.enforced_by)} |`);
  }
  L.push('');

  L.push('### 파일 도구');
  L.push('');
  L.push('| 등급 | 도구 |');
  L.push('|---|---|');
  for (const [tier, list] of Object.entries(r.file_tools || {})) {
    L.push(`| ${tier} | ${cell(list)} |`);
  }
  L.push('');

  L.push('### Bash 접두사');
  L.push('');
  L.push('| 등급 | 접두사 |');
  L.push('|---|---|');
  for (const [tier, list] of Object.entries(r.bash_prefixes || {})) {
    L.push(`| ${tier} | ${cell(list)} |`);
  }
  L.push('');
  L.push(`미지의 접두사: **${cell((r.unknown_prefix_policy || {}).decision)}**`);
  L.push('');

  L.push('### 보호 경로 (리다이렉트 차단)');
  L.push('');
  L.push(cell((r.protected_paths || {}).deny_redirect));
  L.push('');
  L.push('Bash 리다이렉트(`> path` / `>> path`)로 통제면을 우회하는 시도를 **탐지**한다.');
  L.push('예방이 아니다 — `node -e "fs.writeFileSync(...)"` 같은 우회는 문자열 파싱으로 막을 수 없다.');
  L.push('사후 대조는 `node scripts/phase-audit.mjs`가 git 이력에서 독립적으로 수행한다.');
  L.push('');

  return L.join('\n') + '\n';
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('사용법: node scripts/policy-lint.mjs [--print]');
  console.log('  (인자 없음)  harness/policy/*.json 검증. 실패 시 exit 1');
  console.log('  --print      harness/policy/README.md 재생성 (검증도 함께 수행)');
  process.exit(0);
}

if (matrix) {
  checkMatrixSchema(matrix);
  checkReachability(matrix);
  checkWriteAllow(matrix);
  checkGuards(matrix);
  checkShadowing(matrix);
}
if (matrix) checkPatterns(matrix);
if (risk) checkRisk(risk);

console.log('정책 린트 — harness/policy/');
console.log('');
if (matrix) {
  const phaseCount = Object.keys(matrix.phases || {}).length;
  const guardCount = Object.keys(matrix.guards || {}).length;
  console.log(`  phase-matrix.json : 단계 ${phaseCount} · 전이 ${(matrix.transitions || []).length} · 가드 ${guardCount}`);
}
if (risk) {
  const prefixCount = Object.values(risk.bash_prefixes || {}).reduce((n, l) => n + l.length, 0);
  console.log(`  tool-risk.json    : 등급 ${Object.keys(risk.tiers || {}).length} · bash 접두사 ${prefixCount} · 보호 경로 ${((risk.protected_paths || {}).deny_redirect || []).length}`);
}
console.log('');

const checks = [
  ['P1', '스키마 유효성'],
  ['P2', 'IDLE에서 전 단계 도달 가능'],
  ['P3', '빈 write_allow 없음'],
  ['P4', '전이 그래프 연결 (모든 단계 → IDLE)'],
  ['P5', '미정의 가드 참조 없음'],
  ['P6', 'deny가 자기 allow를 가리지 않음'],
  ['P7', 'tool-risk 무결성'],
  ['P8', '매칭 불가능한 패턴 없음'],
];
for (const [id, label] of checks) {
  const n = problems.filter((p) => p.id === id).length;
  console.log(`  ${n === 0 ? 'PASS' : 'FAIL'}  ${id}  ${label}${n ? ` — ${n}건` : ''}`);
}

if (notes.length) {
  console.log('');
  console.log('참고:');
  for (const n of notes) console.log(`  · [${n.id}] ${n.what}`);
}

if (problems.length) {
  console.log('');
  for (const p of problems) {
    console.log(`FAIL [${p.id}] ${p.what}`);
    console.log(`     고치는 법: ${p.how}`);
  }
  console.log('');
  console.log(`정책 린트 실패 — ${problems.length}건. 위 "고치는 법"을 따라 harness/policy/*.json을 고쳐라.`);
  process.exit(1);
}

if (args.includes('--print')) {
  if (!matrix || !risk) {
    console.error('README를 생성하려면 phase-matrix.json과 tool-risk.json이 둘 다 필요하다.');
    process.exit(1);
  }
  const out = renderReadme(matrix, risk);
  const prev = existsSync(README) ? readFileSync(README, 'utf8') : null;
  writeFileSync(README, out, 'utf8');
  console.log('');
  console.log(
    prev === out
      ? '  harness/policy/README.md — 변경 없음 (정책과 표가 일치한다)'
      : `  harness/policy/README.md ${prev === null ? '생성' : '갱신'} — ${out.split('\n').length}줄`
  );
}

console.log('');
console.log('정책 린트 통과.');
process.exit(0);
