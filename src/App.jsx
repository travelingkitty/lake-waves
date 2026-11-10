import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Popover} from '@astryxdesign/core/Popover';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {createWater} from './sim/water.js';
import {celestial} from './sim/astro.js';
import {components, seaState} from './sim/seaState.js';
import {FACE, configureBeach, transform} from './sim/surf.js';
import {LWD, loadGeo, samplers} from './sim/geo.js';
import {MODELS, SERIES_COLORS, conditions, indexOf, lastIndex} from './sim/forecast.js';
import {ForecastChart} from './ForecastChart.jsx';

const STATION = '45198';
const TZ = 'America/Chicago';
const HOURS_PER_SECOND = 2; // playback speed; the water itself always runs in real time
const REPO = 'https://github.com/travelingkitty/lake-waves';
const CHECK_MS = 10 * 60 * 1000; // how often an open page looks for a newer forecast run

/** The moment (ms) a fractional forecast index points at. */
const timeAt = (data, f) => {
  const last = data.time.length - 1;
  const i = Math.max(0, Math.min(last - 1, Math.floor(f)));
  return data.time[i] + (data.time[i + 1] - data.time[i]) * (Math.max(0, Math.min(last, f)) - i);
};

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
const EyeIcon = svgIcon(<><path d="M2.5 12C3.5 9.5 7 5 12 5s8.5 4.5 9.5 7c-1 2.5-4.5 7-9.5 7s-8.5-4.5-9.5-7z" /><circle cx="12" cy="12" r="3" /></>);

/** First Thursday (Chicago time) after the run, and its biggest daylight hour. */
function thursday(data) {
  const run = Date.parse(data.source.initialized ?? data.time[0]);
  const start = data.time.findIndex(t => t > run && weekday(t) === 'Thu');
  if (start < 0) return null;
  let peak = -1;
  for (let i = start; i < Math.min(start + 24, data.time.length); i++) {
    const light = celestial(data.time[i], data.station.lat, data.station.lon).el > 2;
    if (light && (peak < 0 || (data.hs.ens[i] ?? 0) > (data.hs.ens[peak] ?? 0))) peak = i;
  }
  return {start, peak: peak < 0 ? start + 12 : peak};
}

