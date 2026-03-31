# Spectrum — Crypto & Stock Pressure Field Visualizer

A physics-based crypto chart analysis tool that treats candlestick data as light sources. Candle highs and lows emit beams of light; candle bodies and wicks act as translucent obstacles that cast shadows. The result is a pressure field where bright zones reveal support/resistance and dark zones reveal paths of least resistance.

Built with vanilla JavaScript. No frameworks, no build step. Open `index.html` in a browser and go.


## Quick Start

1. Start the local server:
   ```
   python server.py
   ```
2. Open `http://localhost:8080` in your browser.
3. Click **⟳ Fetch Live** to load real market data.
4. Now supports **stocks & ETFs** (SPY, AAPL, etc.) via the new Yahoo Finance source!
5. Click **▶ Play** to watch the chart build up candle-by-candle and calibrate the prediction engine.

The tool opens with generated sample data. Fetch Live pulls real candles from Binance (default) or CoinGecko (if you provide a free API key).


## Data Sources

### Binance (default)

No API key needed. Fetches directly from Binance's public REST API. This is the highest-quality source — native OHLCV at every interval with real taker buy/sell volume for accurate buy pressure data.

Works in all browsers. If `api.binance.us` is blocked in your region, it automatically falls back to `api.binance.com`.

### CoinGecko (optional)

Requires a free Demo API key. Sign up at [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing) — no credit card needed.

To set up:
1. Switch the **SOURCE** dropdown to CoinGecko.
2. Paste your Demo API key into the input field.
3. The key is saved in your browser's localStorage. On future visits, CoinGecko will be selected automatically and the key will be hidden (click the 👁 button to reveal it).

CoinGecko provides aggregated price data from many exchanges. The tool fetches raw price/volume time-series from the `/market_chart` endpoint and synthesizes OHLCV candles at whatever interval is needed. Buy pressure is estimated from candle shape since CoinGecko doesn't expose taker volume.

Rate limit: 30 calls/minute on the free tier. The tool spaces requests 2.2 seconds apart to stay within limits.

### Yahoo Finance (Stocks & ETFs) — NEW

No API key required. Fully CORS-friendly public endpoint.

**How to use:**
1. Change **SOURCE** dropdown to **Yahoo Finance (stocks/ETFs)**.
2. Type any ticker (e.g. `SPY`, `AAPL`, `QQQ`, `NVDA`, `TSLA`) in the new input box.
3. Hit **Load** (or press Enter).

The ticker input appears automatically when Yahoo is selected.  
Multi-asset overlay is disabled for stocks (one ticker at a time).  

All visualization modes (Raycast, Wind Tunnel, Sight Lines, Projection Engine) work exactly the same. The only difference is that stocks use aggregated OHLCV data (no native taker-buy/sell split, so `buyPressure` defaults to 0.5).

Works for any valid Yahoo ticker symbol (U.S. stocks, ETFs, even some international). Real-time/delayed last price is shown in the top bar.

### Range Selector

The **RANGE** dropdown controls how much history to fetch and at what candle interval:

| Range              | Binance (crypto)          | CoinGecko (crypto)               | Yahoo Finance (stocks/ETFs)      |
|--------------------|---------------------------|----------------------------------|----------------------------------|
| 24h (5m candles)   | Native 5m                 | Synthesized                      | 5m interval                      |
| 24h (15m candles)  | Native 15m                | Synthesized                      | 15m interval                     |
| 7d (1h candles)    | Native 1h                 | Synthesized                      | 1h interval                      |
| 7d (4h candles)    | Native 4h                 | Synthesized                      | 4h / 1h interval                 |
| 14d (1h / 4h)      | Native                    | Synthesized                      | 1h / 4h                          |
| 30d (4h candles)   | Native 4h                 | Synthesized                      | 4h interval                      |
| 30d Multi-Res      | 15m→1h→4h stitched        | 15m→1h→4h stitched               | 15m→1h→4h stitched               |
| 90d (daily)        | Native daily              | Synthesized                      | 1d interval                      |

Multi-Res stitches three layers for the best of both worlds on every data source.

### Background Data

Behind the visible chart, the tool fetches additional historical candles at coarser intervals (1h, 4h, daily, weekly). These are positioned off-screen to the left. Their light beams project rightward into the visible area, creating the long-range support/resistance levels you see as faint glow at the chart edges. This is the "historical pressure" that influences the current field.


