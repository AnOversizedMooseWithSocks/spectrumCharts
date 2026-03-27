/*
 * ================================================================
 * main.js  —  Draw Loop, Animation, Data Fetching, Initialization
 * ================================================================
 * Depends on: ALL other files (loaded last)
 *
 * This is the orchestrator. It ties everything together:
 *   - drawFrame(): the main render loop
 *   - Animation system (play/pause/scrub)
 *   - Canvas sizing (hi-DPI support)
 *   - Live data fetching from Binance
 *   - init(): runs once on page load
 * ================================================================
 */

// ================================================================
// CROSSHAIR / CURSOR TRACKING
// ================================================================
// Shows price and time at the mouse position. Updated on mousemove,
// drawn at the end of every frame. Stored in logical (pre-DPR)
// coordinates so the drawing code doesn't need to worry about scaling.

var crosshair = {
  x: -1,           // mouse X in logical coords (-1 = off canvas)
  y: -1,           // mouse Y in logical coords
  visible: false   // true when mouse is over the canvas
};

// Last-frame chart state, saved so drawCrosshair can map pixels to
// price/time without re-computing everything.
var lastFrameState = {
  dims: null,
  range: null,
  candles: null,
  assetKey: null,
  projDims: null
};

// Draw crosshair lines + price/time labels.
// Works in both the candle area and the projection zone.
// Called at the end of drawFrame() after all other rendering.
function drawCrosshair() {
  if (!crosshair.visible || !lastFrameState.dims) return;

  var dims     = lastFrameState.dims;
  var range    = lastFrameState.range;
  var candles  = lastFrameState.candles;
  var projDims = lastFrameState.projDims;
  var mx       = crosshair.x;
  var my       = crosshair.y;

  // ---- VISIBLE VIEWPORT in world coordinates ----
  // Since we're inside the zoom/pan transform, we need to know what
  // part of the world is actually on screen for positioning UI elements
  // (price labels, time pills) at the screen edges.
  var screenW = dims.screenW || dims.width;
  var screenH = dims.screenH || dims.height;
  var visLeftWorld   = -state.viewOffsetX / state.viewScale;
  var visRightWorld  = (screenW - state.viewOffsetX) / state.viewScale;
  var visTopWorld    = -state.viewOffsetY / state.viewScale;
  var visBotWorld    = (screenH - state.viewOffsetY) / state.viewScale;

  // Bounds check: the crosshair works anywhere in the world that has
  // chart data (the full world area, not just the screen-sized portion).
  if (mx < dims.chartLeft || mx > dims.width - 10) return;
  if (my < dims.chartTop  || my > dims.chartTop + dims.chartHeight) return;

  ctx.save();

  // Inverse scale: UI elements drawn at basePx * invS appear as
  // basePx on screen regardless of zoom level. Applied to text,
  // pill backgrounds, line widths — anything that should stay
  // at a fixed screen size rather than scaling with the chart.
  var invS = 1 / state.viewScale;

  // ---- HORIZONTAL LINE + PRICE LABEL ----
  // Line spans the visible portion of the chart (screen edges in world coords).
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 0.5 * invS;
  ctx.setLineDash([4 * invS, 4 * invS]);
  ctx.beginPath();
  ctx.moveTo(Math.max(dims.chartLeft, visLeftWorld), my);
  ctx.lineTo(visRightWorld - 4 * invS, my);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price label on the right axis — stays at visible screen edge
  if (range && my >= dims.chartTop && my <= dims.chartTop + dims.chartHeight) {
    var price = range.priceMax - ((my - dims.chartTop) / dims.chartHeight) * (range.priceMax - range.priceMin);
    var priceStr = price.toFixed(2);
    var pFontPx = Math.round(9 * invS);
    ctx.font = "bold " + pFontPx + "px monospace";
    var textW = ctx.measureText(priceStr).width;
    var pillX = visRightWorld - 62 * invS;
    var pillY = my - 7 * invS;
    var pillH = 14 * invS;
    ctx.fillStyle = "rgba(85,170,255,0.85)";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(pillX - 2 * invS, pillY - 1 * invS, textW + 8 * invS, pillH, 3 * invS);
    } else {
      ctx.rect(pillX - 2 * invS, pillY - 1 * invS, textW + 8 * invS, pillH);
    }
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(priceStr, pillX + 2 * invS, my + 3 * invS);
  }

  // ---- VERTICAL LINE + TIME LABEL ----
  // Line spans the visible vertical portion
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 0.5 * invS;
  ctx.setLineDash([4 * invS, 4 * invS]);
  ctx.beginPath();
  ctx.moveTo(mx, Math.max(dims.chartTop, visTopWorld));
  ctx.lineTo(mx, Math.min(dims.chartTop + dims.chartHeight, visBotWorld));
  ctx.stroke();
  ctx.setLineDash([]);

  // Figure out the candle interval from the data (for projection time estimates)
  var candleIntervalMs = 0;
  if (candles && candles.length >= 2 && candles[0].time && candles[1].time) {
    // Use median interval from last few candles (handles gaps in multi-res)
    var intervals = [];
    var sampleN = Math.min(10, candles.length - 1);
    for (var ii = candles.length - sampleN; ii < candles.length; ii++) {
      if (candles[ii].time && candles[ii - 1] && candles[ii - 1].time) {
        intervals.push(candles[ii].time - candles[ii - 1].time);
      }
    }
    if (intervals.length > 0) {
      intervals.sort(function(a, b) { return a - b; });
      candleIntervalMs = intervals[Math.floor(intervals.length / 2)];
    }
  }

  var timeStr = "";
  var candleW = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var inProjection = false;

  // The boundary where candles end and the future begins
  var candleRightEdge = dims.chartLeft + dims.chartWidth;
  if (candles && candles.length < CONFIG.CANDLE_COUNT) {
    candleRightEdge = dims.chartLeft + candles.length * candleW;
  }

  // ---- CANDLE AREA: map to historical candle ----
  if (mx >= dims.chartLeft && mx <= candleRightEdge && candles && candles.length > 0) {
    var candleIdx = Math.floor((mx - dims.chartLeft) / candleW);
    if (candleIdx < 0) candleIdx = 0;
    if (candleIdx >= candles.length) candleIdx = candles.length - 1;

    var c = candles[candleIdx];
    if (c && c.time) {
      var d = new Date(c.time);
      var mo  = d.getMonth() + 1;
      var day = d.getDate();
      var hr  = d.getHours();
      var min = d.getMinutes();
      timeStr = mo + "/" + day + " "
              + (hr < 10 ? "0" : "") + hr + ":"
              + (min < 10 ? "0" : "") + min;
    } else {
      timeStr = "candle " + (candleIdx + 1);
    }

  // ---- FUTURE AREA: anything past the last candle ----
  // This covers both the original projection zone AND the extended
  // world area beyond it. Uses the candle width to calculate how
  // many candle-intervals into the future the cursor is.
  } else if (mx > candleRightEdge) {
    inProjection = true;
    var projStep = Math.floor((mx - candleRightEdge) / candleW) + 1;

    if (candleIntervalMs > 0 && candles && candles.length > 0) {
      var lastTime = candles[candles.length - 1].time;
      if (lastTime) {
        var projTime = new Date(lastTime + projStep * candleIntervalMs);
        var pmo  = projTime.getMonth() + 1;
        var pday = projTime.getDate();
        var phr  = projTime.getHours();
        var pmin = projTime.getMinutes();
        timeStr = pmo + "/" + pday + " "
                + (phr < 10 ? "0" : "") + phr + ":"
                + (pmin < 10 ? "0" : "") + pmin
                + " (+" + projStep + ")";
      } else {
        timeStr = "+" + projStep + " candles";
      }
    } else {
      timeStr = "+" + projStep + " candles";
    }
  }

  // Draw the time pill at the bottom of the VISIBLE screen area
  if (timeStr) {
    var tFontPx = Math.round(8 * invS);
    ctx.font = "bold " + tFontPx + "px monospace";
    var timeW = ctx.measureText(timeStr).width;
    var timePillX = mx - timeW / 2 - 4 * invS;
    var timePillY = visBotWorld - 16 * invS;
    var timePillH = 13 * invS;
    // Blue for candle area, purple for future/projection
    ctx.fillStyle = inProjection
      ? "rgba(140,120,255,0.85)"
      : "rgba(85,170,255,0.85)";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(timePillX, timePillY, timeW + 8 * invS, timePillH, 3 * invS);
    } else {
      ctx.rect(timePillX, timePillY, timeW + 8 * invS, timePillH);
    }
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(timeStr, mx, timePillY + 10 * invS);
  }

  ctx.restore();
}


// ================================================================
// LOADING OVERLAY
// ================================================================
// Shows a spinner + message during expensive preprocessing steps
// (data fetching, sight-line computation, calibration, etc.)

function showLoading(msg) {
  var overlay = document.getElementById("loading-overlay");
  var msgEl   = document.getElementById("loading-msg");
  if (overlay) overlay.classList.add("visible");
  if (msgEl)   msgEl.textContent = msg || "Processing…";
}

function hideLoading() {
  var overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.classList.remove("visible");
}


// ================================================================
// ANIMATION SYSTEM
// ================================================================
// Progressively reveals candles from left to right, rebuilding
// all visualizations at each step.

// Returns the candles that should be visible based on animation state.
// If animCandles == 0, returns all candles (no animation / show all).
function getVisibleCandles(assetKey) {
  var all = candleData[assetKey];
  if (!state.animCandles || state.animCandles >= all.length) {
    return all;
  }
  return all.slice(0, state.animCandles);
}

// Start/stop playback
function togglePlay() {
  if (state.animating) {
    state.animating = false;
    if (animTimerId) { clearInterval(animTimerId); animTimerId = null; }
  } else {
    state.animating = true;
    if (!state.animCandles || state.animCandles >= CONFIG.CANDLE_COUNT) {
      state.animCandles = 5;
      // Starting a fresh run — reset calibration so the sparkline
      // and accuracy stats start clean for this run.
      calibration = {};
    }

    // ---- INCREMENTAL ANIMATION: Pre-compute visibility pairs ----
    // The O(n³) occlusion check runs ONCE here, at animation start.
    // During playback, each frame uses these cached pairs and only
    // does O(n) coordinate conversion — ~100x faster per frame.
    var assets = state.multiAsset ? ["BTC", "ETH", "SOL"] : [state.asset];
    for (var i = 0; i < assets.length; i++) {
      var ak = assets[i];
      // Only recompute if the candle data changed (new fetch, etc.)
      if (!animPrecomputed[ak] || animPrecomputed[ak].candles !== candleData[ak]) {
        console.time("precompute-" + ak);
        animPrecomputed[ak] = {
          pairs:   precomputeVisibilityPairs(candleData[ak]),
          candles: candleData[ak],  // reference for cache invalidation
        };
        console.timeEnd("precompute-" + ak);
      }
    }
    // ---- LOCK PRICE RANGE for the entire animation run ----
    // Uses the full dataset range so the chart is always fully zoomed out.
    //
    // NOTE: This is a COORDINATE SYSTEM choice, not prediction data.
    // Knowing the Y-axis spans $86-$92 doesn't tell the prediction
    // engine which direction to go. The real data-integrity fixes are:
    //   1. Intensity weights recomputed from visible candles (sightlines.js)
    //   2. Visibility pairs filtered to visibleCount
    //   3. MA/RSI computed from visible candles only
    // Those prevent actual future information from reaching predictions.
    for (var ri = 0; ri < assets.length; ri++) {
      var rk = assets[ri];
      if (candleData[rk] && candleData[rk].length > 0) {
        animPriceRange[rk] = getPriceRange(candleData[rk]);
      }
    }

    // Clear ALL caches when starting a fresh animation run.
    // Before pressing Play, the full chart was visible and all caches
    // (heatmap, sight lines, background grids) contain data computed
    // from all 234 candles. Even though cache keys include animCandles,
    // aggressively clearing ensures zero possibility of stale data.
    sightLineCache   = {};
    heatmapCache     = {};
    bgGridCache      = {};
    bgSightLineCache = {};

    // Force-clear WebGL offscreen canvases. These can retain stale
    // pixels from the full-chart render even after cache dicts are
    // cleared, because the GL contexts persist across frames.
    if (typeof glHeatmap !== "undefined" && glHeatmap.gl) {
      var ghgl = glHeatmap.gl;
      ghgl.clearColor(0, 0, 0, 0);
      ghgl.clear(ghgl.COLOR_BUFFER_BIT);
    }
    if (typeof glBeams !== "undefined" && glBeams.gl && glBeams.fbo) {
      var gbgl = glBeams.gl;
      gbgl.bindFramebuffer(gbgl.FRAMEBUFFER, glBeams.fbo);
      gbgl.clearColor(0, 0, 0, 0);
      gbgl.clear(gbgl.COLOR_BUFFER_BIT);
      gbgl.bindFramebuffer(gbgl.FRAMEBUFFER, null);
    }

    // Force an immediate redraw so the first frame uses clean data.
    // Without this, the stale full-chart render persists on-screen
    // until the first animTick fires (50ms later).
    cancelAnim();

    // ---- CALIBRATE INDICATOR PHYSICS from background data ----
    // Runs once at animation start. Uses the daily/4h/1h background
    // candles (completely separate from the visible chart) to derive
    // MA spring constants, RSI dead zones, and relative weights.
    // These parameters are LOCKED for the entire animation run.
    if (typeof runCalibration === "function") {
      var calAsset = state.multiAsset ? "SOL" : state.asset;
      runCalibration(calAsset);
    }

    drawFrame();

    animTimerId = setInterval(animTick, 1000 / state.animSpeed);
  }
  updateToolbar();
}

