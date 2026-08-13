#!/usr/bin/env node
// gen-perf-fixtures.js - generate Markdown documents for measuring the preview
// pipeline with __fudePerf (see src/js/core/perf-trace.js).
//
// Why generated rather than committed: the cost being measured scales with
// document size, so the size has to be a knob. Committing a 120 KB fixture to
// get one data point is the wrong trade.
//
// Output is DETERMINISTIC — same arguments produce byte-identical files. A
// before/after comparison is only meaningful if the input did not move.
//
// Each profile isolates one suspected cost so the report can attribute time:
//
//   prose-ja   Japanese prose only. No code, no diagrams. Isolates parse +
//              innerHTML + layout. CJK is separate from prose-en because line
//              breaking differs (no spaces to break on).
//   prose-en   The same shape in English, as the Latin-script control.
//   code       Fenced code blocks in several languages. Loads the highlight
//              pass, which re-runs in full on every render because innerHTML
//              replacement wipes its dataset.hlHandled guards.
//   diagram    Mermaid + PlantUML blocks. Loads the diagram passes. Counts are
//              kept small on purpose: these are slow enough that a realistic
//              document has a handful, not hundreds.
//   mixed      A realistic technical document: headings, prose, lists, tables,
//              inline code, a few fenced blocks and a couple of diagrams.
//
// Usage:
//   node scripts/gen-perf-fixtures.js                    # all profiles, medium
//   node scripts/gen-perf-fixtures.js --size large
//   node scripts/gen-perf-fixtures.js --profile code --size small
//   node scripts/gen-perf-fixtures.js --out /tmp/fixtures
//
// Then open a file in Fude, split view, and in devtools:
//   __fudePerf.enable()  →  type for 10-20s  →  __fudePerf.report()

const fs = require('fs');
const path = require('path');

// ── content pools ──────────────────────────────────────────
// Cycled by index, never randomized, so output stays reproducible.

const JA_SENTENCES = [
  'この節では、対象となる構成要素とその責務を整理する。',
  '前提条件が満たされない場合の挙動については、後述の例外処理を参照のこと。',
  '計測は同一の条件で三回以上繰り返し、中央値を採用する。',
  '実装上の制約から、この経路では同期的な処理を避けている。',
  '利用者から見える振る舞いは変わらないが、内部の表現は大きく異なる。',
  '設定値は環境変数より構成ファイルを優先し、いずれも無い場合は既定値を使う。',
  'この判断は可逆であり、必要なら次の版で撤回できる。',
  '境界条件の扱いが曖昧だったため、明示的に定義し直した。',
  '外部サービスへの依存は、この層に閉じ込めることにした。',
  '性能上の理由から、結果は内容をキーとして再利用する。',
];

const EN_SENTENCES = [
  'This section sets out the components involved and what each is responsible for.',
  'When the preconditions do not hold, see the exception handling described below.',
  'Measurements are repeated at least three times under identical conditions.',
  'An implementation constraint rules out synchronous work on this path.',
  'The observable behaviour is unchanged, but the internal representation differs.',
  'Configuration files take precedence over environment variables here.',
  'The decision is reversible and can be withdrawn in a later revision.',
  'The boundary conditions were underspecified, so they are defined explicitly.',
  'Dependencies on external services are confined to this layer.',
  'For performance, results are reused with the content itself as the key.',
];

const HEADINGS_JA = [
  '背景と前提',
  '対象範囲',
  '設計方針',
  '構成要素',
  'データの流れ',
  '失敗時の扱い',
  '性能上の考慮',
  '互換性',
  '運用手順',
  '未解決の論点',
];

const HEADINGS_EN = [
  'Background',
  'Scope',
  'Design approach',
  'Components',
  'Data flow',
  'Failure handling',
  'Performance notes',
  'Compatibility',
  'Operations',
  'Open questions',
];

