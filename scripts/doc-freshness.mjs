#!/usr/bin/env node
/**
 * scripts/doc-freshness.mjs — 문서 드리프트 센서 (C1~C6).
 *
 * 핵심 설계 결정: **문서에서 `updated:` 필드를 읽지 않는다.**
 * 프론트매터의 날짜는 반드시 거짓말을 한다 — 문서를 고치면서 날짜를 안 고치거나, 날짜만 고친다.
 * 갱신일은 전부 git에서 유도한다: `git log -1 --format=%cI -- <path>`.
 * 이 결정 하나가 "메타데이터 자체의 드리프트"라는 문제 계층을 통째로 제거한다.
 * 따라서 이 스크립트에는 날짜를 **쓰는** 경로가 없다. 읽기만 한다.
 *
 *   --digest              ≤5줄. SessionStart 훅용. 항상 exit 0 (세션을 막지 않는다)
 *   --pr [--base <ref>]   차단용. C2를 **이 PR이 건드린 파일로만** 좁힌다
 *   --full                저장소 전체 + 처방. harness-audit 스킬용 (기본 모드)
 *   --strict              advisory(C2 repo·C3·C6)도 차단 대상으로 승격
 *
 * 검사 정의와 심각도의 진실 공급원은 harness/doc-map.json이다. 이 파일은 그것을 실행할 뿐이다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, posix } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOC_MAP = join(ROOT, 'harness/doc-map.json');
const DAY = 86400000;

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/doc-freshness.mjs [--digest | --pr [--base <ref>] | --full] [--strict]');
  process.exit(0);
}
const MODE = argv.includes('--digest') ? 'digest' : argv.includes('--pr') ? 'pr' : 'full';
const STRICT = argv.includes('--strict');
const BASE = (() => {
  const i = argv.indexOf('--base');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'origin/main';
})();

// ── git ─────────────────────────────────────────────────────────────────────
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * 전체 이력을 한 번만 읽어 경로 → 최신 커밋 시각 색인을 만든다.
 * `git log -1 -- <path>`를 문서마다 부르면 문서 24개 × 의존 10개 = 프로세스 240개다.
 * 결과는 `git log -1 --format=%cI -- <path>`와 동일하다 (git log는 최신순이므로 첫 등장이 최신 커밋).
 * 느린 센서는 꺼지는 센서다.
 */
const MARK = '@@commit@@';
function buildCommitIndex() {
  const out = git(['log', `--pretty=format:${MARK}%cI ${MARK}%h`, '--name-only']);
  const index = new Map();
  if (out === null) return index;
  let time = null;
  let sha = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(MARK)) {
      const [t, h] = line.split(` ${MARK}`);
      time = t.slice(MARK.length);
      sha = h;
      continue;
    }
    if (!index.has(line)) index.set(line, { time, sha });
  }
  return index;
}

