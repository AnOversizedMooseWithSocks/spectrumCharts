/*
 * ================================================================
 * particles.js  —  Terrain Flow Particle Visualization (SoA)
 * ================================================================
 * Depends on: config.js (CONFIG, ctx, canvas),
 *             coords.js (priceToY, indexToX, getPriceRange)
 *
 * STRUCT-OF-ARRAYS (SoA) ARCHITECTURE:
 *
 * Instead of an array of JS objects (each scattered on the heap),
 * all particle state lives in parallel typed arrays:
 *   pool.px[i], pool.py[i]   — position
 *   pool.vx[i], pool.vy[i]   — velocity
 *   pool.prevX[i], pool.prevY[i] — previous position
 *   ... etc.
 *
 * This gives the CPU prefetcher contiguous memory to scan — the
 * same pattern Three.js InstancedMesh uses for transforms. When
 * the step loop reads pool.px[0], pool.px[1], pool.px[2]... the
 * prefetcher loads the next cache line automatically because the
 * data is sequential in memory.
 *
 * Trail data is a single large Float32Array (not one per particle).
 * Particle i's trail starts at offset i * TRAIL_STRIDE in the
 * unified buffer. Zero allocation after initial pool creation.
 *
 * TERRAIN FLOW MODEL:
 *
 * The light field intensity is treated as terrain elevation.
 * Particles spawn at the left edge and flow rightward across this
 * landscape, through the candle area and into the projection zone.
 * See stepParticles() for the full physics model.
 *
 * ================================================================
 */

// Spatial grid for particle-particle repulsion.
// Exponential force: grows rapidly as particles get close.
var GRID_CELL = 75;
var REPULSE_RADIUS  = 72;
var REPULSE_RADIUS2 = REPULSE_RADIUS * REPULSE_RADIUS;
var REPULSE_BASE    = 0.60;   // base force magnitude
var REPULSE_EXPO    = 2.5;    // lower exponent = force engages earlier

// Surface drag
var DRAG_RANGE    = 12;
var DRAG_STRENGTH = 0.35;


// ================================================================
// FORCE FIELD + GEOMETRY CACHES
// ================================================================

var _forceField = null;       // { fx, fy, drag } Float32Arrays
var _ffCols = 0;
var _ffRows = 0;
var _ffCacheKey = "";

var _candleGeomCache = null;  // Float64Array: 7 floats per candle
var _geomCacheKey = "";
var GEOM_STRIDE = 7;

// Flat spatial grid arrays (reused, grown as needed)
var _sgHead = null;           // Int32Array: first particle per cell
var _sgNext = null;           // Int32Array: next particle in chain
var _sgCols = 0;
var _sgRows = 0;


// ================================================================
// POOL CREATION — Pre-allocate all typed arrays up front
// ================================================================
// Returns an SoA pool object. The pool has a fixed capacity
// (CONFIG.PARTICLE_COUNT) and a .count for how many are active.
// No objects are allocated per particle — just array indices.

function createParticles() {
  var cap = CONFIG.PARTICLE_COUNT;

  // ---- Core state: parallel typed arrays ----
  // No trail buffers — the GPU streak renderer derives "trails"
  // from velocity alone (motion blur). Zero trail storage.
  var pool = {
    // Position
    px:    new Float32Array(cap),
    py:    new Float32Array(cap),
    prevX: new Float32Array(cap),
    prevY: new Float32Array(cap),

    // Velocity
    vx:    new Float32Array(cap),
    vy:    new Float32Array(cap),

    // Life & age
    life:  new Float32Array(cap),
    age:   new Int32Array(cap),

    // Per-frame computed values
    topoI: new Float32Array(cap),  // topology intensity at particle
    repP:  new Float32Array(cap),  // repulsion pressure (smoothed)
    fade:  new Float32Array(cap),  // fade multiplier (edge proximity)

    // Pool metadata
    count:    0,       // active particles (replaces .length)
    capacity: cap,
  };

  // Initialize
  pool.life.fill(1.0);
  pool.fade.fill(1.0);

  return pool;
}


// ================================================================
// CANDLE GEOMETRY CACHE
// ================================================================