## The Three Visualization Modes

### ☀ Raycast

The primary mode. Candle highs and lows emit beams of colored light. The four colors encode the source and direction:

- **Green** — emitted from candle highs, projecting upward. Strong resistance.
- **Yellow** — emitted from candle highs, projecting downward. Weak resistance.
- **Blue** — emitted from candle lows, projecting upward. Weak support.
- **Red** — emitted from candle lows, projecting downward. Strong support.

Bright areas = heavy support or resistance pressure. Dark areas = paths of least resistance where price can move freely. The heatmap is rendered on the GPU via WebGL for speed.

**Controls specific to Raycast mode:**

- **RES** — Grid resolution. Lower = coarser but faster, higher = finer but slower.
- **OPACITY** — Brightness of the heatmap overlay.
- **LENGTH→GLOW** — How much beam length boosts brightness. At 100%, longer sight lines (connecting distant candles) glow brighter than short ones.
- **INTENSITY** — Weights beam brightness by technical indicators:
  - Uniform: all candles emit equally.
  - MA: Near/Far = candles near/far from the moving average glow brighter.
  - RSI: Extreme/Neutral = candles at extreme/neutral RSI values glow brighter.

### ≋ Wind Tunnel

Particles flow rightward across the pressure field terrain. The light field intensity from Raycast mode becomes elevation — bright zones are ridges, dark zones are valleys.

- Particles naturally channel through valleys (paths of least resistance).
- Ridges deflect particles around them (support/resistance barriers).
- Uphill movement costs momentum; downhill movement accelerates.
- Color shifts from cool cyan (valleys) to warm orange (ridges) based on local field intensity.

Watch where the particle streams converge — those are the channels the physics model predicts price is most likely to flow through.

Rendering uses WebGL2 instanced drawing for 5000 particles at 60fps.

### ⁄ Sight Lines

Shows the raw geometric connections between candle highs and lows. Each line represents a direct line-of-sight between two candle tips that isn't blocked by any candle body in between.

- **Base Lines** — the raw H→H and L→L connections.
- **Extend Rays** — projects each line beyond its endpoint (these are the beams that create the heatmap).
- **Macro Trends** — only shows lines at shallow angles (configurable via the ANGLE slider), filtering out noise to reveal dominant trend lines.


## Animation & Calibration

### Playing Through

Click **▶ Play** to watch the chart build up candle-by-candle. This isn't just visual — it's functional:

1. **Calibration**: As each candle is revealed, the prediction engine compares what it predicted to what actually happened. It tracks directional accuracy per step distance and adjusts bias corrections.
2. **Temporal smoothing**: The prediction blends the current frame's consensus with the two prior frames, producing more stable paths.
3. **Signal pipeline training**: The three domain specialists (terrain, indicator, energy) learn which signals correlate with correct predictions in this specific dataset.

**After a full playthrough, the prediction paths and corridors become visible.** Before calibration, the projection zone shows "▶ Play to calibrate" instead of paths — this prevents showing misleading predictions that would change after calibration.

### Speed & Scrubbing

- **SPEED** slider controls candles per second (1–20).
- **PROGRESS** slider lets you scrub to any point. Drag it to jump forward or backward.
- **⏮ Reset** returns to showing all candles.


## Projection Engine

When **◉ Projection** is enabled, the right portion of the chart becomes the projection zone — a forward-looking region where the prediction engine simulates where price might go.

The engine works by treating the heatmap as a force field. A virtual price "particle" starts at the last candle's close and steps forward through the field. At each step:

- The four color channels exert directional forces (green/yellow push one way, blue/red the other).
- Additional forces from MA reversion, RSI mean-reversion, momentum, volume, LSSA spectral projection, corridor pathfinding, and topology flow contribute.
- Three regime-based paths (bull, bear, neutral) run simultaneously with per-step re-evaluation.
- The consensus price at each step is the weighted average across all paths.

### Prediction Model Controls

The MODEL bar lets you toggle individual force components:

| Toggle | What it does |
|---|---|
| ☀ Light | The core physics — forces from the heatmap color grids. |
| 〰 MA | Moving average spring — pulls price toward the MA. Calibrated from background data. |
| ⚡ RSI | RSI mean-reversion — pushes price away from extremes. |
| 📊 Volume | Volume-weighted momentum — high volume amplifies the current direction. |
| 📈 LSSA | Least-squares spectral analysis — extrapolates dominant price cycles. |
| 🔧 Calibrate | Applies bias correction from historical accuracy tracking. |
| 💡 V.Beams | Virtual beams — the predicted candles themselves emit light back into the field. |
| 🗺 Topo | Topology gradient — follows the terrain's path of least resistance. |
| 🫠 Corridor | Slime-mold pathfinding — traces optimal routes through the pressure field. |
| 💥 Int Rev | Intensity reversal — high pressure zones act as barriers, not attractors. |
| ⬇ Min Step | Minimum step size — prevents prediction from stalling in flat zones. |

### Color Force Tuning

The FORCE bar lets you adjust how each heatmap color translates into prediction force:

- **Direction**: ▼ Down or ▲ Up — flip which way this color pushes price.
- **Strength**: 0.0–2.0 — how strongly this color pushes.

The defaults encode the core S/R physics: green (strong resistance above) pushes down, red (strong support below) pushes up. But you can experiment — flipping a direction or zeroing a color changes the prediction character entirely.

### Overlays

- **◎ Contours** — draws contour lines of equal pressure on the heatmap, like a topographic map.
- **▦ Topo Fill** — fills valleys (low pressure) with cool blue and ridges (high pressure) with warm orange.
- **🫠 Corridors** — shows the corridor pathfinder's traced routes as green dashed lines.


## Live Price Ticker

Click **◉ Live Price** after loading live data to enable real-time price updates. The tool polls the current price every 1 second (Binance) or 2.5 seconds (CoinGecko) and updates the last candle's close price. High and low are adjusted if the new price exceeds them.

This is lightweight by design — it only touches the last candle and repaints from cached data. No heatmap recalculation, no sight line recomputation, no preprocessing. The particle system, heatmap, and projection all continue using their cached state.

The ticker auto-stops when you fetch new data, switch to generated data, or click the button again.


## Chart Interaction

- **Scroll wheel**: zoom in/out, centered on the cursor.
- **Click + drag**: pan the chart.
- **Double-click**: reset zoom and pan.
- **Crosshair**: hover anywhere to see price level and candle index.


## Indicator Overlays

Three technical indicator overlays can be toggled independently (top toolbar, OVERLAY section):

- **MA** (orange) — Simple Moving Average line.
- **RSI** (purple) — RSI indicator scaled to the price axis.
- **LSSA** (cyan) — Least-Squares Spectral Analysis projection line.

These are visual overlays and don't affect the heatmap. They do feed into the prediction engine when their corresponding MODEL toggles are active.


## Multi-Asset

Three assets are available: **SOL**, **ETH**, **BTC**. Click an asset button to switch. The heatmap, particles, sight lines, and predictions all recalculate for the selected asset.

Click **⊕ Overlay** to render all three assets on the same chart simultaneously, each with its own color scheme. Useful for spotting correlated support/resistance levels across assets.


## File Structure

| File | Purpose |
|---|---|
| `index.html` | Layout, toolbar, script loading order |
| `config.js` | All configuration constants and shared state |
| `data.js` | Candle generation, SMA, RSI, intensity weight calculations |
| `coords.js` | Price-to-pixel mapping, chart dimensions, projection zone layout |
| `drawing.js` | Candle rendering, grid lines, crosshair, indicator overlays |
| `sightlines.js` | Build and render H→H / L→L sight lines, background S/R |
| `webgl-heatmap.js` | GPU-accelerated heatmap rendering (WebGL) |
| `gl-beams.js` | GPU beam accumulation (instanced quad rendering) |
| `heatmap.js` | Build the four-color heatmap grids, CPU fallback rendering |
| `calibrate-indicators.js` | MA/RSI physics calibration from background data |
| `regime.js` | Bull/bear/neutral regime detection, 3-path prediction |
| `signal-layers.js` | Layered signal pipeline (terrain → indicator → energy → meta) |
| `topology.js` | Topological analysis — ridges, valleys, saddle points, flow |
| `corridor.js` | Slime-mold corridor pathfinding through the pressure field |
| `gl-particles.js` | Three.js GPU particle renderer (bundled IIFE) |
| `gl-particles-instanced.js` | WebGL2 instanced particle renderer (per-particle color) |
| `particles.js` | Particle physics, emission, spatial grid, trail rendering |
| `projection.js` | Multi-path prediction engine, calibration, scenario consensus |
| `ui.js` | Event handlers, toolbar state management, legend updates |
| `main.js` | Frame loop, animation, data fetching, initialization |
| `server.py` | Simple Python HTTP server for local development |


