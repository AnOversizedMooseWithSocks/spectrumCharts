/*
 * ================================================================
 * particles.js  —  Terrain Flow Particle Visualization
 * ================================================================
 * Depends on: config.js (CONFIG, ctx, canvas),
 *             coords.js (priceToY, indexToX, getPriceRange)
 *
 * TERRAIN FLOW MODEL:
 *
 * The light field intensity is treated as terrain elevation.
 * Particles spawn at the left edge and flow rightward across this
 * landscape, through the candle area and into the projection zone:
 *
 *   - FORWARD PUSH: constant rightward tendency (tilted table)
 *   - Y-STEERING: the Y-gradient steers particles up/down to
 *     find valleys (low-intensity paths of least resistance)
 *   - UPHILL BRAKING: moving into higher intensity costs momentum
 *     — fast particles can crest small ridges, slow ones deflect
 *   - DOWNHILL BOOST: moving into lower intensity adds speed
 *   - RIDGE DEFLECTION: Y-push at ridge cells routes particles
 *     around S/R barriers
 *   - VALLEY BOOST: small forward acceleration in valleys
 *
 * Particles flow through candles (not blocked by them) — the
 * topology of the light field is the only terrain. Wick nudges
 * and wake vortex from the baked force field still influence flow.
 *
 * Particles that exit the right edge of the world (past the
 * projection zone) recycle to the left edge, maintaining a
 * continuous forward flow.
 *
 * Color tints from cool (valleys) to warm (ridges) based on local
 * light field intensity.
 *
 * ================================================================
 */

// Spatial grid for particle-particle repulsion.
// Exponential force: grows rapidly as particles get close.
// Each particle stores its total repulsionPressure for measurement.
var GRID_CELL = 75;
var REPULSE_RADIUS  = 72;
var REPULSE_RADIUS2 = REPULSE_RADIUS * REPULSE_RADIUS;
var REPULSE_BASE    = 0.60;   // base force magnitude
var REPULSE_EXPO    = 2.5;    // lower exponent = force engages earlier at distance

// Surface drag
var DRAG_RANGE    = 12;
var DRAG_STRENGTH = 0.35;


// ================================================================
// FORCE FIELD + GEOMETRY CACHES
// ================================================================
// Force field: 2D grid of pre-baked forces per cell.
// Geometry cache: flat typed array of candle pixel coordinates.
// Both rebuilt only when candle data / chart dims change.

var _forceField = null;       // { fx, fy, drag } Float32Arrays
var _ffCols = 0;
var _ffRows = 0;
var _ffCacheKey = "";

var _candleGeomCache = null;  // Float64Array: 7 floats per candle
var _geomCacheKey = "";
// Layout per candle: [cx, highY, lowY, bodyTop, bodyBot, leftEdge, rightEdge]
var GEOM_STRIDE = 7;

// Flat spatial grid arrays (reused across frames, grown as needed)
var _sgHead = null;           // Int32Array: first particle per cell (-1 = empty)
var _sgNext = null;           // Int32Array: next particle in chain (-1 = end)
var _sgCols = 0;
var _sgRows = 0;


function createParticles() {
  return [];
}


// ================================================================
// CANDLE GEOMETRY CACHE
// ================================================================
// Compute pixel coordinates for all candle bodies once, store in
// a flat Float64Array for cache-friendly sequential access.

function getCandleGeom(candles, dims) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var count       = candles.length;
  var candleW     = chartWidth / CONFIG.CANDLE_COUNT;
  var bodyHalfW   = candleW * 0.5 + 1;  // slightly wider to seal gaps

  var range    = getPriceRange(candles);
  var priceMin = range.priceMin;
  var priceMax = range.priceMax;

  var key = count + "-" + chartLeft + "-" + chartWidth + "-" + chartTop
    + "-" + chartHeight + "-" + priceMin.toFixed(4) + "-" + priceMax.toFixed(4);

  if (_geomCacheKey === key && _candleGeomCache) {
    return _candleGeomCache;
  }

  var arr = new Float64Array(count * GEOM_STRIDE);

  for (var i = 0; i < count; i++) {
    var c   = candles[i];
    var cx  = indexToX(i, count, chartLeft, chartWidth);
    var oY  = priceToY(c.o, priceMin, priceMax, chartTop, chartHeight);
    var cY  = priceToY(c.c, priceMin, priceMax, chartTop, chartHeight);
    var hY  = priceToY(c.h, priceMin, priceMax, chartTop, chartHeight);
    var lY  = priceToY(c.l, priceMin, priceMax, chartTop, chartHeight);
    var bt  = Math.min(oY, cY);
    var bb  = Math.max(oY, cY);
    if (bb - bt < 2) {
      var mid = (bt + bb) / 2;
      bt = mid - 1;
      bb = mid + 1;
    }

    var off = i * GEOM_STRIDE;
    arr[off]     = cx;
    arr[off + 1] = hY;
    arr[off + 2] = lY;
    arr[off + 3] = bt;
    arr[off + 4] = bb;
    arr[off + 5] = cx - bodyHalfW;
    arr[off + 6] = cx + bodyHalfW;
  }

  _candleGeomCache = arr;
  _geomCacheKey = key;
  return arr;
}


