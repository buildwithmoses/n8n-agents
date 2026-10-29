// Minimal dependency-free PDF writer: one Letter page, Helvetica / Helvetica-Bold text, filled rectangles, lines.
// Text is real (extractable). A page with no text ops mimics a scanned image with no text layer.
const esc = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?');

export function renderPdf(ops) {
  const content = [];
  for (const op of ops) {
    if (op.t === 'text') content.push(`BT /${op.bold ? 'F2' : 'F1'} ${op.size ?? 10} Tf ${op.x} ${op.y} Td (${esc(op.s)}) Tj ET`);
    else if (op.t === 'rect') content.push(`${op.gray ?? 0.9} g ${op.x} ${op.y} ${op.w} ${op.h} re f 0 g`);
    else if (op.t === 'line') content.push(`${op.width ?? 0.5} w ${op.x1} ${op.y1} m ${op.x2} ${op.y2} l S`);
  }
  const stream = content.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
