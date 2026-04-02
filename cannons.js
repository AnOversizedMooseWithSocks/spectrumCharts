/*
 * ================================================================
 * cannons.js  —  Candle Cannons (Fun Mode)
 * ================================================================
 * Depends on: config.js (CONFIG, state, ctx, canvas)
 *             coords.js (priceToY, indexToX, getChartDims)
 *
 * Since candle data doesn't change between fetches, every cannon
 * trajectory is fully deterministic. We simulate ALL paths once
 * up front (when data changes or mode is toggled on), store the
 * resulting polylines and splat positions, then just draw static
 * geometry each frame. Zero per-frame physics.
 *
 * Architecture:
 *   _computeCannonPaths()  — runs once, simulates every ball to
 *                            completion, stores trail polylines
 *                            and splat markers.
 *   drawCannons()          — draws the pre-computed paths + barrels
 *                            + splats. Called every frame from
 *                            drawFrame(), pure rendering.
 *
 * Cache is keyed on candle count + first/last candle OHLC so it
 * auto-invalidates when data changes (fetch, animation step, etc).
 *
 * Toggle: state.showCannons (button in main toolbar)
 * ================================================================
 */

// ----------------------------------------------------------------
// TUNING CONSTANTS
// ----------------------------------------------------------------
var CANNON_GRAVITY      = 0.15;   // gravity magnitude (px/frame²)
var CANNON_BALL_RADIUS  = 3;      // cannonball dot radius
var CANNON_BASE_SPEED   = 3.0;    // minimum launch speed
var CANNON_SPEED_SCALE  = 0.5;    // extra speed per px of candle body
var CANNON_MAX_STEPS    = 300;    // max simulation steps per ball
var CANNON_TRAIL_ALPHA  = 0.35;   // trail line opacity
var CANNON_SPLAT_ALPHA  = 0.6;    // splat marker opacity

// ----------------------------------------------------------------
// PRE-COMPUTED DATA CACHE
// ----------------------------------------------------------------
// Stores the results of _computeCannonPaths(). Invalidated when
// the cache key changes (candle data changed).
var _cannonCache = {
  key:    "",        // cache key string
  paths:  [],        // array of { trail: [{x,y}...], color, splatX, splatY, hasSplat }
  peaks:  [],        // array of { index, type, angle } for barrel drawing
};

// ----------------------------------------------------------------
// PRE-COMPUTED PROJECTION CANNON CACHE
// ----------------------------------------------------------------
// Same structure as _cannonCache but for cannons fired from the
// prediction line's peaks/valleys. Separate cache because it
// changes whenever the projection changes (which is more frequent
// than real candle data changes).
var _projCannonCache = {
  key:    "",
  paths:  [],
  peaks:  [],
};
var _projCannonExhaustion = null;  // { zones: [...] }


// ================================================================
// PEAK / VALLEY DETECTION
// ================================================================
// A PEAK has its high >= both neighbors' highs → top cannon.
// A VALLEY has its low <= both neighbors' lows → bottom cannon.

function _findPeaksAndValleys(candles) {
  var result = [];
  for (var i = 1; i < candles.length - 1; i++) {
    var prev = candles[i - 1];
    var curr = candles[i];
    var next = candles[i + 1];

    if (curr.h >= prev.h && curr.h >= next.h) {
      result.push({ index: i, type: "peak" });
    }
    if (curr.l <= prev.l && curr.l <= next.l) {
      result.push({ index: i, type: "valley" });
    }
  }
  return result;
}


// ================================================================
// SEGMENT vs AABB
// ================================================================
// Slab method: tests if line segment (x0,y0)→(x1,y1) intersects box.

function _segmentHitsAABB(x0, y0, x1, y1, box) {
  var dx = x1 - x0;
  var dy = y1 - y0;
  var tMinX, tMaxX, tMinY, tMaxY;

  if (Math.abs(dx) < 0.001) {
    if (x0 < box.left || x0 > box.right) return false;
    tMinX = 0; tMaxX = 1;
  } else {
    var invDx = 1 / dx;
    var t1 = (box.left - x0) * invDx;
    var t2 = (box.right - x0) * invDx;
    tMinX = Math.min(t1, t2);
    tMaxX = Math.max(t1, t2);
  }

  if (Math.abs(dy) < 0.001) {
    if (y0 < box.top || y0 > box.bottom) return false;
    tMinY = 0; tMaxY = 1;
  } else {
    var invDy = 1 / dy;
    var t3 = (box.top - y0) * invDy;
    var t4 = (box.bottom - y0) * invDy;
    tMinY = Math.min(t3, t4);
    tMaxY = Math.max(t3, t4);
  }

  return Math.max(tMinX, tMinY, 0) <= Math.min(tMaxX, tMaxY, 1);
}