function getCandleGeom(candles, dims) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var count       = candles.length;
  var candleW     = chartWidth / CONFIG.CANDLE_COUNT;
  var bodyHalfW   = candleW * 0.5 + 1;

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

  var ffFx   = new Float32Array(cellCount);
  var ffFy   = new Float32Array(cellCount);
  var ffDrag = new Float32Array(cellCount);

  for (var d = 0; d < cellCount; d++) ffDrag[d] = 1.0;

  var geom = getCandleGeom(candles, dims);

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

    // -- WICK NUDGE: upper wick → push down --
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

    // -- WICK NUDGE: lower wick → push up --
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

          var offCenter = cellY - bodyMidY;
          ffFy[widx] += (offCenter < 0 ? 1.0 : -1.0) * wakeStr;

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
// Fills the pool gradually up to maxParticles. Each burst writes
// directly into the SoA arrays at indices pool.count .. count+N.
// Only called when animation is NOT playing.

var _lastEmitTime = 0;
var EMIT_INTERVAL = 1200;    // ms between column spawns

// Band info for recycle (set during emit, read during step)
var _emitBandTop = 0;
var _emitBandH   = 0;

function emitParticles(pool, candles, dims, maxParticles) {
  // Clamp to pool capacity
  var maxP = maxParticles;
  if (maxP > pool.capacity) maxP = pool.capacity;

  var deficit = maxP - pool.count;
  if (deficit <= 0) return;

  var now = performance.now();
  if (now - _lastEmitTime < EMIT_INTERVAL && pool.count > 0) return;
  _lastEmitTime = now;

  var chartLeft = dims.chartLeft;
  var screenH   = dims.screenH || dims.height;
  var bandH     = screenH - 40;

  var bandCenter = dims.chartTop + dims.chartHeight * 0.5;
  if (candles && candles.length > 0) {
    var range = getPriceRange(candles);
    var firstMid = (candles[0].o + candles[0].c) / 2;
    bandCenter = priceToY(firstMid, range.priceMin, range.priceMax,
                          dims.chartTop, dims.chartHeight);
  }

  var bandTop = bandCenter - bandH * 0.5;
  if (bandTop < dims.chartTop) bandTop = dims.chartTop;
  if (bandTop + bandH > dims.chartTop + dims.chartHeight) {
    bandH = dims.chartTop + dims.chartHeight - bandTop;
  }

  _emitBandTop = bandTop;
  _emitBandH   = bandH;

  var columnSize = Math.min(deficit, 20);
  var base = pool.count;

  for (var i = 0; i < columnSize; i++) {
    var idx = base + i;
    var sy = bandTop + (i / columnSize) * bandH + (Math.random() - 0.5) * 3;
    var sx = chartLeft + Math.random() * 6;
    var baseSpeed = 1.2 + Math.random() * 1.0;

    pool.px[idx]    = sx;
    pool.py[idx]    = sy;
    pool.prevX[idx] = sx;
    pool.prevY[idx] = sy;
    pool.vx[idx]    = baseSpeed;
    pool.vy[idx]    = (Math.random() - 0.5) * 0.15;
    pool.life[idx]  = 0.8 + Math.random() * 0.2;
    pool.age[idx]   = 0;
    pool.topoI[idx] = 0;
    pool.repP[idx]  = 0;
    pool.fade[idx]  = 1.0;
  }

  pool.count = base + columnSize;
}


// ================================================================
// FLAT SPATIAL GRID
// ================================================================

