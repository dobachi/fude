import { describe, it, expect, beforeEach } from 'vitest';
import markdownIt from 'markdown-it';
import {
  splitTopLevelBlocks,
  renderBlockHtml,
  diffRange,
  buildAll,
  applyBlocks,
  blockKey,
} from '../core/preview-blocks.js';

const md = markdownIt({ html: false, linkify: true, breaks: true });

function container() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('splitTopLevelBlocks', () => {
  it('returns nothing for an empty stream', () => {
    expect(splitTopLevelBlocks([])).toEqual([]);
  });

  it('splits paragraphs into one block each', () => {
    const blocks = splitTopLevelBlocks(md.parse('one\n\ntwo\n\nthree', {}));
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b[0].type).toBe('paragraph_open');
      expect(b[b.length - 1].type).toBe('paragraph_close');
    }
  });

  it('keeps a list together as a single block', () => {
    const blocks = splitTopLevelBlocks(md.parse('- a\n- b\n- c', {}));
    expect(blocks).toHaveLength(1);
    expect(blocks[0][0].type).toBe('bullet_list_open');
    expect(blocks[0][blocks[0].length - 1].type).toBe('bullet_list_close');
  });

  it('keeps a nested blockquote together', () => {
    const blocks = splitTopLevelBlocks(md.parse('> outer\n>\n> > inner', {}));
    expect(blocks).toHaveLength(1);
    expect(blocks[0][0].type).toBe('blockquote_open');
  });

  it('treats a fence as its own block', () => {
    const blocks = splitTopLevelBlocks(md.parse('text\n\n```js\nx\n```\n\nmore', {}));
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toHaveLength(1);
    expect(blocks[1][0].type).toBe('fence');
  });

  it('keeps a table together', () => {
    const blocks = splitTopLevelBlocks(md.parse('| a | b |\n|---|---|\n| 1 | 2 |', {}));
    expect(blocks).toHaveLength(1);
    expect(blocks[0][0].type).toBe('table_open');
  });

  it('covers every token exactly once, in order', () => {
    const tokens = md.parse('# h\n\npara\n\n- a\n- b\n\n```\ncode\n```\n\n---\n', {});
    const flat = splitTopLevelBlocks(tokens).flat();
    expect(flat).toEqual(tokens);
  });
});

describe('renderBlockHtml', () => {
  it('produces one HTML string per block, concatenating to the full render', () => {
    const text = '# Title\n\npara\n\n- a\n- b\n';
    const parts = renderBlockHtml(md, text, {});
    expect(parts.length).toBe(3);
    expect(parts.join('')).toBe(md.render(text, {}));
  });

  it('matches the full render for a document with mixed block types', () => {
    const text = [
      '# H',
      '',
      'text with `code`',
      '',
      '> quote',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '---',
      '',
      'last',
    ].join('\n');
    expect(renderBlockHtml(md, text, {}).join('')).toBe(md.render(text, {}));
  });

  it('returns nothing for empty input', () => {
    expect(renderBlockHtml(md, '', {})).toEqual([]);
  });
});

