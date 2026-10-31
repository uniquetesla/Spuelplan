export function flowDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000)),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours} Std. ${minutes} Min.`
    : minutes
      ? `${minutes} Min. ${seconds % 60} Sek.`
      : `${seconds} Sek.`;
}
export function flowChart(points, { width = 800 } = {}) {
  if (!points.length)
    return '<div class="flow-chart-empty">Warte auf gültige Live-Durchflusswerte. Es werden keine Ersatzwerte eingetragen.</div>';
  const height = 270,
    left = 60,
    right = 22,
    top = 22,
    bottom = 48,
    maxX = Math.max(1000, ...points.map((p) => p.elapsed_ms)),
    maxY = Math.max(1, ...points.map((p) => p.flow)) * 1.12;
  const x = (v) => left + (v / maxX) * (width - left - right),
    y = (v) => height - bottom - (v / maxY) * (height - top - bottom),
    n = (v) => v.toFixed(2);
  const groups = [];
  for (const p of points) {
    const previous = groups.at(-1)?.at(-1);
    if (
      !previous ||
      (p.segment !== undefined && previous.segment !== undefined
        ? p.segment !== previous.segment
        : p.gap_ms > 5000)
    )
      groups.push([]);
    groups.at(-1).push(p);
  }
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = (i / 4) * maxY;
    return `<line x1="${left}" y1="${n(y(value))}" x2="${width - right}" y2="${n(y(value))}" class="flow-grid-line"/><text x="${left - 10}" y="${n(y(value) + 4)}" text-anchor="end">${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value)}</text>`;
  }).join("");
  const labels = Array.from({ length: 5 }, (_, i) => {
    const value = (i / 4) * maxX;
    return `<text x="${n(x(value))}" y="${height - 23}" text-anchor="middle">${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value / (maxX < 120000 ? 1000 : maxX < 7200000 ? 60000 : 3600000))}</text>`;
  }).join("");
  return `<svg class="flow-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gespeicherter Durchflussverlauf in Kubikmetern pro Stunde über die Messdauer"><text x="${left}" y="13">Durchfluss · m³/h</text>${grid}${labels}<text x="${width / 2}" y="${height - 3}" text-anchor="middle">Zeit seit Messbeginn · ${maxX < 120000 ? "Sekunden" : maxX < 7200000 ? "Minuten" : "Stunden"}</text>${groups
    .map((group) => {
      const line = group
        .map((p, i) => `${i ? "L" : "M"}${n(x(p.elapsed_ms))} ${n(y(p.flow))}`)
        .join(" ");
      return `<path class="flow-chart-area" d="${line} L${n(x(group.at(-1).elapsed_ms))} ${height - bottom} L${n(x(group[0].elapsed_ms))} ${height - bottom} Z"/><path class="flow-chart-line" d="${line}"/>`;
    })
    .join(
      "",
    )}<circle class="flow-chart-dot" cx="${n(x(points.at(-1).elapsed_ms))}" cy="${n(y(points.at(-1).flow))}" r="4"/></svg><p class="flow-chart-hover" data-flow-hover>Durchflussverlauf · Unterbrechungen erscheinen als Lücken.</p>`;
}
