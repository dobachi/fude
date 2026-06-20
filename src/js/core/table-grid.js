// table-grid.js - Grid popover for choosing a new table's dimensions.
// showTableGridPicker(x, y, onPick) opens an N×N grid; hovering highlights an
// R×C region and clicking calls onPick(rows, cols). Closes on pick, outside
// click, Escape, blur, or scroll. Modeled on menu.js's showMenu.

const MAX = 8;

let pickerEl = null;
let cleanup = null;

export function closeTableGridPicker() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
  }
}

/**
 * @param {number} x viewport X
 * @param {number} y viewport Y
 * @param {(rows:number, cols:number) => void} onPick rows/cols include the header row
 */
export function showTableGridPicker(x, y, onPick) {
  closeTableGridPicker();

  pickerEl = document.createElement('div');
  pickerEl.className = 'table-grid-picker';

  const label = document.createElement('div');
  label.className = 'table-grid-label';
  label.textContent = '表を挿入';
  pickerEl.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'table-grid';
  grid.style.gridTemplateColumns = `repeat(${MAX}, 1fr)`;

  // Current selection (also driven by the keyboard). Starts at 1×1.
  let selR = 1;
  let selC = 1;

  /** @type {HTMLElement[]} */
  const cells = [];
  const highlight = (r, c) => {
    selR = r;
    selC = c;
    for (const cell of cells) {
      const cr = Number(cell.dataset.r);
      const cc = Number(cell.dataset.c);
      cell.classList.toggle('active', cr <= r && cc <= c);
    }
    label.textContent = r > 0 ? `${r} × ${c}` : '表を挿入';
  };

  const pick = (r, c) => {
    closeTableGridPicker();
    try {
      onPick(r, c);
    } catch (e) {
      console.error('Table grid pick failed:', e);
    }
  };

  for (let r = 1; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      const cell = document.createElement('div');
      cell.className = 'table-grid-cell';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener('mouseenter', () => highlight(r, c));
      cell.addEventListener('click', () => pick(r, c));
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  pickerEl.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'table-grid-hint';
  hint.textContent = '矢印キーで選択 / Enter で挿入';
  pickerEl.appendChild(hint);

  document.body.appendChild(pickerEl);
  highlight(selR, selC); // show an initial selection for keyboard users

  // Keep within viewport.
  const rect = pickerEl.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
  pickerEl.style.left = `${Math.max(4, left)}px`;
  pickerEl.style.top = `${Math.max(4, top)}px`;

  const onDocMouseDown = (e) => {
    if (pickerEl && !pickerEl.contains(e.target)) closeTableGridPicker();
  };
  const onKey = (e) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closeTableGridPicker();
        return;
      case 'ArrowRight':
        e.preventDefault();
        highlight(selR, Math.min(MAX, selC + 1));
        return;
      case 'ArrowLeft':
        e.preventDefault();
        highlight(selR, Math.max(1, selC - 1));
        return;
      case 'ArrowDown':
        e.preventDefault();
        highlight(Math.min(MAX, selR + 1), selC);
        return;
      case 'ArrowUp':
        e.preventDefault();
        highlight(Math.max(1, selR - 1), selC);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(selR, selC);
        return;
      default:
        return;
    }
  };
  const onScroll = () => closeTableGridPicker();
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', closeTableGridPicker);
  document.addEventListener('scroll', onScroll, true);
  cleanup = () => {
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', closeTableGridPicker);
    document.removeEventListener('scroll', onScroll, true);
  };
}