// ================================================================
// FORCE FIELD BAKING
// ================================================================
// Pre-compute wick nudge + wake vortex + surface drag forces into
// a 2D grid. Each cell stores (fx, fy, drag). Particles sample
// this with a single O(1) lookup per frame instead of iterating
// over every candle.

function buildForceField(candles, dims) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var width       = dims.width;
  var height      = dims.height || (chartTop + chartHeight + 50);
  var count       = candles.length;

  var key = count + "-" + chartLeft + "-" + chartWidth + "-" + chartTop
    + "-" + chartHeight + "-" + width;
  if (_ffCacheKey === key && _forceField) {
    return _forceField;
  }

  var cellSize = GRID_CELL;
  var cols = Math.ceil(width / cellSize);
  var rows = Math.ceil(height / cellSize);
  var cellCount = cols * rows;

  var ffFx   = new Float32Array(cellCount);  // accumulated x force
  var ffFy   = new Float32Array(cellCount);  // accumulated y force
  var ffDrag = new Float32Array(cellCount);  // drag multiplier (1.0 = none)

  // Default drag = 1.0 (no drag)
  for (var d = 0; d < cellCount; d++) ffDrag[d] = 1.0;

  var geom = getCandleGeom(candles, dims);

  // ---- Bake each candle's forces into the grid ----
  for (var ci = 0; ci < count; ci++) {
    var off = ci * GEOM_STRIDE;
    var cgCx      = geom[off];
    var cgHighY   = geom[off + 1];
    var cgLowY    = geom[off + 2];
    var cgBodyTop = geom[off + 3];
    var cgBodyBot = geom[off + 4];
    var cgLeft    = geom[off + 5];
    var cgRight   = geom[off + 6];
    var bodyH     = cgBodyBot - cgBodyTop;
    var bodyMidY  = (cgBodyTop + cgBodyBot) / 2;

    // -- WICK NUDGE: upper wick (between highY and bodyTop) → push down --
    var wickHalfW = 2;
    var gxMin = Math.max(0, Math.floor((cgCx - wickHalfW) / cellSize));
    var gxMax = Math.min(cols - 1, Math.ceil((cgCx + wickHalfW) / cellSize));
    var gyMin = Math.max(0, Math.floor(cgHighY / cellSize));
    var gyMax = Math.min(rows - 1, Math.ceil(cgBodyTop / cellSize));
    for (var gy = gyMin; gy <= gyMax; gy++) {
      for (var gx = gxMin; gx <= gxMax; gx++) {
        var idx = gy * cols + gx;
        ffFy[idx] += 0.25;
        ffFx[idx] -= 0.05;
      }
    }

    // -- WICK NUDGE: lower wick (between bodyBot and lowY) → push up --
    gyMin = Math.max(0, Math.floor(cgBodyBot / cellSize));
    gyMax = Math.min(rows - 1, Math.ceil(cgLowY / cellSize));
    for (var gy2 = gyMin; gy2 <= gyMax; gy2++) {
      for (var gx2 = gxMin; gx2 <= gxMax; gx2++) {
        var idx2 = gy2 * cols + gx2;
        ffFy[idx2] -= 0.25;
        ffFx[idx2] -= 0.05;
      }
    }

    // -- WAKE VORTEX: behind candle body --
    var wakeExtent = bodyH * 2.5;
    if (wakeExtent > 1) {
      var wakeLeft  = cgRight;
      var wakeRight = cgRight + wakeExtent;
      var wakeYTop  = cgBodyTop - bodyH * 0.8;
      var wakeYBot  = cgBodyBot + bodyH * 0.8;

      var wgxMin = Math.max(0, Math.floor(wakeLeft / cellSize));
      var wgxMax = Math.min(cols - 1, Math.ceil(wakeRight / cellSize));
      var wgyMin = Math.max(0, Math.floor(wakeYTop / cellSize));
      var wgyMax = Math.min(rows - 1, Math.ceil(wakeYBot / cellSize));

      for (var wgy = wgyMin; wgy <= wgyMax; wgy++) {
        var cellY = (wgy + 0.5) * cellSize;
        for (var wgx = wgxMin; wgx <= wgxMax; wgx++) {
          var cellX = (wgx + 0.5) * cellSize;
          var wakeFrac = (cellX - wakeLeft) / wakeExtent;
          if (wakeFrac < 0 || wakeFrac > 1) continue;

          var widx = wgy * cols + wgx;
          var wakeStr = (1.0 - wakeFrac) * 0.15;

          // Curl: above mid → down, below mid → up
          var offCenter = cellY - bodyMidY;
          ffFy[widx] += (offCenter < 0 ? 1.0 : -1.0) * wakeStr;

          // Backflow near centerline in close wake
          if (wakeFrac < 0.4 && Math.abs(offCenter) < bodyH * 0.6) {
            ffFx[widx] -= (1.0 - wakeFrac / 0.4) * 0.06;
          }
        }
      }
    }

    // -- SURFACE DRAG: around candle body --
    var dgxMin = Math.max(0, Math.floor((cgLeft - DRAG_RANGE) / cellSize));
    var dgxMax = Math.min(cols - 1, Math.ceil((cgRight + DRAG_RANGE) / cellSize));
    var dgyMin = Math.max(0, Math.floor((cgBodyTop - DRAG_RANGE) / cellSize));
    var dgyMax = Math.min(rows - 1, Math.ceil((cgBodyBot + DRAG_RANGE) / cellSize));

    for (var dgy = dgyMin; dgy <= dgyMax; dgy++) {
      var dCellY = (dgy + 0.5) * cellSize;
      for (var dgx = dgxMin; dgx <= dgxMax; dgx++) {
        var dCellX = (dgx + 0.5) * cellSize;
        var didx = dgy * cols + dgx;

        // Distance to body surface
        var ddx = 0, ddy = 0;
        if (dCellX < cgLeft)       ddx = cgLeft - dCellX;
        else if (dCellX > cgRight) ddx = dCellX - cgRight;
        if (dCellY < cgBodyTop)    ddy = cgBodyTop - dCellY;
        else if (dCellY > cgBodyBot) ddy = dCellY - cgBodyBot;

        var surfDist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (surfDist < DRAG_RANGE) {
          var proximity = 1.0 - (surfDist / DRAG_RANGE);
          var dragVal = 1.0 - proximity * DRAG_STRENGTH;
          if (dragVal < ffDrag[didx]) ffDrag[didx] = dragVal;
        }
      }
    }
  }

  _forceField = { fx: ffFx, fy: ffFy, drag: ffDrag, cols: cols, rows: rows };
  _ffCols = cols;
  _ffRows = rows;
  _ffCacheKey = key;
  return _forceField;
}


