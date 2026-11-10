# Lake Waves · Chicago

**Live:** https://travelingkitty.github.io/lake-waves/ · Thursday test case: [`?t=thu`](https://travelingkitty.github.io/lake-waves/?t=thu)

A moving painting of **Montrose Beach, Chicago**, and a surf forecast. You stand at the
water's edge off the beach mat (Surfline's lineup marker) or out on the hook, and you can
turn the full 360°. The lake in front of you is NOAA GLERL's experimental wave forecast,
hour by hour: the same data the [GLERL WW3 page](https://www.glerl.noaa.gov/emf/waves/WW3/?pg=ww3)
plots when you click the Chicago Buoy. Offshore, the water is the forecast. At the beach,
the same waves shoal, bend and break. The numbers stay out of the way under a small
[Astryx](https://github.com/meta/astryx) menu.

It started from a photo: a sunrise surf session on the lake on a freezing morning. The
page is painted the way that morning felt.

```bash
npm install
npm run data      # pull the latest GLERL run for Chicago (45198) → public/data/45198.json
npm test          # check the simulated water against the forecast (see below)
npm run dev       # http://localhost:5173  (add ?t=thu to open on Thursday's peak)
npm run build     # static site in dist/ — host anywhere
npm run geo       # rebuild Montrose from OpenStreetMap and NOAA (rarely needed)
```

## The forecast keeps itself current

GLERL posts a new run twice a day (00Z and 12Z) and sends no CORS headers, so a browser
can't read it directly. Instead:

1. **Every hour** the GitHub Actions workflow (`.github/workflows/pages.yml`) runs
   `npm run data` and then `scripts/is-fresh.mjs`, which compares the run it just pulled
   with the one the live page is serving.
2. **Only if GLERL has posted something new** does it run `npm test`, build and deploy.
   A failed fetch, or an older run, never replaces a newer one.
3. **An open page** re-reads its own `data/45198.json` every 10 minutes and when the tab
   regains focus. A newer run is swapped in under you, at the same moment in time.

GitHub pauses scheduled workflows after 60 days without repository activity. The
workflow's last step re-enables its own schedule to prevent that; if the page ever stops
updating, open the Actions tab and re-enable the workflow.

Other stations: `npm run data -- 45174`.

## Where the data comes from

`scripts/fetch-glerl.mjs` downloads
`https://www.glerl.noaa.gov/emf/waves/WW3/xgb/fig/45198.json`. That's the
Plotly figure behind the buoy popup on the GLERL page. It keeps, hourly for 10 days:

| Series | What it is |
|---|---|
| `hs.ens`, `p10…p90` | 31-member GEFS ensemble wave height (ft): average and spread |
| `hs.xgb` | XGBoost model, HRRR+GFS winds (≈5 days) |
| `hs.ww3` | WAVEWATCH III, HRRR+GFS winds (≈3 days) |
| `wind.gefs`, `wind.hrrr` | wind speed (mph) and compass direction it blows from |

The lake level is NOAA's live Calumet Harbor gauge.

## The place

`npm run geo` (`scripts/build-montrose.mjs`) builds the beach from survey data and writes
`public/montrose/geo.bin` and `scene.json`:

- **OpenStreetMap:** the shoreline, beach, dunes, the hook and its light, 830 nearby
  buildings and 1,382 trees.
- **NOAA NCEI:** bathymetry.
- **Skyline:** 160 towers, each at its true compass bearing, distance and height as seen
  from the sand: downtown due south (875 N Michigan, Trump Tower, Willis), Uptown to the
  west, the Edgewater towers up the shore to the north-west. Where OpenStreetMap has only
  a floor count, height is taken as 3.05 m a floor plus 3 m.

The surf-zone sandbars are modelled, because Montrose's bars move.

## The sky

`src/sim/astro.js` and `src/sim/light.js` place everything for the forecast hour at
Chicago: the sun, the moon with its true phase, and the stars, which turn with sidereal
time and so rise and set through the night with the Milky Way. Nights are lit brighter
than they are, on purpose, so you can still read the waves in the dark.

## The painting

The scene is rendered in HDR and then painted (`src/sim/post.js`, shaders in
`src/sim/glsl/`): a Kuwahara brush, bloom, a planar reflection of the sky in the water,
a filmic shoulder and canvas weave. The painter has flaws, and they are deliberate:

- **Cold hands.** The brush trembles in beats. It gets worse with the wind and in the dark.
- **Underpainting.** The canvas was toned burnt sienna first, and it still grins through
  the thin darks and through flecks the brush skipped.
- **Impasto.** The lights are laid on thick and catch a little relief.
- **Unfinished edges.** Strokes stop short of the edge of the canvas, where the brush ran dry.

None of this touches the wave geometry. The water under the paint is still the forecast.

## How the water follows the forecast

All of it is in `src/sim/seaState.js`, shared by the renderer and the test:

- **Height.** 32 wave components follow a JONSWAP spectrum. Their amplitudes are scaled
  so that 4·std(surface) equals the forecast significant wave height exactly.
- **Period.** GLERL's point product has no period, so it's derived from
  the forecast height and wind with the JONSWAP fetch-limited growth laws.
  The UI labels it "derived".
- **Direction.** Waves travel downwind (wind from N → waves rolling S), spread ±22–60°.
- **Speed.** Each wave moves at its deep-water speed (ω² = gk), in real time.
- **Roughness and whitecaps.** Ripple slope comes from the Cox–Munk law for the wind
  speed. Whitecaps start around 7 mph and are plentiful by 19–24 mph (Beaufort 5).
- **Weather.** The cloud deck darkens and drifts with the wind.

On screen, the **virtual buoy** measures wave height off the rendered surface
every 0.4 s. The badge turns green when it matches the forecast.

## At the beach

`src/sim/surf.js` carries every wave component from 1.5 km out onto the beach. The
seabed is illustrative: a 1:11 foreshore, an inner trough and a sandbar about 110 m out.

- **Slowing and shortening:** linear dispersion, ω² = g·k·tanh(k·h).
- **Bending toward shore:** Snell's law, which keeps the alongshore wavenumber.
- **Growing:** shoaling and refraction, conserving energy flux.
- **Breaking:** wave height is capped at 0.6 × depth, the value for random waves
  (Thornton & Guza). On screen, any crest higher than ~0.4 × depth turns to
  whitewater, and broken bores and lace roll in to the swash.
- **Readout:** breaker height, distance out, breaker type (Iribarren number:
  spilling, plunging or surging), longshore drift (Longuet-Higgins) and runup
  (Stockdon).

Waves only reach the beach if they're heading for it. On this NE-facing beach a N or NE
wind sends surf in, while a S or W wind (offshore here) leaves it flat. The model treats
all waves as wind sea running downwind, so leftover swell after a wind shift isn't modeled.

## The test

`npm test` takes the next Thursday after the forecast run and checks every
hour from Wednesday noon to Sunday noon. It builds the exact surface the page
draws, then measures it the way a buoy would: Hs over a 1.2 km patch and over 30
minutes at a point, peak period from a Welch spectrum, and heading from slope ×
vertical velocity. It fails if any hour is off (Hs > 6%/12%, Tp > 15%, heading > 10°).
Then it carries the same hours onto the beach. It measures the drawn waves, using the
shader's own formula, along 4 km of shore at 300 m, 110 m and 40 m out. It fails if they
differ from the surf model by more than 10%, outgrow 0.6 × depth anywhere, or the surf
table contains a non-finite value.

## Controls

Drag to look around. The menu (top-left) has sources and settings.
**Space** plays or pauses, **← →** step an hour, **H** hides the data.

Links can open on a particular moment and view:

| Parameter | Meaning |
|---|---|
| `t=thu` | open on the peak of the next Thursday event |
| `h=97.5` | open that many hours into the forecast run |
| `view=mat`, `view=hook`, `view=top` | stand at the beach mat, on the hook, or look from above |
| `yaw=180&pitch=5` | compass direction to face and tilt, in degrees |
| `ui=0` | the painting alone, no interface |