describe('diffRange', () => {
  // "No change" is the three indices agreeing, not any particular value: the
  // prefix scan consumes the whole list first, so identical input lands on
  // {n, n, n}. Assert the property the caller actually branches on.
  it('reports no change for identical lists', () => {
    const r = diffRange(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(r.start).toBe(r.prevEnd);
    expect(r.start).toBe(r.nextEnd);
  });

  it('reports no change for two empty lists', () => {
    const r = diffRange([], []);
    expect(r.start).toBe(r.prevEnd);
    expect(r.start).toBe(r.nextEnd);
  });

  it('isolates a single changed block in the middle', () => {
    expect(diffRange(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({
      start: 1,
      prevEnd: 2,
      nextEnd: 2,
    });
  });

  it('isolates an insertion', () => {
    expect(diffRange(['a', 'c'], ['a', 'b', 'c'])).toEqual({ start: 1, prevEnd: 1, nextEnd: 2 });
  });

  it('isolates a deletion', () => {
    expect(diffRange(['a', 'b', 'c'], ['a', 'c'])).toEqual({ start: 1, prevEnd: 2, nextEnd: 1 });
  });

  it('handles a change at the very start', () => {
    expect(diffRange(['a', 'b'], ['A', 'b'])).toEqual({ start: 0, prevEnd: 1, nextEnd: 1 });
  });

  it('handles a change at the very end', () => {
    expect(diffRange(['a', 'b'], ['a', 'B'])).toEqual({ start: 1, prevEnd: 2, nextEnd: 2 });
  });

  it('handles going from empty to populated', () => {
    expect(diffRange([], ['a', 'b'])).toEqual({ start: 0, prevEnd: 0, nextEnd: 2 });
  });

  it('handles going from populated to empty', () => {
    expect(diffRange(['a', 'b'], [])).toEqual({ start: 0, prevEnd: 2, nextEnd: 0 });
  });

  it('does not mistake repeated blocks for a smaller change', () => {
    // Prefix and suffix both match on "a"; only the middle may be replaced.
    const r = diffRange(['a', 'a', 'a'], ['a', 'b', 'a']);
    expect(r).toEqual({ start: 1, prevEnd: 2, nextEnd: 2 });
  });
});

describe('buildAll', () => {
  it('renders every block into the container', () => {
    const el = container();
    const blocks = buildAll(el, renderBlockHtml(md, '# H\n\npara\n', {}));

    expect(el.querySelector('h1').textContent).toBe('H');
    expect(el.querySelector('p').textContent).toBe('para');
    expect(blocks).toHaveLength(2);
  });

  it('replaces whatever was there before', () => {
    const el = container();
    el.innerHTML = '<p>old</p>';
    buildAll(el, renderBlockHtml(md, 'new\n', {}));

    expect(el.textContent).not.toContain('old');
    expect(el.textContent).toContain('new');
  });

  it('produces the same markup as a single innerHTML assignment', () => {
    const text = '# H\n\npara\n\n- a\n- b\n';
    const built = container();
    buildAll(built, renderBlockHtml(md, text, {}));

    const direct = container();
    direct.innerHTML = md.render(text, {});

    expect(built.innerHTML).toBe(direct.innerHTML);
  });
});

describe('applyBlocks', () => {
  const render = (text) => renderBlockHtml(md, text, {});

  it('touches nothing when the document is unchanged', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n'));
    const before = Array.from(el.childNodes);

    const result = applyBlocks(el, blocks, render('a\n\nb\n'));

    expect(result.replaced).toBe(0);
    expect(result.blocks).toBe(blocks);
    expect(Array.from(el.childNodes)).toEqual(before);
  });

  // The whole point: an untouched block must keep its identity, because that is
  // what carries syntax highlighting, rendered SVG and diagram pan/zoom state.
  it('keeps the DOM nodes of blocks that did not change', () => {
    const el = container();
    const blocks = buildAll(el, render('first\n\nsecond\n\nthird\n'));
    const firstNode = el.querySelectorAll('p')[0];
    const thirdNode = el.querySelectorAll('p')[2];

    // Mark them the way the highlight / diagram passes do.
    firstNode.dataset.marked = '1';
    thirdNode.dataset.marked = '1';

    const result = applyBlocks(el, blocks, render('first\n\nCHANGED\n\nthird\n'));

    expect(result.replaced).toBe(1);
    const paras = el.querySelectorAll('p');
    expect(paras[0]).toBe(firstNode);
    expect(paras[2]).toBe(thirdNode);
    expect(paras[0].dataset.marked).toBe('1');
    expect(paras[2].dataset.marked).toBe('1');
    expect(paras[1].textContent).toBe('CHANGED');
  });

  it('inserts a new block in the middle without rebuilding its neighbours', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nc\n'));
    const aNode = el.querySelectorAll('p')[0];

    const result = applyBlocks(el, blocks, render('a\n\nb\n\nc\n'));

    const texts = Array.from(el.querySelectorAll('p')).map((p) => p.textContent);
    expect(texts).toEqual(['a', 'b', 'c']);
    expect(el.querySelectorAll('p')[0]).toBe(aNode);
    expect(result.blocks).toHaveLength(3);
  });

  it('removes a deleted block', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n\nc\n'));

    const result = applyBlocks(el, blocks, render('a\n\nc\n'));

    expect(Array.from(el.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['a', 'c']);
    expect(result.blocks).toHaveLength(2);
  });

  it('appends when a block is added at the end', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n'));

    applyBlocks(el, blocks, render('a\n\nb\n'));

    expect(Array.from(el.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['a', 'b']);
  });

  it('handles a change at the very start', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n'));
    const bNode = el.querySelectorAll('p')[1];

    applyBlocks(el, blocks, render('A\n\nb\n'));

    expect(Array.from(el.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['A', 'b']);
    expect(el.querySelectorAll('p')[1]).toBe(bNode);
  });

  it('empties the container when the document becomes empty', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n'));

    const result = applyBlocks(el, blocks, render(''));

    expect(el.querySelectorAll('p')).toHaveLength(0);
    expect(result.blocks).toEqual([]);
  });

  // Typing is a sequence of small edits; the DOM must equal a from-scratch
  // render after every one of them, or the preview silently drifts.
  it('matches a full rebuild after a sequence of edits', () => {
    const steps = [
      '# T\n\nalpha\n\n- x\n- y\n',
      '# T\n\nalpha beta\n\n- x\n- y\n',
      '# T\n\nalpha beta\n\n- x\n- y\n- z\n',
      '# T2\n\nalpha beta\n\n- x\n- y\n- z\n',
      '# T2\n\n- x\n- y\n- z\n',
      '',
      '# T2\n\nback\n',
    ];

    const el = container();
    let blocks = buildAll(el, render(steps[0]));

    for (const step of steps.slice(1)) {
      blocks = applyBlocks(el, blocks, render(step)).blocks;

      const expected = container();
      expected.innerHTML = md.render(step, {});
      expect(el.innerHTML).toBe(expected.innerHTML);
      expected.remove();
    }
  });

  it('reports how many blocks were rebuilt', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n\nc\n\nd\n'));

    expect(applyBlocks(el, blocks, render('a\n\nb\n\nc\n\nd\n')).replaced).toBe(0);
    expect(applyBlocks(el, blocks, render('a\n\nB\n\nc\n\nd\n')).replaced).toBe(1);
  });
});