// ================================================================
// EMISSION — Periodic Column from Left Edge
// ================================================================
// Spawns a column of particles at the left edge every ~1 second,
// centered on the first candle's price in a band 1/4 of chart
// height. Fills up gradually to maxParticles then stops emitting
// (recycled particles maintain the population).
//
// Only called when animation is NOT playing.

var _lastEmitTime = 0;
var EMIT_INTERVAL = 1200;    // ms between column spawns

function emitParticles(particleArr, candles, dims, maxParticles) {
  var chartLeft   = dims.chartLeft;
  var chartTop    = dims.chartTop;

  var deficit = maxParticles - particleArr.length;
  if (deficit <= 0) return;

  // Throttle: one column per second
  var now = performance.now();
  if (now - _lastEmitTime < EMIT_INTERVAL && particleArr.length > 0) return;
  _lastEmitTime = now;

  // Center on the first candle's midpoint, span the full screen height.
  // This puts the densest emission right at the price action, with
  // particles above and below to sample the full terrain.
  var screenH = dims.screenH || dims.height;
  var bandH   = screenH - 40;  // full visible height with margin

  // Find the first candle's center Y position
  var bandCenter = dims.chartTop + dims.chartHeight * 0.5;  // fallback
  if (candles && candles.length > 0) {
    var range = getPriceRange(candles);
    var firstMid = (candles[0].o + candles[0].c) / 2;
    bandCenter = priceToY(firstMid, range.priceMin, range.priceMax,
                          dims.chartTop, dims.chartHeight);
  }

  var bandTop = bandCenter - bandH * 0.5;
  // Clamp to chart bounds
  if (bandTop < dims.chartTop) bandTop = dims.chartTop;
  if (bandTop + bandH > dims.chartTop + dims.chartHeight) {
    bandH = dims.chartTop + dims.chartHeight - bandTop;
  }

  // Spawn a column of ~20 particles per burst
  var columnSize = Math.min(deficit, 20);

  for (var i = 0; i < columnSize; i++) {
    // Evenly spaced vertically with slight jitter
    var sy = bandTop + (i / columnSize) * bandH + (Math.random() - 0.5) * 3;
    var sx = chartLeft + Math.random() * 6;

    var baseSpeed = 1.2 + Math.random() * 1.0;

    particleArr.push({
      x: sx, y: sy,
      prevX: sx, prevY: sy,
      vx:   baseSpeed,
      vy:   (Math.random() - 0.5) * 0.15,
      trailBuf: null,  // ring buffer allocated on first step
      trailHead: 0,
      trailCount: 0,
      life: 0.8 + Math.random() * 0.2,
      age:  0,
      src:  "flow",
      topoIntensity: 0,
      repulsionPressure: 0,
    });
  }

  // Store band info so recycle can reuse it
  emitParticles._bandTop = bandTop;
  emitParticles._bandH   = bandH;
}