const CODE_SAMPLES = [
  {
    lang: 'javascript',
    body: [
      'export function createScheduler(render, delay = 100) {',
      '  const pending = new Map();',
      '  function run(key) {',
      '    const entry = pending.get(key);',
      '    if (!entry) return false;',
      '    pending.delete(key);',
      '    render(entry.job);',
      '    return true;',
      '  }',
      '  return { run };',
      '}',
    ],
  },
  {
    lang: 'rust',
    body: [
      'pub fn scan_dir_tree(root: &Path, show_all: bool) -> Result<Vec<Entry>, Error> {',
      '    let mut out = Vec::new();',
      '    for entry in fs::read_dir(root)? {',
      '        let entry = entry?;',
      '        if !show_all && is_hidden(&entry) {',
      '            continue;',
      '        }',
      '        out.push(Entry::from(entry));',
      '    }',
      '    out.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));',
      '    Ok(out)',
      '}',
    ],
  },
  {
    lang: 'python',
    body: [
      'def summarize(samples: dict[str, list[float]]) -> list[dict]:',
      '    rows = []',
      '    for label, values in samples.items():',
      '        if not values:',
      '            continue',
      '        ordered = sorted(values)',
      '        total = sum(ordered)',
      '        rows.append({"label": label, "total": total, "mean": total / len(ordered)})',
      '    return sorted(rows, key=lambda r: r["total"], reverse=True)',
    ],
  },
  {
    lang: 'bash',
    body: [
      'set -euo pipefail',
      'for p in "$@"; do',
      '  if LC_ALL=C apt-cache policy "$p" | grep -qE \'^  Candidate: [^(]\'; then',
      '    echo "$p"',
      '  fi',
      'done',
    ],
  },
  {
    lang: 'yaml',
    body: [
      '- name: Deploy the config',
      '  template:',
      '    src: config.j2',
      '    dest: "{{ user_home }}/.config/app/config"',
      '    mode: "0600"',
      '    backup: yes',
      '  when: configure | bool',
    ],
  },
];

const MERMAID_SAMPLES = [
  ['graph TD', '  A[入力] --> B{変更あり?}', '  B -- はい --> C[再描画]', '  B -- いいえ --> D[何もしない]', '  C --> E[スクロール復元]'],
  [
    'sequenceDiagram',
    '  participant E as エディタ',
    '  participant S as スケジューラ',
    '  participant P as プレビュー',
    '  E->>S: schedule(pane, job)',
    '  S-->>S: 待機 (デバウンス)',
    '  S->>P: render(job)',
    '  P-->>E: 完了',
  ],
  ['flowchart LR', '  parse[パース] --> html[innerHTML]', '  html --> layout[レイアウト]', '  layout --> paint[描画]'],
];

const PLANTUML_SAMPLES = [
  ['@startuml', 'participant Editor', 'participant Scheduler', 'participant Preview', 'Editor -> Scheduler: schedule', 'Scheduler -> Preview: render', 'Preview --> Editor: done', '@enduml'],
  ['@startuml', 'class Scheduler {', '  +schedule(key, job)', '  +flush(key)', '  +cancel(key)', '}', 'class Preview {', '  +render(text)', '}', 'Scheduler --> Preview', '@enduml'],
];

// ── size presets ───────────────────────────────────────────
// `blocks` drives prose/code volume; diagrams are capped separately because a
// realistic document has a handful of them, and hundreds would measure a case
// nobody has.

const SIZES = {
  small: { blocks: 40, diagrams: 3 },
  medium: { blocks: 200, diagrams: 10 },
  large: { blocks: 800, diagrams: 25 },
};

const pick = (arr, i) => arr[i % arr.length];

function paragraph(sentences, i, count = 3) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(pick(sentences, i * 3 + k));
  return out.join('');
}

function proseDoc({ blocks }, lang) {
  const sentences = lang === 'ja' ? JA_SENTENCES : EN_SENTENCES;
  const headings = lang === 'ja' ? HEADINGS_JA : HEADINGS_EN;
  const join = lang === 'ja' ? '' : ' ';
  const lines = [
    `# ${lang === 'ja' ? '散文のみの計測用文書' : 'Prose-only measurement document'} (${lang})`,
    '',
    lang === 'ja'
      ? 'コードブロックも図も含まない。パース・innerHTML 代入・レイアウトの費用だけを見るための文書。'
      : 'No code blocks and no diagrams. Isolates parse, innerHTML assignment and layout.',
    '',
  ];

  for (let i = 0; i < blocks; i++) {
    if (i % 8 === 0) {
      lines.push(`## ${pick(headings, i / 8)} ${Math.floor(i / 8) + 1}`, '');
    }
    if (i % 8 === 5) {
      // A list every so often: different DOM shape, more elements per block.
      for (let k = 0; k < 4; k++) {
        lines.push(`- ${pick(sentences, i + k)}`);
      }
      lines.push('');
      continue;
    }
    lines.push(
      lang === 'ja' ? paragraph(sentences, i) : [0, 1, 2].map((k) => pick(sentences, i * 3 + k)).join(join),
      '',
    );
  }
  return lines.join('\n');
}

function codeDoc({ blocks }) {
  const lines = [
    '# コードブロック中心の計測用文書',
    '',
    'ハイライト後段パスの費用を見るための文書。innerHTML の全置換で',
    '`dataset.hlHandled` が消えるため、この文書では毎回すべて再ハイライトされる。',
    '',
  ];
  // Half as many blocks as prose: a fenced block is many lines on its own.
  const n = Math.max(4, Math.floor(blocks / 2));
  for (let i = 0; i < n; i++) {
    if (i % 6 === 0) lines.push(`## 節 ${Math.floor(i / 6) + 1}`, '');
    lines.push(pick(JA_SENTENCES, i), '');
    const sample = pick(CODE_SAMPLES, i);
    lines.push('```' + sample.lang, ...sample.body, '```', '');
  }
  return lines.join('\n');
}