## Requirements

- A modern browser with WebGL2 support (Chrome, Firefox, Edge, Safari 15+).
- No npm, no node_modules, no build tools. Just files and a browser.

For local development, Python 3 is convenient for `server.py`, but any HTTP server works (see below). The tool degrades gracefully if WebGL is unavailable — CPU fallback renderers handle the heatmap and particles, just at lower frame rates.


## Hosting & Deployment

The included `server.py` is just a convenience for local development. Spectrum is entirely static files — HTML, JS, and nothing else. No server-side code, no database, no build step. It can be hosted anywhere that serves static files.

### What to upload

Every `.js` file and `index.html`. That's it. You do **not** need `server.py` in production — it's only for running locally.

The full file list:
```
index.html
config.js
data.js
coords.js
drawing.js
sightlines.js
webgl-heatmap.js
gl-beams.js
heatmap.js
calibrate-indicators.js
regime.js
signal-layers.js
topology.js
corridor.js
gl-particles.js
gl-particles-instanced.js
particles.js
projection.js
ui.js
main.js
```

All files must be in the same directory (no subdirectories). The `index.html` loads each script via relative paths like `<script src="main.js">`.

### Local development (without Python)

Any HTTP server that serves static files will work. You can't just open `index.html` as a `file://` URL — browsers block `fetch()` calls from `file://` origins. You need a local server. Some alternatives to `server.py`:

```bash
# Node.js (if you have it)
npx serve .

# PHP (if you have it)
php -S localhost:8080

# Ruby (if you have it)
ruby -run -e httpd . -p 8080
```

Or use the VS Code "Live Server" extension — right-click `index.html` → Open with Live Server.

### GitHub Pages

The simplest free hosting option. Push all the files to a GitHub repo and enable Pages:

1. Create a repository and push all the files (the ones listed above, flat in the root — no subdirectory).
2. Go to the repo's **Settings → Pages**.
3. Under "Source", select the branch (usually `main`) and folder (`/ (root)`).
4. Click Save. Your site will be live at `https://yourusername.github.io/reponame/` within a minute or two.

That's it. No build step, no configuration files, no `package.json`.

### Netlify / Vercel / Cloudflare Pages

All three support static sites with zero configuration:

**Netlify:**
1. Go to [app.netlify.com](https://app.netlify.com), sign in, click "Add new site" → "Deploy manually".
2. Drag and drop a folder containing all the files.
3. Done. You get a URL like `https://random-name.netlify.app`.

Or connect a Git repo for automatic deploys on push. No build command needed — leave it blank.

**Vercel:**
1. Go to [vercel.com](https://vercel.com), import your Git repo.
2. Framework preset: "Other". Build command: leave blank. Output directory: `.` (root).
3. Deploy. Live at `https://yourproject.vercel.app`.

**Cloudflare Pages:**
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Pages → Create a project.
2. Connect your Git repo. Build command: leave blank. Build output: `/`.
3. Deploy.

### Any static web host

Upload the files to any web host that serves static content. Shared hosting (cPanel, etc.), S3 + CloudFront, Firebase Hosting, a VPS with nginx — all work. No special server configuration is needed beyond serving files with the correct MIME types (any standard web server handles this out of the box).

Example nginx config (if you want to be explicit):
```nginx
server {
    listen 80;
    server_name spectrum.yourdomain.com;
    root /var/www/spectrum;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

### CORS and API access

Both data sources (Binance and CoinGecko) set CORS headers that allow requests from any origin. Your hosted site can fetch data directly from these APIs — no proxy, no backend, no server-side code. This works from `localhost`, from GitHub Pages, from a custom domain, from anywhere.

The only thing stored in the browser is the CoinGecko API key (in localStorage) and cached candle data. Nothing is sent to or stored on your server.


## Performance Notes

- The heatmap and sight lines are cached aggressively. Changing visualization settings triggers a cache rebuild, but panning/zooming uses cached data.
- The most expensive operation is the O(n³) visibility pair computation (precomputed once when data loads or animation starts).
- Particle trails use Float32Array ring buffers — zero garbage collection pressure. Trail rendering is batched into ~10 color groups for minimal canvas draw calls.
- Background data (historical S/R) is cached in localStorage so page reloads don't require fresh API calls if the data is still within its freshness window.