// ================================================================
// FLAT SPATIAL GRID (Phase 3)
// ================================================================
// Linked-list chaining in flat Int32Arrays. Each cell stores its
// first particle index; a "next" array chains more particles.
// No hash maps, no Object allocation, no GC.

function buildSpatialGrid(particleArr, width, height) {
  var cellSize = GRID_CELL;
  var cols = Math.ceil(width / cellSize);
  var rows = Math.ceil(height / cellSize);
  var cellCount = cols * rows;
  var n = particleArr.length;

  // Reallocate if grid dimensions changed
  if (!_sgHead || _sgCols !== cols || _sgRows !== rows) {
    _sgHead = new Int32Array(cellCount);
    _sgCols = cols;
    _sgRows = rows;
  }
  if (!_sgNext || _sgNext.length < n) {
    _sgNext = new Int32Array(Math.max(n, 2048));
  }

  // Clear cells to -1 (empty)
  _sgHead.fill(-1);

  // Insert each particle at the front of its cell's list
  var invCell = 1.0 / cellSize;
  for (var i = 0; i < n; i++) {
    var p = particleArr[i];
    var col = (p.x * invCell) | 0;
    var row = (p.y * invCell) | 0;
    if (col < 0) col = 0;
    if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    if (row >= rows) row = rows - 1;

    var cellIdx = row * cols + col;
    _sgNext[i] = _sgHead[cellIdx];
    _sgHead[cellIdx] = i;
  }

  return { head: _sgHead, next: _sgNext, cols: cols, rows: rows };
}


// ================================================================
// PHYSICS STEP (Phase 3 optimized + topology flow)
// ================================================================
// topo:        topology object from computeTopology() — provides
//              gradient vectors (path of least resistance) and
//              ridge/valley classification. May be null.
// topoRes:     pixel size of each topology grid cell (heatmapRes)