// ================================================================
// BUILD CACHE KEY
// ================================================================
// Changes when candle count changes, or when first/last candle data
// changes (new fetch, animation step, etc).

function _cannonCacheKey(candles, dims) {
  if (!candles || candles.length < 3) return "";
  var first = candles[0];
  var last  = candles[candles.length - 1];
  return candles.length + "|" +
    first.o + "," + first.c + "," + first.h + "," + first.l + "|" +
    last.o + "," + last.c + "," + last.h + "," + last.l + "|" +
    dims.chartWidth + "," + dims.chartHeight;
}


// ================================================================
// PRE-COMPUTE ALL CANNON PATHS
// ================================================================
// Finds peaks/valleys, builds collision geometry, then simulates
// every ball from launch to collision/expiry. Stores the complete
// trail polyline and splat position for each ball. Runs once per
// data change — typically takes <5ms for ~40 balls × 300 steps.

function _computeCannonPaths(candles, dims, priceMin, priceMax) {
  var paths = [];
  var peaks = _findPeaksAndValleys(candles);

  // ---- Build collision AABBs (full wick range, full slot width) ----
  var candleW  = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var halfSlot = candleW * 0.5;
  var colliders = [];

  for (var i = 0; i < candles.length; i++) {
    var c  = candles[i];
    var cx = indexToX(i, candles.length, dims.chartLeft, dims.chartWidth);
    var highY = priceToY(c.h, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var lowY  = priceToY(c.l, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    colliders.push({
      left: cx - halfSlot, right: cx + halfSlot,
      top: highY, bottom: lowY,
    });
  }

  var chartBottom = dims.chartTop + dims.chartHeight;
  var chartRight  = dims.width;

  // ---- Simulate each cannon ----
  for (var pi = 0; pi < peaks.length; pi++) {
    var entry = peaks[pi];
    var idx   = entry.index;
    var curr  = candles[idx];
    var prev  = candles[idx - 1];  // guaranteed by _findPeaksAndValleys (i >= 1)
    var next  = candles[idx + 1];  // guaranteed by _findPeaksAndValleys (i < len-1)

    var cannonX = indexToX(idx, candles.length, dims.chartLeft, dims.chartWidth);

    // Aim target: average of both neighbors' close prices.
    // At a peak, both neighbors are lower → target is below → barrel points down.
    // At a valley, both neighbors are higher → target is above → barrel points up.
    var avgClosePrice = (prev.c + next.c) / 2;
    var avgCloseY = priceToY(avgClosePrice, priceMin, priceMax, dims.chartTop, dims.chartHeight);

    // Aim from the cannon's mount point (high for peaks, low for valleys)
    var mountY;
    if (entry.type === "peak") {
      mountY = priceToY(curr.h, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    } else {
      mountY = priceToY(curr.l, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    }

    // Direction vector: from mount point toward the averaged neighbor target.
    // Use a fixed horizontal offset (one candle width) so the barrel length
    // is consistent — only the vertical angle varies.
    var aimDx = candleW;  // always point rightward by one slot
    var aimDy = avgCloseY - mountY;
    var dist = Math.sqrt(aimDx * aimDx + aimDy * aimDy);
    if (dist < 1) continue;
    var nx = aimDx / dist;
    var ny = aimDy / dist;

    // Store barrel info on the peak entry for drawing
    entry.nx = nx;
    entry.ny = ny;

    // Speed: driven by the momentum context around the peak/valley.
    // Average the previous candle's open with the next candle's close,
    // then measure the distance from that average to the cannon candle's
    // close. Bigger divergence = stronger momentum = faster ball.
    var neighborAvg = (prev.o + next.c) / 2;
    var powerDiff = Math.abs(neighborAvg - curr.c);
    var powerPixels = Math.abs(
      priceToY(neighborAvg, priceMin, priceMax, dims.chartTop, dims.chartHeight) -
      priceToY(curr.c, priceMin, priceMax, dims.chartTop, dims.chartHeight)
    );
    var speed = CANNON_BASE_SPEED + powerPixels * CANNON_SPEED_SCALE;
    speed = Math.max(CANNON_BASE_SPEED, Math.min(speed, 18));

    // Color by cannon type, not candle direction.
    // Yellow = downward momentum force (from peaks, gravity pulls down)
    // Blue   = upward momentum force (from valleys, gravity pulls up)
    var ballColor = (entry.type === "peak") ? "#f0c828" : "#40a8f0";

    // Launch position and velocity
    var startX = cannonX;
    var startY = mountY + (entry.type === "peak" ? -5 : 5);  // offset slightly away from candle
    var launchVx = nx * speed;  // nx is always positive (rightward)
    var gravDir = (entry.type === "peak") ? +1 : -1;

    // ---- Simulate this ball to completion ----
    var trail = [{ x: startX, y: startY }];
    var bx = startX, by = startY;
    var bvx = launchVx, bvy = 0;  // pure horizontal launch — gravity creates the arc
    var hasSplat = false;
    var splatX = 0, splatY = 0;

    for (var step = 0; step < CANNON_MAX_STEPS; step++) {
      var prevBx = bx, prevBy = by;

      // Gravity + move
      bvy += CANNON_GRAVITY * gravDir;
      bx += bvx;
      by += bvy;

      // Collision: candles (segment test)
      var hit = false;
      for (var ci = 0; ci < colliders.length; ci++) {
        if (ci === idx) continue;  // skip source candle
        if (_segmentHitsAABB(prevBx, prevBy, bx, by, colliders[ci])) {
          hit = true;
          break;
        }
      }

      // Collision: chart edges
      if (by > chartBottom || by < dims.chartTop ||
          bx > chartRight + 30 || bx < dims.chartLeft - 30) {
        bx = Math.max(dims.chartLeft - 30, Math.min(bx, chartRight + 30));
        by = Math.max(dims.chartTop, Math.min(by, chartBottom));
        hit = true;
      }

      trail.push({ x: bx, y: by });

      if (hit) {
        hasSplat = true;
        splatX = bx;
        splatY = by;
        break;
      }
    }

    paths.push({
      trail:      trail,
      color:      ballColor,
      hasSplat:   hasSplat,
      splatX:     splatX,
      splatY:     splatY,
      // Convert splat Y pixel back to price for exhaustion zone binning.
      // priceMax is at chartTop, priceMin is at chartTop + chartHeight.
      splatPrice: hasSplat
        ? priceMax - (splatY - dims.chartTop) / dims.chartHeight * (priceMax - priceMin)
        : 0,
      sourceIdx:  idx,           // candle index this cannon fired from
      age:        trail.length,  // used to vary splat rotation
    });
  }

  // Store in cache
  _cannonCache.paths = paths;
  _cannonCache.peaks = peaks;
}


// ================================================================
// DRAW EVERYTHING (pure rendering, no simulation)
// ================================================================
// Draws pre-computed trail polylines, splat markers, cannon barrels,
// and ball dots at the end of each trail. Called every frame from
// drawFrame() inside the zoom/pan transform.

function _drawCannonPaths(candles, dims, priceMin, priceMax) {
  var paths = _cannonCache.paths;
  var peaks = _cannonCache.peaks;

  // ---- Draw full trail polylines ----
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;

  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    var trail = p.trail;
    if (trail.length < 2) continue;

    ctx.globalAlpha = CANNON_TRAIL_ALPHA;
    ctx.strokeStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(trail[0].x, trail[0].y);
    for (var ti = 1; ti < trail.length; ti++) {
      ctx.lineTo(trail[ti].x, trail[ti].y);
    }
    ctx.stroke();

    // ---- Splat marker at collision point ----
    if (p.hasSplat) {
      ctx.globalAlpha = CANNON_SPLAT_ALPHA;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.splatX, p.splatY, CANNON_BALL_RADIUS * 0.9, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.0;
      for (var si = 0; si < 6; si++) {
        var sAngle = (si / 6) * Math.PI * 2 + p.age * 0.1;
        var sLen = CANNON_BALL_RADIUS * 1.5;
        ctx.beginPath();
        ctx.moveTo(p.splatX, p.splatY);
        ctx.lineTo(
          p.splatX + Math.cos(sAngle) * sLen,
          p.splatY + Math.sin(sAngle) * sLen
        );
        ctx.stroke();
      }
    }
  }

  // ---- Draw cannon barrels ----
  var candleW   = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var barrelLen = Math.max(6, candleW * 0.6);

  ctx.globalAlpha = 1;
  for (var pi = 0; pi < peaks.length; pi++) {
    var entry = peaks[pi];
    var idx   = entry.index;
    var curr  = candles[idx];
    var cx    = indexToX(idx, candles.length, dims.chartLeft, dims.chartWidth);

    var mountY;
    if (entry.type === "peak") {
      mountY = priceToY(curr.h, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    } else {
      mountY = priceToY(curr.l, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    }

    var endX = cx + entry.nx * barrelLen;
    var endY = mountY + entry.ny * barrelLen;

    // Barrel line
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, mountY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Muzzle dot
    ctx.fillStyle = "#aaa";
    ctx.beginPath();
    ctx.arc(endX, endY, 2, 0, Math.PI * 2);
    ctx.fill();

    // Base circle
    ctx.fillStyle = "#555";
    ctx.beginPath();
    ctx.arc(cx, mountY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}


// ================================================================
// PUBLIC API — called from main.js drawFrame()
// ================================================================
// Checks cache validity, recomputes if stale, then draws.
// No animation loop needed — this is pure static rendering.

function updateAndDrawCannons(candles, dims, priceMin, priceMax) {
  // Compute paths when ANY cannon feature is active
  // (visual trails, exhaustion zones, or prediction signal)
  var needPaths = state.showCannons || state.showCannonZones || state.predCannon;
  if (!needPaths) return;
  if (!candles || candles.length < 3) return;

  // Check if we need to recompute
  var key = _cannonCacheKey(candles, dims);
  if (key !== _cannonCache.key) {
    _cannonCache.key = key;
    _computeCannonPaths(candles, dims, priceMin, priceMax);
    _analyzeExhaustion(priceMin, priceMax);
  }

  // Draw cannon trails + barrels (only when visual toggle is on)
  if (state.showCannons) {
    _drawCannonPaths(candles, dims, priceMin, priceMax);
  }

  // Draw exhaustion zones (independent toggle)
  if (state.showCannonZones) {
    drawCannonZones(dims, priceMin, priceMax);
  }
}

// Reset cache (called when toggling off, changing data, etc.)
function initCannonballs() {
  _cannonCache.key = "";
  _cannonCache.paths = [];
  _cannonCache.peaks = [];
  _cannonExhaustion = null;
  _projCannonCache.key = "";
  _projCannonCache.paths = [];
  _projCannonCache.peaks = [];
  _projCannonExhaustion = null;
}

// Stub for backward compat
function renderCannonTrails() {}


// ================================================================
// EXHAUSTION ZONE ANALYSIS
// ================================================================
// Scans the pre-computed splat positions, bins them into narrow
// horizontal price bands, and finds clusters where multiple balls
// of the same type (peak/valley) all exhaust their momentum at
// roughly the same price level.
//
// Yellow clusters (peak exhaustion) = downward momentum dies here = SUPPORT
// Blue clusters (valley exhaustion) = upward momentum dies here = RESISTANCE
//
// Results are cached alongside the paths.

var _cannonExhaustion = null;  // { zones: [...], priceMin, priceMax }

// Number of horizontal price bands to divide the chart into.
// More bands = finer resolution but sparser clusters.
var EXHAUSTION_BANDS = 60;

// Minimum splats in a band to qualify as an exhaustion zone.
var EXHAUSTION_MIN_SPLATS = 2;

function _analyzeExhaustion(priceMin, priceMax) {
  var paths = _cannonCache.paths;
  if (!paths || paths.length === 0) {
    _cannonExhaustion = { zones: [], priceMin: priceMin, priceMax: priceMax };
    return;
  }

  var bandHeight = (priceMax - priceMin) / EXHAUSTION_BANDS;
  if (bandHeight < 0.001) {
    _cannonExhaustion = { zones: [], priceMin: priceMin, priceMax: priceMax };
    return;
  }

  // Two separate histograms: yellow (peak) splats and blue (valley) splats
  var yellowBins = new Float32Array(EXHAUSTION_BANDS);  // weighted count
  var blueBins   = new Float32Array(EXHAUSTION_BANDS);

  // Also track total Y position in each bin for centroid calculation
  var yellowYSum = new Float32Array(EXHAUSTION_BANDS);
  var blueYSum   = new Float32Array(EXHAUSTION_BANDS);

  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    if (!p.hasSplat) continue;

    // Convert splat Y pixel back to price for binning.
    // We stored splatY as a pixel position, but we need the price band.
    // Use the cache's priceMin/priceMax that was active during computation.
    var splatPrice = p.splatPrice;  // added during computation
    if (splatPrice === undefined) continue;

    var band = Math.floor((splatPrice - priceMin) / bandHeight);
    if (band < 0 || band >= EXHAUSTION_BANDS) continue;

    // Weight by recency — later candle index = more weight.
    // p.sourceIdx is the candle index of the cannon.
    var recencyWeight = 0.3 + 0.7 * (p.sourceIdx / (_cannonCache.paths.length || 1));

    if (p.color === "#f0c828") {
      // Yellow = peak cannon = downward momentum exhaustion
      yellowBins[band] += recencyWeight;
      yellowYSum[band] += splatPrice * recencyWeight;
    } else {
      // Blue = valley cannon = upward momentum exhaustion
      blueBins[band] += recencyWeight;
      blueYSum[band] += splatPrice * recencyWeight;
    }
  }

  // Find zones: bands with enough splats
  var zones = [];
  for (var b = 0; b < EXHAUSTION_BANDS; b++) {
    if (yellowBins[b] >= EXHAUSTION_MIN_SPLATS) {
      var centroidPrice = yellowYSum[b] / yellowBins[b];
      zones.push({
        type:     "support",       // peak exhaustion = downward momentum dies = support
        price:    centroidPrice,
        priceMin: priceMin + b * bandHeight,
        priceMax: priceMin + (b + 1) * bandHeight,
        strength: yellowBins[b],
        color:    "#f0c828",   // yellow
        border:   "#f0c828",
      });
    }
    if (blueBins[b] >= EXHAUSTION_MIN_SPLATS) {
      var centroidPrice = blueYSum[b] / blueBins[b];
      zones.push({
        type:     "resistance",    // valley exhaustion = upward momentum dies = resistance
        price:    centroidPrice,
        priceMin: priceMin + b * bandHeight,
        priceMax: priceMin + (b + 1) * bandHeight,
        strength: blueBins[b],
        color:    "#40a8f0",   // blue
        border:   "#40a8f0",
      });
    }
  }

  _cannonExhaustion = { zones: zones, priceMin: priceMin, priceMax: priceMax };
}


// ================================================================
// DRAW EXHAUSTION ZONES (canvas2D, inside zoom/pan transform)
// ================================================================
// Draws semi-transparent horizontal bands at each exhaustion zone.
// Controlled by state.showCannonZones (independent of state.predCannon).

function drawCannonZones(dims, priceMin, priceMax) {
  if (!state.showCannonZones) return;
  if (!_cannonExhaustion || _cannonExhaustion.zones.length === 0) return;

  var zones = _cannonExhaustion.zones;

  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    var y1 = priceToY(z.priceMax, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var y2 = priceToY(z.priceMin, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var bandH = Math.max(2, y2 - y1);

    // Strength scales opacity — capped low so zones never dominate
    var strengthAlpha = Math.min(0.15, z.strength / 15);

    // Filled band (very subtle wash)
    ctx.globalAlpha = strengthAlpha * 0.4;
    ctx.fillStyle = z.color;
    ctx.fillRect(dims.chartLeft, y1, dims.chartWidth, bandH);

    // Single dashed border line at the centroid price
    ctx.strokeStyle = z.border;
    ctx.lineWidth = 1;
    ctx.globalAlpha = strengthAlpha * 1.2;
    ctx.setLineDash([4, 6]);
    var centroidY = (y1 + y2) / 2;
    ctx.beginPath();
    ctx.moveTo(dims.chartLeft, centroidY);
    ctx.lineTo(dims.chartLeft + dims.chartWidth, centroidY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 1;
}


// ================================================================
// PROJECTION CANNONS
// ================================================================
// Fires cannons from peaks/valleys of the prediction line's virtual
// candles, using identical physics to the real cannon system. Balls
// collide with both real candle bodies and virtual candle bodies,
// creating S/R information that visually extends into the future.
//
// The system mirrors _computeCannonPaths() but uses virtual candle
// data from projData.virtualCandles instead of real candle data.
// Results are cached separately so they refresh when the projection
// changes without invalidating the more expensive real cannon cache.

// Build a cache key from virtual candle data. Changes when the
// prediction changes (different consensus path, different step count).
function _projCannonCacheKey(virtualCandles, dims) {
  if (!virtualCandles || virtualCandles.length < 3) return "";
  var first = virtualCandles[0];
  var last  = virtualCandles[virtualCandles.length - 1];
  return "proj|" + virtualCandles.length + "|" +
    first.h.toFixed(2) + "," + first.l.toFixed(2) + "|" +
    last.h.toFixed(2) + "," + last.l.toFixed(2) + "|" +
    dims.chartWidth + "," + dims.chartHeight;
}

// Find peaks and valleys in the virtual candle series.
// Same logic as _findPeaksAndValleys but operates on the
// {x, o, h, l, c, hY, lY} objects from buildProjection.
function _findProjPeaksAndValleys(vcs) {
  var result = [];
  for (var i = 1; i < vcs.length - 1; i++) {
    var prev = vcs[i - 1];
    var curr = vcs[i];
    var next = vcs[i + 1];

    if (curr.h >= prev.h && curr.h >= next.h) {
      result.push({ index: i, type: "peak" });
    }
    if (curr.l <= prev.l && curr.l <= next.l) {
      result.push({ index: i, type: "valley" });
    }
  }
  return result;
}

// Pre-compute all projection cannon paths.
// Builds collision AABBs from both the real candles (so balls can
// fly backward into the chart) and the virtual candles (so balls
// collide with the prediction line itself).
function _computeProjCannonPaths(virtualCandles, realCandles, dims, priceMin, priceMax) {
  var paths = [];
  var peaks = _findProjPeaksAndValleys(virtualCandles);

  // ---- Build collision AABBs from REAL candles ----
  var candleW  = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var halfSlot = candleW * 0.5;
  var colliders = [];

  for (var i = 0; i < realCandles.length; i++) {
    var rc  = realCandles[i];
    var rcx = indexToX(i, realCandles.length, dims.chartLeft, dims.chartWidth);
    var rcHighY = priceToY(rc.h, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var rcLowY  = priceToY(rc.l, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    colliders.push({
      left: rcx - halfSlot, right: rcx + halfSlot,
      top: rcHighY, bottom: rcLowY,
      isVirtual: false, vcIndex: -1,
    });
  }

  // ---- Build collision AABBs from VIRTUAL candles ----
  // Virtual candles already have pixel positions (x, hY, lY).
  // Tag them so balls can skip their own source candle.
  for (var vi = 0; vi < virtualCandles.length; vi++) {
    var vc = virtualCandles[vi];
    colliders.push({
      left: vc.x - halfSlot, right: vc.x + halfSlot,
      top: vc.hY, bottom: vc.lY,
      isVirtual: true, vcIndex: vi,
    });
  }

  var chartBottom = dims.chartTop + dims.chartHeight;
  var chartRight  = dims.width;

  // ---- Simulate each cannon ----
  for (var pi = 0; pi < peaks.length; pi++) {
    var entry = peaks[pi];
    var idx   = entry.index;
    var curr  = virtualCandles[idx];
    var prev  = virtualCandles[idx - 1];
    var next  = virtualCandles[idx + 1];

    var cannonX = curr.x;

    // Aim target: average of both neighbors' close prices
    var avgClosePrice = (prev.c + next.c) / 2;
    var avgCloseY = priceToY(avgClosePrice, priceMin, priceMax, dims.chartTop, dims.chartHeight);

    // Mount point (high for peaks, low for valleys)
    var mountY = (entry.type === "peak") ? curr.hY : curr.lY;

    // Direction vector: from mount toward averaged neighbor target
    var aimDx = candleW;
    var aimDy = avgCloseY - mountY;
    var dist = Math.sqrt(aimDx * aimDx + aimDy * aimDy);
    if (dist < 1) continue;
    var nx = aimDx / dist;
    var ny = aimDy / dist;

    // Store barrel info for drawing
    entry.nx = nx;
    entry.ny = ny;
    entry.cannonX = cannonX;
    entry.mountY  = mountY;

    // Speed: driven by momentum context (same formula as real cannons)
    var neighborAvg = (prev.o + next.c) / 2;
    var powerPixels = Math.abs(
      priceToY(neighborAvg, priceMin, priceMax, dims.chartTop, dims.chartHeight) -
      priceToY(curr.c, priceMin, priceMax, dims.chartTop, dims.chartHeight)
    );
    var speed = CANNON_BASE_SPEED + powerPixels * CANNON_SPEED_SCALE;
    speed = Math.max(CANNON_BASE_SPEED, Math.min(speed, 18));

    var ballColor = (entry.type === "peak") ? "#f0c828" : "#40a8f0";

    // Launch position and velocity
    var startX = cannonX;
    var startY = mountY + (entry.type === "peak" ? -5 : 5);
    var launchVx = nx * speed;
    var gravDir = (entry.type === "peak") ? +1 : -1;

    // ---- Simulate this ball to completion ----
    var trail = [{ x: startX, y: startY }];
    var bx = startX, by = startY;
    var bvx = launchVx, bvy = 0;
    var hasSplat = false;
    var splatX = 0, splatY = 0;

    for (var step = 0; step < CANNON_MAX_STEPS; step++) {
      var prevBx = bx, prevBy = by;

      // Gravity + move
      bvy += CANNON_GRAVITY * gravDir;
      bx += bvx;
      by += bvy;

      // Collision against all candle bodies (real + virtual)
      var hit = false;
      for (var ci = 0; ci < colliders.length; ci++) {
        var col = colliders[ci];
        // Skip the source virtual candle
        if (col.isVirtual && col.vcIndex === idx) continue;
        if (_segmentHitsAABB(prevBx, prevBy, bx, by, col)) {
          hit = true;
          break;
        }
      }

      // Collision: chart edges
      if (by > chartBottom || by < dims.chartTop ||
          bx > chartRight + 30 || bx < dims.chartLeft - 30) {
        bx = Math.max(dims.chartLeft - 30, Math.min(bx, chartRight + 30));
        by = Math.max(dims.chartTop, Math.min(by, chartBottom));
        hit = true;
      }

      trail.push({ x: bx, y: by });

      if (hit) {
        hasSplat = true;
        splatX = bx;
        splatY = by;
        break;
      }
    }

    paths.push({
      trail:      trail,
      color:      ballColor,
      hasSplat:   hasSplat,
      splatX:     splatX,
      splatY:     splatY,
      splatPrice: hasSplat
        ? priceMax - (splatY - dims.chartTop) / dims.chartHeight * (priceMax - priceMin)
        : 0,
      sourceIdx:  idx,
      age:        trail.length,
    });
  }

  _projCannonCache.paths = paths;
  _projCannonCache.peaks = peaks;
}


// Analyze projection cannon exhaustion zones (same algorithm as
// _analyzeExhaustion but stored in _projCannonExhaustion).
function _analyzeProjExhaustion(priceMin, priceMax) {
  var paths = _projCannonCache.paths;
  if (!paths || paths.length === 0) {
    _projCannonExhaustion = { zones: [], priceMin: priceMin, priceMax: priceMax };
    return;
  }

  var bandHeight = (priceMax - priceMin) / EXHAUSTION_BANDS;
  if (bandHeight < 0.001) {
    _projCannonExhaustion = { zones: [], priceMin: priceMin, priceMax: priceMax };
    return;
  }

  var yellowBins = new Float32Array(EXHAUSTION_BANDS);
  var blueBins   = new Float32Array(EXHAUSTION_BANDS);
  var yellowYSum = new Float32Array(EXHAUSTION_BANDS);
  var blueYSum   = new Float32Array(EXHAUSTION_BANDS);

  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    if (!p.hasSplat || p.splatPrice === undefined) continue;

    var band = Math.floor((p.splatPrice - priceMin) / bandHeight);
    if (band < 0 || band >= EXHAUSTION_BANDS) continue;

    // Weight by position in prediction — later steps = more speculative = less weight
    var recencyWeight = 0.5 + 0.5 * (1 - p.sourceIdx / (paths.length || 1));

    if (p.color === "#f0c828") {
      yellowBins[band] += recencyWeight;
      yellowYSum[band] += p.splatPrice * recencyWeight;
    } else {
      blueBins[band] += recencyWeight;
      blueYSum[band] += p.splatPrice * recencyWeight;
    }
  }

  var zones = [];
  for (var b = 0; b < EXHAUSTION_BANDS; b++) {
    if (yellowBins[b] >= EXHAUSTION_MIN_SPLATS) {
      zones.push({
        type:     "support",
        price:    yellowYSum[b] / yellowBins[b],
        priceMin: priceMin + b * bandHeight,
        priceMax: priceMin + (b + 1) * bandHeight,
        strength: yellowBins[b],
        color:    "#f0c828",
        border:   "#f0c828",
      });
    }
    if (blueBins[b] >= EXHAUSTION_MIN_SPLATS) {
      zones.push({
        type:     "resistance",
        price:    blueYSum[b] / blueBins[b],
        priceMin: priceMin + b * bandHeight,
        priceMax: priceMin + (b + 1) * bandHeight,
        strength: blueBins[b],
        color:    "#40a8f0",
        border:   "#40a8f0",
      });
    }
  }

  _projCannonExhaustion = { zones: zones, priceMin: priceMin, priceMax: priceMax };
}


// Draw projection cannon trails, splats, and barrels.
// Same rendering style as real cannons but slightly more transparent
// so they read as "predicted" rather than "actual" trajectories.
function _drawProjCannonPaths(virtualCandles, dims) {
  var paths = _projCannonCache.paths;
  var peaks = _projCannonCache.peaks;
  if (!paths || paths.length === 0) return;

  var candleW   = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var barrelLen = Math.max(6, candleW * 0.6);

  // ---- Trail polylines (more transparent than real cannons) ----
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.2;

  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    var trail = p.trail;
    if (trail.length < 2) continue;

    ctx.globalAlpha = CANNON_TRAIL_ALPHA * 0.6;
    ctx.strokeStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(trail[0].x, trail[0].y);
    for (var ti = 1; ti < trail.length; ti++) {
      ctx.lineTo(trail[ti].x, trail[ti].y);
    }
    ctx.stroke();

    // Splat marker
    if (p.hasSplat) {
      ctx.globalAlpha = CANNON_SPLAT_ALPHA * 0.5;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.splatX, p.splatY, CANNON_BALL_RADIUS * 0.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = p.color;
      ctx.lineWidth = 0.8;
      for (var si = 0; si < 5; si++) {
        var sAngle = (si / 5) * Math.PI * 2 + p.age * 0.1;
        var sLen = CANNON_BALL_RADIUS * 1.2;
        ctx.beginPath();
        ctx.moveTo(p.splatX, p.splatY);
        ctx.lineTo(
          p.splatX + Math.cos(sAngle) * sLen,
          p.splatY + Math.sin(sAngle) * sLen
        );
        ctx.stroke();
      }
    }
  }

  // ---- Cannon barrels at virtual candle peaks/valleys ----
  ctx.globalAlpha = 0.6;
  for (var pi = 0; pi < peaks.length; pi++) {
    var entry = peaks[pi];
    if (!entry.nx) continue;

    var cx = entry.cannonX;
    var my = entry.mountY;
    var endX = cx + entry.nx * barrelLen;
    var endY = my + entry.ny * barrelLen;

    // Barrel line (lighter than real cannon barrels)
    ctx.strokeStyle = "#777";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, my);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Muzzle dot
    ctx.fillStyle = "#999";
    ctx.beginPath();
    ctx.arc(endX, endY, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Base circle
    ctx.fillStyle = "#555";
    ctx.beginPath();
    ctx.arc(cx, my, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}


// ================================================================
// PUBLIC API: Projection Cannons
// ================================================================
// Called from main.js after projection is rendered. Computes paths
// from virtual candle peaks/valleys, draws trails, and updates
// exhaustion zones for the cannon signal query.

function updateAndDrawProjectionCannons(projData, candles, dims, priceMin, priceMax) {
  if (!projData || !projData.virtualCandles) return;
  var vcs = projData.virtualCandles;
  if (vcs.length < 3) return;

  // Only compute if cannon features are active
  var needPaths = state.showCannons || state.predCannon;
  if (!needPaths) {
    // Clear stale projection exhaustion so cannonSignal doesn't use old data
    _projCannonExhaustion = null;
    return;
  }

  // Check if recompute is needed
  var key = _projCannonCacheKey(vcs, dims);
  if (key !== _projCannonCache.key) {
    _projCannonCache.key = key;
    _computeProjCannonPaths(vcs, candles, dims, priceMin, priceMax);
    _analyzeProjExhaustion(priceMin, priceMax);
  }

  // Draw projection cannon trails (only when visual toggle is on)
  if (state.showCannons) {
    _drawProjCannonPaths(vcs, dims);
  }
}


// ================================================================
// CANNON SIGNAL QUERY (for prediction pipeline)
// ================================================================
// Returns a directional signal based on proximity of the given
// price to the nearest exhaustion zone. Checks BOTH real cannon
// exhaustion zones and projection cannon exhaustion zones.
// Used by projection.js as a post-pipeline force alongside
// corridor and LSSA.
//
// Returns: { signal: -1..+1, clarity: 0..1 }
//   signal > 0 = bullish push (near support zone, expect bounce up)
//   signal < 0 = bearish push (near resistance zone, expect rejection down)
//   clarity    = how strong/confident the zone is
//
// priceY is in pixel coords (same as the prediction step's Y position).

function cannonSignal(priceY, dims, priceMin, priceMax) {
  var result = { signal: 0, clarity: 0 };
  if (!state.predCannon) return result;

  // Convert priceY pixel to price value
  var priceRange = priceMax - priceMin;
  if (priceRange < 0.001) return result;
  var price = priceMax - (priceY - dims.chartTop) / dims.chartHeight * priceRange;

  // Gather zones from both real and projection exhaustion analyses
  var allZones = [];
  if (_cannonExhaustion && _cannonExhaustion.zones.length > 0) {
    allZones = allZones.concat(_cannonExhaustion.zones);
  }
  if (_projCannonExhaustion && _projCannonExhaustion.zones.length > 0) {
    allZones = allZones.concat(_projCannonExhaustion.zones);
  }
  if (allZones.length === 0) return result;

  // Find the nearest zone and its influence
  var bestSignal = 0;
  var bestClarity = 0;

  for (var i = 0; i < allZones.length; i++) {
    var z = allZones[i];
    var zoneMid = (z.priceMin + z.priceMax) / 2;
    var zoneHalf = (z.priceMax - z.priceMin) / 2;

    // Distance from price to zone center, in units of zone half-width.
    // Inside the zone = dist < 1.0.  Up to 3× zone width away = still felt.
    var dist = Math.abs(price - zoneMid) / Math.max(zoneHalf, 0.001);

    // Influence falls off with distance: full inside, fades to zero at 3× width
    var influence = 0;
    if (dist < 3.0) {
      influence = 1 - dist / 3.0;
    }
    if (influence <= 0) continue;

    // Zone strength scales clarity
    var zClarity = Math.min(1, z.strength / 5) * influence;

    // Direction: support zones push UP (+1), resistance zones push DOWN (-1)
    var zSignal;
    if (z.type === "support") {
      zSignal = influence;   // bullish
    } else {
      zSignal = -influence;  // bearish
    }

    // Keep the strongest signal
    if (zClarity > bestClarity) {
      bestClarity = zClarity;
      bestSignal = zSignal;
    }
  }

  result.signal = bestSignal;
  result.clarity = bestClarity;
  return result;
}
