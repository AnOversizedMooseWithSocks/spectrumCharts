/*
 * ================================================================
 * config.js  —  Configuration, Application State, Caches
 * ================================================================
 * Loaded first. Everything else depends on these globals.
 *
 * CONFIG: all the knobs you can tweak to change the simulation.
 * state:  tracks what's currently selected in the UI.
 * Caches: persist across frames, cleared when state changes.
 * ================================================================
 */

// ----------------------------------------------------------------
// CONFIGURATION
// ----------------------------------------------------------------
// Grouped by category so you can find what you need.

var CONFIG = {

  // -- Visual colors --
  CANDLE_UP:    "#00c087",   // green for bullish candles
  CANDLE_DOWN:  "#ff4757",   // red for bearish candles
  BG:           "#0b0e18",   // dark background
  GRID_COLOR:   "rgba(255,255,255,0.04)",
  TEXT_COLOR:   "#8892a4",

  // -- Raycast (beam) settings --
  // Rays act like strong beams / trend lines that extend across
  // the entire chart. They do NOT decay with distance. The only
  // thing that attenuates a beam is passing through a candle body.
  RAY_COUNT:     64,            // rays per light source (rightward hemisphere)
  RAY_SKIP:      30,            // skip depositing light for the first N pixels
                                // (prevents hotspot where all rays overlap at source)
  // Note: candle opacity is controlled by state.translucency (slider)

  // -- MA / RSI settings --
  MA_PERIOD:     20,            // moving average period for intensity weighting
  RSI_PERIOD:    14,            // RSI period

  // -- Particle (wind tunnel) settings --
  // New system: particles spawn as a wall off-screen left and flow
  // rightward through the candle field. Uses pre-allocated typed
  // arrays for zero-GC performance and an offscreen trail canvas
  // for persistence-based trails (no per-particle trail drawing).
  PARTICLE_COUNT: 5000,          // particle pool size
  WIND_BASE:      1.2,           // constant rightward push (the "wind")
  FORCE_RADIUS:   50,            // how far each candle extreme pushes (pixels)
  FORCE_STRENGTH: 0.35,          // how hard candle extremes push particles
  PARTICLE_R:     1.4,           // dot radius for each particle
  TRAIL_LEN:      8,              // past positions for trail rendering
  TURBULENCE:     0.15,          // random jitter each frame
  DAMPING:        0.97,          // velocity multiplier each frame (friction)
  TRAIL_FADE:     0.04,          // how fast trails fade (0=permanent, 1=instant)

  // -- Approximate market caps in billions (for mass/gravity ratios) --
  MCAP: { BTC: 1200, ETH: 300, SOL: 45 },

  // -- Per-asset colors used in multi-asset overlay --
  ASSET_COLORS: {
    SOL: { candle: "#9945ff", particle: "#c084fc", heatHi: "#9945ff" },
    ETH: { candle: "#627eea", particle: "#93b5ff", heatHi: "#627eea" },
    BTC: { candle: "#f7931a", particle: "#fbbf24", heatHi: "#f7931a" },
  },

  CANDLE_COUNT: 120,  // how many candles to generate
};


// ----------------------------------------------------------------
// APPLICATION STATE
// ----------------------------------------------------------------
// Simple object to track what's currently selected.
// When state changes, we invalidate caches and redraw.