function stepParticles(particleArr, candles, dims, crossForces, topo, topoRes) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var width       = dims.width;
  var height      = dims.height || (chartTop + chartHeight + 50);

  // ---- Phase 3: reuse cached force field ----
  var ff   = buildForceField(candles, dims);
  var ffCols = ff.cols;
  var ffRows = ff.rows;
  var invCell = 1.0 / GRID_CELL;

  // ---- Candle geometry for vertical attraction ----
  var geom    = getCandleGeom(candles, dims);
  var nCandles = candles.length;
  var candleW  = chartWidth / CONFIG.CANDLE_COUNT;

  // ---- Topology as terrain elevation ----
  // The light field intensity IS the elevation. Particles flow forward
  // (rightward) across this terrain:
  //   - Y-gradient steers particles up/down to find low paths
  //   - Going uphill (into higher intensity) costs momentum (slows vx)
  //   - Going downhill (into lower intensity) adds momentum
  //   - Ridges act like hills — deflect around them or crest with speed
  //   - Valleys channel flow like riverbeds
  var hasTopo = (topo && topo.gradX && topo.gradY && topo.intensity);
  var topoInvRes = hasTopo ? (1.0 / (topoRes || 10)) : 0;
  var topoCols   = hasTopo ? topo.cols : 0;
  var topoRows   = hasTopo ? topo.rows : 0;

  // Terrain physics constants
  var FORWARD_PUSH   = 0.40;   // constant rightward push
  var STEER_FORCE    = 0.30;   // Y-gradient steering
  var HILL_BRAKE     = 0.08;   // uphill slowing
  var DOWNHILL_BOOST = 0.10;   // downhill acceleration
  var RIDGE_DEFLECT  = 0.40;   // extra Y-push at ridges

  // ---- Phase 3: flat spatial grid for repulsion ----
  var sg = buildSpatialGrid(particleArr, width, height);

  for (var pi = 0; pi < particleArr.length; pi++) {
    var p = particleArr[pi];
    p.age++;

    // ---- Recycle: particles that exit the world ----
    // Right boundary uses full world width (includes projection zone).
    // Recycled particles go back to the LEFT EDGE to maintain the
    // continuous forward flow pattern.
    var exitRight = (p.x > width + 10);
    var exitOther = (p.x < chartLeft - 40
                  || p.y < chartTop - 30
                  || p.y > chartTop + chartHeight + 30);

    if (exitRight || exitOther) {
      // Recycle to left edge in the same vertical band as initial emit
      var rbTop = emitParticles._bandTop || chartTop;
      var rbH   = emitParticles._bandH   || chartHeight;
      p.x = chartLeft + Math.random() * 8;
      p.y = rbTop + Math.random() * rbH;
      p.prevX = p.x;
      p.prevY = p.y;
      p.vx = 1.2 + Math.random() * 1.0;
      p.vy = (Math.random() - 0.5) * 0.2;
      p.trailHead = 0;
      p.trailCount = 0;
      p.age = 0;
      p.life = 0.8 + Math.random() * 0.2;
      p.repulsionPressure = 0;
    }

    // ---- Fade based on progress across full world ----
    // Fades near the right edge of the world (past projection zone)
    var progress = (p.x - chartLeft) / (width - chartLeft);
    var fade = 1.0;
    if (progress > 0.88) {
      fade = Math.max(0.1, 1.0 - (progress - 0.88) / 0.12);
    }

    // Trail ring buffer: no allocations after initial setup.
    // trailBuf is a flat array [x0,y0, x1,y1, ...] with fixed size.
    // trailHead is the write index, trailCount tracks fill level.
    if (!p.trailBuf) {
      p.trailBuf = new Float32Array(CONFIG.TRAIL_LEN * 2);
      p.trailHead = 0;
      p.trailCount = 0;
    }
    var th = p.trailHead;
    p.trailBuf[th]     = p.x;
    p.trailBuf[th + 1] = p.y;
    p.trailHead = (th + 2) % (CONFIG.TRAIL_LEN * 2);
    if (p.trailCount < CONFIG.TRAIL_LEN) p.trailCount++;

    // ---- Save previous position BEFORE movement ----
    p.prevX = p.x;
    p.prevY = p.y;

    // ---- Force field lookup ----
    // When topology is available, SKIP the baked candle force field
    // (wick nudges, wake vortex). Those forces were designed for the
    // old wind-tunnel model and fight the topology gradient, pushing
    // particles off their downhill paths. The topology already captures
    // the full pressure landscape — it's a superset of what the crude
    // candle-level forces approximate. We still use the drag factor
    // from the force field (surface proximity slowing).
    var fx = 0;
    var fy = 0;

    var gcx = (p.x * invCell) | 0;
    var gcy = (p.y * invCell) | 0;
    if (gcx >= 0 && gcx < ffCols && gcy >= 0 && gcy < ffRows) {
      var ffIdx = gcy * ffCols + gcx;
      if (!hasTopo) {
        // No topology: fall back to candle force field
        fx += ff.fx[ffIdx];
        fy += ff.fy[ffIdx];
      }
      // Skip drag factor — surface drag was designed for solid body
      // collision which is no longer active. Topology handles all
      // the terrain forces now.
    }

    // ---- Constant forward push (tilted table) ----
    fx += FORWARD_PUSH;

    // ---- Topology terrain forces ----
    // Simple model: Y-gradient steers, X-gradient brakes/boosts,
    // ridges deflect. No scaling — forces apply at full strength
    // everywhere. Forward momentum prevents valley trapping.
    p.topoIntensity = 0;
    if (hasTopo) {
      var tgx = (p.x * topoInvRes) | 0;
      var tgy = (p.y * topoInvRes) | 0;
      if (tgx >= 0 && tgx < topoCols && tgy >= 0 && tgy < topoRows) {
        var tIdx = tgy * topoCols + tgx;
        p.topoIntensity = topo.intensity[tIdx];

        // ---- Y-STEERING: steer toward lower ground ----
        // gradY points UPHILL, negate to push DOWNHILL.
        fy -= topo.gradY[tIdx] * STEER_FORCE;

        // ---- HILL CLIMBING / COASTING ----
        var xSlope = topo.gradX[tIdx];
        if (xSlope > 0) {
          // Going uphill: gentle brake, capped at 10% of speed
          var brakeAmt = Math.min(xSlope * HILL_BRAKE, p.vx * 0.10);
          fx -= brakeAmt;
        } else {
          // Going downhill: speed boost
          fx -= xSlope * DOWNHILL_BOOST;
        }

        // ---- RIDGE DEFLECTION ----
        if (topo.ridges[tIdx]) {
          var gm = topo.gradMag[tIdx];
          if (gm > 0.001) {
            fy -= (topo.gradY[tIdx] / gm) * RIDGE_DEFLECT;
          }
        }

        // ---- VALLEY BOOST ----
        if (topo.valleys[tIdx]) {
          fx += 0.08;
        }
      }
    }

    // ---- CANDLE VERTICAL ATTRACTION ----
    // Gently pulls particles toward the nearest candle's price range.
    // Candles represent where price actually was — particles should
    // concentrate near those levels to show meaningful flow paths.
    //
    // The pull targets the midpoint of the candle's high-low range.
    // Force is proportional to distance (further away = stronger pull)
    // but capped so it doesn't overpower topology steering.
    // Only applies in the candle area (not past the last candle).
    if (nCandles > 0 && p.x >= chartLeft && p.x < chartLeft + chartWidth) {
      var candleIdx = Math.floor((p.x - chartLeft) / candleW);
      if (candleIdx < 0) candleIdx = 0;
      if (candleIdx >= nCandles) candleIdx = nCandles - 1;

      var goff = candleIdx * GEOM_STRIDE;
      var cHighY = geom[goff + 1];  // high price Y (top of wick)
      var cLowY  = geom[goff + 2];  // low price Y (bottom of wick)
      var cMidY  = (cHighY + cLowY) * 0.5;

      // Distance from particle to candle midpoint
      var dy = cMidY - p.y;
      var absDy = Math.abs(dy);

      // Only pull if particle is outside the candle's range
      // (inside the range, let topology handle it)
      if (p.y < cHighY || p.y > cLowY) {
        // Force scales with distance — gentle nearby, stronger far away
        var pullStr = Math.min(0.25, absDy * 0.004);
        fy += (dy > 0 ? 1 : -1) * pullStr;
      }
    }
    // In the projection zone (past last candle), pull toward the
    // last candle's range
    if (nCandles > 0 && p.x >= chartLeft + chartWidth) {
      var lastOff = (nCandles - 1) * GEOM_STRIDE;
      var lastHighY = geom[lastOff + 1];
      var lastLowY  = geom[lastOff + 2];
      var lastMidY  = (lastHighY + lastLowY) * 0.5;

      var projDy = lastMidY - p.y;
      var projAbsDy = Math.abs(projDy);

      if (p.y < lastHighY || p.y > lastLowY) {
        var projPull = Math.min(0.15, projAbsDy * 0.002);
        fy += (projDy > 0 ? 1 : -1) * projPull;
      }
    }

    // ---- Particle-particle repulsion: exponential force ----
    // Force grows exponentially as particles approach each other:
    //   F = REPULSE_BASE * (1 - dist/radius)^REPULSE_EXPO
    //
    // At the radius edge: F = 0 (just entered range)
    // At half radius:     F = REPULSE_BASE * 0.5^4 = very gentle
    // At 1/4 radius:      F = REPULSE_BASE * 0.75^4 = significant
    // Near contact:       F = REPULSE_BASE * ~1.0^4 = strong push
    //
    // Each particle accumulates its total repulsion magnitude in
    // p.repulsionPressure — this can be read later to measure how
    // crowded/pressured a particle's neighborhood is. High values
    // mean the particle is in a congested flow channel.

    var pCol = gcx;
    var pRow = gcy;
    var totalRepulsion = 0;  // accumulated magnitude this frame

    for (var dc = -1; dc <= 1; dc++) {
      var nc = pCol + dc;
      if (nc < 0 || nc >= sg.cols) continue;

      for (var dr = -1; dr <= 1; dr++) {
        var nr = pRow + dr;
        if (nr < 0 || nr >= sg.rows) continue;

        var oi = sg.head[nr * sg.cols + nc];
        while (oi >= 0) {
          if (oi !== pi) {
            var other = particleArr[oi];
            var rdx = p.x - other.x;
            var rdy = p.y - other.y;
            var dist2 = rdx * rdx + rdy * rdy;

            if (dist2 < REPULSE_RADIUS2 && dist2 > 0.1) {
              var dist = Math.sqrt(dist2);
              // Proximity: 0 at radius edge, 1 at contact
              var proximity = 1.0 - dist / REPULSE_RADIUS;
              // Exponential force: gentle at range, strong up close
              var pushStr = REPULSE_BASE * Math.pow(proximity, REPULSE_EXPO);
              var invDist = 1.0 / dist;

              fx += rdx * invDist * pushStr;
              fy += rdy * invDist * pushStr;
              totalRepulsion += pushStr;
            }
          }
          oi = sg.next[oi];
        }
      }
    }

    // Store total repulsion pressure on this particle.
    // Smoothed with EMA so it doesn't flicker frame-to-frame.
    // Values: 0 = no neighbors, higher = more crowded.
    var prevPressure = p.repulsionPressure || 0;
    p.repulsionPressure = prevPressure * 0.7 + totalRepulsion * 0.3;

    // Cross-asset forces
    if (crossForces) {
      for (var fi = 0; fi < crossForces.length; fi++) {
        var cf = crossForces[fi];
        var cdy = p.y - cf.y;
        var cdist = Math.abs(cdy) + 1;
        if (cdist < 80) {
          fy += cf.strength * cf.direction * (1 - cdist / 80);
        }
      }
    }

    // Turbulence (gentle random jitter to prevent stagnation)
    fx += (Math.random() - 0.5) * CONFIG.TURBULENCE * 0.5;
    fy += (Math.random() - 0.5) * CONFIG.TURBULENCE;

    // ---- Update velocity ----
    // Forward velocity (vx) uses lighter damping than vertical (vy)
    // so particles maintain forward momentum through the terrain.
    p.vx = (p.vx + fx) * 0.99;
    p.vy = (p.vy + fy) * CONFIG.DAMPING;

    // Ensure minimum forward velocity — always push through
    if (p.vx < 1.0) p.vx = 1.0;

    var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed > 6) {
      p.vx = (p.vx / speed) * 6;
      p.vy = (p.vy / speed) * 6;
    }

    // ---- Update position ----
    p.x += p.vx;
    p.y += p.vy;

    // Vertical containment — soft bounce at chart edges
    if (p.y < chartTop) {
      p.y = chartTop;
      p.vy = Math.abs(p.vy) * 0.3;
    }
    if (p.y > chartTop + chartHeight) {
      p.y = chartTop + chartHeight;
      p.vy = -Math.abs(p.vy) * 0.3;
    }

    p.fadeMult = fade;
  }

  return particleArr;
}