function listFiles() {
  const out = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  if (out === null) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── glob ────────────────────────────────────────────────────────────────────
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
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const reCache = new Map();
function matches(glob, path) {
  if (!reCache.has(glob)) reCache.set(glob, globToRegExp(glob));
  return reCache.get(glob).test(path);
}

// ── 로드 ────────────────────────────────────────────────────────────────────
if (!existsSync(DOC_MAP)) {
  console.error('harness/doc-map.json이 없다 — 문서 레지스트리 없이는 이 센서가 판단할 근거가 없다.');
  console.error('고치는 법: harness/doc-map.json을 만들어라 (governed_globs / docs[] / checks).');
  process.exit(1);
}
let map;
try {
  map = JSON.parse(readFileSync(DOC_MAP, 'utf8'));
} catch (e) {
  console.error(`harness/doc-map.json 파싱 실패: ${e.message}`);
  console.error('고치는 법: JSON 문법 오류를 고쳐라. 이 파일이 깨지면 문서 거버넌스 전체가 멈춘다.');
  process.exit(1);
}

const CHECKS = map.checks || {};
const DEFAULTS = map.defaults || {};
const files = listFiles();
const commits = buildCommitIndex();
const NOW = Date.now();

const findings = []; // {check, severity, doc, lines[]}
function add(check, doc, lines) {
  const def = CHECKS[check] || {};
  let severity = def.severity || 'advisory';
  // C2는 PR 범위에서만 blocking — 저장소 전체 낡음을 게이트로 걸면 첫날부터 모든 PR이 빨개지고
  // 게이트는 그날로 무시된다. "이 PR이 건드린 의존만 책임진다"가 게이트를 살려둔다.
  if (check === 'C2' && MODE !== 'pr' && def.advisory_scope) severity = 'advisory';
  findings.push({ check, severity, doc, lines });
}

function lastCommit(path) {
  return commits.get(path) || null;
}
function expand(pattern) {
  if (!/[*?]/.test(pattern)) return existsSync(join(ROOT, pattern)) ? [pattern] : [];
  return files.filter((f) => matches(pattern, f));
}
function ageDays(iso) {
  return Math.floor((NOW - Date.parse(iso)) / DAY);
}
function fmt(iso) {
  return iso ? iso.replace('T', ' ').replace(/[+-]\d\d:\d\d$/, '') : '(미커밋)';
}

// ── PR 범위 ─────────────────────────────────────────────────────────────────
let changed = null;
let baseUsed = null;
if (MODE === 'pr') {
  for (const ref of [BASE, 'main', 'HEAD~1']) {
    const out = git(['diff', '--name-only', `${ref}...HEAD`]);
    if (out !== null) {
      changed = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
      baseUsed = ref;
      break;
    }
  }
  if (changed === null) {
    changed = new Set();
    baseUsed = '(base 참조 해석 실패 — 워킹트리만 봄)';
  }
  // 워킹트리·인덱스의 미커밋 변경도 이 PR의 일부로 본다 (커밋 전 로컬 실행에서도 맞는 답이 나오게)
  for (const args of [['diff', '--name-only', 'HEAD'], ['diff', '--name-only', '--cached']]) {
    for (const f of (git(args) || '').split('\n')) if (f.trim()) changed.add(f.trim());
  }
}

// ── C1 레지스트리 완결성 ────────────────────────────────────────────────────
const governed = files.filter(
  (f) =>
    (map.governed_globs || []).some((g) => matches(g, f)) &&
    !(map.exclude_globs || []).some((g) => matches(g, f))
);
const registryPatterns = (map.docs || []).map((d) => d.path);

function checkC1() {
  for (const f of governed.filter((f) => !registryPatterns.some((p) => p === f || matches(p, f)))) {
    add('C1', f, [
      `레지스트리에 없는 관리 대상 문서: ${f}`,
      `  고치는 법: harness/doc-map.json의 docs[]에 항목을 추가하라 —`,
      `    { "path": "${f}", "tier": ${DEFAULTS.tier ?? 2}, "purpose": "...", "depends_on": [], "review_every_days": ${DEFAULTS.review_every_days ?? 90} }`,
      `  이 문서가 관리 대상이 아니면 exclude_globs에 넣어라. 판단을 미루면 C1은 영원히 빨갛다.`,
    ]);
  }
  for (const d of map.docs || []) {
    if (expand(d.path).length === 0) {
      add('C1', d.path, [
        `레지스트리에 등록됐지만 실재하지 않는 문서: ${d.path}`,
        `  고치는 법: 파일을 만들거나(목적: ${d.purpose || '—'}), doc-map.json의 docs[]에서 이 항목을 지워라.`,
        `  존재하지 않는 문서의 depends_on은 영원히 검사되지 않는다 — 조용한 무검사가 가장 나쁘다.`,
      ]);
    }
  }
}

// ── C2 결합 낡음 ────────────────────────────────────────────────────────────
const uncommittedDeps = [];
function checkC2() {
  for (const d of map.docs || []) {
    const deps = d.depends_on || DEFAULTS.depends_on || [];
    if (!deps.length) continue;
    for (const docPath of expand(d.path)) {
      const docCommit = lastCommit(docPath);
      // 문서 축의 면제(`MODE === 'pr' && changed.has(docPath)` → continue)는 **제거했다.**
      //
      // "이 PR이 문서를 동행시켰으면 책임을 다한 것이다"라는 가정이 틀렸다. 동행은
      // **건드렸다**는 뜻이지 **의존보다 나중이다**는 뜻이 아니다. 문서를 먼저 고치고
      // 그 다음 의존을 고치면 문서는 여전히 낡았는데 면제된다 — 그리고 그것이 정확히
      // 2026-07-27 B-d 가 새어나간 경로다(115커밋 브랜치에서 문서·의존이 둘 다 변경
      // 집합에 있어 이 줄이 전부 삼켰다).
      //
      // 아래 `:!changed.has(depFile)` (의존 축)은 **그대로 둔다.** 게이트 범위를 넓히는
      // 것은 그쪽이고, 넓히면 첫날부터 모든 PR 이 빨개져 게이트가 무시된다. 두 축은
      // 독립이므로 문서 축만 지워도 분모는 저장소 전체로 넓어지지 않는다.
      //
      // 판정 기준은 아래 `Date.parse(dc.time) > Date.parse(docCommit.time)` 시각 비교
      // 하나다 — 문서가 의존보다 **나중에** 커밋되면 통과한다. 고치는 법이 "문서를
      // 건드려라"가 아니라 "의존을 고친 뒤에 문서를 고쳐라"가 된다.
      if (!docCommit) continue; // 미커밋 문서는 낡을 수가 없다

      let worst = null;
      for (const dep of deps) {
        for (const depFile of expand(dep)) {
          if (depFile === docPath) continue;
          if (MODE === 'pr' && !changed.has(depFile)) continue; // ← C2의 PR 스코프
          const dc = lastCommit(depFile);
          if (!dc) {
            if (MODE === 'full') uncommittedDeps.push({ doc: docPath, dep: depFile, pattern: dep });
            continue;
          }
          if (Date.parse(dc.time) > Date.parse(docCommit.time)) {
            if (!worst || Date.parse(dc.time) > Date.parse(worst.time)) worst = { ...dc, file: depFile, pattern: dep };
          }
        }
      }
      if (!worst) continue;

      const gap = Math.round((Date.parse(worst.time) - Date.parse(docCommit.time)) / DAY);
      add('C2', docPath, [
        `[C2 결합 낡음] ${docPath}`,
        `  문서 최종 커밋 : ${fmt(docCommit.time)}  (${docCommit.sha})`,
        `  움직인 의존    : ${worst.file}  ${fmt(worst.time)}  (${worst.sha})  — 문서보다 ${gap}일 나중`,
        `                   ↳ depends_on 패턴: ${worst.pattern}`,
        `  고치는 법 — 셋 중 하나를 골라라:`,
        `    1) 문서를 갱신한다 — ${worst.file}의 변경을 ${docPath}에 반영하고 **같은 PR**에 넣는다. (기본 처방)`,
        `    2) 의존이 틀렸다 — doc-map.json에서 '${worst.pattern}'를 지우거나 더 좁게 고친다. 왜 무관한지를 _doc에 남긴다.`,
        `    3) 문서를 지운다 — 더 이상 무엇의 진실 공급원도 아니면 docs[]에서 빼고 파일도 지운다.`,
        `  (날짜만 고치는 4번째 길은 없다 — 갱신일은 git에서만 나오고 이 스크립트는 날짜를 쓰지 않는다.)`,
      ]);
    }
  }
}

// ── C3 나이 초과 ────────────────────────────────────────────────────────────
function checkC3() {
  for (const d of map.docs || []) {
    const limit = d.review_every_days ?? DEFAULTS.review_every_days ?? 90;
    for (const docPath of expand(d.path)) {
      const c = lastCommit(docPath);
      if (!c) continue;
      const age = ageDays(c.time);
      if (age > limit) {
        add('C3', docPath, [
          `${docPath} — ${age}일 경과 (검토 주기 ${limit}일, ${age - limit}일 초과)`,
          `  고치는 법: 읽고 (a) 여전히 맞으면 고칠 게 없다는 뜻이니 review_every_days를 늘려라, (b) 틀렸으면 고쳐라, (c) 아무도 안 읽으면 지워라.`,
        ]);
      }
    }
  }
}

// ── C4 링크·경로 무결성 ─────────────────────────────────────────────────────
const PATH_EXT = /\.(md|json|jsonl|ts|tsx|mjs|cjs|js|py|sh|ya?ml|html|css|txt|toml)$/;

/**
 * **gitignore 된 경로는 죽은 참조가 아니라 생성물이다.**
 *
 * 이 구분이 없으면 C4 는 **환경 의존 센서**가 된다 — `dist/server/main.js` 는
 * `npm run build` 를 돌린 머신에는 있고 신선한 체크아웃에는 없다. 그래서 이 검사는
 * 개발 머신에서 초록이고 CI 에서 빨갛다. 문서(`docs/adr/0006-deployment.md`)는 그
 * 경로를 **정당하게** 인용한다 — 배포 산출물의 이름이 그것이기 때문이다.
 *
 * 2026-07-29 에 `doc-freshness --pr` 을 `ci.yml` 에 처음 배선하면서 드러났다.
 * **그 전까지 이 검사는 빌드 산출물이 있는 머신에서만 돌았고, 아무도 몰랐다.**
 * "센서가 환경에 따라 다른 답을 내면 그 센서는 판정에 쓸 수 없다"가 여기의 교훈이다.
 *
 * 판정은 `git check-ignore --stdin` 한 번으로 일괄한다(경로마다 서브프로세스를 띄우면
 * 문서 수에 비례해 느려진다). git 을 못 부르면 **아무것도 무시하지 않는다** —
 * 판정 불가일 때 통과시키는 쪽이 아니라 원래대로 두는 쪽이다.
 */
function ignoredPaths(candidates) {
  if (!candidates.length) return new Set();
  const r = spawnSync('git', ['check-ignore', '--stdin'],
    { cwd: ROOT, input: candidates.join('\n'), encoding: 'utf8' });
  // exit 0 = 하나 이상 무시됨, 1 = 무시된 것 없음, 그 외 = 오류
  if (r.status !== 0 && r.status !== 1) return new Set();
  return new Set((r.stdout || '').split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean));
}