describe('applyBlocks — 外部からの書き換えへの耐性', () => {
  const render = (text) => renderBlockHtml(md, text, {});

  // The diagram passes do `pre.replaceWith(holder)` after a render, so any node
  // reference captured at render time is detached by the next edit. The swap is
  // one-for-one, so tracking counts instead of references keeps offsets valid.
  it('survives a one-for-one node swap by a post-render pass', () => {
    const el = container();
    let blocks = buildAll(el, render('a\n\n```plantuml\n@startuml\n@enduml\n```\n\nc\n'));

    // Stand in for renderPlantumlBlocks replacing the <pre> with its holder.
    const pre = el.querySelector('pre');
    const holder = document.createElement('div');
    holder.className = 'puml-diagram';
    holder.textContent = 'rendered';
    pre.replaceWith(holder);

    const result = applyBlocks(
      el,
      blocks,
      render('a\n\n```plantuml\n@startuml\n@enduml\n```\n\nCHANGED\n'),
    );
    blocks = result.blocks;

    // The diagram block was untouched, so the holder must still be there.
    expect(result.full).toBe(false);
    expect(el.querySelector('.puml-diagram')).toBe(holder);
    expect(el.textContent).toContain('CHANGED');
  });

  // Tab close and the whole-file .puml/.mmd renderers clear the container
  // directly. An update that cannot trust what it sees must rebuild.
  it('rebuilds from scratch when the container was cleared behind its back', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n\nb\n'));

    el.innerHTML = '';
    const result = applyBlocks(el, blocks, render('a\n\nb\n'));

    expect(result.full).toBe(true);
    expect(Array.from(el.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['a', 'b']);
  });

  it('rebuilds when something appended to the container', () => {
    const el = container();
    const blocks = buildAll(el, render('a\n'));
    el.appendChild(document.createElement('span'));

    const result = applyBlocks(el, blocks, render('a\n\nb\n'));

    expect(result.full).toBe(true);
    expect(el.querySelector('span')).toBe(null);
    expect(Array.from(el.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['a', 'b']);
  });

  it('rebuilds when there is no previous state', () => {
    const el = container();
    const result = applyBlocks(el, null, render('a\n'));

    expect(result.full).toBe(true);
    expect(el.querySelector('p').textContent).toBe('a');
  });
});

describe('data-source-line の扱い', () => {
  // preview.js の createMd() と同じく、ブロック要素に行番号を付ける
  const lineMd = markdownIt({ html: false, linkify: true, breaks: true });
  lineMd.core.ruler.push('source_line', (state) => {
    for (const token of state.tokens) {
      if (!token.map) continue;
      if (
        token.type.endsWith('_open') ||
        token.type === 'code_block' ||
        token.type === 'fence' ||
        token.type === 'hr' ||
        token.type === 'html_block'
      ) {
        token.attrSet('data-source-line', String(token.map[0] + 1));
      }
    }
  });
  // preview.js の renderFenceLike と同じく、フェンスでは <pre> 側に行番号を置く
  lineMd.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const line = token.attrGet('data-source-line');
    const lang = token.info ? token.info.trim().split(/\s+/)[0] : '';
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre data-source-line="${line || ''}"><code${langClass}>${token.content}</code></pre>\n`;
  };

  const render = (text) => renderBlockHtml(lineMd, text, {});

  it('blockKey は行番号を無視する', () => {
    const a = '<p data-source-line="3">x</p>';
    const b = '<p data-source-line="9">x</p>';
    expect(blockKey(a)).toBe(blockKey(b));
    expect(blockKey(a)).not.toBe(blockKey('<p data-source-line="3">y</p>'));
  });

  // 改行を1つ入れると以降の全ブロックの行番号がずれる。行番号込みで比較すると
  // Enter を押すたびに文書の残り全部が作り直され、図のズームも失われる。
  it('前方に改行を挿入しても後続ブロックのノードが保持される', () => {
    const before = 'one\n\ntwo\n\nthree\n';
    const after = 'one\n\nINSERTED\n\ntwo\n\nthree\n';

    const el = container();
    let blocks = buildAll(el, render(before));
    const twoNode = el.querySelectorAll('p')[1];
    const threeNode = el.querySelectorAll('p')[2];
    twoNode.dataset.marked = '1';
    threeNode.dataset.marked = '1';

    const result = applyBlocks(el, blocks, render(after));
    blocks = result.blocks;

    // 追加された1ブロックだけが作られ、既存ノードは同一のまま
    expect(result.replaced).toBe(1);
    const paras = el.querySelectorAll('p');
    expect(paras[2]).toBe(twoNode);
    expect(paras[3]).toBe(threeNode);
    expect(paras[2].dataset.marked).toBe('1');
  });

  it('保持したブロックの行番号は書き換えられる', () => {
    const el = container();
    let blocks = buildAll(el, render('one\n\ntwo\n'));
    const twoNode = el.querySelectorAll('p')[1];
    expect(twoNode.getAttribute('data-source-line')).toBe('3');

    blocks = applyBlocks(el, blocks, render('one\n\nINSERTED\n\ntwo\n')).blocks;

    // 同じノードのまま、行番号だけが追従している
    expect(el.querySelectorAll('p')[2]).toBe(twoNode);
    expect(twoNode.getAttribute('data-source-line')).toBe('5');
  });

  // 後段パスが <pre> をホルダに差し替えても、ホルダが属性を引き継ぐので
  // 位置による対応付けは崩れない
  it('図のホルダに差し替わっていても行番号を書き換えられる', () => {
    const el = container();
    let blocks = buildAll(el, render('one\n\n```plantuml\n@startuml\n@enduml\n```\n'));

    const pre = el.querySelector('pre');
    const holder = document.createElement('div');
    holder.className = 'puml-diagram';
    holder.setAttribute('data-source-line', pre.getAttribute('data-source-line'));
    holder.textContent = 'rendered svg';
    pre.replaceWith(holder);
    expect(holder.getAttribute('data-source-line')).toBe('3');

    const result = applyBlocks(
      el,
      blocks,
      render('one\n\nINSERTED\n\n```plantuml\n@startuml\n@enduml\n```\n'),
    );

    expect(el.querySelector('.puml-diagram')).toBe(holder);
    expect(holder.textContent).toBe('rendered svg');
    expect(holder.getAttribute('data-source-line')).toBe('5');
    expect(result.replaced).toBe(1);
  });

  it('行番号が変わっただけでも最終的な行番号はフル描画と一致する', () => {
    const steps = [
      'a\n\nb\n\nc\n',
      'a\n\nX\n\nb\n\nc\n',
      'a\n\nX\n\nY\n\nb\n\nc\n',
      'a\n\nb\n\nc\n',
    ];

    const el = container();
    let blocks = buildAll(el, render(steps[0]));

    for (const step of steps.slice(1)) {
      blocks = applyBlocks(el, blocks, render(step)).blocks;

      const expected = container();
      expected.innerHTML = render(step).join('');
      expect(el.innerHTML).toBe(expected.innerHTML);
      expected.remove();
    }
  });
});