// ================================================================
// TRAIL RENDERER (2D canvas, batched for performance)
// ================================================================
// Draws fading streamlines behind each particle. Batches trails
// by quantized color into ~10 groups to minimize stroke() calls.
// Uses ring buffer trail data (trailBuf/trailHead/trailCount).

function renderParticleTrails(particleArr) {
  if (!particleArr || particleArr.length === 0) return;

  var n = particleArr.length;
  var trailLen = CONFIG.TRAIL_LEN;
  var bufSize  = trailLen * 2;

  // When population is high, only draw every Nth trail to stay fast.
  var skip = 1;
  if (n > 3000) skip = 2;
  if (n > 4500) skip = 3;

  // ---- Quantize into color buckets ----
  // 10 buckets based on topology intensity (0..1 mapped to 0..9).
  // All trails in the same bucket share one strokeStyle.
  var NBUCKETS = 10;
  var buckets = [];
  for (var b = 0; b < NBUCKETS; b++) buckets.push([]);

  for (var pi = 0; pi < n; pi += skip) {
    var p = particleArr[pi];
    if (!p.trailBuf || p.trailCount < 2) continue;

    var fade = (p.fadeMult !== undefined) ? p.fadeMult : 1.0;
    if (fade < 0.05) continue;

    var speed = p.vx * p.vx + p.vy * p.vy;
    if (speed < 0.5) continue;

    var ti = p.topoIntensity || 0;
    var bi = (ti * 3.0 * NBUCKETS) | 0;
    if (bi < 0) bi = 0;
    if (bi >= NBUCKETS) bi = NBUCKETS - 1;
    buckets[bi].push(pi);
  }

  ctx.save();
  ctx.lineWidth = 0.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (var bk = 0; bk < NBUCKETS; bk++) {
    var list = buckets[bk];
    if (list.length === 0) continue;

    // Compute color for this bucket
    var t = (bk / NBUCKETS);
    t = t * t;
    var pR = Math.round(200 + (255 - 200) * t);
    var pG = Math.round(240 + (140 - 240) * t);
    var pB = Math.round(255 + (40 - 255)  * t);
    ctx.strokeStyle = "rgba(" + pR + "," + pG + "," + pB + ",0.20)";

    // Draw all trails in this bucket in one beginPath/stroke
    ctx.beginPath();
    for (var li = 0; li < list.length; li++) {
      var p2 = particleArr[list[li]];
      var count = p2.trailCount;
      var head  = p2.trailHead;
      var buf   = p2.trailBuf;

      // Oldest entry is at (head - count*2) wrapped
      var start = (head - count * 2 + bufSize * 4) % bufSize;
      ctx.moveTo(buf[start], buf[start + 1]);
      for (var si = 1; si < count; si++) {
        var idx = (start + si * 2) % bufSize;
        ctx.lineTo(buf[idx], buf[idx + 1]);
      }
      // Line to current position
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
  }

  ctx.restore();
}


// ================================================================
// 2D CANVAS FALLBACK RENDERER
// ================================================================
// Colors particles based on local topology intensity:
//   Low intensity (valleys)  → cool cyan/blue (path of least resistance)
//   High intensity (ridges)  → warm orange/red (S/R pressure zone)
//   Speed still modulates brightness.

function renderParticles(particleArr, colorHex) {
  var baseColor = colorHex || "#00d4ff";
  var cr = parseInt(baseColor.slice(1, 3), 16);
  var cg = parseInt(baseColor.slice(3, 5), 16);
  var cb = parseInt(baseColor.slice(5, 7), 16);

  for (var pi = 0; pi < particleArr.length; pi++) {
    var p = particleArr[pi];
    var fade = (p.fadeMult !== undefined) ? p.fadeMult : 1;

    // ---- Topology-based color tinting ----
    // Valley (dark/low intensity): bright white-cyan for visibility
    // Ridge (bright/high intensity): warm orange
    var pR, pG, pB;
    var ti = p.topoIntensity || 0;
    var t = Math.min(1.0, ti * 3.0);
    t = t * t;

    // In valleys (low t): use bright white-tinted cyan so particles
    // pop against the dark topo fill background.
    // On ridges (high t): warm orange.
    pR = Math.round(200 + (255 - 200) * t);   // 200 → 255
    pG = Math.round(240 + (140 - 240) * t);   // 240 → 140
    pB = Math.round(255 + (40 - 255) * t);    // 255 → 40

    // Trails are drawn by renderParticleTrails() — just draw dots here.
    var speed  = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    var bright = Math.min(1, speed / 2);

    // High minimum alpha — particles should ALWAYS be visible
    var alpha = (0.7 + bright * 0.3) * fade;
    var radius = 1.4 + bright * 0.4;

    ctx.fillStyle = "rgba(" + pR + "," + pG + "," + pB + "," + alpha.toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