// Reset to show all candles
function resetAnim() {
  state.animating = false;
  state.animCandles = 0;
  if (animTimerId) { clearInterval(animTimerId); animTimerId = null; }
  heatmapCache     = {};
  sightLineCache   = {};
  bgGridCache      = {};
  bgSightLineCache = {};
  animPrecomputed  = {};
  animPriceRange   = {};
  particles        = {};
  // NOTE: calibration is intentionally NOT cleared here.
  // It was built during the animation playthrough and should persist
  // so projection paths and corridors remain accurate in static view.
  // Calibration only resets when data changes (new fetch, generated
  // data, or user starts a fresh animation run from candle 5).

  // Clear WebGL offscreen canvases
  if (typeof glHeatmap !== "undefined" && glHeatmap.gl) {
    glHeatmap.gl.clearColor(0, 0, 0, 0);
    glHeatmap.gl.clear(glHeatmap.gl.COLOR_BUFFER_BIT);
  }
  if (typeof glBeams !== "undefined" && glBeams.gl && glBeams.fbo) {
    glBeams.gl.bindFramebuffer(glBeams.gl.FRAMEBUFFER, glBeams.fbo);
    glBeams.gl.clearColor(0, 0, 0, 0);
    glBeams.gl.clear(glBeams.gl.COLOR_BUFFER_BIT);
    glBeams.gl.bindFramebuffer(glBeams.gl.FRAMEBUFFER, null);
  }

  updateToolbar();
  updateProgress();
  cancelAnim();
  drawFrame();
}

// Set playback speed
function setAnimSpeed(val) {
  state.animSpeed = val;
  var el = document.getElementById("speed-val");
  if (el) el.textContent = val + "/s";
  if (state.animating && animTimerId) {
    clearInterval(animTimerId);
    animTimerId = setInterval(animTick, 1000 / state.animSpeed);
  }
}

// Scrub to a specific candle position
function scrubAnim(val) {
  state.animCandles = val;
  heatmapCache     = {};
  sightLineCache   = {};
  bgGridCache      = {};
  bgSightLineCache = {};
  particles        = {};

  // Clear WebGL offscreen canvases
  if (typeof glHeatmap !== "undefined" && glHeatmap.gl) {
    glHeatmap.gl.clearColor(0, 0, 0, 0);
    glHeatmap.gl.clear(glHeatmap.gl.COLOR_BUFFER_BIT);
  }
  if (typeof glBeams !== "undefined" && glBeams.gl && glBeams.fbo) {
    glBeams.gl.bindFramebuffer(glBeams.gl.FRAMEBUFFER, glBeams.fbo);
    glBeams.gl.clearColor(0, 0, 0, 0);
    glBeams.gl.clear(glBeams.gl.COLOR_BUFFER_BIT);
    glBeams.gl.bindFramebuffer(glBeams.gl.FRAMEBUFFER, null);
  }

  updateProgress();
  cancelAnim();
  drawFrame();
}

// One animation step: add a candle and redraw
function animTick() {
  if (!state.animCandles) state.animCandles = 5;
  state.animCandles++;

  if (state.animCandles >= CONFIG.CANDLE_COUNT) {
    state.animCandles = CONFIG.CANDLE_COUNT;
    state.animating = false;
    if (animTimerId) { clearInterval(animTimerId); animTimerId = null; }
    updateToolbar();
  }

  // Only clear heatmap cache (rebuilt each frame from sight-line data).
  // Sight line cache is NOT cleared — each frame either hits a cached
  // entry or builds one quickly via pre-computed visibility pairs.
  heatmapCache = {};
  particles = {};
  updateProgress();
  cancelAnim();
  drawFrame();
}

// Update the progress slider and label
function updateProgress() {
  var total = CONFIG.CANDLE_COUNT;
  var current = state.animCandles || total;
  var slider = document.getElementById("progress-slider");
  if (slider) {
    slider.max = total;
    slider.value = current;
  }
  var label = document.getElementById("progress-val");
  if (label) label.textContent = current + "/" + total;
}


// ================================================================
// ZOOM / PAN RESET
// ================================================================
// Called when switching data sources or other major state changes
// where the old zoom/pan position wouldn't make sense anymore.

function resetZoom() {
  state.viewScale = 1.0;
  var home = getHomeOffset();
  state.viewOffsetX = home.x;
  state.viewOffsetY = home.y;
}


// ================================================================
// MAIN DRAW LOOP
// ================================================================
// Called once for raycast/sightlines mode (static image) or
// every frame for particle mode (animated).