function checkC4() {
  const fileSet = new Set(files);
  for (const d of map.docs || []) {
    for (const docPath of expand(d.path)) {
      if (!docPath.endsWith('.md')) continue;
      const abs = join(ROOT, docPath);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8').replace(/```[\s\S]*?```/g, ''); // 펜스 코드는 예시다
      const dead = [];
      const seen = new Set();

      const consider = (raw, kind) => {
        const t = raw.trim().split('#')[0].trim();
        if (!t || seen.has(t)) return;
        if (/^(https?:|mailto:|tel:|data:|#)/.test(t)) return;
        if (/[\s<>|"'`${}()]/.test(t)) return;
        if (kind === 'backtick' && !t.includes('/')) return;
        if (kind === 'backtick' && !PATH_EXT.test(t) && !t.endsWith('/')) return;
        seen.add(t);
        const candidates = [t.replace(/^\.\//, ''), posix.normalize(posix.join(posix.dirname(docPath), t))];
        for (const c of candidates) {
          const bare = c.replace(/\/+$/, '');
          if (/[*?]/.test(bare)) {
            if (files.some((f) => matches(bare, f))) return;
            // git ls-files는 gitignore된 경로를 모른다. _workspace/review/*.md 처럼
            // 추적되지 않지만 실재하는 디렉터리를 죽은 참조로 몰지 않으려면 디스크도 봐야 한다.
            const star = bare.search(/[*?]/);
            const dir = bare.slice(0, bare.lastIndexOf('/', star) + 1);
            if (dir && existsSync(join(ROOT, dir))) {
              try {
                if (readdirSync(join(ROOT, dir)).some((n) => matches(bare, dir + n))) return;
              } catch {
                /* 읽을 수 없으면 판정하지 않는다 */
              }
            }
          } else if (fileSet.has(bare) || existsSync(join(ROOT, bare))) {
            return;
          }
        }
        dead.push({ ref: t, kind });
      };

      for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) consider(m[1], 'link');
      for (const m of text.matchAll(/`([^`\n]+)`/g)) consider(m[1], 'backtick');

      // 생성물(gitignore 대상)은 판정에서 뺀다 — 있고 없고가 환경에 달렸다.
      const ignored = ignoredPaths(dead.map((x) => x.ref.replace(/^\.\//, '')));
      for (const x of dead.filter((x) => !ignored.has(x.ref.replace(/^\.\//, '')))) {
        add('C4', docPath, [
          `${docPath} → 죽은 ${x.kind === 'link' ? '링크' : '경로 참조'}: ${x.ref}`,
          `  고치는 법: 파일이 이동했으면 참조를 고치고, 사라졌으면 문장째 지워라. 예시 경로라면 펜스 코드 블록에 넣어라 — 이 검사는 펜스 안을 보지 않는다.`,
        ]);
      }
    }
  }
}

// ── C5 진입점 예산 ──────────────────────────────────────────────────────────
function checkC5() {
  for (const d of map.docs || []) {
    if (!d.max_lines) continue;
    for (const docPath of expand(d.path)) {
      const abs = join(ROOT, docPath);
      if (!existsSync(abs)) continue;
      const n = readFileSync(abs, 'utf8').split('\n').length;
      if (n > d.max_lines) {
        add('C5', docPath, [
          `${docPath} — ${n}줄 (예산 ${d.max_lines}줄, ${n - d.max_lines}줄 초과)`,
          `  고치는 법: 내용을 지우지 말고 **옮겨라**. 진입점 문서는 백과사전이 아니라 목차다 —`,
          `  상세는 참조 파일로 빼고 여기엔 "어떤 작업에 무엇을 읽어라" 한 줄만 남겨라. (안티패턴 01의 유일한 기계 방어)`,
        ]);
      }
    }
  }
}

// ── C6 열린 마커 낡음 ───────────────────────────────────────────────────────
function blameTimes(path) {
  const out = git(['blame', '--line-porcelain', '--', path]);
  if (out === null) return null;
  const times = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('committer-time ')) cur = Number(line.slice('committer-time '.length)) * 1000;
    else if (line.startsWith('\t')) times.push(cur);
  }
  return times;
}
function checkC6() {
  const def = CHECKS.C6 || {};
  if (!def.marker_pattern) return;
  const re = new RegExp(def.marker_pattern, 'u');
  const staleAfterDays = def.stale_after_days ?? 14;
  for (const d of map.docs || []) {
    const tier = d.tier ?? DEFAULTS.tier ?? 2;
    if (tier > 2) continue;
    for (const docPath of expand(d.path)) {
      const abs = join(ROOT, docPath);
      if (!docPath.endsWith('.md') || !existsSync(abs)) continue;
      const lines = readFileSync(abs, 'utf8').split('\n');
      const hits = [];
      lines.forEach((l, i) => {
        if (re.test(l)) hits.push(i);
      });
      if (!hits.length) continue;
      const times = blameTimes(docPath);
      const stale = [];
      for (const i of hits) {
        const t = times && times[i] != null ? times[i] : null;
        if (t === null) continue; // 미커밋 줄 — 오늘 쓴 것이므로 낡을 수 없다
        const age = Math.floor((NOW - t) / DAY);
        if (age > staleAfterDays) stale.push({ line: i + 1, age, text: lines[i].trim().slice(0, 90) });
      }
      if (!stale.length) continue;
      add('C6', docPath, [
        `${docPath} — ${staleAfterDays}일 넘게 열려 있는 마커 ${stale.length}건`,
        ...stale.slice(0, 6).map((s) => `    L${s.line} (${s.age}일)  ${s.text}`),
        `  고치는 법: 마커마다 (a) 이미 해결됐으면 ✅로 닫아라, (b) 아직이면 docs/progress.md 원장에 행을 만들고 문서에서는 지워라.`,
        `  둘 다 아니면 그 마커는 아무도 안 볼 것이므로 지우는 게 정직하다.`,
      ]);
    }
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const RUN = MODE === 'digest' ? ['C1', 'C2', 'C3', 'C5'] : ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const RUNNER = { C1: checkC1, C2: checkC2, C3: checkC3, C4: checkC4, C5: checkC5, C6: checkC6 };
for (const id of RUN) RUNNER[id]();

const by = (c) => findings.filter((f) => f.check === c);
const blocking = findings.filter((f) => f.severity === 'blocking' || (STRICT && f.severity === 'advisory'));

if (MODE === 'digest') {
  // ≤5줄. SessionStart 훅은 컨텍스트 예산을 쓰는 자리다 — 여기서 장황하면 훅 자체가 비용이 된다.
  console.log(
    `문서 신선도: 미등록 ${by('C1').length} · 낡음 ${by('C2').length} · 나이초과 ${by('C3').length} · 예산초과 ${by('C5').length}`
  );
  const top = [...by('C1'), ...by('C5'), ...by('C2')].slice(0, 3);
  for (const f of top) console.log(`  ⚠ [${f.check}] ${f.doc}`);
  if (!top.length) console.log('  이상 없음.');
  console.log('  자세히: node scripts/doc-freshness.mjs --full');
  process.exit(0);
}

console.log(
  `문서 신선도 검사 — 모드: ${MODE}${MODE === 'pr' ? ` (base: ${baseUsed}, 변경 파일 ${changed.size}개)` : ''}${STRICT ? ' [strict]' : ''}`
);
console.log(
  `레지스트리 ${(map.docs || []).length}항목 → 실파일 ${new Set((map.docs || []).flatMap((d) => expand(d.path))).size}개 · governed_globs 일치 ${governed.length}개`
);
console.log('');

for (const [id, def] of Object.entries(CHECKS)) {
  const list = by(id);
  const isBlocking = list.some((f) => f.severity === 'blocking');
  const sev = id === 'C2' && MODE !== 'pr' && def.advisory_scope ? 'advisory(repo)' : def.severity;
  const mark = !RUN.includes(id) ? 'SKIP' : list.length === 0 ? 'PASS' : isBlocking ? 'FAIL' : 'WARN';
  console.log(`  ${mark}  ${id} ${def.name}  [${sev}]${list.length ? ` — ${list.length}건` : ''}`);
}
console.log('');

for (const id of Object.keys(CHECKS)) {
  const list = by(id);
  if (!list.length) continue;
  console.log(`── ${id} ${CHECKS[id].name} — ${list.length}건 ${'─'.repeat(40)}`);
  for (const f of list) for (const l of f.lines) console.log(l);
  console.log('');
}

if (MODE === 'full') {
  if (uncommittedDeps.length) {
    console.log('── 미커밋 의존 (아직 C2를 켜지 않았지만, 커밋되는 순간 켜진다) ─────────────');
    for (const u of uncommittedDeps.slice(0, 12)) console.log(`  ${u.doc} ← ${u.dep}  (패턴: ${u.pattern})`);
    if (uncommittedDeps.length > 12) console.log(`  … 외 ${uncommittedDeps.length - 12}건`);
    console.log('');
  }
  console.log('── 처방 ─────────────────────────────────────────────────────────────────');
  if (!findings.length) {
    console.log('  없음. 문서와 코드가 같은 시각을 가리키고 있다.');
  } else {
    const hardCount = by('C1').length + by('C4').length + by('C5').length;
    if (hardCount) console.log(`  ! 차단 등급(C1/C4/C5) ${hardCount}건 — 판단이 아니라 사실 오류다. 먼저 고쳐라.`);
    if (by('C2').length)
      console.log(`  1) C2 ${by('C2').length}건 — 가장 오래 벌어진 것부터 하나씩 닫아라. 한꺼번에 닫으면 문서 커밋이 코드와 분리돼 다음 주에 또 벌어진다.`);
    if (by('C3').length)
      console.log(`  2) C3 ${by('C3').length}건 — 검토 주기가 현실과 안 맞는다는 신호일 수 있다. 고칠 게 없는 문서는 주기를 늘리는 쪽이 정직하다.`);
    if (by('C6').length) console.log(`  3) C6 ${by('C6').length}건 — 열린 마커는 "나중에"의 다른 이름이다. 원장으로 옮기거나 닫아라.`);
  }
  console.log('');
}

if (blocking.length) {
  console.log(`실패 — 차단 등급 ${blocking.length}건 (${[...new Set(blocking.map((b) => b.check))].join(', ')}).`);
  process.exit(1);
}
console.log(`통과 — 차단 등급 0건${findings.length ? ` · advisory ${findings.length}건 (위 처방 참고)` : ''}.`);
process.exit(0);
