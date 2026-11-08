# Lake Waves · Chicago

The whole page is Lake Michigan off Chicago, drawn live in WebGL. The water is
driven, hour by hour, by NOAA GLERL's experimental wave forecast, the same data
the [GLERL WW3 page](https://www.glerl.noaa.gov/emf/waves/WW3/?pg=ww3) plots
when you click the Chicago Buoy. The numbers float on top in a few small
[Astryx](https://github.com/meta/astryx) panels.

```bash
npm install
npm run data      # pull the latest GLERL run for Chicago (45198) → public/data/45198.json
npm test          # check the simulated water against the forecast (see below)
npm run dev       # http://localhost:5173  (add ?t=thu to open on Thursday's peak)
npm run build     # static site in dist/ — host anywhere
```

GLERL runs twice a day (00Z and 12Z). Re-run `npm run data` to refresh. GLERL
doesn't send CORS headers, so the browser can't fetch it directly. The script
saves a small (≈18 KB) JSON snapshot instead. Other stations: `npm run data -- 45174`.

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
- **Sky.** The sun is placed for the forecast hour at Chicago, and the cloud deck darkens
  and drifts with the wind.

On screen, the **virtual buoy** measures wave height off the rendered surface
every 0.4 s. The badge turns green when it matches the forecast.

## The test

`npm test` takes the next Thursday after the forecast run and checks every
hour from Wednesday noon to Sunday noon. It builds the exact surface the page
draws, then measures it the way a buoy would: Hs over a 1.2 km patch and over 30
minutes at a point, peak period from a Welch spectrum, and heading from slope ×
vertical velocity. It fails if any hour is off (Hs > 6%/12%, Tp > 15%, heading > 10°).

## Controls

Drag the water to look around (you start on the Chicago shore facing east).
**Space** plays or pauses, **← →** step an hour, **H** hides the data.