function drawFrame() {
  var _t0 = performance.now();
  var _tSL = 0, _tHM = 0, _tProj = 0;
  var dims = getChartDims();
  var screenW = dims.screenW || dims.width;
  var screenH = dims.screenH || dims.height;

  // Clear the canvas at 1:1 logical scale (BEFORE zoom/pan transform).
  // This ensures the background covers the screen edges regardless
  // of how far you've zoomed or panned.
  ctx.fillStyle = CONFIG.BG;
  ctx.fillRect(0, 0, screenW, screenH);

  // ---- ZOOM / PAN TRANSFORM ----
  // Apply the viewport transform so all subsequent drawing (candles,
  // heatmap, projection, topology, crosshair, labels — everything)
  // is rendered through the zoom/pan lens. The ctx.save() here pairs
  // with a ctx.restore() at the very end of drawFrame.
  ctx.save();
  ctx.translate(state.viewOffsetX, state.viewOffsetY);
  ctx.scale(state.viewScale, state.viewScale);

  // Fill the full WORLD area with background inside the transform.
  // This covers the extended projection zone that becomes visible
  // when panning right — those areas weren't covered by the
  // pre-transform screen fill.
  ctx.fillStyle = CONFIG.BG;
  ctx.fillRect(0, 0, dims.width, dims.height);

  // Which assets are we rendering?
  var assetsToRender = state.multiAsset ? ["BTC", "ETH", "SOL"] : [state.asset];

  for (var ai = 0; ai < assetsToRender.length; ai++) {
    var assetKey = assetsToRender[ai];
    var candles  = getVisibleCandles(assetKey);
    var colors   = CONFIG.ASSET_COLORS[assetKey];
    // During animation, use the progressive price range that only
    // expands as new candles are revealed. This prevents future price
    // data from leaking into the coordinate system.
    var range = (state.animating && animPriceRange[assetKey])
      ? animPriceRange[assetKey]
      : getPriceRange(candles);

    // Save for crosshair overlay (last asset wins in multi-asset mode)
    lastFrameState.range = range;
    lastFrameState.candles = candles;
    lastFrameState.assetKey = assetKey;

    // --- Draw grid lines (only once, behind everything) ---
    if (ai === 0) {
      if (!state.multiAsset) {
        drawGrid(dims, range.priceMin, range.priceMax);
      } else {
        ctx.strokeStyle = CONFIG.GRID_COLOR;
        for (var gi = 1; gi < 6; gi++) {
          var gy = dims.chartTop + (dims.chartHeight / 6) * gi;
          ctx.beginPath();
          ctx.moveTo(dims.chartLeft, gy);
          ctx.lineTo(dims.chartLeft + dims.chartWidth, gy);
          ctx.stroke();
        }
      }
    }

    // ---------------------------------------------------------------
    // STEP 1: Build sight-line data (needed by raycast, sightlines,
    //         heatmap, AND particle mode — particles use the topology
    //         derived from the heatmap grids to flow through the
    //         pressure landscape).
    //
    //         INCREMENTAL: When pre-computed visibility pairs exist
    //         (from togglePlay or preprocessChart), uses the fast O(n)
    //         path instead of the full O(n³) computation.
    // ---------------------------------------------------------------
    var slCacheKey = assetKey + "-sl-" + state.slMacroAngle + "-" + state.intensityMode + "-" + state.beamSpread + "-" + (state.animCandles || "all");
    var slData = null;
    var needsHeatmap = state.mode === "raycast"
                    || state.mode === "particle"
                    || (state.showProjection && state.mode !== "particle");
    var needsSightLines = state.mode === "sightlines" || needsHeatmap;

    if (needsSightLines) {
      if (!sightLineCache[slCacheKey]) {
        // Check for pre-computed visibility pairs (from animation start).
        // If available, skip the O(n³) occlusion check entirely.
        var precomp = animPrecomputed[assetKey];
        if (precomp && precomp.candles === candleData[assetKey]) {
          // FAST PATH: O(n) coordinate conversion + ray extension
          sightLineCache[slCacheKey] = buildSightLinesFromPairs(
            precomp.pairs, candles, dims, candles.length, range
          );
        } else {
          // FULL PATH: O(n³) computation (used for static view, no animation)
          sightLineCache[slCacheKey] = buildSightLines(candles, dims, range);
        }
      }
      slData = sightLineCache[slCacheKey];
    }
    var _tSL = performance.now();

    // ---------------------------------------------------------------
    // STEP 2: Build heatmap (for raycast mode).
    //         SKIP in particle mode — the heatmap grids are only
    //         used by the raycast renderer and the projection engine.
    //         When projection is on AND we're in particle mode,
    //         neither consumer is active, so don't pay the cost.
    // ---------------------------------------------------------------
    var hmData = null;
    if (needsHeatmap) {
      var cacheKey = assetKey + "-" + state.heatmapRes + "-"
        + state.translucency.toFixed(2) + "-" + state.intensityMode + "-"
        + state.beamLenBoost.toFixed(2) + "-" + (state.animCandles || "all")
        + "-ro" + (state.raysOnly ? "1" : "0");

      if (!heatmapCache[cacheKey]) {
        heatmapCache[cacheKey] = buildHeatmap(
          candles, dims, state.heatmapRes, assetKey, slData, range
        );

        // During animation, drop old frames to save memory
        if (state.animating && state.animCandles > 5) {
          var oldKey = assetKey + "-" + state.heatmapRes + "-"
            + state.translucency.toFixed(2) + "-" + state.intensityMode + "-"
            + state.beamLenBoost.toFixed(2) + "-" + (state.animCandles - 2)
            + "-ro" + (state.raysOnly ? "1" : "0");
          delete heatmapCache[oldKey];
        }
      }

      if (state.showProjection && state.predVBeam) {
        // V.Beams ON: Clone grids so projection's virtual beams
        // don't pollute the cache. Only needed when projection
        // actually WRITES into the grids (paintBeam calls).
        var baseHm = heatmapCache[cacheKey];
        var clonedGrids = [];
        for (var cgi = 0; cgi < baseHm.grids.length; cgi++) {
          clonedGrids.push(new Float32Array(baseHm.grids[cgi]));
        }
        hmData = {
          grids: clonedGrids,
          cols: baseHm.cols,
          rows: baseHm.rows,
          occGrid: baseHm.occGrid,
          paintBeam: baseHm.paintBeam,
        };
      } else {
        // V.Beams OFF or no projection: use cached grids directly.
        // Projection only READS from grids (sampleForce), never writes.
        hmData = heatmapCache[cacheKey];
      }
    }
    var _tHM = performance.now();

    // ---------------------------------------------------------------
    // STEP 3: Build projection FROM the heatmap light grids.
    //         The four color grids are the force field: green/blue
    //         push price up, yellow/red push price down. Position
    //         relative to the particle determines barrier vs magnet.
    // ---------------------------------------------------------------
    var projDims = null;
    var projData = null;
    lastFrameState.projDims = null;
    if (state.showProjection && hmData) {
      projDims = getProjectionDims(dims, candles.length);
      lastFrameState.projDims = projDims;
      if (projDims) {
        projData = buildProjection(hmData, state.heatmapRes, candles, dims, projDims,
                                   range.priceMin, range.priceMax, assetKey);
      }
    }
    var _tProj = performance.now();

    // ---------------------------------------------------------------
    // STEP 4: Mode-specific visualization
    // ---------------------------------------------------------------

    // --- RAYCAST MODE: render the heatmap ---
    // Rendered AFTER projection so virtual candle beams (painted into
    // the grids by buildProjection) are visible on screen.
    if (state.mode === "raycast" && hmData) {
      renderHeatmap(
        hmData,
        state.multiAsset ? colors.heatHi : null
      );
    }

    // --- PARTICLE MODE (step physics — rendering happens after overlays) ---
    var particleTopo = null;
    if (state.mode === "particle") {
      if (!particles[assetKey]) {
        particles[assetKey] = createParticles();
      }

      var maxP = state.multiAsset
        ? Math.floor(CONFIG.PARTICLE_COUNT / 3)
        : CONFIG.PARTICLE_COUNT;

      // Only emit new particles when animation is paused.
      if (!state.animating) {
        emitParticles(particles[assetKey], candles, dims, maxP);
      }

      var crossForces = null;
      if (state.multiAsset) {
        crossForces = [];
        for (var oi = 0; oi < assetsToRender.length; oi++) {
          var otherKey = assetsToRender[oi];
          if (otherKey === assetKey) continue;
          var otherForces = computeCrossForces(
            candleData[otherKey], dims, CONFIG.MCAP[otherKey]
          );
          for (var fi = 0; fi < otherForces.length; fi++) {
            crossForces.push(otherForces[fi]);
          }
        }
      }

      // Compute topology from the heatmap grids
      if (hmData && typeof computeTopology === "function") {
        particleTopo = computeTopology(hmData.grids, hmData.cols, hmData.rows, state.colorForce);
      }

      particles[assetKey] = stepParticles(
        particles[assetKey], candles, dims, crossForces, particleTopo, state.heatmapRes
      );
    }

    // --- SIGHT LINES MODE ---
    if (state.mode === "sightlines" && slData) {
      renderSightLines(
        slData,
        state.multiAsset ? colors.candle : null
      );
    }

    // --- CONTOUR OVERLAY (topology visualization) ---
    // Renders contour lines, ridge/valley markers, saddle points, and
    // optional flow arrows from the topological analysis. Available in
    // both raycast and particle modes (where the heatmap grids exist).
    //
    // During animation, contours only extend as far as the light field
    // reaches from the currently visible candles. They grow outward as
    // more candles are revealed — this is correct behavior, not a bug.
    //
    // When projection is on, reuses the topology already computed inside
    // buildProjection. When projection is off, computes it standalone
    // from the heatmap grids so you can visualize the terrain independently.
    if ((state.showContours || state.contourFill) && (state.mode === "raycast" || state.mode === "particle") && hmData) {
      var contourTopo = (projData && projData.topology)
        ? projData.topology
        : (typeof computeTopology === "function")
          ? computeTopology(hmData.grids, hmData.cols, hmData.rows, state.colorForce)
          : null;

      if (contourTopo) {
        renderContours(ctx, contourTopo, state.heatmapRes, 5, {
          showRidges:  true,
          showValleys: true,
          showSaddles: true,
          showFlow:    state.contourFlow,
          showFill:    state.contourFill
        });
      }
    }

    // --- CORRIDOR PATHFINDING OVERLAY ---
    // Shows where the slime mold corridor tracer found paths of
    // least resistance. Green dashed line = corridor center.
    //
    // CALIBRATION GATE: Only render corridors and projection paths
    // after an animation playthrough has built enough calibration data.
    // Without it, the prediction pipeline is untrained: no temporal
    // smoothing (needs 3 prior frames), no accuracy history, no
    // scenario weighting. Showing those paths would be misleading
    // because they'd change after playthrough.
    var isCalibrated = calibration[assetKey]
      && calibration[assetKey].prevConsensusPrices !== null
      && calibration[assetKey].totalSamples >= 3;

    if (isCalibrated && state.showCorridors && projData && projData.corridorData
        && typeof renderCorridors === "function") {
      renderCorridors(ctx, projData.corridorData, state.heatmapRes);
    }

    // --- PARTICLE RENDERING (after all overlays so particles are visible) ---
    if (state.mode === "particle" && particles[assetKey]) {
      // Draw trails first on the 2D canvas (inside zoom/pan transform)
      renderParticleTrails(particles[assetKey]);

      // Then draw particle dots (GPU instanced or 2D fallback)
      if (window._useGLParticlesInstanced) {
        renderParticlesInstanced(particles[assetKey], ctx, canvas,
          state.viewScale, state.viewOffsetX, state.viewOffsetY);
      } else {
        renderParticles(particles[assetKey]);
      }
    }

    // --- CANDLES (drawn on top of the visualization) ---
    if (state.showCandles) {
      var candleAlpha;
      if (state.mode === "raycast") {
        candleAlpha = 0.35;
      } else if (state.mode === "sightlines") {
        candleAlpha = 0.8;
      } else {
        candleAlpha = 0.5;
      }
      var upCol   = state.multiAsset ? colors.candle : CONFIG.CANDLE_UP;
      var downCol = state.multiAsset ? colors.candle : CONFIG.CANDLE_DOWN;
      drawCandles(
        candles, dims, range.priceMin, range.priceMax,
        upCol, downCol,
        state.multiAsset ? 0.25 : candleAlpha
      );
    }

    // --- INDICATOR OVERLAYS (MA, RSI, LSR lines) ---
    if (state.showMA || state.showRSI || state.showLSR) {
      drawIndicatorOverlays(candles, dims, range.priceMin, range.priceMax);
    }

    // --- PROJECTION ZONE (overlay graphics: paths, histogram, labels) ---
    if (projData && projDims) {
      if (isCalibrated) {
        renderProjection(projData, dims, projDims, range.priceMin, range.priceMax);
      } else {
        // Show the projection zone background but with a hint
        // that calibration is needed. Keeps the zone visible so
        // the user knows it's there, without showing misleading paths.
        var invS = 1 / state.viewScale;
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.font = Math.round(11 * invS) + "px monospace";
        ctx.textAlign = "center";
        var hintX = projDims.startX + (projDims.endX - projDims.startX) / 2;
        var hintY = dims.chartTop + dims.chartHeight / 2;
        ctx.fillText("▶ Play to calibrate", hintX, hintY);
        ctx.restore();
      }
    }

    // Asset label in multi-asset mode
    if (state.multiAsset) {
      var maInvS = 1 / state.viewScale;
      ctx.fillStyle = colors.candle;
      ctx.font      = "bold " + Math.round(12 * maInvS) + "px monospace";
      ctx.textAlign = "left";
      ctx.fillText(assetKey, dims.chartLeft + 6 + ai * 60, dims.chartTop + 16 * maInvS);
    }
  }

  // Save chart state for crosshair overlay (uses last-rendered asset)
  lastFrameState.dims = dims;

  // Inverse scale for UI text that should stay at constant screen size
  var invS = 1 / state.viewScale;

  // --- Labels for single-asset mode ---
  if (!state.multiAsset) {
    var singleRange = getPriceRange(candleData[state.asset]);
    ctx.fillStyle = CONFIG.TEXT_COLOR;
    ctx.font      = "bold " + Math.round(13 * invS) + "px monospace";
    ctx.textAlign = "left";
    ctx.fillText(state.asset + "/USD", dims.chartLeft + 6, dims.chartTop + 16 * invS);

    ctx.font = Math.round(11 * invS) + "px monospace";
    ctx.fillText(
      singleRange.priceMin.toFixed(2) + " – " + singleRange.priceMax.toFixed(2),
      dims.chartLeft + 6, dims.chartTop + 30 * invS
    );
  }

  // --- Mode watermark ---
  // Position at the visible screen bottom-right (inside transform,
  // so we inverse-transform the screen coordinates to world space).
  var wmX = (screenW - state.viewOffsetX) / state.viewScale - 70 * invS;
  var wmY = (screenH - state.viewOffsetY) / state.viewScale - 8 * invS;
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.font      = Math.round(10 * invS) + "px monospace";
  ctx.textAlign = "right";
  ctx.fillText(
    state.mode === "raycast" ? "RAYCAST / BEAM PRESSURE" :
    state.mode === "sightlines" ? "SIGHT LINES / LINE OF SIGHT" :
    "TERRAIN FLOW [" + (particles[state.asset] ? particles[state.asset].length : 0) + " particles]",
    wmX, wmY
  );

  // Keep animating in particle mode
  if (state.mode === "particle") {
    animFrameId = requestAnimationFrame(drawFrame);
  }

  // ---- Crosshair overlay (cursor price/time) ----
  // Drawn INSIDE the zoom/pan transform so crosshair lines
  // align with the chart content at any zoom level.
  drawCrosshair();

  // ---- END ZOOM / PAN TRANSFORM ----
  // Restore to the base DPR-only transform so the zoom indicator
  // is always drawn at a fixed screen position and size.
  ctx.restore();

  // ---- Zoom indicator (drawn at screen-level, outside transform) ----
  // Shows current zoom level and a hint about how to reset.
  // Only visible when zoomed/panned away from the home position.
  var home = getHomeOffset();
  var isAtHome = state.viewScale === 1.0
              && Math.abs(state.viewOffsetX - home.x) < 1
              && Math.abs(state.viewOffsetY - home.y) < 1;
  if (!isAtHome) {
    var zoomStr = state.viewScale.toFixed(1) + "×";
    ctx.save();
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "left";
    // Background pill — positioned at bottom of SCREEN, not world
    var indicatorY = screenH - 26;
    var zw = ctx.measureText(zoomStr + "  drag=pan dblclick=reset").width + 12;
    ctx.fillStyle = "rgba(85,170,255,0.2)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(8, indicatorY, zw, 18, 4);
    else ctx.rect(8, indicatorY, zw, 18);
    ctx.fill();
    // Text
    ctx.fillStyle = "#7bc4ff";
    ctx.fillText(zoomStr, 14, indicatorY + 14);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "9px monospace";
    ctx.fillText("drag=pan dblclick=reset", 14 + ctx.measureText(zoomStr).width + 8, indicatorY + 14);
    ctx.restore();
  }

  // Keep toolbar zoom indicator in sync with state
  updateZoomIndicator();

  // ---- Performance timing breakdown ----
  var _tEnd = performance.now();
  var _total = _tEnd - _t0;
  if (_total > 500) {  // only log if frame took > 500ms
    console.log("[drawFrame] TOTAL: " + _total.toFixed(0) + "ms"
      + " | SL: " + ((_tSL || _t0) - _t0).toFixed(0)
      + " | HM: " + ((_tHM || _tSL || _t0) - (_tSL || _t0)).toFixed(0)
      + " | Proj: " + ((_tProj || _tHM || _t0) - (_tHM || _tSL || _t0)).toFixed(0)
      + " | Render: " + (_tEnd - (_tProj || _tHM || _t0)).toFixed(0));
  }
}


// ================================================================
// CANVAS SIZING
// ================================================================
// Handles high-DPI (retina) displays by scaling the canvas buffer
// while keeping CSS size matched to the container.

function resizeCanvas() {
  var container = document.getElementById("canvas-wrap");
  var w   = container.clientWidth;
  var h   = container.clientHeight;
  // Force at least 2x render scale for crisp candles and shadows
  var dpr = Math.max(2, window.devicePixelRatio || 1);

  canvas.width  = w * dpr;
  canvas.height = h * dpr;

  canvas.style.width  = w + "px";
  canvas.style.height = h + "px";

  ctx.scale(dpr, dpr);

  // Store logical dimensions for our drawing code
  canvas.logicalWidth  = w;
  canvas.logicalHeight = h;

  // Caches are invalid after resize
  heatmapCache     = {};
  sightLineCache   = {};
  bgSightLineCache = {};
  bgGridCache      = {};
  particles        = {};
}



// ================================================================
// LIVE DATA FETCHING (Binance API)
// ================================================================
// Pulls real OHLCV candle data from Binance's public REST API.
// No API key required. Uses api.binance.us as primary (required
// for US users) with api.binance.com as fallback.
//
// Binance /api/v3/klines returns native OHLCV at any interval:
//   1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w
//
// Each kline includes: open time, OHLC, volume, close time,
// quote volume, trade count, taker buy base/quote volume.
// This gives us real buyPressure (taker buy ratio) — far more
// accurate than estimating from candle direction.
//
// Rate limit: 1200 requests/min (very generous). We add 300ms
// delays between calls to be polite.

var BINANCE_SYMBOLS = {
  SOL: "SOLUSDT",
  ETH: "ETHUSDT",
  BTC: "BTCUSDT",
};

// Try .us first (required for US users), fall back to .com
var BINANCE_BASES = [
  "https://api.binance.us",
  "https://api.binance.com",
];

// Which base URL worked last — avoids retrying the wrong one each call
var binanceBaseIdx = 0;

// Maps range selector values to Binance kline parameters.
//   interval: Binance kline interval string
//   limit:    how many candles to fetch
//   label:    human-readable for status display
var RANGE_MAP = {
  "1":      { interval: "5m",  limit: 288,  label: "24h × 5m" },
  "1-15m":  { interval: "15m", limit: 96,   label: "24h × 15m" },
  "multi":  { interval: null,  limit: null,  label: "30d Multi-Res" },
  "7-1h":   { interval: "1h",  limit: 168,  label: "7d × 1h" },
  "7":      { interval: "4h",  limit: 42,   label: "7d × 4h" },
  "14-1h":  { interval: "1h",  limit: 336,  label: "14d × 1h" },
  "14":     { interval: "4h",  limit: 84,   label: "14d × 4h" },
  "30":     { interval: "4h",  limit: 180,  label: "30d × 4h" },
  "90":     { interval: "1d",  limit: 90,   label: "90d × 1d" },
};


// ================================================================
// LOCALSTORAGE PERSISTENCE
// ================================================================
// Stores fetched candle data so page reloads don't require fresh
// API calls if the cached data is still within its freshness window.
//
// Structure: binanceCache[symbol][cacheKey] = {
//   candles:   [...],          // parsed candle objects
//   fetchedAt: timestamp_ms,   // when the data was fetched
// }
//
// Key: "spectrum_cache"

var binanceCache = {};
var BN_STORAGE_KEY = "spectrum_cache";

// Save the current in-memory cache to localStorage.
// Called after every successful API fetch.
function saveCacheToStorage() {
  try {
    localStorage.setItem(BN_STORAGE_KEY, JSON.stringify(binanceCache));
  } catch (e) {
    // localStorage full or unavailable — in-memory cache still works
    console.warn("[cache] localStorage save failed:", e.message || e);
  }
}

