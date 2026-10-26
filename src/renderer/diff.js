'use strict';
// Line diff (Myers) for before/after file contents, and a parser for git unified diffs.
window.TCDiff = (() => {
  function myers(a, b) {
    const n = a.length, m = b.length, max = n + m;
    if (max > 40000) return null;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= n && y >= m) return backtrack(trace, a, b, max, d);
      }
      if (d > 4000) return null;
    }
    return null;
  }

  function backtrack(trace, a, b, max, dEnd) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let d = dEnd; d > 0; d--) {
      const v = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? k + 1 : k - 1;
      const prevX = v[max + prevK], prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push({ t: ' ', s: a[x - 1], a: x, b: y }); x--; y--; }
      if (x === prevX) { ops.push({ t: '+', s: b[y - 1], b: y }); y--; } else { ops.push({ t: '-', s: a[x - 1], a: x }); x--; }
    }
    while (x > 0 && y > 0) { ops.push({ t: ' ', s: a[x - 1], a: x, b: y }); x--; y--; }
    return ops.reverse();
  }

  // Returns hunks: [{ header, lines: [{t, s, a, b}] }] with `context` lines around changes.
  function lineDiff(before, after, context = 3) {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    const ops = myers(a, b);
    if (!ops) return null;
    const hunks = [];
    let cur = null, lastChange = -Infinity;
    ops.forEach((op, i) => {
      if (op.t !== ' ') {
        if (!cur || i - lastChange > context * 2) {
          cur = { lines: [] };
          hunks.push(cur);
          for (let j = Math.max(0, i - context); j < i; j++) if (!cur.lines.includes(ops[j])) cur.lines.push(ops[j]);
        } else {
          for (let j = lastChange + 1; j < i; j++) cur.lines.push(ops[j]);
        }
        cur.lines.push(op);
        lastChange = i;
        cur.end = i;
      }
    });
    for (const h of hunks) {
      for (let j = h.end + 1; j <= Math.min(ops.length - 1, h.end + context); j++) if (ops[j].t === ' ') h.lines.push(ops[j]); else break;
      const first = h.lines[0];
      h.header = `@@ line ${first.a || first.b || 1} @@`;
    }
    return hunks;
  }

  function parseGitDiff(text) {
    const files = [];
    let f = null, h = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const m = line.match(/ b\/(.*)$/);
        f = { path: m ? m[1] : line, hunks: [], adds: 0, dels: 0, binary: false };
        files.push(f); h = null; continue;
      }
      if (!f) continue;
      if (line.startsWith('Binary files')) { f.binary = true; continue; }
      if (line.startsWith('@@')) { h = { header: line, lines: [] }; f.hunks.push(h); continue; }
      if (!h || line.startsWith('+++') || line.startsWith('---')) continue;
      const t = line[0];
      if (t === '+' || t === '-' || t === ' ') {
        h.lines.push({ t, s: line.slice(1) });
        if (t === '+') f.adds++; else if (t === '-') f.dels++;
      }
    }
    return files;
  }

  return { lineDiff, parseGitDiff };
})();