function buildSpatialGrid(pool, width, height) {
  var cellSize = GRID_CELL;
  var cols = Math.ceil(width / cellSize);
  var rows = Math.ceil(height / cellSize);
  var cellCount = cols * rows;
  var n = pool.count;

  if (!_sgHead || _sgCols !== cols || _sgRows !== rows) {
    _sgHead = new Int32Array(cellCount);
    _sgCols = cols;
    _sgRows = rows;
  }
  if (!_sgNext || _sgNext.length < n) {
    _sgNext = new Int32Array(Math.max(n, 2048));
  }

  _sgHead.fill(-1);

  var invCell = 1.0 / cellSize;
  var ppx = pool.px;
  var ppy = pool.py;

  for (var i = 0; i < n; i++) {
    var col = (ppx[i] * invCell) | 0;
    var row = (ppy[i] * invCell) | 0;
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
// PHYSICS STEP (SoA — all typed array access)
// ================================================================
// All reads/writes go through typed arrays — no object property
// lookups in the hot loop. The CPU prefetcher stays ahead because
// each array is contiguous in memory.

function stepParticles(pool, candles, dims, crossForces, topo, topoRes) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var width       = dims.width;
  var height      = dims.height || (chartTop + chartHeight + 50);
  var n           = pool.count;
  if (n === 0) return pool;

  // ---- Pull array references into locals ----
  // Avoids repeated pool.xxx property lookups. Each local IS the
  // typed array — reads like ppx[i] go straight to contiguous memory.
  var ppx    = pool.px;
  var ppy    = pool.py;
  var ppvx   = pool.prevX;
  var ppvy   = pool.prevY;
  var pvx    = pool.vx;
  var pvy    = pool.vy;
  var pAge   = pool.age;
  var pLife  = pool.life;
  var pTopoI = pool.topoI;
  var pRepP  = pool.repP;
  var pFade  = pool.fade;

  // ---- Force field (cached) ----
  var ff      = buildForceField(candles, dims);
  var ffCols  = ff.cols;
  var ffRows  = ff.rows;
  var invCell = 1.0 / GRID_CELL;

  // ---- Candle geometry ----
  var geom     = getCandleGeom(candles, dims);
  var nCandles = candles.length;
  var candleW  = chartWidth / CONFIG.CANDLE_COUNT;

  // ---- Topology as terrain ----
  var hasTopo    = (topo && topo.gradX && topo.gradY && topo.intensity);
  var topoInvRes = hasTopo ? (1.0 / (topoRes || 10)) : 0;
  var topoCols   = hasTopo ? topo.cols : 0;
  var topoRows   = hasTopo ? topo.rows : 0;

  // Topology typed array locals (avoid repeated topo.xxx in hot loop)
  var topoIntensity = hasTopo ? topo.intensity : null;
  var topoColorBias = hasTopo ? topo.colorBias : null;  // signed: +support / -resistance
  var topoMaxBias   = hasTopo ? (topo.maxBias || 1) : 1;
  var topoGradX     = hasTopo ? topo.gradX : null;
  var topoGradY     = hasTopo ? topo.gradY : null;
  var topoGradMag   = hasTopo ? topo.gradMag : null;
  var topoRidges    = hasTopo ? topo.ridges : null;
  var topoValleys   = hasTopo ? topo.valleys : null;

  // Terrain physics constants
  var FORWARD_PUSH   = 0.40;
  var STEER_FORCE    = 0.30;
  var HILL_BRAKE     = 0.08;
  var DOWNHILL_BOOST = 0.10;
  var RIDGE_DEFLECT  = 0.40;
  var COLOR_BIAS_FORCE = state.colorBiasForce || 0.25;  // from UI slider

  // ---- Spatial grid for repulsion ----
  var sg = buildSpatialGrid(pool, width, height);

  // ---- Recycle band ----
  var rbTop = _emitBandTop || chartTop;
  var rbH   = _emitBandH   || chartHeight;

  var invWorldW   = 1.0 / (width - chartLeft);
  var chartBottom = chartTop + chartHeight;

  // ================================================================
  // MAIN PARTICLE LOOP — typed array access only, no objects
  // ================================================================
  for (var pi = 0; pi < n; pi++) {
    pAge[pi]++;

    var x = ppx[pi];
    var y = ppy[pi];

    // ---- Recycle: exit detection ----
    if (x > width + 10
        || x < chartLeft - 40
        || y < chartTop - 30
        || y > chartBottom + 30) {
      x = chartLeft + Math.random() * 8;
      y = rbTop + Math.random() * rbH;
      ppx[pi]  = x;
      ppy[pi]  = y;
      ppvx[pi] = x;
      ppvy[pi] = y;
      pvx[pi]  = 1.2 + Math.random() * 1.0;
      pvy[pi]  = (Math.random() - 0.5) * 0.2;
      pAge[pi]  = 0;
      pLife[pi] = 0.8 + Math.random() * 0.2;
      pRepP[pi] = 0;
    }

    // ---- Fade near right edge ----
    var progress = (x - chartLeft) * invWorldW;
    var fade = 1.0;
    if (progress > 0.88) {
      fade = 1.0 - (progress - 0.88) * 8.333;  // 1/0.12 ≈ 8.333
      if (fade < 0.1) fade = 0.1;
    }
    pFade[pi] = fade;

    // ---- Save previous position ----
    ppvx[pi] = x;
    ppvy[pi] = y;

    // ---- Accumulate forces ----
    var fx = 0;
    var fy = 0;

    var gcx = (x * invCell) | 0;
    var gcy = (y * invCell) | 0;
    if (gcx >= 0 && gcx < ffCols && gcy >= 0 && gcy < ffRows) {
      if (!hasTopo) {
        var ffIdx = gcy * ffCols + gcx;
        fx += ff.fx[ffIdx];
        fy += ff.fy[ffIdx];
      }
    }

    // Constant forward push
    fx += FORWARD_PUSH;

    // ---- Topology terrain forces ----
    pTopoI[pi] = 0;
    if (hasTopo) {
      var tgx = (x * topoInvRes) | 0;
      var tgy = (y * topoInvRes) | 0;
      if (tgx >= 0 && tgx < topoCols && tgy >= 0 && tgy < topoRows) {
        var tIdx = tgy * topoCols + tgx;
        pTopoI[pi] = topoIntensity[tIdx];

        // Y-steering: push downhill
        fy -= topoGradY[tIdx] * STEER_FORCE;

        // Hill climbing / coasting
        var xSlope = topoGradX[tIdx];
        if (xSlope > 0) {
          var brakeAmt = xSlope * HILL_BRAKE;
          var maxBrake = pvx[pi] * 0.10;
          fx -= (brakeAmt < maxBrake ? brakeAmt : maxBrake);
        } else {
          fx -= xSlope * DOWNHILL_BOOST;
        }

        // Ridge deflection
        if (topoRidges[tIdx]) {
          var gm = topoGradMag[tIdx];
          if (gm > 0.001) {
            fy -= (topoGradY[tIdx] / gm) * RIDGE_DEFLECT;
          }
        }

        // Valley boost
        if (topoValleys[tIdx]) {
          fx += 0.08;
        }

        // ---- Color bias directional force ----
        // The color bias tells us which type of pressure dominates here:
        //   Positive bias = support-dominated → pushes price UP (Y decreases)
        //   Negative bias = resistance-dominated → pushes price DOWN (Y increases)
        // This force is proportional to the local pressure intensity —
        // strong light with a clear bias pushes harder than dim light.
        // Only applies where there's meaningful pressure (not empty space).
        if (topoColorBias) {
          var bias = topoColorBias[tIdx];
          var localPressure = topoIntensity[tIdx];
          if (localPressure > 0.01) {
            // Normalize bias to -1..+1 range, scale by local pressure
            var normBias = bias / topoMaxBias;
            var pressureScale = localPressure / (topo.refIntensity || 1);
            if (pressureScale > 1) pressureScale = 1;
            // Support (positive bias) pushes particles UP (negative Y)
            // Resistance (negative bias) pushes particles DOWN (positive Y)
            fy -= normBias * pressureScale * COLOR_BIAS_FORCE;
          }
        }
      }
    }

    // ---- Candle vertical attraction ----
    if (nCandles > 0 && x >= chartLeft && x < chartLeft + chartWidth) {
      var candleIdx = ((x - chartLeft) / candleW) | 0;
      if (candleIdx < 0) candleIdx = 0;
      if (candleIdx >= nCandles) candleIdx = nCandles - 1;

      var goff = candleIdx * GEOM_STRIDE;
      var cHighY = geom[goff + 1];
      var cLowY  = geom[goff + 2];
      var cMidY  = (cHighY + cLowY) * 0.5;

      if (y < cHighY || y > cLowY) {
        var dy = cMidY - y;
        var absDy = dy < 0 ? -dy : dy;
        var pullStr = absDy * 0.004;
        if (pullStr > 0.25) pullStr = 0.25;
        fy += (dy > 0 ? 1 : -1) * pullStr;
      }
    }
    // Projection zone: pull toward last candle
    if (nCandles > 0 && x >= chartLeft + chartWidth) {
      var lastOff = (nCandles - 1) * GEOM_STRIDE;
      var lastMidY = (geom[lastOff + 1] + geom[lastOff + 2]) * 0.5;

      if (y < geom[lastOff + 1] || y > geom[lastOff + 2]) {
        var projDy = lastMidY - y;
        var projAbsDy = projDy < 0 ? -projDy : projDy;
        var projPull = projAbsDy * 0.002;
        if (projPull > 0.15) projPull = 0.15;
        fy += (projDy > 0 ? 1 : -1) * projPull;
      }
    }

    // ---- Particle-particle repulsion ----
    var totalRepulsion = 0;

    for (var dc = -1; dc <= 1; dc++) {
      var nc = gcx + dc;
      if (nc < 0 || nc >= sg.cols) continue;

      for (var dr = -1; dr <= 1; dr++) {
        var nr = gcy + dr;
        if (nr < 0 || nr >= sg.rows) continue;

        var oi = sg.head[nr * sg.cols + nc];
        while (oi >= 0) {
          if (oi !== pi) {
            var rdx = x - ppx[oi];
            var rdy = y - ppy[oi];
            var dist2 = rdx * rdx + rdy * rdy;

            if (dist2 < REPULSE_RADIUS2 && dist2 > 0.1) {
              var dist = Math.sqrt(dist2);
              var proximity = 1.0 - dist / REPULSE_RADIUS;
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

    // EMA-smoothed repulsion pressure
    pRepP[pi] = pRepP[pi] * 0.7 + totalRepulsion * 0.3;

    // ---- Cross-asset forces ----
    if (crossForces) {
      for (var fi = 0; fi < crossForces.length; fi++) {
        var cf = crossForces[fi];
        var cdy = y - cf.y;
        var cdist = cdy < 0 ? -cdy : cdy;
        cdist += 1;
        if (cdist < 80) {
          fy += cf.strength * cf.direction * (1 - cdist / 80);
        }
      }
    }

    // Turbulence
    fx += (Math.random() - 0.5) * CONFIG.TURBULENCE * 0.5;
    fy += (Math.random() - 0.5) * CONFIG.TURBULENCE;

    // ---- Update velocity ----
    var newVx = (pvx[pi] + fx) * 0.99;
    var newVy = (pvy[pi] + fy) * CONFIG.DAMPING;

    if (newVx < 1.0) newVx = 1.0;

    // Speed cap: avoid sqrt unless over limit
    var speed2 = newVx * newVx + newVy * newVy;
    if (speed2 > 36) {  // 6^2
      var invSpeed = 6.0 / Math.sqrt(speed2);
      newVx *= invSpeed;
      newVy *= invSpeed;
    }

    pvx[pi] = newVx;
    pvy[pi] = newVy;

    // ---- Update position ----
    var nx = x + newVx;
    var ny = y + newVy;

    // Vertical containment — soft bounce
    if (ny < chartTop) {
      ny = chartTop;
      if (newVy < 0) pvy[pi] = -newVy * 0.3;
    }
    if (ny > chartBottom) {
      ny = chartBottom;
      if (newVy > 0) pvy[pi] = -newVy * 0.3;
    }

    ppx[pi] = nx;
    ppy[pi] = ny;
  }

  return pool;
}


// ================================================================
// TRAIL RENDERER — NO-OP
// ================================================================
// Motion blur is handled by the GL accumulation buffer in
// gl-particles-instanced.js. Previous frames fade gradually,
// creating natural comet tails with zero CPU cost.

function renderParticleTrails(pool) {
  // No-op: GL accumulation buffer handles motion blur.
}


// ================================================================
// 2D CANVAS FALLBACK RENDERER (velocity lines)
// ================================================================
// When WebGL2 is unavailable, draws each particle as a short line
// segment from (x, y) backward along its velocity vector. This
// approximates the GPU motion-blur effect. Batched by color bucket.

function renderParticles(pool, colorHex) {
  var n = pool.count;
  if (n === 0) return;

  var ppx    = pool.px;
  var ppy    = pool.py;
  var pvx    = pool.vx;
  var pvy    = pool.vy;
  var pFade  = pool.fade;
  var pTopoI = pool.topoI;

  // Streak scale: how far back the tail extends (in velocity units)
  var STREAK = 3.0;

  // Batch by color for fewer strokeStyle changes
  var NBUCKETS = 8;
  var buckets = [];
  for (var b = 0; b < NBUCKETS; b++) buckets.push([]);

  for (var pi = 0; pi < n; pi++) {
    if (pFade[pi] < 0.05) continue;
    var bi = (pTopoI[pi] * 3.0 * NBUCKETS) | 0;
    if (bi < 0) bi = 0;
    if (bi >= NBUCKETS) bi = NBUCKETS - 1;
    buckets[bi].push(pi);
  }

  ctx.save();
  ctx.lineCap = "round";

  for (var bk = 0; bk < NBUCKETS; bk++) {
    var list = buckets[bk];
    if (list.length === 0) continue;

    var t = (bk / NBUCKETS);
    t = t * t;
    var pR = Math.round(200 + 55 * t);
    var pG = Math.round(240 - 100 * t);
    var pB = Math.round(255 - 215 * t);

    // Draw streaks as lines
    ctx.strokeStyle = "rgba(" + pR + "," + pG + "," + pB + ",0.35)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var li = 0; li < list.length; li++) {
      var idx = list[li];
      var x = ppx[idx];
      var y = ppy[idx];
      // Tail position: backward along velocity
      var tx = x - pvx[idx] * STREAK;
      var ty = y - pvy[idx] * STREAK;
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw bright dots at head positions
    ctx.fillStyle = "rgba(" + pR + "," + pG + "," + pB + ",0.7)";
    for (var di = 0; di < list.length; di++) {
      var didx = list[di];
      ctx.fillRect(ppx[didx] - 0.8, ppy[didx] - 0.8, 1.6, 1.6);
    }
  }

  ctx.restore();
}