// Load cached data from localStorage into the in-memory cache.
// Called once at startup, before any fetch decisions.
// Returns the number of symbol entries loaded (0 = nothing cached).
function loadCacheFromStorage() {
  try {
    var stored = localStorage.getItem(BN_STORAGE_KEY);
    if (!stored) return 0;

    var parsed = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return 0;

    var loaded = 0;
    var symbols = Object.keys(parsed);
    for (var i = 0; i < symbols.length; i++) {
      var sym = symbols[i];
      var entries = parsed[sym];
      if (typeof entries !== "object" || entries === null) continue;

      binanceCache[sym] = {};
      var keys = Object.keys(entries);
      for (var j = 0; j < keys.length; j++) {
        var entry = entries[keys[j]];
        if (entry && entry.candles && typeof entry.fetchedAt === "number") {
          binanceCache[sym][keys[j]] = entry;
        }
      }
      loaded++;
    }

    if (loaded > 0) {
      console.log("[cache] Loaded " + loaded + " symbols from localStorage");
    }
    return loaded;
  } catch (e) {
    console.warn("[cache] localStorage load failed:", e.message || e);
    return 0;
  }
}

// How long cached data stays fresh, based on candle interval.
// No point re-fetching 4h candles every 5 minutes.
function getFreshnessMinutes(interval) {
  switch (interval) {
    case "1m": case "3m": case "5m":  return 5;
    case "15m": case "30m":           return 15;
    case "1h": case "2h":             return 30;
    case "4h": case "6h": case "8h":  return 120;
    case "12h": case "1d":            return 240;
    default:                          return 60;
  }
}

function cacheIsFresh(entry, interval) {
  if (!entry || !entry.candles || !entry.fetchedAt) return false;
  var maxAgeMs = getFreshnessMinutes(interval) * 60 * 1000;
  return (Date.now() - entry.fetchedAt) < maxAgeMs;
}


// ================================================================
// BINANCE FETCH HELPERS
// ================================================================

// Fetch JSON from Binance. Tries api.binance.us first, then
// falls back to api.binance.com. Remembers which worked last
// so subsequent calls don't waste time on the failing endpoint.
async function binanceFetch(path) {
  for (var attempt = 0; attempt < BINANCE_BASES.length; attempt++) {
    var idx = (binanceBaseIdx + attempt) % BINANCE_BASES.length;
    var url = BINANCE_BASES[idx] + path;
    try {
      var resp = await fetch(url);
      if (resp.ok) {
        binanceBaseIdx = idx;  // remember which worked
        return await resp.json();
      }
      if (resp.status === 429) {
        var statusEl = document.getElementById("data-status");
        if (statusEl) {
          statusEl.textContent = "Rate limited — wait a moment and retry";
          statusEl.style.color = "#ff6040";
        }
        return null;
      }
      // Non-OK, non-429: try next base URL
      console.warn("Binance " + resp.status + " from " + BINANCE_BASES[idx]);
    } catch (e) {
      // Network error: try next base URL
      console.warn("Binance fetch error from " + BINANCE_BASES[idx] + ":", e.message || e);
    }
  }
  console.warn("Binance fetch failed for all endpoints: " + path);
  return null;
}

// Fetch klines for one symbol at one interval.
// Returns array of our internal candle objects, or null on failure.
async function fetchKlines(symbol, interval, limit) {
  var path = "/api/v3/klines?symbol=" + symbol
           + "&interval=" + interval
           + "&limit=" + limit;
  var data = await binanceFetch(path);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  return parseBinanceKlines(data);
}

// Convert Binance kline arrays to our internal candle format.
//
// Binance kline layout:
//   [0] openTime       [1] open     [2] high     [3] low      [4] close
//   [5] volume         [6] closeTime  [7] quoteAssetVolume
//   [8] numberOfTrades [9] takerBuyBaseVolume  [10] takerBuyQuoteVolume
//
// buyPressure is computed from taker buy volume / total volume.
// This is real exchange data — much more accurate than estimating
// from candle direction (which was all CoinGecko could offer).
function parseBinanceKlines(klines) {
  var candles = [];
  for (var i = 0; i < klines.length; i++) {
    var k = klines[i];
    var vol      = parseFloat(k[5]);
    var takerBuy = parseFloat(k[9]);

    // Real buy pressure from taker buy volume ratio.
    // Clamp to 0.05..0.95 to avoid degenerate extremes.
    var bp = vol > 0 ? takerBuy / vol : 0.5;
    if (bp < 0.05) bp = 0.05;
    if (bp > 0.95) bp = 0.95;

    candles.push({
      o:           parseFloat(k[1]),
      h:           parseFloat(k[2]),
      l:           parseFloat(k[3]),
      c:           parseFloat(k[4]),
      v:           vol,
      qv:          parseFloat(k[7]),
      trades:      parseInt(k[8], 10),
      buyPressure: bp,
      time:        k[0],   // open timestamp in ms
    });
  }
  return candles;
}

// Small delay between API calls to be polite.
// Binance allows 1200/min but there's no need to hammer.
function apiDelay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}


// ================================================================
// MAIN FETCH FUNCTION
// ================================================================
// Fetches OHLCV candles + daily background for all three assets.
// One Binance /klines call per asset per resolution — no synthesis,
// no merging, no separate volume fetch. Much simpler than CoinGecko.

async function fetchLive() {
  stopLiveTicker();
  var statusEl = document.getElementById("data-status");
  var rawRange = document.getElementById("interval-select").value;
  var rangeInfo = RANGE_MAP[rawRange];

  if (!rangeInfo) {
    statusEl.textContent = "Unknown range: " + rawRange;
    statusEl.style.color = "#ff6040";
    return;
  }

  statusEl.textContent = "Fetching from Binance...";
  statusEl.style.color = "#5af";
  showLoading("Fetching live data…");

  var success = true;
  var assets = ["SOL", "ETH", "BTC"];
  var isMultiRes = (rawRange === "multi");

  // ================================================================
  // Phase 1: FETCH CANDLE DATA
  // ================================================================

  for (var i = 0; i < assets.length; i++) {
    var assetKey = assets[i];
    var symbol = BINANCE_SYMBOLS[assetKey];

    if (isMultiRes) {
      // ---- MULTI-RES: stitch 4h + 1h + 15m ----
      // Three calls per asset, each at a native Binance interval.
      // No synthesis needed — Binance gives us real candles at each.
      showLoading("Fetching " + assetKey + " (multi-res)…");
      statusEl.textContent = "Fetching " + assetKey + " (4h)...";
      var layer4h = await fetchKlines(symbol, "4h", 180);
      await apiDelay(300);

      statusEl.textContent = "Fetching " + assetKey + " (1h)...";
      var layer1h = await fetchKlines(symbol, "1h", 168);
      await apiDelay(300);

      statusEl.textContent = "Fetching " + assetKey + " (15m)...";
      var layer15m = await fetchKlines(symbol, "15m", 96);
      await apiDelay(300);

      // Stitch: trim overlaps, keep latest data at finest resolution
      if (layer4h && layer1h && layer15m) {
        var cutoff1h  = layer1h[0].time;
        var cutoff15m = layer15m[0].time;

        var trimmed4h = layer4h.filter(function(c) { return c.time < cutoff1h; });
        var trimmed1h = layer1h.filter(function(c) { return c.time < cutoff15m; });

        candleData[assetKey] = trimmed4h.concat(trimmed1h).concat(layer15m);
      } else {
        // Partial success — use whatever we got
        candleData[assetKey] = layer15m || layer1h || layer4h;
        if (!candleData[assetKey]) success = false;
      }

    } else {
      // ---- SINGLE RESOLUTION ----
      // Check cache first, then fetch if stale
      var cacheKey = symbol + "_" + rangeInfo.interval + "_" + rangeInfo.limit;
      if (!binanceCache[symbol]) binanceCache[symbol] = {};
      var cached = binanceCache[symbol][cacheKey];

      if (cacheIsFresh(cached, rangeInfo.interval)) {
        candleData[assetKey] = cached.candles;
      } else {
        showLoading("Fetching " + assetKey + " (" + rangeInfo.interval + ")…");
        statusEl.textContent = "Fetching " + assetKey + " (" + rangeInfo.interval + ")...";

        var klines = await fetchKlines(symbol, rangeInfo.interval, rangeInfo.limit);
        await apiDelay(300);

        if (klines && klines.length > 0) {
          candleData[assetKey] = klines;
          binanceCache[symbol][cacheKey] = {
            candles: klines,
            fetchedAt: Date.now(),
          };
          saveCacheToStorage();
        } else {
          statusEl.textContent = "No data for " + assetKey;
          statusEl.style.color = "#ff6040";
          success = false;
        }
      }
    }
  }

  // ---- Gap-fill: ensure no time discontinuities ----
  // Binance data is usually clean, but exchange outages or
  // de-listings can create gaps. Fill them with flat candles
  // so the chart/physics systems never see discontinuities.
  var bnExpectedMs = isMultiRes ? 0 : intervalToMs(rangeInfo.interval);
  for (var gi = 0; gi < assets.length; gi++) {
    if (candleData[assets[gi]] && candleData[assets[gi]].length > 1) {
      candleData[assets[gi]] = fillCandleGaps(candleData[assets[gi]], bnExpectedMs);
      stitchCandles(candleData[assets[gi]]);
    }
  }

  // Bail out if we got nothing
  if (!candleData.SOL || candleData.SOL.length === 0) {
    statusEl.textContent = "No data received — check network connection";
    statusEl.style.color = "#ff6040";
    hideLoading();
    return;
  }

  CONFIG.CANDLE_COUNT = candleData.SOL.length;

  // ================================================================
  // Phase 2: FETCH BACKGROUND DATA (multi-layer for context)
  // ================================================================
  // Background candles are positioned off-screen left, with rays
  // projecting rightward into the visible chart. Finer-grained
  // background provides more S/R levels in the visible area.
  //
  // The layers fetched depend on what timeframe we're viewing:
  //   Viewing 5m/15m/multi → background: 1h + 4h + daily
  //   Viewing 1h           → background: 4h + daily
  //   Viewing 4h           → background: daily
  //   Viewing 1d           → background: weekly
  //
  // Each layer is native Binance klines — no synthesis needed.

  var viewInterval = isMultiRes ? "15m" : rangeInfo.interval;
  var needBg1h    = (viewInterval === "5m" || viewInterval === "15m");
  var needBg4h    = needBg1h || (viewInterval === "1h");
  var needBgDaily = needBg1h || needBg4h || (viewInterval === "4h");
  var needBgWeekly = (viewInterval === "1d");

  // Build labels for status display
  var bgLayers = [];
  if (needBg1h)     bgLayers.push("1h");
  if (needBg4h)     bgLayers.push("4h");
  if (needBgDaily)  bgLayers.push("daily");
  if (needBgWeekly) bgLayers.push("weekly");
  var bgLabel = bgLayers.join("+") || "daily";

  // Helper: fetch one background layer with caching.
  // Defined outside the loop to keep things clean.
  async function fetchBgLayer(sym, interval, limit, assetLabel) {
    var ck = sym + "_bg_" + interval + "_" + limit;
    if (!binanceCache[sym]) binanceCache[sym] = {};
    var cached = binanceCache[sym][ck];
    if (cacheIsFresh(cached, interval)) {
      return cached.candles;
    }
    showLoading("Fetching " + assetLabel + " background (" + interval + ")…");
    statusEl.textContent = "Fetching " + assetLabel + " (" + interval + " background)...";
    var klines = await fetchKlines(sym, interval, limit);
    await apiDelay(300);
    if (klines && klines.length > 0) {
      binanceCache[sym][ck] = { candles: klines, fetchedAt: Date.now() };
      saveCacheToStorage();
    }
    return klines;
  }

  for (var j = 0; j < assets.length; j++) {
    var bgKey = assets[j];
    var bgSymbol = BINANCE_SYMBOLS[bgKey];

    // Timestamp where the visible chart starts — background candles
    // must be BEFORE this so they don't overlap visible data.
    var visStart = (candleData[bgKey] && candleData[bgKey].length > 0)
      ? candleData[bgKey][0].time : Infinity;

    // Fetch each needed layer
    var layer1h    = needBg1h    ? await fetchBgLayer(bgSymbol, "1h",  500, bgKey) : null;
    var layer4h    = needBg4h    ? await fetchBgLayer(bgSymbol, "4h",  500, bgKey) : null;
    var layerDaily = needBgDaily ? await fetchBgLayer(bgSymbol, "1d",  200, bgKey) : null;
    var layerWeekly = needBgWeekly ? await fetchBgLayer(bgSymbol, "1w", 52, bgKey) : null;

    // Stitch layers: coarsest first, trimming overlaps so each layer
    // only covers the period before the next finer layer begins.
    var stitched = [];

    // Weekly (coarsest, only when viewing daily)
    if (layerWeekly && layerWeekly.length > 0) {
      for (var wi = 0; wi < layerWeekly.length; wi++) {
        if (layerWeekly[wi].time < visStart) stitched.push(layerWeekly[wi]);
      }
    }

    // Daily
    if (layerDaily && layerDaily.length > 0) {
      var dailyCut = Infinity;
      if (layer4h && layer4h.length > 0)     dailyCut = layer4h[0].time;
      else if (layer1h && layer1h.length > 0) dailyCut = layer1h[0].time;
      dailyCut = Math.min(dailyCut, visStart);
      // If we already have weekly, only add daily candles after the weekly range
      var dailyFloor = (stitched.length > 0) ? stitched[stitched.length - 1].time : -Infinity;
      for (var di = 0; di < layerDaily.length; di++) {
        if (layerDaily[di].time > dailyFloor && layerDaily[di].time < dailyCut) {
          stitched.push(layerDaily[di]);
        }
      }
    }

    // 4h
    if (layer4h && layer4h.length > 0) {
      var fourHCut = Infinity;
      if (layer1h && layer1h.length > 0) fourHCut = layer1h[0].time;
      fourHCut = Math.min(fourHCut, visStart);
      var fourHFloor = (stitched.length > 0) ? stitched[stitched.length - 1].time : -Infinity;
      for (var fi = 0; fi < layer4h.length; fi++) {
        if (layer4h[fi].time > fourHFloor && layer4h[fi].time < fourHCut) {
          stitched.push(layer4h[fi]);
        }
      }
    }

    // 1h (finest background layer)
    if (layer1h && layer1h.length > 0) {
      var oneHFloor = (stitched.length > 0) ? stitched[stitched.length - 1].time : -Infinity;
      for (var oi = 0; oi < layer1h.length; oi++) {
        if (layer1h[oi].time > oneHFloor && layer1h[oi].time < visStart) {
          stitched.push(layer1h[oi]);
        }
      }
    }

    backgroundData[bgKey] = stitched.length > 0 ? stitchCandles(fillCandleGaps(stitched, 0)) : null;
  }

  // ================================================================
  // Phase 3: CLEAR CACHES AND REDRAW
  // ================================================================

  heatmapCache     = {};
  sightLineCache   = {};
  bgSightLineCache = {};
  bgGridCache      = {};
  animPrecomputed  = {};
  animPriceRange   = {};
  particles        = {};
  calibration      = {};
  state.animCandles = 0;
  resetZoom();
  cancelAnim();
  updateProgress();

  setActive("btn-live", true);
  setActive("btn-generated", false);

  resizeCanvas();

  // Run preprocessing (sight-line precomputation + calibration)
  // so the chart is fully ready on first render.
  preprocessChart(function() {
    if (success) {
      var bgCount = backgroundData.SOL ? backgroundData.SOL.length : 0;
      var label = isMultiRes ? "30d Multi-Res (15m→1h→4h)" : rangeInfo.label;
      statusEl.textContent = "Binance: " + CONFIG.CANDLE_COUNT
        + " candles (" + label + ") + " + bgCount + " bg " + bgLabel;
      statusEl.style.color = "#00c080";
    }
    drawFrame();
  });
}