function diagramDoc({ diagrams }) {
  const lines = [
    '# 図中心の計測用文書',
    '',
    'Mermaid と PlantUML の後段パスの費用を見るための文書。',
    'SVG 生成自体は内容をキーにキャッシュされるが、DOM への差し込みと',
    'パン/ズームの再取り付けは再描画のたびにやり直される。',
    '',
    '> 図を1つ拡大した状態で本文を編集すると、拡大が戻ることを目視でも確認できる。',
    '',
  ];
  for (let i = 0; i < diagrams; i++) {
    lines.push(`## 図 ${i + 1}`, '', pick(JA_SENTENCES, i), '');
    if (i % 2 === 0) {
      lines.push('```mermaid', ...pick(MERMAID_SAMPLES, i / 2), '```', '');
    } else {
      lines.push('```plantuml', ...pick(PLANTUML_SAMPLES, (i - 1) / 2), '```', '');
    }
  }
  return lines.join('\n');
}

function mixedDoc({ blocks, diagrams }) {
  const lines = [
    '# 実文書に近い構成の計測用文書',
    '',
    '見出し・散文・箇条書き・表・インラインコード・コードブロック・図を混ぜた、',
    '実際の技術文書に近い構成。普段の体感に一番近い数値が出るはず。',
    '',
  ];
  let diagramsPlaced = 0;
  for (let i = 0; i < blocks; i++) {
    if (i % 10 === 0) lines.push(`## ${pick(HEADINGS_JA, i / 10)} ${Math.floor(i / 10) + 1}`, '');
    const slot = i % 10;
    if (slot === 3) {
      for (let k = 0; k < 3; k++) lines.push(`- ${pick(JA_SENTENCES, i + k)}`);
      lines.push('');
    } else if (slot === 5) {
      lines.push('| 項目 | 既定値 | 説明 |', '|---|---|---|');
      for (let k = 0; k < 4; k++) {
        lines.push(`| \`option_${i}_${k}\` | \`${k * 100}\` | ${pick(JA_SENTENCES, i + k).slice(0, 24)} |`);
      }
      lines.push('');
    } else if (slot === 7) {
      // Index by section, not by `i`: code blocks land on a fixed stride of 10,
      // and `i % CODE_SAMPLES.length` would then select the same sample every
      // time, leaving the document single-language.
      const sample = pick(CODE_SAMPLES, Math.floor(i / 10));
      lines.push('```' + sample.lang, ...sample.body, '```', '');
    } else if (slot === 9 && diagramsPlaced < diagrams) {
      if (diagramsPlaced % 2 === 0) {
        lines.push('```mermaid', ...pick(MERMAID_SAMPLES, diagramsPlaced / 2), '```', '');
      } else {
        lines.push('```plantuml', ...pick(PLANTUML_SAMPLES, (diagramsPlaced - 1) / 2), '```', '');
      }
      diagramsPlaced++;
    } else {
      lines.push(`${paragraph(JA_SENTENCES, i)} 設定は \`config.json\` の \`preview\` 節で変更できる。`, '');
    }
  }
  return lines.join('\n');
}

const PROFILES = {
  'prose-ja': (size) => proseDoc(size, 'ja'),
  'prose-en': (size) => proseDoc(size, 'en'),
  code: (size) => codeDoc(size),
  diagram: (size) => diagramDoc(size),
  mixed: (size) => mixedDoc(size),
};

// ── cli ────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { size: 'medium', profile: null, out: '.perf-fixtures' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') opts.size = argv[++i];
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      opts.help = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/gen-perf-fixtures.js [options]

  --profile <name>   ${Object.keys(PROFILES).join(' | ')}   (default: all)
  --size <name>      ${Object.keys(SIZES).join(' | ')}   (default: medium)
  --out <dir>        output directory (default: .perf-fixtures)

Output is deterministic: the same arguments always produce identical files.`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const size = SIZES[opts.size];
  if (!size) {
    console.error(`unknown size: ${opts.size} (expected ${Object.keys(SIZES).join(', ')})`);
    process.exit(1);
  }
  const names = opts.profile ? [opts.profile] : Object.keys(PROFILES);
  for (const name of names) {
    if (!PROFILES[name]) {
      console.error(`unknown profile: ${name} (expected ${Object.keys(PROFILES).join(', ')})`);
      process.exit(1);
    }
  }

  fs.mkdirSync(opts.out, { recursive: true });
  for (const name of names) {
    const text = PROFILES[name](size);
    const file = path.join(opts.out, `${name}-${opts.size}.md`);
    fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
    const kb = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1);
    const lineCount = text.split('\n').length;
    console.log(`${file}  ${kb} KB  ${lineCount} lines`);
  }
}

main();
