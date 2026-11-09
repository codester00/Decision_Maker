// Small SVG charts (no library). Colors come from CSS variables --s1..--s8
// (the validated default categorical palette, with dark-mode steps in
// styles.css). Text always uses text colors, never series colors. Every chart
// has a tap/hover readout and a "Show as table" view, so no value depends on
// color or hovering alone.

const SVG = 'http://www.w3.org/2000/svg';

function el(ns, tag, props, children) {
  const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node['on' + k.slice(2).toLowerCase()] = v;
    else node.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : String(v));
  }
  for (const c of (children || []).flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}
const s = (tag, props, ...children) => el(SVG, tag, props, children);
const h = (tag, props, ...children) => el(null, tag, props, children);

export const seriesColor = (i) => `var(--s${(i % 8) + 1})`;
export const MAX_SERIES = 8;

// The app re-renders by patching existing elements, so handlers look up the
// readout and crosshair from the event target instead of keeping references.
function setReadout(e, text) {
  const card = e.currentTarget.closest('.chart');
  const out = card && card.querySelector('.chart-readout');
  if (out) out.textContent = text;
}

const fmt = (v) => (Math.round(v * 10) / 10).toLocaleString();

function niceMax(v) {
  if (v <= 0) return 1;
  const steps = [1, 2, 4, 5, 10];
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const st of steps) if (st * mag >= v) return st * mag;
  return 10 * mag;
}