// ================================================================
// CANDLE SYNTHESIS & GAP FILLING
// ================================================================
// Shared utilities used by both Binance and CoinGecko pipelines
// to ensure clean, gapless candle data.

// Convert a Binance-style interval string ("5m", "1h", "4h", "1d")
// to milliseconds. Used for gap detection.
function intervalToMs(interval) {
  var match = interval.match(/^(\d+)([mhdwMW])$/);
  if (!match) return 300000; // fallback 5m
  var n    = parseInt(match[1], 10);
  var unit = match[2];
  switch (unit) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": case "W": return n * 7 * 24 * 60 * 60 * 1000;
    case "M": return n * 30 * 24 * 60 * 60 * 1000;
    default:  return n * 60 * 1000;
  }
}


// Force candle continuity: each candle's open = previous candle's close.
// Adjusts high/low to include the new open. This is the final step
// after all fetching, synthesis, and gap-filling — guarantees no
// visual price gaps regardless of data source or processing.
function stitchCandles(candles) {
  if (!candles || candles.length < 2) return candles;
  for (var i = 1; i < candles.length; i++) {
    candles[i].o = candles[i - 1].c;
    if (candles[i].o > candles[i].h) candles[i].h = candles[i].o;
    if (candles[i].o < candles[i].l) candles[i].l = candles[i].o;
  }
  return candles;
}


// Build OHLCV candles from raw price and volume time-series points.
// pricePoints:  [[timestamp_ms, price], ...]  (sorted chronologically)
// volPoints:    [[timestamp_ms, volume], ...] (sorted chronologically)
// targetMs:     desired candle width in milliseconds
//
// Groups points into time-aligned buckets and computes O/H/L/C/V
// for each bucket. Buckets align to clean multiples of targetMs
// (e.g., 5m candles start at :00, :05, :10, etc.).
// Merge consecutive OHLC candles into coarser time buckets.
// Used when CoinGecko gives us finer candles than we need
// (e.g., 30m candles merged into 4h buckets, or 4h into daily).
//
// Preserves real OHLC structure:
//   O = first candle's open in the bucket
//   H = max of all highs in the bucket
//   L = min of all lows in the bucket
//   C = last candle's close in the bucket
//   V = sum of all volumes in the bucket
//   time = bucket-aligned start time
function mergeCandles(candles, targetMs) {
  if (!candles || candles.length === 0 || !targetMs) return candles;

  var merged = [];
  var bucketStart = Math.floor(candles[0].time / targetMs) * targetMs;
  var ci = 0;

  while (ci < candles.length) {
    var bucketEnd = bucketStart + targetMs;
    var open = null, high = -Infinity, low = Infinity, close = null;
    var vol = 0, bpSum = 0, bpCount = 0, trades = 0;

    // Gather all source candles that fall within this target bucket
    while (ci < candles.length && candles[ci].time < bucketEnd) {
      var c = candles[ci];
      if (open === null) open = c.o;
      if (c.h > high) high = c.h;
      if (c.l < low)  low  = c.l;
      close = c.c;
      vol += c.v;
      trades += (c.trades || 0);
      bpSum += c.buyPressure;
      bpCount++;
      ci++;
    }

    if (open !== null) {
      merged.push({
        o:           open,
        h:           high,
        l:           low,
        c:           close,
        v:           vol,
        trades:      trades,
        buyPressure: bpCount > 0 ? bpSum / bpCount : 0.5,
        time:        bucketStart,
      });
    }

    bucketStart = bucketEnd;
  }

  return merged;
}


// Convert CoinGecko's total_volumes (24h rolling snapshots) into
// incremental per-interval volume deltas.
// Input:  [[timestamp_ms, rolling_total], ...]   (sorted by time)
// Output: [[timestamp_ms, incremental_volume], ...]
//
// CoinGecko's total_volumes report the 24h rolling volume at each
// timestamp. The delta between consecutive snapshots approximates
// the actual trading volume during that interval. Deltas can go
// negative (old data rolling off the window), so we clamp to zero.
function volumeDeltas(volEntries) {
  if (!volEntries || volEntries.length < 2) return [];
  var deltas = [];
  for (var i = 1; i < volEntries.length; i++) {
    var delta = volEntries[i][1] - volEntries[i - 1][1];
    deltas.push([volEntries[i][0], Math.max(0, delta)]);
  }
  return deltas;
}


// Assign volume to candles by bucketing volume deltas into each
// candle's time range and summing. Updates candles in place.
function assignVolume(candles, volDeltas) {
  if (!candles || candles.length === 0 || !volDeltas || volDeltas.length === 0) return;

  // Detect candle interval from timestamps
  var candleMs = candles.length > 1 ? (candles[1].time - candles[0].time) : 300000;

  var vi = 0;
  for (var ci = 0; ci < candles.length; ci++) {
    var start = candles[ci].time;
    var end   = start + candleMs;
    var vol   = 0;

    // Advance past any deltas before this candle
    while (vi < volDeltas.length && volDeltas[vi][0] < start) vi++;

    // Sum all deltas within this candle's time range
    var vj = vi;
    while (vj < volDeltas.length && volDeltas[vj][0] < end) {
      vol += volDeltas[vj][1];
      vj++;
    }

    candles[ci].v = vol;
  }
}


// Detect and fill gaps in a candle array.
// For each gap between consecutive candles, inserts interpolating
// candles that smoothly bridge from the previous close to the next
// open. This ensures every time slot has a visible candle with a
// real body (open ≠ close), not invisible flat lines.
//
// expectedMs: hint for the expected interval. If 0 or omitted,
//             auto-detects from the data. For multi-res, pass 0.
function fillCandleGaps(candles, expectedMs) {
  if (!candles || candles.length < 2) return candles;

  // ---- Compute local interval per gap ----
  var globalMs = (expectedMs && expectedMs > 0) ? expectedMs : 0;

  var filled = [candles[0]];

  for (var i = 1; i < candles.length; i++) {
    var prev = filled[filled.length - 1];
    var gap  = candles[i].time - prev.time;

    // Determine expected interval at this position
    var localMs = globalMs;
    if (!localMs) {
      var gapBefore = (i >= 2) ? (candles[i - 1].time - candles[i - 2].time) : gap;
      var gapAfter  = (i < candles.length - 1) ? (candles[i + 1].time - candles[i].time) : gap;
      localMs = Math.min(gapBefore, gapAfter, gap);
      if (localMs < 1000) localMs = gap;
    }

    // If gap is more than 1.5× local interval, fill it
    if (gap > localMs * 1.5 && localMs > 0) {
      var startPrice = prev.c;
      var endPrice   = candles[i].o;
      var fillTime   = prev.time + localMs;

      // Count how many fill candles we'll insert
      var fillCount = 0;
      var t = fillTime;
      while (t < candles[i].time - localMs * 0.3) {
        fillCount++;
        t += localMs;
      }

      // Insert interpolating candles
      if (fillCount > 0) {
        var step = 0;
        while (fillTime < candles[i].time - localMs * 0.3) {
          step++;
          var frac  = step / (fillCount + 1);
          var price = startPrice + (endPrice - startPrice) * frac;
          var prevP = startPrice + (endPrice - startPrice) * ((step - 1) / (fillCount + 1));

          filled.push({
            o:           prevP,
            h:           Math.max(prevP, price),
            l:           Math.min(prevP, price),
            c:           price,
            v:           0,
            trades:      0,
            buyPressure: 0.5,
            time:        fillTime,
          });
          fillTime += localMs;
        }
      }
    }

    filled.push(candles[i]);
  }

  return filled;
}


// ================================================================
// COINGECKO DATA SOURCE (optional, requires free Demo API key)
// ================================================================
// Uses /market_chart endpoint which returns price+volume time-series.
// Demo tier auto-granularity:
//   days=1    → ~5-minute price points (~288 per day)
//   days=2-90 → hourly price points
//   days=90+  → daily price points
//
// We synthesize OHLCV candles at the desired interval by grouping
// consecutive price points into time-aligned buckets:
//   O = first price in bucket
//   H = max of all prices in bucket
//   L = min of all prices in bucket
//   C = last price in bucket
//
// For buckets with only one point, the previous candle's close
// becomes this candle's open so you get a real body showing the
// price change between intervals. Wicks won't capture intra-interval
// extremes (no raw tick data), but the price movement is accurate.
//
// Free Demo tier: 30 calls/min, key as query param.
// Sign up at: https://www.coingecko.com/en/api/pricing

var CG_BASE = "https://api.coingecko.com/api/v3";

var CG_COIN_IDS = {
  SOL: "solana",
  ETH: "ethereum",
  BTC: "bitcoin",
};

// Maps our range selector to CoinGecko fetch strategy.
//   days:       'days' param for /market_chart
//   targetMs:   desired candle width in ms for synthesis
//   label:      what the user sees in the status bar
//
// market_chart auto-granularity gives us:
//   days=1  → ~5min points → can build 5m, 15m candles
//   days=7  → hourly points → can build 1h, 4h candles
//   days=14 → hourly points → can build 1h, 4h candles
//   days=30 → hourly points → can build 4h candles
//   days=90 → daily points  → can build daily candles
var CG_RANGE_MAP = {
  "1":      { days: 1,   targetMs: 5 * 60000,        label: "24h × 5m" },
  "1-15m":  { days: 1,   targetMs: 15 * 60000,       label: "24h × 15m" },
  "multi":  { days: null, targetMs: null,              label: "30d Multi-Res" },
  "7-1h":   { days: 7,   targetMs: 60 * 60000,       label: "7d × 1h" },
  "7":      { days: 7,   targetMs: 4 * 60 * 60000,   label: "7d × 4h" },
  "14-1h":  { days: 14,  targetMs: 60 * 60000,       label: "14d × 1h" },
  "14":     { days: 14,  targetMs: 4 * 60 * 60000,   label: "14d × 4h" },
  "30":     { days: 30,  targetMs: 4 * 60 * 60000,   label: "30d × 4h" },
  "90":     { days: 90,  targetMs: 24 * 60 * 60000,   label: "90d × 1d" },
};


// Get/set the stored CoinGecko API key from localStorage.
function getCoinGeckoKey() {
  try {
    var key = localStorage.getItem("cg_demo_api_key");
    return (key && key.trim().length > 5) ? key.trim() : null;
  } catch (e) { return null; }
}
function setCoinGeckoKey(key) {
  try {
    if (key && key.trim().length > 5) {
      localStorage.setItem("cg_demo_api_key", key.trim());
    } else {
      localStorage.removeItem("cg_demo_api_key");
    }
  } catch (e) { /* ignore */ }
}


