import {useMemo, useRef, useState} from 'react';
import {Text} from '@astryxdesign/core/Text';
import {sunDirection} from './sim/water.js';
import {MODELS, SERIES_COLORS} from './sim/forecast.js';

const TZ = 'America/Chicago';
const W = 1000;
const H = 100;
const hourCT = ms => Number(new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: '2-digit', hourCycle: 'h23'}).format(ms));
const dayParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short', day: 'numeric'})
  .formatToParts(ms).map(p => [p.type, p.value]));
const whenLabel = ms => new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short', hour: 'numeric'}).format(ms);

function linePath(values, x, y) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function ForecastChart({data, f, model, nowIndex, onScrub}) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const dragging = useRef(false);
  const n = data.time.length;

  const geo = useMemo(() => {
    const all = [...data.hs.p90, ...data.hs.xgb, ...data.hs.ww3].filter(v => v != null);
    const yMax = Math.max(4, Math.ceil(Math.max(...all) + 0.5));
    const x = i => (i / (n - 1)) * W;
    const y = v => H - (v / yMax) * (H - 6);
    const band = [
      ...data.hs.p90.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`),
      ...data.hs.p10.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).reverse(),
    ].join(' ');
    const lines = Object.fromEntries(Object.keys(MODELS).map(k => [k, linePath(data.hs[MODELS[k].hs], x, y)]));
    const midnights = data.time.map((t, i) => (hourCT(t) === 0 ? i : -1)).filter(i => i >= 0);
    const nights = [];
    let s = null;
    data.time.forEach((t, i) => {
      const dark = sunDirection(t, data.station.lat, data.station.lon)[1] < 0;
      if (dark && s == null) s = i;
      if ((!dark || i === n - 1) && s != null) { nights.push([s, i]); s = null; }
    });
    const ticks = [];
    for (let v = 2; v < yMax; v += 2) ticks.push(v);
    return {yMax, x, y, band, lines, midnights, nights, ticks};
  }, [data, n]);

  const toIndex = e => {
    const r = ref.current.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, ((e.clientX - r.left) / r.width) * (n - 1)));
  };

  const selectedHs = data.hs[MODELS[model].hs];
  const at = arr => arr[Math.round(f)] ?? null;
  const headV = at(selectedHs) ?? at(data.hs.ens) ?? 0;
  const pct = i => `${(i / (n - 1)) * 100}%`;
  const hi = hover == null ? null : Math.round(hover);

  return (
    <div className="chart">
      <div
        ref={ref}
        className="chart-plot"
        onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onScrub(toIndex(e)); }}
        onPointerMove={e => { if (dragging.current) onScrub(toIndex(e)); else setHover(toIndex(e)); }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {geo.nights.map(([a, b]) => (
            <rect key={a} x={geo.x(a)} width={geo.x(b) - geo.x(a)} y="0" height={H} className="chart-night" />
          ))}
          {geo.ticks.map(v => <line key={v} x1="0" x2={W} y1={geo.y(v)} y2={geo.y(v)} className="chart-grid" />)}
          {geo.midnights.map(i => <line key={i} x1={geo.x(i)} x2={geo.x(i)} y1="0" y2={H} className="chart-day" />)}
          <polygon points={geo.band} fill={SERIES_COLORS.ens} opacity="0.2" />
          {Object.keys(MODELS).filter(k => k !== model).map(k => (
            <path key={k} d={geo.lines[k]} stroke={SERIES_COLORS[k]} className="chart-line" opacity="0.6" />
          ))}
          <path d={geo.lines[model]} stroke={SERIES_COLORS[model]} className="chart-line selected" />
          {nowIndex > 0 && nowIndex < n - 1 && (
            <line x1={geo.x(nowIndex)} x2={geo.x(nowIndex)} y1="0" y2={H} className="chart-now" />
          )}
          {hi != null && <line x1={geo.x(hi)} x2={geo.x(hi)} y1="0" y2={H} className="chart-hover" />}
          <line x1={geo.x(f)} x2={geo.x(f)} y1="0" y2={H} className="chart-head" />
        </svg>
        <span className="chart-dot" style={{left: pct(f), top: `${(geo.y(headV) / H) * 100}%`, borderColor: SERIES_COLORS[model]}} />
        {geo.ticks.map(v => (
          <span key={v} className="chart-tick" style={{top: `${(geo.y(v) / H) * 100}%`}}>{v} ft</span>
        ))}
        {nowIndex > 0 && nowIndex < n - 1 && <span className="chart-now-label" style={{left: pct(nowIndex)}}>now</span>}
        {hi != null && (
          <div className={`chart-tip ${hi > n * 0.7 ? 'flip' : ''}`} style={{left: pct(hi)}}>
            <Text type="supporting" weight="semibold">{whenLabel(data.time[hi])} CT</Text>
            {Object.entries(MODELS).map(([k, m]) => (
              <div key={k} className="chart-tip-row">
                <span className="swatch" style={{background: SERIES_COLORS[k]}} />
                <Text type="supporting">{m.label}</Text>
                <Text type="supporting" hasTabularNumbers>{data.hs[m.hs][hi] != null ? `${data.hs[m.hs][hi].toFixed(1)} ft` : '—'}</Text>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chart-days" aria-hidden="true">
        {geo.midnights.map(i => {
          const p = dayParts(data.time[i]);
          return (
            <span key={i} style={{left: pct(i)}}>
              {p.weekday}<span className="chart-daynum"> {p.day}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