/** Wave arrow, the beach line, the sun and where you're looking. */
function Compass({towardDeg, yaw, sun}) {
  const r = 26;
  const at = (deg, len) => {
    const a = (deg * Math.PI) / 180;
    return [Math.sin(a) * len, -Math.cos(a) * len];
  };
  const [tx, ty] = at(towardDeg, 16);
  const left = at(yaw - 35, r);
  const right = at(yaw + 35, r);
  const shoreA = at(FACE + 90, r);
  const shoreB = at(FACE - 90, r);
  const land = at(FACE + 180, r * 0.55);
  const [sx, sy] = at(sun.az, r + 1);
  const up = sun.el > 0;
  return (
    <svg className="compass" viewBox="-36 -36 72 72" role="img"
      aria-label={`Waves rolling ${point(towardDeg)}; beach faces ${point(FACE)}; sun ${up ? 'up' : 'down'} in the ${point(sun.az)}; view faces ${point(yaw)}`}>
      <circle r={r} className="compass-ring" />
      <path d={`M0 0 L${left[0]} ${left[1]} A${r} ${r} 0 0 1 ${right[0]} ${right[1]} Z`} className="compass-view" />
      <path d={`M${shoreA[0]} ${shoreA[1]} L${shoreB[0]} ${shoreB[1]} L${shoreB[0] + land[0]} ${shoreB[1] + land[1]} L${shoreA[0] + land[0]} ${shoreA[1] + land[1]} Z`} className="compass-land" />
      <text y={-r - 3} className="compass-n">N</text>
      <line x1={-tx} y1={-ty} x2={tx} y2={ty} className="compass-arrow" markerEnd="url(#head)" />
      <defs>
        <marker id="head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <circle cx={sx} cy={sy} r="3.6" className={up ? 'compass-sun' : 'compass-sun down'} />
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

function Menu({data, level, onHide}) {
  const run = data.source.initialized ? whenLabel(Date.parse(data.source.initialized)) : '—';
  return (
    <VStack gap={3}>
      <VStack gap={0.5}>
        <Heading level={2}>Montrose Beach · Chicago</Heading>
        <Text type="supporting">Standing at the end of the beach mat, looking out at the lineup. Waves: {data.station.name} {data.station.id}, NOAA GLERL experimental forecast, run {run} CT.</Text>
      </VStack>
      <Text>
        The shoreline, the dunes, the hook and its light, the beach house and the trees come from OpenStreetMap. The lake
        bottom comes from NOAA bathymetry, and the towers on the horizon are real heights. The water level is NOAA&apos;s live
        Calumet Harbor gauge: {(LWD + level).toFixed(2)} m, {level >= 0 ? '+' : ''}{(level * 100).toFixed(0)} cm over low-water datum.
      </Text>
      <Text>
        Offshore, the water is the forecast. Inshore, the same waves bend along the beach&apos;s depth contours. They lose
        height behind the hook and break on the sandbars once they&apos;re too tall for the depth (about 0.6 × depth). The
        bars are modelled, because Montrose&apos;s bars move from storm to storm.
      </Text>
      <Text>
        It&apos;s a painting, not a photograph. The sun, the moon with tonight&apos;s phase, and the stars are where they
        really are for the hour you pick. The hand gets less steady when it&apos;s cold and blowing, which is when
        the lake is at its best.
      </Text>
      <Text type="supporting">
        New forecast runs load by themselves: the site rebuilds from GLERL every hour and this page checks every 10 minutes.
      </Text>
      <Text type="supporting">Drag to look all the way around (downtown is behind you, to the south) · Space play/pause · ← → step an hour · H hide data</Text>
      <HStack gap={2} wrap="wrap">
        <Button size="sm" label="GLERL wave forecasts" href={data.source.page} target="_blank" rel="noreferrer" />
        <Button size="sm" label="Source on GitHub" href={REPO} target="_blank" rel="noreferrer" />
        <Button size="sm" variant="ghost" label="Hide data (H)" onClick={onHide} />
      </HStack>
      <Text type="supporting">Map data © OpenStreetMap contributors (ODbL).</Text>
    </VStack>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [f, setF] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [model, setModel] = useState('ens');
  const [measured, setMeasured] = useState(null);
  const [hidden, setHidden] = useState(() => new URLSearchParams(location.search).get('ui') === '0');
  const [menuOpen, setMenuOpen] = useState(false);
  const [yaw, setYaw] = useState(27);
  const [geo, setGeo] = useState(null);
  const [view, setView] = useState('mat');
  // Lake level above Low Water Datum (live NOAA gauge, or a typical recent level). Read once
  // per visit: it moves a centimetre or two a week, and changing it rebuilds the beach.
  const [level, setLevel] = useState(0.38);
  const canvasRef = useRef(null);
  const markerRef = useRef(null);
  const waterRef = useRef(null);
  const fRef = useRef(0);
  fRef.current = f;
  const dataRef = useRef(null);
  dataRef.current = data;
  const playingRef = useRef(false);
  playingRef.current = playing;
  // "Live": the page is showing the present moment and should keep up with the clock.
  const liveRef = useRef(false);

  useEffect(() => {
    fetch(`data/${STATION}.json`)
      .then(r => {
        if (!r.ok) throw new Error(`No forecast file (data/${STATION}.json). Run: npm run data`);
        return r.json();
      })
      .then(d => {
        setData(d);
        if (d.lakeLevel?.igld85) setLevel(d.lakeLevel.igld85 - LWD);
        // Open on "now" if the run covers it. ?t=thu jumps to the Thursday test case,
        // ?h=96 to a forecast hour, ?dh=12 to twelve hours from now.
        const q = new URLSearchParams(location.search);
        const thu = thursday(d);
        const now = indexOf(d, Date.now());
        const h = parseFloat(q.get('h')), dh = parseFloat(q.get('dh'));
        let start = now;
        if (q.get('t') === 'thu' && thu) start = thu.peak;
        else if (Number.isFinite(h)) start = h;
        else if (Number.isFinite(dh)) start = now + dh;
        else liveRef.current = true;
        setF(Math.max(0, Math.min(d.time.length - 1, start)));
      })
      .catch(e => setError(e.message));
  }, []);

  // Keep the forecast fresh while the page stays open. The published snapshot is rebuilt
  // from GLERL on a schedule; when a newer run shows up, swap it in under the same moment.
  useEffect(() => {
    let lastCheck = Date.now();
    const check = async () => {
      lastCheck = Date.now();
      const old = dataRef.current;
      if (!old) return;
      try {
        const r = await fetch(`data/${STATION}.json`, {cache: 'no-store'});
        if (!r.ok) return;
        const d = await r.json();
        if (!Array.isArray(d.time) || d.time.length < 2 || !d.hs?.ens) return;
        const fresh = d.source?.initialized !== old.source?.initialized || d.time[0] !== old.time[0] || d.time.length !== old.time.length;
        if (!fresh) return;
        const at = liveRef.current ? Date.now() : timeAt(old, fRef.current);
        setData(d);
        setF(indexOf(d, at));
      } catch {
        // offline or mid-deploy: keep painting the run we have
      }
    };
    const tick = setInterval(() => {
      // follow the clock while live
      if (liveRef.current && !playingRef.current && dataRef.current) setF(indexOf(dataRef.current, Date.now()));
    }, 60 * 1000);
    const poll = setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > CHECK_MS / 2) check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    loadGeo().then(setGeo).catch(e => setError(e.message));
  }, []);

  const ready = Boolean(data && geo);
  const where = useMemo(() => (geo ? samplers(geo) : null), [geo]);

  useEffect(() => {
    if (!ready) return undefined;
    configureBeach({face: geo.header.face, D0: geo.header.D0, profile: geo.scene.profile, levelShift: level - geo.header.mapLevel});
    let w;
    try {
      w = createWater(canvasRef.current, {geo, level, onMeasure: setMeasured, marker: markerRef.current});
    } catch (e) {
      setError(e.message);
      return undefined;
    }
    w.onView = setYaw;
    // ?view=hook&yaw=110&pitch=4 opens looking a particular way (for sharing a moment).
    const q = new URLSearchParams(location.search);
    const v0 = q.get('view');
    if (v0) { w.setView(v0); if (v0 === 'mat' || v0 === 'hook') setView(v0); }
    if (q.has('yaw') || q.has('pitch')) w.look(parseFloat(q.get('yaw')), parseFloat(q.get('pitch')));
    waterRef.current = w;
    return () => w.destroy();
  }, [ready, geo, level]);

  const cond = useMemo(() => (data ? conditions(data, f, model) : null), [data, f, model]);
  const sea = useMemo(() => (cond ? seaState(cond) : null), [cond]);
  // Where the sun, the moon and the stars really are at that hour (sun az/el at the top level).
  const sun = useMemo(() => (cond && data ? celestial(cond.time, data.station.lat, data.station.lon) : {az: 180, el: 0}), [cond, data]);

  // The surf report for the hour (whole hours only, so playback stays light).
  const hour = Math.round(f);
  const surf = useMemo(() => {
    if (!ready) return null;
    const s = seaState(conditions(data, hour, model));
    const r = transform(components(s), s).report;
    if (!r.breaking) return r;
    // The hook and Montrose Point block some directions: scale by the energy that
    // reaches the break straight out from the mat (spread over ±22.5°).
    const {profileBase: b, face} = geo.header;
    const x = b.x + Math.sin(face * Math.PI / 180) * r.distance, y = b.y + Math.cos(face * Math.PI / 180) * r.distance;
    const fromDeg = (s.towardDeg + 180) % 360;
    const open = 0.25 * where.shelter(x, y, fromDeg - 22.5) + 0.5 * where.shelter(x, y, fromDeg) + 0.25 * where.shelter(x, y, fromDeg + 22.5);
    return {...r, open, breakerFt: r.breakerFt * open, breaking: r.breakerFt * open >= 0.3};
  }, [ready, data, geo, where, hour, model]);

  // Hand the forecast hour to the water. This is the whole coupling.
  useEffect(() => {
    if (!sea || !ready) return;
    waterRef.current?.set(sea, sun, {tau: playing ? 0.15 : 0.8});
  }, [sea, sun, ready, playing]);

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
  const jump = useCallback((i, live = false) => { liveRef.current = live; setPlaying(false); setF(i); }, []);

  // Keyboard: space play/pause, H hide data, ←/→ hour.
  useEffect(() => {
    const onKey = e => {
      if (e.target !== document.body) return;
      if (e.key === ' ') { e.preventDefault(); liveRef.current = false; setPlaying(p => !p); }
      else if (e.key === 'h' || e.key === 'H') setHidden(h => !h);
      else if (data && e.key === 'ArrowRight') jump(Math.min(data.time.length - 1, Math.floor(fRef.current) + 1));
      else if (data && e.key === 'ArrowLeft') jump(Math.max(0, Math.ceil(fRef.current) - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, jump]);

  const nowIndex = data ? indexOf(data, Date.now()) : 0;
  const settled = measured && sea && Math.abs(measured.hsFt - sea.hsFt) <= Math.max(0.08 * sea.hsFt, 0.05);

  let breakers = 'Flat';
  let breakAt = '—';
  if (surf?.breaking && surf.breakerFt >= 0.3) {
    breakers = `${surf.breakerFt.toFixed(1)} ft · ${surf.type}`;
    breakAt = surf.distance < 15 ? 'Shore break' : `~${Math.round(surf.distance / 5) * 5} m off the mat`;
  } else if (surf?.open != null && surf.open < 0.35 && sea?.hsFt >= 1) {
    breakers = 'Flat (hook blocks it)';
  }

  return (
    <div className="app">
      <canvas ref={canvasRef} className="water" aria-label="Surf cam: simulated Lake Michigan breaking on a Chicago beach for the selected forecast hour. Drag to look around." />
      <div ref={markerRef} className={`break-marker ${hidden || !surf?.breaking ? 'off' : ''}`} aria-hidden="true">
        <span className="break-label">Breaking · {surf?.breaking ? `${surf.breakerFt.toFixed(1)} ft` : ''}</span>
      </div>

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
          <div className="menu">
            <Popover label="About this surf cam" placement="below" alignment="start" width={380} padding={4}
              isOpen={menuOpen} onOpenChange={setMenuOpen}
              content={<Menu data={data} level={level} onHide={() => { setMenuOpen(false); setHidden(true); }} />}>
              <IconButton label="About and settings" variant="secondary" elevation="low" icon={<Icon icon="menu" />} />
            </Popover>
            <div className="views">
              <SegmentedControl size="sm" label="Where you're standing" value={view}
                onChange={v => { setView(v); waterRef.current?.setView(v); }}>
                <SegmentedControlItem value="mat" label="Off the mat" />
                <SegmentedControlItem value="hook" label="The hook" />
              </SegmentedControl>
            </div>
          </div>

          <aside className="panel stats" aria-live="polite">
            <VStack gap={3}>
              <VStack gap={0.5}>
                <Text type="label" color="secondary">Offshore · {MODELS[cond.model].label}</Text>
                <HStack gap={2} align="end">
                  <Text type="display-2" hasTabularNumbers>{cond.hsFt.toFixed(1)}</Text>
                  <Text type="large" color="secondary">ft</Text>
                </HStack>
                {cond.band.p10 != null && (
                  <div className="stats-detail">
                    <Text type="supporting" hasTabularNumbers>
                      Ensemble range {cond.band.p10.toFixed(1)}–{cond.band.p90.toFixed(1)} ft (10–90%)
                    </Text>
                  </div>
                )}
              </VStack>

              <VStack gap={1}>
                <Row label="Wind">{cond.windFrom} {cond.windMph.toFixed(0)} mph</Row>
                <div className="stats-detail">
                  <Row label="Period (derived)">{sea.tp.toFixed(1)} s</Row>
                </div>
              </VStack>

              <VStack gap={1}>
                <Text type="label" color="secondary">At Montrose</Text>
                <Row label="Breakers">{breakers}</Row>
                <Row label="Breaking">{breakAt}</Row>
                {surf?.breaking && surf.driftMs > 0.05 && (
                  <div className="stats-detail">
                    <Row label="Drift">{point(surf.driftBearing)} ~{surf.driftMs.toFixed(1)} m/s</Row>
                  </div>
                )}
              </VStack>

              <div className="stats-detail">
                <HStack gap={3} align="center">
                  <Compass towardDeg={sea.towardDeg} yaw={yaw} sun={sun} />
                  <VStack gap={0.5}>
                    <Text>Waves from {point(sea.windFromDeg)}</Text>
                    <Text type="supporting">Montrose faces {point(FACE)} · sun {sun.el > 0 ? `up, ${point(sun.az)}` : 'down'}</Text>
                  </VStack>
                </HStack>
              </div>

              <HStack justify="between" align="center" gap={2} wrap="wrap">
                <div className="stats-detail">
                  <Text type="supporting" hasTabularNumbers>
                    Virtual buoy: {measured ? `${measured.hsFt.toFixed(2)} ft` : '…'}
                  </Text>
                </div>
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
                    liveRef.current = false;
                    setPlaying(p => !p);
                  }} />
                <Button size="sm" label="Now" onClick={() => jump(nowIndex, true)} isDisabled={nowIndex <= 0 || nowIndex >= data.time.length - 1} />
                {thu && <Button size="sm" label={`Thursday ${fmt(data.time[thu.peak], {hour: 'numeric'})}`} tooltip="Jump to Thursday's biggest daylight surf" onClick={() => jump(thu.peak)} />}
                <Text weight="semibold" hasTabularNumbers>
                  {sun.el > 0 ? '☀' : '☾'} {whenLabel(cond.time)} CT
                </Text>
                <span className="spacer" />
                <SegmentedControl size="sm" label="Wave model driving the water" value={model} onChange={setModel}>
                  {Object.entries(MODELS).map(([k, m]) => (
                    <SegmentedControlItem key={k} value={k} label={m.label}
                      icon={<span className="swatch" style={{background: SERIES_COLORS[k]}} />} />
                  ))}
                </SegmentedControl>
              </HStack>

              {cond.fellBack && (
                <Text type="supporting">
                  {MODELS[model].label} runs to {whenLabel(data.time[lastIndex(data, model)])} CT. Past that, the water follows the ensemble.
                </Text>
              )}

              <ForecastChart data={data} f={f} model={model} nowIndex={nowIndex}
                onScrub={i => jump(i)} />

              <Slider label="Forecast hour" isLabelHidden valueDisplay="none" width="100%"
                min={0} max={data.time.length - 1} step={1} value={Math.round(f)}
                onChange={v => jump(v)}
                formatValue={v => {
                  const c = conditions(data, v, model);
                  return `${whenLabel(c.time)}: ${c.hsFt.toFixed(1)} feet offshore, wind ${c.windFrom} ${c.windMph.toFixed(0)} mph`;
                }} />
            </VStack>
          </footer>
        </>
      )}
    </div>
  );
}