// Fetch JSON from CoinGecko with the Demo API key.
async function cgFetch(path) {
  var apiKey = getCoinGeckoKey();
  if (!apiKey) {
    console.warn("CoinGecko: no API key set");
    return null;
  }
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  var url = CG_BASE + path + sep + "x_cg_demo_api_key=" + apiKey;

  try {
    var resp = await fetch(url);
    if (resp.ok) return await resp.json();
    if (resp.status === 429) {
      var statusEl = document.getElementById("data-status");
      if (statusEl) {
        statusEl.textContent = "CoinGecko rate limit — wait and retry";
        statusEl.style.color = "#ff6040";
      }
      return null;
    }
    if (resp.status === 401 || resp.status === 403) {
      var statusEl2 = document.getElementById("data-status");
      if (statusEl2) {
        statusEl2.textContent = "CoinGecko: invalid API key";
        statusEl2.style.color = "#ff6040";
      }
      return null;
    }
    console.warn("CoinGecko " + resp.status);
  } catch (e) {
    console.warn("CoinGecko fetch error:", e.message || e);
  }
  return null;
}


// Delay between CoinGecko calls. 30 calls/min = 1 per 2s.
// We use 2.2s to leave headroom.
function cgDelay() {
  return new Promise(function(resolve) { setTimeout(resolve, 2200); });
}


// Build OHLCV candles from /market_chart price+volume time-series.
//
// pricePoints:  [[timestamp_ms, price], ...]  (sorted chronologically)
// volPoints:    [[timestamp_ms, rolling_24h_vol], ...] (sorted)
// targetMs:     desired candle width in milliseconds
//
// Groups price points into time-aligned buckets. For each bucket:
//   O = first price point in bucket (or previous close if bucket
//       has only 1 point, giving a real body)
//   H = max of all prices in bucket
//   L = min of all prices in bucket
//   C = last price point in bucket
//   V = sum of volume deltas that fall in the bucket
function synthesizeCandles(pricePoints, volPoints, targetMs) {
  if (!pricePoints || pricePoints.length < 2 || !targetMs) return [];

  // ---- Pre-compute volume deltas ----
  // CoinGecko total_volumes are rolling 24h snapshots. The delta
  // between consecutive snapshots approximates interval volume.
  var volDeltas = volumeDeltas(volPoints);

  // Bucket the volume deltas by candle time
  var volByBucket = {};
  for (var vi = 0; vi < volDeltas.length; vi++) {
    var vBucket = Math.floor(volDeltas[vi][0] / targetMs) * targetMs;
    if (!volByBucket[vBucket]) volByBucket[vBucket] = 0;
    volByBucket[vBucket] += volDeltas[vi][1];
  }

  // ---- Build candles ----
  var candles = [];
  var firstTime   = pricePoints[0][0];
  var bucketStart = Math.floor(firstTime / targetMs) * targetMs;
  var lastTime    = pricePoints[pricePoints.length - 1][0];
  var pi          = 0;
  var prevClose   = pricePoints[0][1]; // seed for first candle

  while (bucketStart <= lastTime) {
    var bucketEnd = bucketStart + targetMs;
    var prices    = [];

    // Collect all price points that fall in this bucket
    while (pi < pricePoints.length && pricePoints[pi][0] < bucketEnd) {
      prices.push(pricePoints[pi][1]);
      pi++;
    }

    if (prices.length > 0) {
      var open, high, low, close;

      if (prices.length === 1) {
        // Single point in bucket: use previous close as open
        // so the candle body shows the movement between intervals
        open  = prevClose;
        close = prices[0];
        high  = Math.max(open, close);
        low   = Math.min(open, close);
      } else {
        // Multiple points: real O/H/L/C from the spread
        open  = prices[0];
        close = prices[prices.length - 1];
        high  = prices[0];
        low   = prices[0];
        for (var p = 1; p < prices.length; p++) {
          if (prices[p] > high) high = prices[p];
          if (prices[p] < low)  low  = prices[p];
        }
      }

      // Estimate buy pressure from candle shape
      var range = high - low;
      var bp = 0.5;
      if (range > 0) {
        bp = 0.5 + ((close - open) / range * 0.18)
                  + ((Math.min(open, close) - low - (high - Math.max(open, close))) / range * 0.07);
        if (bp < 0.05) bp = 0.05;
        if (bp > 0.95) bp = 0.95;
      }

      candles.push({
        o:           open,
        h:           high,
        l:           low,
        c:           close,
        v:           volByBucket[bucketStart] || 0,
        trades:      0,
        buyPressure: bp,
        time:        bucketStart,
      });

      prevClose = close;

    }
    // Empty buckets are skipped — fillCandleGaps will bridge them
    // with interpolating candles after synthesis is complete.

    bucketStart = bucketEnd;
  }

  return candles;
}


// Fetch /market_chart and synthesize candles at the target interval.
// Returns array of candle objects in our internal format, or null.
//
// This is the primary CoinGecko fetch — used for foreground candles
// where we need both price data and volume.
async function cgFetchCandles(coinId, days, targetMs) {
  var path = "/coins/" + coinId + "/market_chart?vs_currency=usd&days=" + days;
  var data = await cgFetch(path);
  if (!data || !data.prices || data.prices.length < 2) return null;

  var candles = synthesizeCandles(
    data.prices,
    data.total_volumes || [],
    targetMs
  );

  if (candles.length === 0) return null;

  // Gap fill is already handled by synthesizeCandles (empty buckets
  // get flat carry-forward candles), but run fillCandleGaps too for
  // any edge cases at the boundaries.
  candles = fillCandleGaps(candles, targetMs);

  return candles;
}


// Lightweight version for background data — same approach but
// uses a single API call. Volume is zero (background rays only
// need price levels). Saves API calls vs the 30/min limit.
async function cgFetchCandlesLight(coinId, days, targetMs) {
  var path = "/coins/" + coinId + "/market_chart?vs_currency=usd&days=" + days;
  var data = await cgFetch(path);
  if (!data || !data.prices || data.prices.length < 2) return null;

  // Synthesize with empty volume array (all zero)
  var candles = synthesizeCandles(data.prices, [], targetMs);
  if (candles.length === 0) return null;

  candles = fillCandleGaps(candles, targetMs);
  return candles;
}


// ================================================================
// COINGECKO MAIN FETCH
// ================================================================
// Mirrors fetchLive() but pulls from CoinGecko market_chart and
// synthesizes candles at the exact intervals Binance would provide.
// Multi-res stitching works the same way: fine→medium→coarse layers.

async function fetchLiveCoinGecko() {
  stopLiveTicker();
  var statusEl = document.getElementById("data-status");
  var rawRange = document.getElementById("interval-select").value;
  var cgRange  = CG_RANGE_MAP[rawRange];

  if (!cgRange) {
    statusEl.textContent = "Unknown range: " + rawRange;
    statusEl.style.color = "#ff6040";
    return;
  }

  if (!getCoinGeckoKey()) {
    statusEl.textContent = "CoinGecko: enter your Demo API key first";
    statusEl.style.color = "#ff6040";
    return;
  }

  statusEl.textContent = "Fetching from CoinGecko...";
  statusEl.style.color = "#5af";
  showLoading("Fetching CoinGecko data…");

  var success = true;
  var assets = ["SOL", "ETH", "BTC"];
  var isMultiRes = (rawRange === "multi");

  // ================================================================
  // Phase 1: FETCH CANDLE DATA
  // ================================================================

  for (var i = 0; i < assets.length; i++) {
    var assetKey = assets[i];
    var coinId   = CG_COIN_IDS[assetKey];

    if (isMultiRes) {
      // ---- MULTI-RES: 3 layers from market_chart ----
      // days=30 → hourly points → synthesize 4h candles (coarse)
      // days=7  → hourly points → synthesize 1h candles (mid)
      // days=1  → ~5min points  → synthesize 15m candles (fine)
      showLoading("Fetching " + assetKey + " (multi-res CG)…");

      statusEl.textContent = "Fetching " + assetKey + " (4h layer)...";
      var layer4h = await cgFetchCandles(coinId, 30, 4 * 60 * 60000);
      await cgDelay();

      statusEl.textContent = "Fetching " + assetKey + " (1h layer)...";
      var layer1h = await cgFetchCandles(coinId, 7, 60 * 60000);
      await cgDelay();

      statusEl.textContent = "Fetching " + assetKey + " (15m layer)...";
      var layerFine = await cgFetchCandles(coinId, 1, 15 * 60000);
      await cgDelay();

      // Stitch: same logic as Binance multi-res
      if (layer4h && layer1h && layerFine) {
        var cutoff1h   = layer1h[0].time;
        var cutoffFine = layerFine[0].time;
        var trimmed4h  = layer4h.filter(function(c) { return c.time < cutoff1h; });
        var trimmed1h  = layer1h.filter(function(c) { return c.time < cutoffFine; });
        candleData[assetKey] = trimmed4h.concat(trimmed1h).concat(layerFine);
      } else {
        candleData[assetKey] = layerFine || layer1h || layer4h;
        if (!candleData[assetKey]) success = false;
      }

    } else {
      // ---- SINGLE RESOLUTION ----
      showLoading("Fetching " + assetKey + " from CoinGecko…");
      statusEl.textContent = "Fetching " + assetKey + "...";

      var candles = await cgFetchCandles(coinId, cgRange.days, cgRange.targetMs);
      await cgDelay();

      if (candles && candles.length > 0) {
        candleData[assetKey] = candles;
      } else {
        statusEl.textContent = "No CoinGecko data for " + assetKey;
        statusEl.style.color = "#ff6040";
        success = false;
      }
    }
  }

  // ---- Gap-fill: ensure no time discontinuities ----
  // CoinGecko data and multi-res stitching can create gaps.
  // Same treatment as Binance: pass 0 for auto-detect mode.
  for (var gi = 0; gi < assets.length; gi++) {
    if (candleData[assets[gi]] && candleData[assets[gi]].length > 1) {
      candleData[assets[gi]] = fillCandleGaps(candleData[assets[gi]], 0);
      stitchCandles(candleData[assets[gi]]);
    }
  }

  // Bail if we got nothing
  if (!candleData.SOL || candleData.SOL.length === 0) {
    statusEl.textContent = "No data — check API key and try again";
    statusEl.style.color = "#ff6040";
    hideLoading();
    return;
  }

  CONFIG.CANDLE_COUNT = candleData.SOL.length;

  // ================================================================
  // Phase 2: BACKGROUND DATA
  // ================================================================
  // Same layered approach as Binance: fetch coarser timeframes for
  // off-screen S/R context. CoinGecko gives hourly for 2-90 days,
  // so we synthesize the background layer from that.

  // CoinGecko /market_chart provides:
  //   days=7  → hourly points → can synthesize 1h bg candles
  //   days=30 → hourly points → can synthesize 4h bg candles
  //   days=90 → daily points  → can synthesize daily bg candles
  //   days=365 → daily points → can synthesize weekly bg candles
  var viewTargetMs = isMultiRes ? 15 * 60000 : cgRange.targetMs;
  var needBg1h    = (viewTargetMs <= 15 * 60000);
  var needBg4h    = needBg1h || (viewTargetMs <= 60 * 60000);
  var needBgDaily = needBg1h || needBg4h || (viewTargetMs <= 4 * 60 * 60000);
  var needBgWeekly = (viewTargetMs >= 24 * 60 * 60000);

  var bgLayers = [];
  if (needBg1h)     bgLayers.push("1h");
  if (needBg4h)     bgLayers.push("4h");
  if (needBgDaily)  bgLayers.push("daily");
  if (needBgWeekly) bgLayers.push("weekly");
  var bgLabel = bgLayers.join("+") || "daily";

  for (var j = 0; j < assets.length; j++) {
    var bgKey  = assets[j];
    var bgCoin = CG_COIN_IDS[bgKey];
    var visStart = (candleData[bgKey] && candleData[bgKey].length > 0)
      ? candleData[bgKey][0].time : Infinity;

    // Fetch all needed layers first, then stitch with proper cutoffs.
    var bgWeekly = null, bgDaily = null, bgFourH = null, bgOneH = null;

    if (needBgWeekly) {
      statusEl.textContent = "Fetching " + bgKey + " weekly bg...";
      bgWeekly = await cgFetchCandlesLight(bgCoin, 365, 7 * 24 * 60 * 60000);
      await cgDelay();
    }
    if (needBgDaily) {
      statusEl.textContent = "Fetching " + bgKey + " daily bg...";
      showLoading("Fetching " + bgKey + " background…");
      bgDaily = await cgFetchCandlesLight(bgCoin, 90, 24 * 60 * 60000);
      await cgDelay();
    }
    if (needBg4h) {
      statusEl.textContent = "Fetching " + bgKey + " 4h bg...";
      bgFourH = await cgFetchCandlesLight(bgCoin, 30, 4 * 60 * 60000);
      await cgDelay();
    }
    if (needBg1h) {
      statusEl.textContent = "Fetching " + bgKey + " 1h bg...";
      bgOneH = await cgFetchCandlesLight(bgCoin, 7, 60 * 60000);
      await cgDelay();
    }

    // ---- Stitch layers: coarsest first, trimming overlaps ----
    var stitched = [];

    // Weekly (coarsest)
    if (bgWeekly && bgWeekly.length > 0) {
      for (var wi = 0; wi < bgWeekly.length; wi++) {
        if (bgWeekly[wi].time < visStart) stitched.push(bgWeekly[wi]);
      }
    }

    // Daily — cut at where 4h starts (or 1h, or visStart)
    if (bgDaily && bgDaily.length > 0) {
      var dailyCut = Infinity;
      if (bgFourH && bgFourH.length > 0)   dailyCut = bgFourH[0].time;
      else if (bgOneH && bgOneH.length > 0) dailyCut = bgOneH[0].time;
      dailyCut = Math.min(dailyCut, visStart);
      var dailyFloor = stitched.length > 0 ? stitched[stitched.length - 1].time : -Infinity;
      for (var di = 0; di < bgDaily.length; di++) {
        if (bgDaily[di].time > dailyFloor && bgDaily[di].time < dailyCut) {
          stitched.push(bgDaily[di]);
        }
      }
    }

    // 4h — cut at where 1h starts (or visStart)
    if (bgFourH && bgFourH.length > 0) {
      var fourHCut = Infinity;
      if (bgOneH && bgOneH.length > 0) fourHCut = bgOneH[0].time;
      fourHCut = Math.min(fourHCut, visStart);
      var fourHFloor = stitched.length > 0 ? stitched[stitched.length - 1].time : -Infinity;
      for (var fi = 0; fi < bgFourH.length; fi++) {
        if (bgFourH[fi].time > fourHFloor && bgFourH[fi].time < fourHCut) {
          stitched.push(bgFourH[fi]);
        }
      }
    }

    // 1h (finest background layer) — runs up to visStart
    if (bgOneH && bgOneH.length > 0) {
      var oneHFloor = stitched.length > 0 ? stitched[stitched.length - 1].time : -Infinity;
      for (var oi = 0; oi < bgOneH.length; oi++) {
        if (bgOneH[oi].time > oneHFloor && bgOneH[oi].time < visStart) {
          stitched.push(bgOneH[oi]);
        }
      }
    }

    backgroundData[bgKey] = stitched.length > 0 ? stitchCandles(fillCandleGaps(stitched, 0)) : null;
  }

  // ================================================================
  // Phase 3: CLEAR CACHES AND REDRAW
  // ================================================================

  heatmapCache     = {};
  sightLineCache   = {};
  bgSightLineCache = {};
  bgGridCache      = {};
  animPrecomputed  = {};
  animPriceRange   = {};
  particles        = {};
  calibration      = {};
  state.animCandles = 0;
  resetZoom();
  cancelAnim();
  updateProgress();

  setActive("btn-live", true);
  setActive("btn-generated", false);

  resizeCanvas();

  preprocessChart(function() {
    if (success) {
      var bgCount = backgroundData.SOL ? backgroundData.SOL.length : 0;
      var label = isMultiRes ? "30d Multi-Res (15m→1h→4h)" : cgRange.label;
      statusEl.textContent = "CoinGecko: " + CONFIG.CANDLE_COUNT
        + " candles (" + label + ")"
        + (bgCount > 0 ? " + " + bgCount + " bg " + bgLabel : "");
      statusEl.style.color = "#00c080";
    }
    drawFrame();
  });
}