// A bar whose end away from the baseline is rounded (4px), square at the baseline.
function barPath(x0, y, w, hgt) {
  const r = Math.min(4, w, hgt / 2);
  if (w <= 0) return '';
  const x1 = x0 + w;
  return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + hgt - r}Q${x1},${y + hgt} ${x1 - r},${y + hgt}H${x0}Z`;
}

function frame(id, title, subtitle, legend, svg, readoutText, table) {
  return h('section', { className: 'card chart', id },
    h('h2', {}, title),
    subtitle && h('p', { className: 'muted small' }, subtitle),
    legend,
    svg,
    h('div', { className: 'chart-readout', 'aria-live': 'polite' }, readoutText || ''),
    table && h('details', { className: 'chart-table' }, h('summary', {}, 'Show as table'), table));
}

function legendRow(items) {
  return h('div', { className: 'legend' }, items.map((it) => h('span', { className: 'legend-item' },
    it.line
      ? h('span', { className: 'key-line', style: `background:${it.color}` })
      : h('span', { className: 'key-box', style: `background:${it.color}` }),
    it.label)));
}

function table(headers, rows) {
  return h('table', {},
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((x, i) => (i === 0 ? h('th', { scope: 'row' }, x) : h('td', {}, x)))))));
}

/* ---------- horizontal bars (one series), with an optional marker per bar ---------- */
// rows: [{ key, label, value, marker? }]
export function barChart({ id, title, subtitle, rows, unit, markerLabel, color = seriesColor(0), readoutFor }) {
  const W = 340;
  const labelW = 92;
  const valueW = 40;
  const band = 34;
  const barH = 18;
  const top = 6;
  const H = top + rows.length * band + 4;
  const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(r.value, r.marker || 0))));
  const plotW = W - labelW - valueW;
  const x = (v) => labelW + (Math.max(0, v) / max) * plotW;
  const unitFor = (v) => (v === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit);
  const describe = readoutFor || ((r) => `${r.label}: ${fmt(r.value)} ${unitFor(r.value)}${r.marker != null ? ` · ${markerLabel.toLowerCase()} ${fmt(r.marker)}` : ''}`);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, className: 'chart-svg', role: 'img', 'aria-label': title },
    s('line', { x1: labelW, x2: labelW, y1: 0, y2: H, className: 'axis' }),
    rows.map((r, i) => {
      const y = top + i * band + (band - barH) / 2;
      const show = (e) => setReadout(e, describe(r));
      return s('g', { className: 'bar-row', tabindex: 0, onPointermove: show, onClick: show, onFocus: show, 'data-key': 'b-' + r.key },
        s('rect', { x: 0, y: top + i * band, width: W, height: band, className: 'hit' }),
        s('text', { x: labelW - 8, y: y + barH / 2, className: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'central' }, r.label.length > 12 ? r.label.slice(0, 11) + '…' : r.label),
        r.value > 0 && s('path', { d: barPath(labelW, y, x(r.value) - labelW, barH), fill: color, className: 'bar' }),
        r.marker != null && s('line', { x1: x(r.marker), x2: x(r.marker), y1: y - 4, y2: y + barH + 4, className: 'marker' }),
        s('text', { x: Math.max(x(r.value), r.marker != null ? x(r.marker) : 0) + 6, y: y + barH / 2, className: 'value', 'dominant-baseline': 'central' }, fmt(r.value)));
    }));
  return frame(id, title, subtitle,
    markerLabel ? legendRow([{ label: unit[0].toUpperCase() + unit.slice(1), color }, { label: markerLabel, color: 'var(--text)', line: true }]) : null,
    svg, 'Tap a bar for details.',
    table(['Person', unit[0].toUpperCase() + unit.slice(1), ...(markerLabel ? [markerLabel] : [])],
      rows.map((r) => [r.label, fmt(r.value), ...(markerLabel ? [r.marker != null ? fmt(r.marker) : ''] : [])])));
}

/* ---------- stacked horizontal bars ---------- */
// rows: [{ key, label, parts: { seriesKey: value } }], series: [{ key, label }]
export function stackedBarChart({ id, title, subtitle, rows, series, unit }) {
  const W = 340;
  const labelW = 92;
  const valueW = 36;
  const band = 34;
  const barH = 18;
  const top = 6;
  const H = top + rows.length * band + 4;
  const totals = rows.map((r) => series.reduce((t, x) => t + (r.parts[x.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const plotW = W - labelW - valueW;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, className: 'chart-svg', role: 'img', 'aria-label': title },
    s('line', { x1: labelW, x2: labelW, y1: 0, y2: H, className: 'axis' }),
    rows.map((r, i) => {
      const y = top + i * band + (band - barH) / 2;
      let x0 = labelW;
      const segs = [];
      series.forEach((ser, k) => {
        const v = r.parts[ser.key] || 0;
        if (v <= 0) return;
        const w = (v / max) * plotW;
        const isLast = series.slice(k + 1).every((later) => !(r.parts[later.key] > 0));
        // 2px surface gap between segments.
        const drawW = Math.max(1, w - (isLast ? 0 : 2));
        segs.push(isLast
          ? s('path', { d: barPath(x0, y, drawW, barH), fill: seriesColor(k), className: 'bar' })
          : s('rect', { x: x0, y, width: drawW, height: barH, fill: seriesColor(k), className: 'bar' }));
        x0 += w;
      });
      const show = (e) => setReadout(e, `${r.label}: ` + series.map((ser) => `${ser.label} ${fmt(r.parts[ser.key] || 0)}`).join(' · ') + ` (total ${fmt(totals[i])})`);
      return s('g', { className: 'bar-row', tabindex: 0, onPointermove: show, onClick: show, onFocus: show, 'data-key': 'sb-' + r.key },
        s('rect', { x: 0, y: top + i * band, width: W, height: band, className: 'hit' }),
        s('text', { x: labelW - 8, y: y + barH / 2, className: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'central' }, r.label.length > 12 ? r.label.slice(0, 11) + '…' : r.label),
        segs,
        s('text', { x: x0 + 6, y: y + barH / 2, className: 'value', 'dominant-baseline': 'central' }, fmt(totals[i])));
    }));
  return frame(id, title, subtitle,
    legendRow(series.map((ser, k) => ({ label: ser.label, color: seriesColor(k) }))),
    svg, 'Tap a bar for details.',
    table(['Person', ...series.map((x) => x.label), 'Total'], rows.map((r, i) => [r.label, ...series.map((x) => fmt(r.parts[x.key] || 0)), fmt(totals[i])])));
}

/* ---------- lines over time ---------- */
// series: [{ key, label, color }], points: [{ x, label, values: { key: number } }]
export function lineChart({ id, title, subtitle, series, points, unit }) {
  const W = 340;
  const H = 200;
  const left = 30;
  const right = 12;
  const top = 10;
  const bottom = 24;
  const maxY = niceMax(Math.max(1, ...points.flatMap((p) => series.map((x) => p.values[x.key] || 0))));
  const n = Math.max(1, points.length - 1);
  const X = (i) => left + (i / n) * (W - left - right);
  const Y = (v) => top + (1 - v / maxY) * (H - top - bottom);
  const ticks = [0, maxY / 2, maxY];
  const cross = s('line', { x1: -10, x2: -10, y1: top, y2: H - bottom, className: 'crosshair' });
  const describe = (i) => {
    const p = points[i];
    return `${p.label}: ` + [...series].sort((a, b) => (p.values[b.key] || 0) - (p.values[a.key] || 0))
      .map((x) => `${x.label} ${fmt(p.values[x.key] || 0)}`).join(' · ');
  };
  const onMove = (e) => {
    const svg = e.currentTarget.ownerSVGElement;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - left) / (W - left - right)) * n)));
    const line = svg.querySelector('.crosshair');
    line.setAttribute('x1', X(i));
    line.setAttribute('x2', X(i));
    setReadout(e, describe(i));
  };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, className: 'chart-svg', role: 'img', 'aria-label': title },
    ticks.map((v) => s('g', {},
      s('line', { x1: left, x2: W - right, y1: Y(v), y2: Y(v), className: 'grid' }),
      s('text', { x: left - 6, y: Y(v), className: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'central' }, fmt(v)))),
    s('text', { x: left, y: H - 6, className: 'tick' }, points[0] ? points[0].label : ''),
    s('text', { x: W - right, y: H - 6, className: 'tick', 'text-anchor': 'end' }, points.length ? points[points.length - 1].label : ''),
    series.map((ser) => s('path', {
      d: points.map((p, i) => `${i ? 'L' : 'M'}${X(i)},${Y(p.values[ser.key] || 0)}`).join(''),
      stroke: ser.color, className: 'line',
    })),
    series.map((ser) => {
      const last = points[points.length - 1];
      return s('circle', { cx: X(points.length - 1), cy: Y(last.values[ser.key] || 0), r: 4, fill: ser.color, className: 'end-dot' });
    }),
    cross,
    s('rect', { x: left, y: 0, width: W - left - right, height: H, className: 'hit', onPointermove: onMove, onPointerdown: onMove }));
  const last = points[points.length - 1];
  return frame(id, title, subtitle,
    legendRow(series.map((ser) => ({ label: ser.label, color: ser.color, line: true }))),
    svg, 'Tap or drag across the chart to see the totals at any point.',
    table(['Person', `${unit} so far`], series.map((x) => [x.label, fmt(last.values[x.key] || 0)])));
}
