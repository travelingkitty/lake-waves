import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {IconButton} from '@astryxdesign/core/IconButton';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {createWater, sunDirection} from './sim/water.js';
import {seaState} from './sim/seaState.js';
import {MODELS, SERIES_COLORS, conditions, indexOf, lastIndex} from './sim/forecast.js';
import {ForecastChart} from './ForecastChart.jsx';

const STATION = '45198';
const TZ = 'America/Chicago';
const HOURS_PER_SECOND = 2; // playback speed; the water itself always runs in real time

const fmt = (ms, opts) => new Intl.DateTimeFormat('en-US', {timeZone: TZ, ...opts}).format(ms);
const whenLabel = ms => fmt(ms, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric'});
const weekday = ms => fmt(ms, {weekday: 'short'});
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const point = deg => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

const svgIcon = d => props => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {d}
  </svg>
);
const PlayIcon = svgIcon(<path d="M7 4.5v15l12-7.5z" fill="currentColor" />);
const PauseIcon = svgIcon(<><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" /></>);
const EyeOffIcon = svgIcon(<><path d="M3 3l18 18" /><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.7 3.9M6.6 6.6A13 13 0 0 0 2.5 12c1 2.5 4.5 7 9.5 7 1.6 0 3-.4 4.3-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
const EyeIcon = svgIcon(<><path d="M2.5 12C3.5 9.5 7 5 12 5s8.5 4.5 9.5 7c-1 2.5-4.5 7-9.5 7s-8.5-4.5-9.5-7z" /><circle cx="12" cy="12" r="3" /></>);

/** First Thursday (Chicago time) after the run, and its highest-wave hour. */
function thursday(data) {
  const run = Date.parse(data.source.initialized ?? data.time[0]);
  const start = data.time.findIndex(t => t > run && weekday(t) === 'Thu');
  if (start < 0) return null;
  let peak = start;
  for (let i = start; i < Math.min(start + 24, data.time.length); i++) {
    if ((data.hs.ens[i] ?? 0) > (data.hs.ens[peak] ?? 0)) peak = i;
  }
  return {start, peak};
}

function Compass({towardDeg, windFromDeg, yaw}) {
  const r = 26;
  const arrow = deg => {
    const a = (deg * Math.PI) / 180;
    return [Math.sin(a), -Math.cos(a)];
  };
  const [tx, ty] = arrow(towardDeg);
  const left = arrow(yaw - 33);
  const right = arrow(yaw + 33);
  return (
    <svg className="compass" viewBox="-34 -34 68 68" role="img"
      aria-label={`Waves travel toward ${point(towardDeg)}; wind from ${point(windFromDeg)}; view faces ${point(yaw)}`}>
      <circle r={r} className="compass-ring" />
      <path d={`M0 0 L${left[0] * r} ${left[1] * r} A${r} ${r} 0 0 1 ${right[0] * r} ${right[1] * r} Z`} className="compass-view" />
      <text y={-r - 2} className="compass-n">N</text>
      <line x1={-tx * 16} y1={-ty * 16} x2={tx * 16} y2={ty * 16} className="compass-arrow" markerEnd="url(#head)" />
      <defs>
        <marker id="head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <circle r="2.2" className="compass-you" />
    </svg>
  );
}

function Row({label, children}) {
  return (
    <HStack justify="between" align="center" gap={3}>
      <Text type="supporting">{label}</Text>
      <Text hasTabularNumbers weight="medium">{children}</Text>
    </HStack>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [f, setF] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [model, setModel] = useState('ens');
  const [measured, setMeasured] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [yaw, setYaw] = useState(90);
  const canvasRef = useRef(null);
  const waterRef = useRef(null);
  const fRef = useRef(0);
  fRef.current = f;

  useEffect(() => {
    fetch(`data/${STATION}.json`)
      .then(r => {
        if (!r.ok) throw new Error(`No forecast file (data/${STATION}.json). Run: npm run data`);
        return r.json();
      })
      .then(d => {
        setData(d);
        // Open on "now" if the run covers it; ?t=thu jumps to the Thursday test case.
        const want = new URLSearchParams(location.search).get('t');
        const thu = thursday(d);
        setF(want === 'thu' && thu ? thu.peak : indexOf(d, Date.now()));
      })
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    let w;
    try {
      w = createWater(canvasRef.current, {onMeasure: setMeasured});
    } catch (e) {
      setError(e.message);
      return undefined;
    }
    w.onView = setYaw;
    waterRef.current = w;
    return () => w.destroy();
  }, []);

  const cond = useMemo(() => (data ? conditions(data, f, model) : null), [data, f, model]);
  const sea = useMemo(() => (cond ? seaState(cond) : null), [cond]);

  // Hand the forecast hour to the water. This is the whole coupling.
  useEffect(() => {
    if (!sea || !data) return;
    waterRef.current?.set(sea, sunDirection(cond.time, data.station.lat, data.station.lon));
  }, [sea, cond, data]);

  // Playback through the forecast.
  useEffect(() => {
    if (!playing || !data) return undefined;
    let last = performance.now();
    const end = data.time.length - 1;
    const id = setInterval(() => {
      const now = performance.now();
      const next = fRef.current + ((now - last) / 1000) * HOURS_PER_SECOND;
      last = now;
      if (next >= end) {
        setF(end);
        setPlaying(false);
      } else setF(next);
    }, 50);
    return () => clearInterval(id);
  }, [playing, data]);

  const thu = useMemo(() => (data ? thursday(data) : null), [data]);
  const jump = useCallback(i => { setPlaying(false); setF(i); }, []);

  // Keyboard: space play/pause, H hide data, ←/→ hour.
  useEffect(() => {
    const onKey = e => {
      if (e.target !== document.body) return;
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'h' || e.key === 'H') setHidden(h => !h);
      else if (data && e.key === 'ArrowRight') jump(Math.min(data.time.length - 1, Math.floor(fRef.current) + 1));
      else if (data && e.key === 'ArrowLeft') jump(Math.max(0, Math.ceil(fRef.current) - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, jump]);

  const nowIndex = data ? indexOf(data, Date.now()) : 0;
  const settled = measured && sea && Math.abs(measured.hsFt - sea.hsFt) <= Math.max(0.08 * sea.hsFt, 0.05);
  const runLabel = data?.source.initialized ? whenLabel(Date.parse(data.source.initialized)) : '—';

  return (
    <div className="app">
      <canvas ref={canvasRef} className="water" aria-label="Simulated Lake Michigan surface for the selected forecast hour. Drag to look around." />

      {error && (
        <div className="panel error" role="alert">
          <Text weight="semibold">{error}</Text>
        </div>
      )}

      {hidden ? (
        <div className="reveal">
          <IconButton label="Show data (H)" tooltip="Show data (H)" variant="secondary" elevation="med" icon={<EyeIcon width={18} />} onClick={() => setHidden(false)} />
        </div>
      ) : data && cond && sea && (
        <>
          <header className="brand">
            <VStack gap={0.5}>
              <Heading level={1}>Lake Michigan · Chicago</Heading>
              <Text type="supporting">{data.station.name} {data.station.id} · GLERL experimental wave forecast · run {runLabel} CT</Text>
            </VStack>
          </header>

          <aside className="panel stats" aria-live="polite">
            <VStack gap={3}>
              <VStack gap={0.5}>
                <Text type="label" color="secondary">Waves · {MODELS[cond.model].label}</Text>
                <HStack gap={2} align="end">
                  <Text type="display-2" hasTabularNumbers>{cond.hsFt.toFixed(1)}</Text>
                  <Text type="large" color="secondary">ft</Text>
                </HStack>
                {cond.band.p10 != null && (
                  <Text type="supporting" hasTabularNumbers>
                    Ensemble range {cond.band.p10.toFixed(1)}–{cond.band.p90.toFixed(1)} ft (10–90%)
                  </Text>
                )}
              </VStack>

              <VStack gap={1}>
                <Row label="Wind">{cond.windFrom} {cond.windMph.toFixed(0)} mph</Row>
                <div className="stats-detail">
                  <VStack gap={1}>
                    <Row label="Period (derived)">{sea.tp.toFixed(1)} s</Row>
                    <Row label="Wavelength">{sea.lp.toFixed(0)} m</Row>
                  </VStack>
                </div>
              </VStack>

              <div className="stats-detail">
                <HStack gap={3} align="center">
                  <Compass towardDeg={sea.towardDeg} windFromDeg={sea.windFromDeg} yaw={yaw} />
                  <VStack gap={0.5}>
                    <Text>Waves from {point(sea.windFromDeg)}, rolling {point(sea.towardDeg)}</Text>
                    <Text type="supporting">You face {point(yaw)} · drag the water to look around</Text>
                  </VStack>
                </HStack>
              </div>

              <HStack justify="between" align="center" gap={2} wrap="wrap">
                <Text type="supporting" hasTabularNumbers>
                  Virtual buoy: {measured ? `${measured.hsFt.toFixed(2)} ft` : '…'}
                </Text>
                <Badge variant={settled ? 'success' : 'neutral'} label={settled ? 'Water matches forecast' : 'Water settling…'} />
              </HStack>
            </VStack>
          </aside>

          <footer className="panel timeline">
            <VStack gap={2}>
              <HStack gap={2} align="center" wrap="wrap">
                <Button size="sm" variant="primary" label={playing ? 'Pause' : 'Play'}
                  icon={playing ? <PauseIcon width={14} /> : <PlayIcon width={14} />}
                  onClick={() => {
                    if (!playing && f >= data.time.length - 1.01) setF(0);
                    setPlaying(p => !p);
                  }} />
                <Button size="sm" label="Now" onClick={() => jump(nowIndex)} isDisabled={nowIndex <= 0 || nowIndex >= data.time.length - 1} />
                {thu && <Button size="sm" label={`Thursday ${fmt(data.time[thu.peak], {hour: 'numeric'})}`} tooltip="Jump to Thursday's highest waves" onClick={() => jump(thu.peak)} />}
                <Text weight="semibold" hasTabularNumbers>{whenLabel(cond.time)} CT</Text>
                <span className="spacer" />
                <SegmentedControl size="sm" label="Wave model driving the water" value={model} onChange={setModel}>
                  {Object.entries(MODELS).map(([k, m]) => (
                    <SegmentedControlItem key={k} value={k} label={m.label}
                      icon={<span className="swatch" style={{background: SERIES_COLORS[k]}} />} />
                  ))}
                </SegmentedControl>
                <IconButton size="sm" variant="ghost" label="Hide data (H)" tooltip="Hide data (H)" icon={<EyeOffIcon width={16} />} onClick={() => setHidden(true)} />
              </HStack>

              {cond.fellBack && (
                <Text type="supporting">
                  {MODELS[model].label} runs to {whenLabel(data.time[lastIndex(data, model)])} CT. Past that, the water follows the ensemble.
                </Text>
              )}

              <ForecastChart data={data} f={f} model={model} nowIndex={nowIndex}
                onScrub={i => { setPlaying(false); setF(i); }} />

              <Slider label="Forecast hour" isLabelHidden valueDisplay="none" width="100%"
                min={0} max={data.time.length - 1} step={1} value={Math.round(f)}
                onChange={v => jump(v)}
                formatValue={v => {
                  const c = conditions(data, v, model);
                  return `${whenLabel(c.time)}: ${c.hsFt.toFixed(1)} feet, wind ${c.windFrom} ${c.windMph.toFixed(0)} mph`;
                }} />
            </VStack>
          </footer>
        </>
      )}
    </div>
  );
}