// ================================================================
// FETCH ROUTER
// ================================================================
// Called by the Fetch Live button. Routes to Binance or CoinGecko
// based on the data source selector.

function fetchLiveRouter() {
  var srcEl = document.getElementById("data-source-select");
  var source = srcEl ? srcEl.value : "binance";

  if (source === "coingecko") {
    fetchLiveCoinGecko();
  } else {
    fetchLive();
  }
}


// ================================================================
// DATA SOURCE UI HANDLERS
// ================================================================

// Label text for each range option, per data source.
// CoinGecko can't match Binance's granularity at several ranges,
// so the labels honestly reflect what you'll actually get.
var RANGE_LABELS = {
  binance: {
    "1":      "24h (5m candles)",
    "1-15m":  "24h (15m candles)",
    "multi":  "30d Multi-Res (15m→1h→4h)",
    "7-1h":   "7d (1h candles)",
    "7":      "7d (4h candles)",
    "14-1h":  "14d (1h candles)",
    "14":     "14d (4h candles)",
    "30":     "30d (4h candles)",
    "90":     "90d (daily candles)",
  },
  coingecko: {
    "1":      "24h (5m candles)",
    "1-15m":  "24h (15m candles)",
    "multi":  "30d Multi-Res (15m→1h→4h)",
    "7-1h":   "7d (1h candles)",
    "7":      "7d (4h candles)",
    "14-1h":  "14d (1h candles)",
    "14":     "14d (4h candles)",
    "30":     "30d (4h candles)",
    "90":     "90d (daily candles)",
  },
};

// Update the range dropdown labels to match the selected data source.
function updateRangeLabels(source) {
  var labels = RANGE_LABELS[source] || RANGE_LABELS.binance;
  var select = document.getElementById("interval-select");
  if (!select) return;
  for (var i = 0; i < select.options.length; i++) {
    var opt = select.options[i];
    if (labels[opt.value]) {
      opt.textContent = labels[opt.value];
    }
  }
}

// Called when the data source dropdown changes.
// Shows/hides the CoinGecko API key input area and
// updates range labels to reflect the source's actual granularity.
function onDataSourceChange() {
  var srcEl   = document.getElementById("data-source-select");
  var keyArea = document.getElementById("cg-key-area");
  if (!srcEl || !keyArea) return;

  var source = srcEl.value;

  if (source === "coingecko") {
    keyArea.style.display = "inline";
    updateCgKeyUI();
  } else {
    keyArea.style.display = "none";
  }

  updateRangeLabels(source);
}

// Called when the CoinGecko API key input changes.
// Saves (or clears) the key in localStorage and updates UI.
function onCgKeyChange() {
  var keyInput = document.getElementById("cg-key-input");
  if (!keyInput) return;
  setCoinGeckoKey(keyInput.value);
  updateCgKeyUI();

  var statusEl = document.getElementById("data-status");
  if (statusEl) {
    if (keyInput.value.trim().length > 5) {
      statusEl.textContent = "CoinGecko key saved — hit Fetch Live";
      statusEl.style.color = "#00c080";
    } else {
      statusEl.textContent = "CoinGecko key cleared";
      statusEl.style.color = "#556";
    }
  }
}

// Update the CG key area UI based on whether a key is stored.
// When a key exists: input is type=password, "get key" link hidden.
// When no key: input is type=text (so placeholder is readable), "get key" visible.
function updateCgKeyUI() {
  var keyInput = document.getElementById("cg-key-input");
  var getLink  = document.getElementById("cg-key-getlink");
  if (!keyInput) return;

  var hasKey = getCoinGeckoKey() !== null;

  keyInput.type = hasKey ? "password" : "text";
  if (getLink) {
    getLink.style.display = hasKey ? "none" : "inline";
  }
}

// Toggle the CG API key between visible and hidden.
function toggleCgKeyVisibility() {
  var keyInput = document.getElementById("cg-key-input");
  if (!keyInput) return;
  keyInput.type = (keyInput.type === "password") ? "text" : "password";
}

// Set up the data source UI on startup.
// If a CoinGecko key is stored, default to CoinGecko as the source.
function initDataSource() {
  var savedKey = getCoinGeckoKey();
  var srcEl    = document.getElementById("data-source-select");
  var keyArea  = document.getElementById("cg-key-area");
  var keyInput = document.getElementById("cg-key-input");

  if (savedKey && srcEl) {
    // Default to CoinGecko when a key is available
    srcEl.value = "coingecko";
    if (keyArea)  keyArea.style.display = "inline";
    if (keyInput) keyInput.value = savedKey;
    updateCgKeyUI();
    updateRangeLabels("coingecko");
  }
}


// Switch back to generated data
function useGenerated() {
  stopLiveTicker();
  CONFIG.CANDLE_COUNT = 120;
  candleData.SOL = generateCandles(88,    0.008, CONFIG.CANDLE_COUNT, 101);
  candleData.ETH = generateCandles(2050,  0.006, CONFIG.CANDLE_COUNT, 202);
  candleData.BTC = generateCandles(68000, 0.004, CONFIG.CANDLE_COUNT, 303);

  heatmapCache     = {};
  sightLineCache   = {};
  bgSightLineCache = {};
  bgGridCache      = {};
  animPrecomputed  = {};  // invalidate pre-computed visibility pairs
  animPriceRange   = {};  // clear locked price range
  particles        = {};
  backgroundData   = {};
  calibration      = {};
  state.animCandles = 0;
  resetZoom();  // clear zoom/pan — new data, old position wouldn't make sense
  cancelAnim();
  updateProgress();

  var statusEl = document.getElementById("data-status");
  statusEl.textContent = "Generated data";
  statusEl.style.color = "#556";

  setActive("btn-live", false);
  setActive("btn-generated", true);

  resizeCanvas();

  // Run preprocessing so generated data is fully ready on first render
  preprocessChart(function() {
    drawFrame();
  });
}


// ================================================================
// LIVE PRICE TICKER
// ================================================================
// When enabled, polls the current price every 1s (Binance) or
// 2.5s (CoinGecko) and updates ONLY the last candle's close
// (and H/L if the new price exceeds them).
//
// This is intentionally lightweight:
//   - Does NOT invalidate any caches (heatmap, sight lines, etc.)
//   - Does NOT trigger preprocessing or recalibration
//   - Just calls drawFrame(), which repaints from cached data
//   - Only the candle overlay and price axis change visually
//
// The ticker auto-stops when you switch to generated data or
// start a new fetch.

var liveTicker = {
  active:   false,     // is the ticker currently running?
  timer:    null,      // setInterval handle
  source:   "binance", // which API to poll
};


// Start the live price ticker.
function startLiveTicker() {
  if (liveTicker.active) return;

  // Only works when we have live data loaded
  if (!candleData.SOL || candleData.SOL.length === 0) return;

  var srcEl = document.getElementById("data-source-select");
  liveTicker.source = (srcEl && srcEl.value === "coingecko") ? "coingecko" : "binance";
  liveTicker.active = true;

  // Poll interval: Binance 1s, CoinGecko 2.5s (30 calls/min limit)
  var intervalMs = liveTicker.source === "coingecko" ? 2500 : 1000;

  liveTicker.timer = setInterval(tickerPoll, intervalMs);

  setActive("btn-ticker", true);
  var statusEl = document.getElementById("data-status");
  if (statusEl) {
    statusEl.textContent += " | LIVE";
  }
}


// Stop the live price ticker.
function stopLiveTicker() {
  if (liveTicker.timer) {
    clearInterval(liveTicker.timer);
    liveTicker.timer = null;
  }
  liveTicker.active = false;
  setActive("btn-ticker", false);
}


// Toggle the ticker on/off.
function toggleLiveTicker() {
  if (liveTicker.active) {
    stopLiveTicker();
  } else {
    startLiveTicker();
  }
}


// One tick: fetch current prices, update last candles, redraw.
async function tickerPoll() {
  if (!liveTicker.active) return;

  var prices = null;

  if (liveTicker.source === "coingecko") {
    prices = await tickerPollCoinGecko();
  } else {
    prices = await tickerPollBinance();
  }

  if (!prices) return;

  // Update the last candle for each asset
  var changed = false;
  var assets = ["SOL", "ETH", "BTC"];

  for (var i = 0; i < assets.length; i++) {
    var key   = assets[i];
    var price = prices[key];
    if (!price || !candleData[key] || candleData[key].length === 0) continue;

    var last = candleData[key][candleData[key].length - 1];

    // Update close — this always changes
    if (last.c !== price) {
      last.c = price;
      changed = true;
    }

    // Update high/low if the new price exceeds them
    if (price > last.h) { last.h = price; changed = true; }
    if (price < last.l) { last.l = price; changed = true; }
  }

  // Redraw without clearing any caches — just repaint from cached data
  if (changed && !state.animating) {
    drawFrame();
  }
}


// Poll Binance for current prices (3 quick requests, CORS OK).
async function tickerPollBinance() {
  try {
    var prices = {};
    var symbols = { SOL: "SOLUSDT", ETH: "ETHUSDT", BTC: "BTCUSDT" };
    var keys = ["SOL", "ETH", "BTC"];

    // Fetch all 3 in parallel — Binance ticker is very fast
    var promises = keys.map(function(k) {
      // Try .us first (same as main fetch), fall back to .com
      var idx = binanceBaseIdx;
      var url = BINANCE_BASES[idx] + "/api/v3/ticker/price?symbol=" + symbols[k];
      return fetch(url).then(function(r) {
        return r.ok ? r.json() : null;
      }).catch(function() { return null; });
    });

    var results = await Promise.all(promises);

    for (var i = 0; i < keys.length; i++) {
      if (results[i] && results[i].price) {
        prices[keys[i]] = parseFloat(results[i].price);
      }
    }

    return (Object.keys(prices).length > 0) ? prices : null;
  } catch (e) {
    return null;
  }
}


// Poll CoinGecko for current prices (1 request for all 3 coins).
async function tickerPollCoinGecko() {
  try {
    var apiKey = getCoinGeckoKey();
    if (!apiKey) return null;

    var url = CG_BASE + "/simple/price?ids=solana,ethereum,bitcoin&vs_currencies=usd"
            + "&x_cg_demo_api_key=" + apiKey;

    var resp = await fetch(url);
    if (!resp.ok) return null;
    var data = await resp.json();

    var prices = {};
    if (data.solana   && data.solana.usd)   prices.SOL = data.solana.usd;
    if (data.ethereum && data.ethereum.usd) prices.ETH = data.ethereum.usd;
    if (data.bitcoin  && data.bitcoin.usd)  prices.BTC = data.bitcoin.usd;

    return (Object.keys(prices).length > 0) ? prices : null;
  } catch (e) {
    return null;
  }
}