var state = {
  mode:          "raycast",
  asset:         "SOL",
  multiAsset:    false,
  heatmapRes:    4,
  showCandles:   true,
  translucency:  0.95,          // 95% opacity
  beamLenBoost:  0.0,           // 0% length→glow (corridor-focused, no beam glow)
  beamSpread:    0,            // 0° spread (was 15°)
  raysOnly:      false,
  intensityMode: "ma_near",     // MA: Near = Bright (consolidation zones glow)

  // -- Sight line toggles --
  slShowBase:    true,
  slShowRays:    false,
  slShowMacro:   false,
  slMacroAngle:  3,
  slMomentum:    0,

  // -- Animation --
  animating:     false,
  animCandles:   0,
  animSpeed:     20,            // 20/s (was 3)

  // -- Projection zone --
  showProjection: true,
  showProjInfo:   true,   // show text overlay in projection zone (direction, target, accuracy)
  projCandles:    25,

  // -- Color force settings for projection --
  colorForce: {
    green:  { dir:  1, str: 2.0 },  // down, 2.0
    yellow: { dir:  1, str: 1.0 },  // down, 1.0
    blue:   { dir: -1, str: 1.0 },  // up, 1.0
    red:    { dir: -1, str: 2.0 },  // up, 2.0
  },

  // -- Prediction component toggles --
  predLight: true,    // light field S/R forces from beams
  predMA:    false,   // moving average spring (OFF — traditional tool, not light-based)
  predRSI:   false,   // RSI mean-reversion (OFF — traditional tool, not light-based)
  predVol:   true,    // volume buy/sell pressure
  predLSR:   false,   // LSSA spectral analysis (OFF — traditional tool, not light-based)
  predMom:   false,   // micro wind tunnel momentum (OFF — old pre-pipeline code)
  predCycle: false,   // streak exhaustion / pullback detector (OFF — handled by trajectory tax)
  predVolDamp: false, // volatility regime dampening (OFF)
  predCalib: false,   // calibration bias correction (OFF — let new 3-path system build fresh history)
  predVBeam: false,   // virtual candle beam emission in prediction zone (OFF)
  predVBeamStr: 0.5,  // VBeam intensity multiplier (0..1, slider-controlled)
  predTopo:  true,    // topological flow field forces (ridges, valleys, gradient)
  predCorridor: true, // slime mold corridor pathfinding (lookahead through topology)
  colorBiasForce: 0.25, // how strongly color bias (S/R polarity) pushes particles/corridors vertically
  predDistFade: false, // distance fade (OFF)
  predIntRev: true,   // intensity reversal: dampens/flips signal when beam brightness is unrealistic
  predMinStep: true,  // minimum step: ensures candles always move at least 30% of avg body

  // -- Topology overlay (visual verification, does NOT affect prediction) --
  showContours: false, // draw contour lines + ridge/valley/saddle markers
  contourFlow:  false, // draw sparse flow-direction arrows (noisy, off by default)
  contourFill:  false,  // draw greyscale elevation fill behind contour lines
  showCorridors: true,  // draw corridor pathfinding overlay (green dashed lines)
  showAttractorDebug: false, // draw particle attractor zones for visual verification

  // -- Indicator overlay visibility --
  // These just draw the lines on the chart for reference.
  // Independent of whether the indicator is used for prediction.
  showMA:  false,      // show SMA(20) line on chart
  showRSI: false,      // show RSI(14) as overlay (scaled to price range)
  showLSR: false,      // show least squares regression line

  // -- Zoom / Pan viewport --
  // All chart content (heatmap, candles, projection, topology, etc.)
  // is drawn through a ctx.translate + ctx.scale transform so you can
  // zoom in to inspect fine detail or pan rightward to explore the
  // projection zone beyond the default viewport.
  //
  // viewScale:   1.0 = no zoom, 2.0 = 2× magnification, etc.
  // viewOffsetX/Y: pan offset in logical (pre-DPR) pixels.
  //   Positive viewOffsetX shifts the chart content RIGHTWARD on screen,
  //   i.e. you see earlier candles. Negative shifts LEFT = see future.
  //
  // The background fill always covers the full canvas at 1:1 scale
  // BEFORE the zoom/pan transform is applied, so there's never an
  // uncovered gap.
  //
  // Controls:
  //   Scroll wheel         → zoom in/out centered on cursor
  //   Left-click drag      → pan (also middle-click drag)
  //   Double-click         → reset to 1× zoom, zero pan
  viewScale:    1.0,
  viewOffsetX:  0,
  viewOffsetY:  0,
};


// ----------------------------------------------------------------
// CACHES & RUNTIME REFS
// ----------------------------------------------------------------
// These persist across frames but get cleared when state changes.

var heatmapCache = {};          // key -> { grid, cols, rows }
var sightLineCache = {};        // key -> array of line objects
var bgSightLineCache = {};      // key -> sight lines from daily background data
var bgGridCache = {};           // key -> 4 Float32Arrays of background beam grids (Phase 1 perf optimization)
var particles    = {};          // asset key -> array of particle objects
var animFrameId  = null;        // requestAnimationFrame handle
var animTimerId  = null;        // setInterval handle for playback
var candleData   = {};          // asset key -> array of candle objects (visible)
var backgroundData = {};        // asset key -> array of daily candle objects (hidden context)
var canvas, ctx;                // set once on page load

// ----------------------------------------------------------------
// INCREMENTAL ANIMATION CACHE
// ----------------------------------------------------------------
// Pre-computed visibility pairs for the FULL candle dataset.
// The expensive O(n³) sight-line occlusion check runs once at
// animation start. Each animation frame then filters to the
// visible count and converts to pixel coords — O(n) instead of O(n³).
//
// Keyed by asset. Cleared when data source changes or animation resets.
var animPrecomputed = {};       // asset key -> { pairs, candles }
var animPriceRange  = {};       // asset key -> { priceMin, priceMax } locked at Play start

// ----------------------------------------------------------------
// PREDICTION CALIBRATION STORE
// ----------------------------------------------------------------
// Tracks per-distance accuracy: how well do we predict the candle
// 1 step ahead? 5 steps? 20 steps? Each distance has its own
// EMA-smoothed bias correction, direction accuracy, and error rate.
//
// The headline score is always the +1 candle prediction — because
// if the very next candle is wrong, you could get liquidated.
//
// Bias corrections are weighted by distance reliability: close
// predictions (d=1,2,3) are more accurate, so their corrections
// carry more weight. Distant corrections are applied gently.
//
// Keyed by asset. Resets when data source changes.

var calibration = {};  // asset key -> per-distance tracking state