// ================================================================
// PREPROCESSING
// ================================================================
// Runs the same precomputation that togglePlay() does so the
// initial static view matches what you'd see after an animation
// plays all the way through. Precomputes visibility pairs (the
// expensive O(n³) occlusion check) and runs indicator calibration.
// Shows a loading spinner while working.

function preprocessChart(callback) {
  showLoading("Preprocessing sight lines…");

  // Use setTimeout so the browser can render the spinner
  // before we block the main thread with heavy computation.
  setTimeout(function() {
    // Precompute visibility pairs for ALL assets (so switching
    // assets later doesn't need another expensive pass).
    var assets = ["BTC", "ETH", "SOL"];

    // Precompute visibility pairs for each asset (same as togglePlay)
    for (var i = 0; i < assets.length; i++) {
      var ak = assets[i];
      if (!candleData[ak] || candleData[ak].length === 0) continue;
      if (!animPrecomputed[ak] || animPrecomputed[ak].candles !== candleData[ak]) {
        console.time("precompute-" + ak);
        animPrecomputed[ak] = {
          pairs:   precomputeVisibilityPairs(candleData[ak]),
          candles: candleData[ak],
        };
        console.timeEnd("precompute-" + ak);
      }
    }

    // Run indicator calibration from background data
    if (typeof runCalibration === "function") {
      var calAsset = state.multiAsset ? "SOL" : state.asset;
      runCalibration(calAsset);
    }

    // Clear caches so the first drawFrame uses fresh precomputed data
    heatmapCache     = {};
    sightLineCache   = {};
    bgSightLineCache = {};
    bgGridCache      = {};

    hideLoading();

    if (callback) callback();
  }, 30);
}


// ================================================================
// INITIALIZATION
// ================================================================
// Runs once when the page loads.

function init() {
  // Grab canvas and context
  canvas = document.getElementById("main-canvas");
  ctx    = canvas.getContext("2d");

  // Initialize WebGL heatmap renderer (falls back gracefully if unavailable)
  var glOk = initGLHeatmap();
  console.log("Heatmap renderer: " + (glOk ? "WebGL (GPU)" : "ImageData (CPU fallback)"));

  // Initialize GPU beam accumulation (Phase 2).
  // Falls back to CPU paintBeam loops (Phase 1 caching) if unavailable.
  var glBOk = (typeof initGLBeams === "function") ? initGLBeams() : false;
  console.log("Beam renderer: " + (glBOk ? "GPU instanced (Phase 2)" : "CPU (Phase 1 caching)"));

  // Initialize WebGL2 instanced particle renderer (per-particle color).
  // Falls back to Three.js Points (uniform color) or 2D canvas.
  var glPInstOk = (typeof initGLParticlesInstanced === "function") ? initGLParticlesInstanced() : false;
  console.log("Particle renderer: " + (glPInstOk ? "WebGL2 instanced (GPU)" : "checking fallbacks..."));
  window._useGLParticlesInstanced = glPInstOk;

  // Three.js fallback (if instanced not available)
  var glPOk = false;
  if (!glPInstOk) {
    glPOk = (typeof initGLParticles === "function") ? initGLParticles() : false;
    console.log("Particle fallback: " + (glPOk ? "Three.js (GPU, uniform color)" : "2D Canvas (CPU)"));
  }
  window._useGLParticles = glPOk;

  // Generate candle data for all three assets
  candleData.SOL = generateCandles(88,    0.008, CONFIG.CANDLE_COUNT, 101);
  candleData.ETH = generateCandles(2050,  0.006, CONFIG.CANDLE_COUNT, 202);
  candleData.BTC = generateCandles(68000, 0.004, CONFIG.CANDLE_COUNT, 303);

  // Size the canvas to fit its container
  resizeCanvas();
  resetZoom();  // set home position (centered vertically in the world)

  // Re-size and redraw when the window changes
  window.addEventListener("resize", function() {
    cancelAnim();
    resizeCanvas();
    resetZoom();  // recalculate home for new screen size
    drawFrame();
  });

  // ================================================================
  // ZOOM / PAN HELPERS
  // ================================================================
  // Convert a screen-space point (CSS pixels relative to canvas element)
  // into chart-space coordinates (what the drawing code uses). This is
  // the INVERSE of the ctx.translate + ctx.scale transform applied in
  // drawFrame. Needed so the crosshair, candle-hover, and price readout
  // work correctly at any zoom level.

  function screenToChart(screenX, screenY) {
    return {
      x: (screenX - state.viewOffsetX) / state.viewScale,
      y: (screenY - state.viewOffsetY) / state.viewScale,
    };
  }

  // Shared drag state. Multiple event handlers read/write this.
  var panDrag = {
    active:       false,
    moved:        false,   // true once mouse has moved past dead zone
    startScreenX: 0,       // mouse position when drag started (screen coords)
    startScreenY: 0,
    startOffsetX: 0,       // viewOffset when drag started
    startOffsetY: 0,
    button:       -1,      // which mouse button started the drag
  };

  // Dead zone in pixels — mouse must move at least this far from the
  // mousedown point before a pan actually starts. Prevents tiny jitter
  // during normal clicks and double-clicks from shifting the view.
  var PAN_DEAD_ZONE = 3;

  // ================================================================
  // PAN: Left-click drag, Middle-click drag, or Ctrl+Left drag
  // ================================================================
  // Pan moves the viewport so you can explore the projection zone
  // (the "future" area to the right) or revisit earlier candles.
  //
  // Left-click drag is the primary gesture — most natural for chart
  // navigation. Middle-click also works (common in 3D apps).
  //
  // IMPORTANT: The mousemove handler for pan dragging is on WINDOW,
  // not on the canvas. This prevents the drag from breaking when the
  // mouse briefly exits the canvas during a fast swipe. The mouseup
  // is also on window for the same reason.

  canvas.addEventListener("mousedown", function(e) {
    // Left button (with or without Ctrl) OR middle button
    var isPanGesture = (e.button === 0) || (e.button === 1);
    if (!isPanGesture) return;

    e.preventDefault();  // prevent middle-click auto-scroll & text selection

    var rect = canvas.getBoundingClientRect();
    panDrag.active       = true;
    panDrag.moved        = false;
    panDrag.button       = e.button;
    panDrag.startScreenX = e.clientX - rect.left;
    panDrag.startScreenY = e.clientY - rect.top;
    panDrag.startOffsetX = state.viewOffsetX;
    panDrag.startOffsetY = state.viewOffsetY;

    // Don't change cursor yet — wait until dead zone is crossed
    // (handled in the window mousemove handler)
  });

  // Pan drag movement — on WINDOW so it tracks even outside the canvas.
  // This is the fix for the interrupted-drag bug: when the mouse exits
  // the canvas briefly during a fast swipe, window still gets mousemove.
  window.addEventListener("mousemove", function(e) {
    if (!panDrag.active) return;

    var rect = canvas.getBoundingClientRect();
    var screenX = e.clientX - rect.left;
    var screenY = e.clientY - rect.top;

    // Dead zone: don't start panning until mouse has moved enough.
    // This prevents micro-pans during normal clicks and double-clicks.
    if (!panDrag.moved) {
      var dx = screenX - panDrag.startScreenX;
      var dy = screenY - panDrag.startScreenY;
      if (Math.abs(dx) < PAN_DEAD_ZONE && Math.abs(dy) < PAN_DEAD_ZONE) {
        return;  // still inside dead zone, don't pan yet
      }
      panDrag.moved = true;
      canvas.style.cursor = "grabbing";
    }

    state.viewOffsetX = panDrag.startOffsetX + (screenX - panDrag.startScreenX);
    state.viewOffsetY = panDrag.startOffsetY + (screenY - panDrag.startScreenY);

    // Clamp so viewport stays within world bounds (no black edges)
    clampPan();

    // Update crosshair while panning
    var chart = screenToChart(screenX, screenY);
    crosshair.x = chart.x;
    crosshair.y = chart.y;

    // Redraw (particle mode already redraws every frame)
    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  });

  // End pan on mouseup — on WINDOW so releasing outside canvas still works.
  window.addEventListener("mouseup", function(e) {
    if (!panDrag.active) return;

    panDrag.active = false;
    panDrag.button = -1;
    canvas.style.cursor = "grab";  // back to grab hint (was "grabbing")

    // Redraw to clear any artifacts
    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  });

  // ---- Crosshair mouse tracking (non-drag) ----
  // Updates the crosshair position when NOT dragging. During a drag,
  // the window-level mousemove handler updates the crosshair instead.
  canvas.addEventListener("mousemove", function(e) {
    if (panDrag.active) return;  // drag handler takes care of it

    var rect = canvas.getBoundingClientRect();
    var screenX = e.clientX - rect.left;
    var screenY = e.clientY - rect.top;

    var chart = screenToChart(screenX, screenY);
    crosshair.x = chart.x;
    crosshair.y = chart.y;
    crosshair.visible = true;

    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  });

  canvas.addEventListener("mouseleave", function() {
    // Don't hide crosshair during a pan drag — the window-level
    // handler is still tracking and the user expects to see the
    // chart update smoothly even if the cursor exits briefly.
    if (panDrag.active) return;

    crosshair.visible = false;
    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  });

  canvas.addEventListener("mouseenter", function(e) {
    // Re-show crosshair when mouse comes back
    if (!panDrag.active) {
      crosshair.visible = true;
    }
  });

  // ================================================================
  // ZOOM: Scroll wheel centered on cursor
  // ================================================================
  // Zoom works like Google Maps: the point under the cursor stays
  // pinned in place as the scale changes. This makes it easy to
  // zoom into a specific candle or projection feature.
  //
  // Math: if a chart-space point C is at screen position S:
  //   S = C * scale + offset
  // After changing scale to newScale, we want S to stay the same:
  //   S = C * newScale + newOffset
  //   newOffset = S - C * newScale

  canvas.addEventListener("wheel", function(e) {
    e.preventDefault();  // don't scroll the page

    var rect = canvas.getBoundingClientRect();
    var screenX = e.clientX - rect.left;
    var screenY = e.clientY - rect.top;

    // Figure out what chart-space point is under the cursor
    var chartPt = screenToChart(screenX, screenY);

    // Zoom factor: negative deltaY = scroll up = zoom in
    var zoomFactor = 1.1;
    var direction = e.deltaY < 0 ? 1 : -1;
    var newScale = state.viewScale * Math.pow(zoomFactor, direction);

    // Clamp: don't zoom out past the world boundary, don't zoom in past 20×.
    // getMinZoom() returns 1/EXPLORE_MULTIPLIER so the world always fills
    // the screen — no black edges ever appear.
    var minZ = getMinZoom();
    newScale = Math.max(minZ, Math.min(20.0, newScale));

    // Snap to 1.0 if we're very close (avoids floating point drift)
    if (Math.abs(newScale - 1.0) < 0.03) newScale = 1.0;

    // Pin the chart point under the cursor to its current screen position
    state.viewOffsetX = screenX - chartPt.x * newScale;
    state.viewOffsetY = screenY - chartPt.y * newScale;
    state.viewScale   = newScale;

    // Clamp pan so the viewport stays within world bounds
    clampPan();

    // Redraw
    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  }, { passive: false });

  // ================================================================
  // RESET: Double-click resets zoom/pan to default
  // ================================================================
  canvas.addEventListener("dblclick", function(e) {
    // Only reset if we're not already at home position
    var home = getHomeOffset();
    var isAtHome = state.viewScale === 1.0
                && Math.abs(state.viewOffsetX - home.x) < 1
                && Math.abs(state.viewOffsetY - home.y) < 1;
    if (isAtHome) return;

    state.viewScale   = 1.0;
    state.viewOffsetX = home.x;
    state.viewOffsetY = home.y;

    if (state.mode !== "particle" && !state.animating) {
      drawFrame();
    }
  });

  // ---- Prevent browser defaults that interfere with pan ----

  // Middle-click auto-scroll (the scroll circle icon).
  // Both pointerdown and auxclick need to be handled for cross-browser
  // compatibility — some browsers trigger auto-scroll from pointerdown
  // before mousedown even fires.
  canvas.addEventListener("pointerdown", function(e) {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener("auxclick", function(e) {
    if (e.button === 1) e.preventDefault();
  });

  // Prevent default drag behavior (image drag, text selection)
  canvas.addEventListener("dragstart", function(e) {
    e.preventDefault();
  });

  // Set initial UI state — push all state values into HTML controls
  syncUIToState();
  updateLegend();
  updateProgress();

  // ---- Clean up old localStorage keys (one-time migration) ----
  try {
    localStorage.removeItem("cpv_cache");
    localStorage.removeItem("cg_api_key");   // old key name from earlier CG implementation
  } catch (e) { /* ignore */ }

  // ---- Set up data source UI (CoinGecko key, default source) ----
  initDataSource();

  // ---- Restore cached Binance data from localStorage ----
  // This means page reloads don't require fresh API calls if the
  // cached data is still within its freshness window.
  var restored = loadCacheFromStorage();
  if (restored > 0) {
    var statusEl = document.getElementById("data-status");
    if (statusEl) {
      statusEl.textContent = "Restored " + restored + " cached symbols";
      statusEl.style.color = "#00c080";
    }
  }

  // Preprocess sight lines + calibration, then draw the first frame.
  // This ensures the initial view matches what you'd see after an
  // animation plays through to the end — all calibration data and
  // precomputed visibility pairs are ready from the start.
  preprocessChart(function() {
    drawFrame();
  });
}

// Go!
init();
