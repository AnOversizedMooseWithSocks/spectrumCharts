/*
 * ================================================================
 * topology.js  —  Topological Analysis of the Light Field
 * ================================================================
 * Depends on: config.js (CONFIG, state)
 *             heatmap.js (builds the grids we analyze)
 *
 * PURPOSE:
 *   Treats the 4-channel heatmap intensity as a heightfield and
 *   extracts topological features that the prediction engine can
 *   use as a richer force field:
 *
 *     - GRADIENT VECTORS: slope direction at every cell — points
 *       "downhill" toward lower intensity. This IS the path of
 *       least resistance. Prediction particles can follow it.
 *
 *     - RIDGES: connected paths along local intensity maxima.
 *       These are the strongest S/R barriers. Where ridges narrow
 *       or curve, that's where breakouts are most likely.
 *
 *     - VALLEYS: low-intensity channels between ridges. Natural
 *       corridors for price movement. A valley connecting current
 *       price to a region above/below is a probable path.
 *
 *     - SADDLE POINTS: where two ridges meet with a pass between
 *       them. Critical decision points — a small push sends price
 *       into one valley or another.
 *
 * DATA INTEGRITY:
 *   computeTopology() is a PURE FUNCTION. It takes grid arrays
 *   and dimensions, returns computed features. It has no opinion
 *   about whether the grids include future data or not.
 *
 *   For prediction: call it on the incrementally-updated grids
 *   at each step. The topology only reflects data up to that step.
 *
 *   For verification: call it on the full "god view" grids and
 *   compare against the prediction-time topology.
 *
 * PERFORMANCE:
 *   All operations are O(cols × rows) — single pass or small
 *   fixed-neighborhood scans. Should add < 1ms per prediction
 *   step on typical grid sizes (~300 × ~200 cells).
 * ================================================================
 */

// Grid channel indices (must match heatmap.js)
var TOPO_G_GREEN  = 0;
var TOPO_G_YELLOW = 1;
var TOPO_G_BLUE   = 2;
var TOPO_G_RED    = 3;


// ================================================================
// ================================================================
// BLUR BUFFER POOL — reuse intermediate arrays across calls
// ================================================================
// The blur passes are the biggest allocation cost: 4 new
// Float32Arrays of (cols*rows) per call, each immediately GC'd.
// Pool two buffers for ping-pong blur. Output arrays (gradX, etc)
// are allocated fresh because multiple topology results can coexist
// (e.g. particle topo + projection topo in the same frame).

var _blurPool = {
  cellCount: 0,
  bufA: null,    // ping buffer
  bufB: null,    // pong buffer
};

function _ensureBlurPool(cellCount) {
  if (_blurPool.cellCount === cellCount) return;
  _blurPool.bufA = new Float32Array(cellCount);
  _blurPool.bufB = new Float32Array(cellCount);
  _blurPool.cellCount = cellCount;
}


// computeTopology  —  Main entry point
// ================================================================
//
// Parameters:
//   grids      — array of 4 Float32Arrays [green, yellow, blue, red]
//   cols, rows — grid dimensions
//   colorForce — (optional) object with per-color strength weights:
//                { green: { str: 1.0 }, yellow: { str: 0.4 }, ... }
//                If omitted, all channels weighted equally at 1.0.
//
// Returns a topology object with:
//   .intensity  — Float32Array(cols*rows), combined weighted intensity
//   .gradX      — Float32Array(cols*rows), horizontal gradient component
//   .gradY      — Float32Array(cols*rows), vertical gradient component
//   .gradMag    — Float32Array(cols*rows), gradient magnitude
//   .ridges     — Uint8Array(cols*rows),   1 = ridge cell, 0 = not
//   .valleys    — Uint8Array(cols*rows),   1 = valley cell, 0 = not
//   .saddles    — array of {gx, gy, strength} saddle point objects
//   .cols, .rows — dimensions (for convenience)
//
//   Plus query functions (see below).

function computeTopology(grids, cols, rows, colorForce) {
  var cellCount = cols * rows;

  // ---- Ensure buffer pool is sized correctly ----
  _ensureBlurPool(cellCount);

  // Default color weights: all equal
  var wG = 1.0, wY = 1.0, wB = 1.0, wR = 1.0;
  if (colorForce) {
    wG = (colorForce.green  && colorForce.green.str  != null) ? colorForce.green.str  : 1.0;
    wY = (colorForce.yellow && colorForce.yellow.str != null) ? colorForce.yellow.str : 1.0;
    wB = (colorForce.blue   && colorForce.blue.str   != null) ? colorForce.blue.str   : 1.0;
    wR = (colorForce.red    && colorForce.red.str    != null) ? colorForce.red.str    : 1.0;
  }

  // ----------------------------------------------------------------
  // STEP 1: Combine channels into a SIGNED elevation field
  // ----------------------------------------------------------------
  // Resistance light (green + yellow from candle highs) = POSITIVE
  //   elevation (mountains). These are ceilings that push price down.
  // Support light (blue + red from candle lows) = NEGATIVE elevation
  //   (wells). These are floors that push price up.

  var intensity = new Float32Array(cellCount);
  var gG = grids[TOPO_G_GREEN];
  var gY = grids[TOPO_G_YELLOW];
  var gB = grids[TOPO_G_BLUE];
  var gR = grids[TOPO_G_RED];

  var maxIntensity = 0;
  var minIntensity = 0;
  for (var i = 0; i < cellCount; i++) {
    var resist  = gG[i] * wG + gY[i] * wY;
    var support = gB[i] * wB + gR[i] * wR;
    var val = resist - support;
    intensity[i] = val;
    if (val > maxIntensity) maxIntensity = val;
    if (val < minIntensity) minIntensity = val;
  }

  var absMax = Math.max(maxIntensity, -minIntensity);

  // ---- SAMPLED PERCENTILE ----
  // Instead of pushing all non-zero values into a JS array and sorting
  // (which at fine res creates a 230K-element array + O(n log n) sort),
  // sample every Nth cell. At N=8, a 230K grid samples ~29K values.
  // The 85th percentile estimate is statistically stable at this size.
  var SAMPLE_STEP = 8;
  var sampleCount = 0;
  // Reuse blurA temporarily as sample storage (it gets overwritten by blur next)
  var sampleBuf = _blurPool.bufA;
  for (var nzi = 0; nzi < cellCount; nzi += SAMPLE_STEP) {
    var absVal = intensity[nzi];
    if (absVal < 0) absVal = -absVal;
    if (absVal > 0.001) {
      sampleBuf[sampleCount++] = absVal;
    }
  }
  var refIntensity = absMax;  // fallback
  if (sampleCount > 10) {
    // Partial sort: find the 85th percentile value using a selection
    // approach — sort only the sampled subset
    var samples = new Float32Array(sampleBuf.buffer, 0, sampleCount);
    samples.sort();
    refIntensity = samples[Math.floor(sampleCount * 0.85)] || absMax;
  }

  // ----------------------------------------------------------------
  // STEP 2: Gaussian blur — PING-PONG between two pooled buffers
  // ----------------------------------------------------------------
  // 4 passes of 3×3 Gaussian ≈ 9×9 kernel. No allocations.
  // Reads from src, writes to dst, then swaps.
  var blurA = _blurPool.bufA;
  var blurB = _blurPool.bufB;

  // Copy intensity into blurA as the starting point
  blurA.set(intensity);

  var src = blurA;
  var dst = blurB;
  for (var blurPass = 0; blurPass < 4; blurPass++) {
    // Interior cells: apply 3×3 kernel
    for (var y = 1; y < rows - 1; y++) {
      var rowOff = y * cols;
      var rowAbove = (y - 1) * cols;
      var rowBelow = (y + 1) * cols;
      for (var x = 1; x < cols - 1; x++) {
        dst[rowOff + x] = (
          src[rowAbove + x - 1]       + src[rowAbove + x] * 2 + src[rowAbove + x + 1] +
          src[rowOff   + x - 1] * 2   + src[rowOff   + x] * 4 + src[rowOff   + x + 1] * 2 +
          src[rowBelow + x - 1]       + src[rowBelow + x] * 2 + src[rowBelow + x + 1]
        ) * 0.0625;  // 1/16
      }
    }
    // Edge rows/cols: copy from source (unchanged)
    // First and last row
    for (var ex = 0; ex < cols; ex++) {
      dst[ex] = src[ex];
      dst[(rows - 1) * cols + ex] = src[(rows - 1) * cols + ex];
    }
    // First and last column (interior rows only — corners already done)
    for (var ey = 1; ey < rows - 1; ey++) {
      dst[ey * cols] = src[ey * cols];
      dst[ey * cols + cols - 1] = src[ey * cols + cols - 1];
    }

    // Swap for next pass
    var tmp = src;
    src = dst;
    dst = tmp;
  }
  // After 4 passes, src points to the final smoothed result.
  // Copy out of the pool so it survives if computeTopology is called
  // again this frame (projection.js calls it independently).
  var smoothed = new Float32Array(src);

  // ----------------------------------------------------------------
  // STEP 3: Compute gradient vectors (central differences)
  // ----------------------------------------------------------------
  // gradX = d(intensity)/dx  — positive means intensity increases rightward
  // gradY = d(intensity)/dy  — positive means intensity increases downward
  //
  // The NEGATIVE gradient (-gradX, -gradY) points "downhill" — toward
  // lower intensity, i.e. the path of least resistance.

  var gradX  = new Float32Array(cellCount);
  var gradY  = new Float32Array(cellCount);
  var gradMag = new Float32Array(cellCount);

  for (var gy = 1; gy < rows - 1; gy++) {
    for (var gx = 1; gx < cols - 1; gx++) {
      var idx = gy * cols + gx;

      // Central differences (more accurate than forward/backward)
      var dx = (smoothed[(gy) * cols + (gx + 1)] - smoothed[(gy) * cols + (gx - 1)]) * 0.5;
      var dy = (smoothed[(gy + 1) * cols + (gx)] - smoothed[(gy - 1) * cols + (gx)]) * 0.5;

      gradX[idx] = dx;
      gradY[idx] = dy;
      gradMag[idx] = Math.sqrt(dx * dx + dy * dy);
    }
  }

  // ----------------------------------------------------------------
  // STEP 4: Ridge detection (non-maximum suppression)
  // ----------------------------------------------------------------
  // A ridge cell has high intensity AND is a local maximum in the
  // direction perpendicular to the gradient. Think of walking along
  // a mountain ridge — the ground falls away on both sides, but the
  // gradient along the ridge is shallow.
  //
  // Algorithm: at each cell, find the direction perpendicular to the
  // gradient, then check if this cell's intensity is higher than its
  // two neighbors in that perpendicular direction.
  //
  // Only cells above a minimum intensity threshold are considered
  // (no ridges in empty space).

  var ridges  = new Uint8Array(cellCount);
  var valleys = new Uint8Array(cellCount);

  // With signed elevation:
  //   Ridges = POSITIVE peaks (resistance zones)
  //   Valleys = NEGATIVE troughs (support zones)
  // Thresholds use refIntensity (85th percentile of absolute values).
  var ridgeThresh  = refIntensity * 0.15;   // must be positive and significant
  var valleyThresh = -refIntensity * 0.15;  // must be negative and significant
  var ridgeMargin = 0.05;
  var valleyMargin = 0.05;

  for (var gy2 = 2; gy2 < rows - 2; gy2++) {
    for (var gx2 = 2; gx2 < cols - 2; gx2++) {
      var idx2 = gy2 * cols + gx2;
      var mag  = gradMag[idx2];
      var val2 = smoothed[idx2];

      // ---- RIDGE DETECTION (positive peaks = resistance) ----
      // Must be significantly positive AND higher than perpendicular neighbors.
      if (val2 > ridgeThresh && mag > 0.001) {
        var perpX = -gradY[idx2] / mag;
        var perpY =  gradX[idx2] / mag;

        // Check TWO cells out in each perpendicular direction
        // (wider check catches broader features)
        var nx1 = Math.round(gx2 + perpX);
        var ny1 = Math.round(gy2 + perpY);
        var nx2 = Math.round(gx2 - perpX);
        var ny2 = Math.round(gy2 - perpY);
        var nx3 = Math.round(gx2 + perpX * 2);
        var ny3 = Math.round(gy2 + perpY * 2);
        var nx4 = Math.round(gx2 - perpX * 2);
        var ny4 = Math.round(gy2 - perpY * 2);

        if (nx1 >= 0 && nx1 < cols && ny1 >= 0 && ny1 < rows &&
            nx2 >= 0 && nx2 < cols && ny2 >= 0 && ny2 < rows) {
          var nVal1 = smoothed[ny1 * cols + nx1];
          var nVal2 = smoothed[ny2 * cols + nx2];

          // Also check 2-cells-out if in bounds
          var nVal3 = (nx3 >= 0 && nx3 < cols && ny3 >= 0 && ny3 < rows)
            ? smoothed[ny3 * cols + nx3] : nVal1;
          var nVal4 = (nx4 >= 0 && nx4 < cols && ny4 >= 0 && ny4 < rows)
            ? smoothed[ny4 * cols + nx4] : nVal2;

          // Ridge: higher than ALL perpendicular neighbors with margin
          var marginAbs = val2 * ridgeMargin;
          if (val2 > nVal1 + marginAbs && val2 > nVal2 + marginAbs &&
              val2 > nVal3 + marginAbs && val2 > nVal4 + marginAbs) {
            ridges[idx2] = 1;
          }
        }
      }

      // ---- VALLEY DETECTION (negative troughs = support) ----
      // Must be significantly negative AND lower than perpendicular neighbors.
      // This finds support zones where blue+red light dominates.
      if (val2 < valleyThresh && mag > 0.001) {
        var vperpX = -gradY[idx2] / mag;
        var vperpY =  gradX[idx2] / mag;

        var vnx1 = Math.round(gx2 + vperpX);
        var vny1 = Math.round(gy2 + vperpY);
        var vnx2 = Math.round(gx2 - vperpX);
        var vny2 = Math.round(gy2 - vperpY);
        var vnx3 = Math.round(gx2 + vperpX * 2);
        var vny3 = Math.round(gy2 + vperpY * 2);
        var vnx4 = Math.round(gx2 - vperpX * 2);
        var vny4 = Math.round(gy2 - vperpY * 2);

        if (vnx1 >= 0 && vnx1 < cols && vny1 >= 0 && vny1 < rows &&
            vnx2 >= 0 && vnx2 < cols && vny2 >= 0 && vny2 < rows) {
          var vnVal1 = smoothed[vny1 * cols + vnx1];
          var vnVal2 = smoothed[vny2 * cols + vnx2];
          var vnVal3 = (vnx3 >= 0 && vnx3 < cols && vny3 >= 0 && vny3 < rows)
            ? smoothed[vny3 * cols + vnx3] : vnVal1;
          var vnVal4 = (vnx4 >= 0 && vnx4 < cols && vny4 >= 0 && vny4 < rows)
            ? smoothed[vny4 * cols + vnx4] : vnVal2;

          var vMarginAbs = refIntensity * valleyMargin;

          // Valley: more negative than all perpendicular neighbors.
          // This is a support trough — blue+red light concentrated here.
          if (val2 < vnVal1 - vMarginAbs && val2 < vnVal2 - vMarginAbs &&
              val2 < vnVal3 - vMarginAbs && val2 < vnVal4 - vMarginAbs) {
            valleys[idx2] = 1;
          }
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // STEP 5: Saddle point detection
  // ----------------------------------------------------------------
  // A saddle point is where the surface curves UP in one direction
  // and DOWN in the perpendicular direction (like the middle of a
  // horse saddle or a mountain pass). Mathematically: the Hessian
  // matrix has eigenvalues of opposite sign.
  //
  // For our grid, we approximate the Hessian with finite differences:
  //   Hxx = d²I/dx²  — second derivative in x
  //   Hyy = d²I/dy²  — second derivative in y
  //   Hxy = d²I/dxdy — cross derivative
  //
  // Saddle when determinant < 0:  det(H) = Hxx*Hyy - Hxy² < 0
  //
  // These are the breakout/decision points — where two ridges form
  // a gateway and price could go either direction through the pass.

  var saddles = [];
  // With signed elevation, saddle points are most interesting near
  // the transition between resistance (positive) and support (negative).
  // Use absolute value so we detect saddles in both regimes.
  var saddleMinIntensity = refIntensity * 0.10;

  for (var gy3 = 2; gy3 < rows - 2; gy3++) {
    for (var gx3 = 2; gx3 < cols - 2; gx3++) {
      var idx3 = gy3 * cols + gx3;
      var val3 = smoothed[idx3];
      // Must be at a location with significant terrain (either sign)
      if (Math.abs(val3) < saddleMinIntensity) continue;

      // Second partial derivatives (central differences)
      var Hxx = smoothed[gy3 * cols + (gx3 + 1)]
              + smoothed[gy3 * cols + (gx3 - 1)]
              - 2 * val3;

      var Hyy = smoothed[(gy3 + 1) * cols + gx3]
              + smoothed[(gy3 - 1) * cols + gx3]
              - 2 * val3;

      var Hxy = (smoothed[(gy3 + 1) * cols + (gx3 + 1)]
               - smoothed[(gy3 + 1) * cols + (gx3 - 1)]
               - smoothed[(gy3 - 1) * cols + (gx3 + 1)]
               + smoothed[(gy3 - 1) * cols + (gx3 - 1)]) * 0.25;

      var det = Hxx * Hyy - Hxy * Hxy;

      // Negative determinant = saddle point.
      // Use a threshold to avoid weak/noisy saddles.
      if (det < -0.0001) {
        // Strength: how "deep" the saddle is — stronger negative det
        // means more pronounced pass between features.
        // Use absolute intensity so support-zone saddles rank properly.
        var strength = Math.abs(det) * Math.abs(val3);

        saddles.push({
          gx: gx3,
          gy: gy3,
          strength: strength,
          intensity: val3,
          det: det
        });
      }
    }
  }

  // Sort saddles by strength (strongest first) and keep top N
  // to avoid returning thousands of weak saddle points.
  saddles.sort(function(a, b) { return b.strength - a.strength; });
  if (saddles.length > 50) saddles.length = 50;


  // ----------------------------------------------------------------
  // STEP 6: Build the flow direction field
  // ----------------------------------------------------------------
  // This is what the prediction engine will primarily use.
  // At each cell, the "flow direction" is the NEGATIVE gradient —
  // pointing toward lower intensity, i.e. path of least resistance.
  //
  // We store it as normalized (unit) vectors so the prediction
  // engine can scale the force independently of the gradient
  // magnitude.
  //
  // We also store a "confinement" value per cell: how steep the
  // walls are around this cell. High confinement = deep valley
  // (price is channeled). Low confinement = flat terrain (price
  // can drift freely). Computed as gradient magnitude relative
  // to local intensity — steep slope on bright terrain = confined.

  var flowX = new Float32Array(cellCount);
  var flowY = new Float32Array(cellCount);
  var confinement = new Float32Array(cellCount);

  for (var fi = 0; fi < cellCount; fi++) {
    var fmag = gradMag[fi];
    if (fmag > 0.0001) {
      // Negative gradient = downhill = path of least resistance
      flowX[fi] = -gradX[fi] / fmag;
      flowY[fi] = -gradY[fi] / fmag;

      // Confinement: how boxed-in is this cell?
      // High gradient magnitude relative to the local intensity means
      // the terrain drops steeply — we're near a ridge wall.
      // Normalize by max intensity so it's comparable across datasets.
      confinement[fi] = (refIntensity > 0) ? fmag / refIntensity : 0;
    }
    // else: zero gradient → flat terrain → no preferred direction
  }


  // ----------------------------------------------------------------
  // Return topology object with data arrays AND query functions
  // ----------------------------------------------------------------
  var topo = {
    // Raw data arrays (for advanced use / verification)
    intensity:   smoothed,   // smoothed combined intensity
    rawIntensity: intensity,  // unsmoothed (for comparison)
    gradX:       gradX,
    gradY:       gradY,
    gradMag:     gradMag,
    ridges:      ridges,
    valleys:     valleys,
    saddles:     saddles,
    flowX:       flowX,
    flowY:       flowY,
    confinement: confinement,
    cols:        cols,
    rows:        rows,
    maxIntensity: maxIntensity,
    minIntensity: minIntensity,
    refIntensity: refIntensity,  // 85th percentile of absolute values

    // --- QUERY FUNCTIONS ---
    // These are what the prediction engine calls.

    // queryFlow(gx, gy)
    //   Returns { fx, fy, conf } — the flow direction (unit vector
    //   pointing along path of least resistance) and confinement
    //   (0 = open terrain, higher = steeper walls nearby).
    //   Returns null if out of bounds.
    queryFlow: function(gx, gy) {
      if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) return null;
      var qi = gy * cols + gx;
      return {
        fx:   flowX[qi],
        fy:   flowY[qi],
        conf: confinement[qi]
      };
    },

    // queryRidge(gx, gy, radius)
    //   Scans a neighborhood around (gx, gy) for the nearest ridge
    //   cell. Returns { dx, dy, dist, intensity } — direction to the
    //   ridge, distance in cells, and the ridge's intensity.
    //   Returns null if no ridge found within radius.
    queryRidge: function(gx, gy, radius) {
      if (!radius) radius = 8;
      var bestDist = radius + 1;
      var bestRx = 0, bestRy = 0, bestInt = 0;
      var found = false;

      var rMin = Math.max(0, gy - radius);
      var rMax = Math.min(rows - 1, gy + radius);
      var cMin = Math.max(0, gx - radius);
      var cMax = Math.min(cols - 1, gx + radius);

      for (var ry = rMin; ry <= rMax; ry++) {
        for (var rx = cMin; rx <= cMax; rx++) {
          if (ridges[ry * cols + rx]) {
            var rdx = rx - gx;
            var rdy = ry - gy;
            var rdist = Math.sqrt(rdx * rdx + rdy * rdy);
            if (rdist < bestDist) {
              bestDist = rdist;
              bestRx = rdx;
              bestRy = rdy;
              bestInt = smoothed[ry * cols + rx];
              found = true;
            }
          }
        }
      }

      if (!found) return null;
      return {
        dx: bestRx,       // direction to ridge (grid cells)
        dy: bestRy,
        dist: bestDist,   // distance in grid cells
        intensity: bestInt // how bright the ridge is
      };
    },

    // queryValley(gx, gy, radius)
    //   Like queryRidge but for valley cells.
    queryValley: function(gx, gy, radius) {
      if (!radius) radius = 8;
      var bestDist = radius + 1;
      var bestVx = 0, bestVy = 0, bestInt = 0;
      var found = false;

      var rMin = Math.max(0, gy - radius);
      var rMax = Math.min(rows - 1, gy + radius);
      var cMin = Math.max(0, gx - radius);
      var cMax = Math.min(cols - 1, gx + radius);

      for (var vy = rMin; vy <= rMax; vy++) {
        for (var vx = cMin; vx <= cMax; vx++) {
          if (valleys[vy * cols + vx]) {
            var vdx = vx - gx;
            var vdy = vy - gy;
            var vdist = Math.sqrt(vdx * vdx + vdy * vdy);
            if (vdist < bestDist) {
              bestDist = vdist;
              bestVx = vdx;
              bestVy = vdy;
              bestInt = smoothed[vy * cols + vx];
              found = true;
            }
          }
        }
      }

      if (!found) return null;
      return {
        dx: bestVx,
        dy: bestVy,
        dist: bestDist,
        intensity: bestInt
      };
    },

    // queryNearestSaddle(gx, gy, radius)
    //   Finds the nearest saddle point to (gx, gy).
    //   Returns { dx, dy, dist, strength } or null.
    queryNearestSaddle: function(gx, gy, radius) {
      if (!radius) radius = 15;
      var best = null;
      var bestDist = radius + 1;

      for (var si = 0; si < saddles.length; si++) {
        var s = saddles[si];
        var sdx = s.gx - gx;
        var sdy = s.gy - gy;
        var sdist = Math.sqrt(sdx * sdx + sdy * sdy);
        if (sdist < bestDist) {
          bestDist = sdist;
          best = { dx: sdx, dy: sdy, dist: sdist, strength: s.strength };
        }
      }

      return best;
    },

    // queryColumnProfile(gx)
    //   Returns the intensity profile for a single column — useful
    //   for the prediction engine to see what's at a given time step.
    //   Returns an object with:
    //     .values — Float32Array of intensity by row
    //     .ridgeRows — array of row indices that are ridge cells
    //     .valleyRows — array of row indices that are valley cells
    queryColumnProfile: function(gx) {
      if (gx < 0 || gx >= cols) return null;
      var colVals = new Float32Array(rows);
      var colRidges = [];
      var colValleys = [];

      for (var r = 0; r < rows; r++) {
        var ci = r * cols + gx;
        colVals[r] = smoothed[ci];
        if (ridges[ci]) colRidges.push(r);
        if (valleys[ci]) colValleys.push(r);
      }

      return {
        values: colVals,
        ridgeRows: colRidges,
        valleyRows: colValleys
      };
    }
  };

  return topo;
}


// ================================================================
// queryFlowLive  —  Flow direction from LIVE grid data
// ================================================================
// Unlike topo.queryFlow() which reads from pre-computed arrays,
// this function computes the gradient on-the-fly from whatever
// the current grid state is. This means it responds to virtual
// beams painted during the prediction step loop.
//
// Cost: 4 array reads + some math per call. Negligible.
//
// Parameters:
//   grids      — the 4 live grid arrays [green, yellow, blue, red]
//   cols, rows — grid dimensions
//   gx, gy     — grid cell to query
//   colorForce — per-color strength weights (same as computeTopology)
//
// Returns { fx, fy, conf } same as topo.queryFlow(), or null if OOB.

function queryFlowLive(grids, cols, rows, gx, gy, colorForce) {
  if (gx < 1 || gx >= cols - 1 || gy < 1 || gy >= rows - 1) return null;

  // Color weights (match computeTopology)
  var wG = 1.0, wY = 1.0, wB = 1.0, wR = 1.0;
  if (colorForce) {
    wG = (colorForce.green  && colorForce.green.str  != null) ? colorForce.green.str  : 1.0;
    wY = (colorForce.yellow && colorForce.yellow.str != null) ? colorForce.yellow.str : 1.0;
    wB = (colorForce.blue   && colorForce.blue.str   != null) ? colorForce.blue.str   : 1.0;
    wR = (colorForce.red    && colorForce.red.str    != null) ? colorForce.red.str    : 1.0;
  }

  var gG = grids[0], gY = grids[1], gB = grids[2], gR = grids[3];

  // Sample SIGNED intensity at the 4 cardinal neighbors + center.
  // Resistance (green+yellow) = positive, support (blue+red) = negative.
  var idxL = gy * cols + (gx - 1);
  var idxR = gy * cols + (gx + 1);
  var idxU = (gy - 1) * cols + gx;
  var idxD = (gy + 1) * cols + gx;
  var idxC = gy * cols + gx;

  var vL = (gG[idxL]*wG + gY[idxL]*wY) - (gB[idxL]*wB + gR[idxL]*wR);
  var vR = (gG[idxR]*wG + gY[idxR]*wY) - (gB[idxR]*wB + gR[idxR]*wR);
  var vU = (gG[idxU]*wG + gY[idxU]*wY) - (gB[idxU]*wB + gR[idxU]*wR);
  var vD = (gG[idxD]*wG + gY[idxD]*wY) - (gB[idxD]*wB + gR[idxD]*wR);
  var vC = (gG[idxC]*wG + gY[idxC]*wY) - (gB[idxC]*wB + gR[idxC]*wR);

  // Gradient (central differences)
  var dx = (vR - vL) * 0.5;
  var dy = (vD - vU) * 0.5;
  var mag = Math.sqrt(dx * dx + dy * dy);

  if (mag < 0.0001) return { fx: 0, fy: 0, conf: 0 };

  // Flow = negative gradient (downhill = path of least resistance)
  var fx = -dx / mag;
  var fy = -dy / mag;

  // Confinement = how steep the terrain is around this cell.
  // With signed field, use max absolute value for normalization.
  var maxAbsI = Math.max(Math.abs(vL), Math.abs(vR), Math.abs(vU), Math.abs(vD), Math.abs(vC), 0.001);
  var conf = mag / maxAbsI;

  return { fx: fx, fy: fy, conf: conf };
}


// ================================================================
// queryRidgeLive  —  Ridge proximity from LIVE grid data
// ================================================================
// Lightweight ridge check: scans a small neighborhood for cells
// where intensity is a local maximum perpendicular to the gradient.
// Much cheaper than pre-computing all ridges — only checks the
// cells around the query point.
//
// Parameters: same as queryFlowLive plus radius
// Returns: { dx, dy, dist, intensity } or null

function queryRidgeLive(grids, cols, rows, gx, gy, colorForce, radius) {
  if (!radius) radius = 6;
  if (gx < 2 || gx >= cols - 2 || gy < 2 || gy >= rows - 2) return null;

  var wG = 1.0, wY = 1.0, wB = 1.0, wR = 1.0;
  if (colorForce) {
    wG = (colorForce.green  && colorForce.green.str  != null) ? colorForce.green.str  : 1.0;
    wY = (colorForce.yellow && colorForce.yellow.str != null) ? colorForce.yellow.str : 1.0;
    wB = (colorForce.blue   && colorForce.blue.str   != null) ? colorForce.blue.str   : 1.0;
    wR = (colorForce.red    && colorForce.red.str    != null) ? colorForce.red.str    : 1.0;
  }

  var gG = grids[0], gY = grids[1], gB = grids[2], gR = grids[3];

  // Helper: SIGNED intensity at a grid cell.
  // Positive = resistance (green+yellow), negative = support (blue+red).
  // Ridges detected here are resistance peaks only, which is correct —
  // the caller uses ridge proximity for repulsion (push away from resistance).
  // Support attraction is handled by the flow direction (gradient toward
  // negative values = toward support zones).
  function intAt(x, y) {
    if (x < 0 || x >= cols || y < 0 || y >= rows) return 0;
    var i = y * cols + x;
    return (gG[i]*wG + gY[i]*wY) - (gB[i]*wB + gR[i]*wR);
  }

  var bestDist = radius + 1;
  var bestDx = 0, bestDy = 0, bestInt = 0;
  var found = false;

  // Scan neighborhood — check if each cell is a ridge
  // (local max perpendicular to its gradient)
  var rMin = Math.max(2, gy - radius);
  var rMax = Math.min(rows - 3, gy + radius);
  var cMin = Math.max(2, gx - radius);
  var cMax = Math.min(cols - 3, gx + radius);

  for (var ry = rMin; ry <= rMax; ry++) {
    for (var rx = cMin; rx <= cMax; rx++) {
      var val = intAt(rx, ry);
      if (val < 0.01) continue;

      // Quick gradient at this cell
      var gdx = (intAt(rx+1, ry) - intAt(rx-1, ry)) * 0.5;
      var gdy = (intAt(rx, ry+1) - intAt(rx, ry-1)) * 0.5;
      var gmag = Math.sqrt(gdx*gdx + gdy*gdy);
      if (gmag < 0.0001) continue;

      // Perpendicular to gradient
      var px = Math.round(-gdy / gmag);
      var py = Math.round(gdx / gmag);

      // Ridge test: higher than both perpendicular neighbors
      var n1 = intAt(rx + px, ry + py);
      var n2 = intAt(rx - px, ry - py);
      if (val >= n1 && val >= n2) {
        var ddx = rx - gx;
        var ddy = ry - gy;
        var dist = Math.sqrt(ddx*ddx + ddy*ddy);
        if (dist < bestDist) {
          bestDist = dist;
          bestDx = ddx;
          bestDy = ddy;
          bestInt = val;
          found = true;
        }
      }
    }
  }

  if (!found) return null;
  return { dx: bestDx, dy: bestDy, dist: bestDist, intensity: bestInt };
}


// ================================================================
// gaussianBlur3x3  —  Simple 3×3 Gaussian smoothing pass
// ================================================================
// Kernel:  [1 2 1]      Normalized by /16.
//          [2 4 2]
//          [1 2 1]
//
// Applied to a flat Float32Array with given cols × rows.
// Returns a new Float32Array (does not modify input).
// Edges are left unblurred (copied from input).
// Used by computeTopology() — 4 passes create a ~9×9 effective kernel.

function gaussianBlur3x3(src, cols, rows) {
  var dst = new Float32Array(src.length);

  // Copy edges (row 0, row N-1, col 0, col N-1)
  for (var i = 0; i < src.length; i++) dst[i] = src[i];

  // Interior cells: apply 3×3 kernel
  for (var y = 1; y < rows - 1; y++) {
    for (var x = 1; x < cols - 1; x++) {
      var c = y * cols + x;
      dst[c] = (
        src[(y-1)*cols + (x-1)]     + src[(y-1)*cols + x] * 2 + src[(y-1)*cols + (x+1)] +
        src[(y)  *cols + (x-1)] * 2 + src[(y)  *cols + x] * 4 + src[(y)  *cols + (x+1)] * 2 +
        src[(y+1)*cols + (x-1)]     + src[(y+1)*cols + x] * 2 + src[(y+1)*cols + (x+1)]
      ) / 16.0;
    }
  }

  return dst;
}


// ================================================================
// VERIFICATION SYSTEM
// ================================================================
//
// Tracks how well topological features from "past-only" data
// predicted actual price movement through the "known" zone.
//
// Usage:
//   1. At prediction boundary, snapshot the topology:
//        var snap = topoSnapshot(topo, boundaryGx)
//
//   2. After new candles arrive, build full topology and verify:
//        topoVerify(snap, fullTopo, actualPricePath)
//
//   3. The result tells you which features were predictive.
//      Feed that back into feature weights for next prediction.

// topoSnapshot  —  Capture topology state at the prediction boundary
//
// Stores the gradient, ridge, valley, and saddle data from column
// boundaryGx rightward (the prediction zone at that moment).
// Also stores the profile at the boundary itself — the "launching
// conditions" that determined which valleys were open.
//
// Parameters:
//   topo       — topology object from computeTopology
//   boundaryGx — grid X column where prediction begins (last real candle)
//   lookAhead  — how many columns rightward to capture (default: 30)
//
// Returns a snapshot object.

function topoSnapshot(topo, boundaryGx, lookAhead) {
  if (!lookAhead) lookAhead = 30;
  var cols = topo.cols;
  var rows = topo.rows;

  // Capture the boundary column profile
  var boundaryProfile = topo.queryColumnProfile(boundaryGx);

  // Capture flow field and features in the prediction zone
  var zoneFlowX = [];
  var zoneFlowY = [];
  var zoneConf  = [];
  var zoneRidgeRows = [];  // per-column ridge positions
  var zoneValleyRows = []; // per-column valley positions

  for (var dx = 0; dx < lookAhead; dx++) {
    var gx = boundaryGx + dx;
    if (gx >= cols) break;

    var profile = topo.queryColumnProfile(gx);
    if (profile) {
      zoneRidgeRows.push(profile.ridgeRows);
      zoneValleyRows.push(profile.valleyRows);
    } else {
      zoneRidgeRows.push([]);
      zoneValleyRows.push([]);
    }

    // Capture flow at each row in this column
    var colFX = new Float32Array(rows);
    var colFY = new Float32Array(rows);
    var colConf = new Float32Array(rows);
    for (var r = 0; r < rows; r++) {
      var fi = r * cols + gx;
      colFX[r] = topo.flowX[fi];
      colFY[r] = topo.flowY[fi];
      colConf[r] = topo.confinement[fi];
    }
    zoneFlowX.push(colFX);
    zoneFlowY.push(colFY);
    zoneConf.push(colConf);
  }

  // Capture saddle points in the zone
  var zoneSaddles = [];
  for (var si = 0; si < topo.saddles.length; si++) {
    var s = topo.saddles[si];
    if (s.gx >= boundaryGx && s.gx < boundaryGx + lookAhead) {
      zoneSaddles.push({
        gx: s.gx - boundaryGx,  // relative to boundary
        gy: s.gy,
        strength: s.strength
      });
    }
  }

  return {
    boundaryGx:     boundaryGx,
    lookAhead:       lookAhead,
    boundaryProfile: boundaryProfile,
    ridgeRows:       zoneRidgeRows,
    valleyRows:      zoneValleyRows,
    flowX:           zoneFlowX,
    flowY:           zoneFlowY,
    confinement:     zoneConf,
    saddles:         zoneSaddles,
    timestamp:       Date.now()
  };
}


// topoVerify  —  Compare prediction-time topology against actual outcomes
//
// Parameters:
//   snap           — snapshot from topoSnapshot (past-only topology)
//   fullTopo       — topology computed from all data (god view)
//   actualPriceGYs — array of grid Y positions where price actually went,
//                    one per prediction step (same length as snap.lookAhead)
//
// Returns a verification report with per-feature accuracy scores:
//   .flowAccuracy     — how often the flow direction correctly predicted
//                       the direction of actual price movement
//   .valleyAccuracy   — how often price stayed within valley corridors
//   .ridgeRespect     — how often price bounced off ridge positions
//   .saddleRelevance  — how often price passed near predicted saddle points
//   .overallScore     — weighted combination (0..1)

function topoVerify(snap, fullTopo, actualPriceGYs) {
  var steps = Math.min(snap.lookAhead, actualPriceGYs.length);
  if (steps < 2) return null;

  var flowCorrect = 0;
  var flowTotal = 0;
  var valleyHits = 0;
  var valleyChecks = 0;
  var ridgeBounces = 0;
  var ridgeApproaches = 0;

  for (var step = 1; step < steps; step++) {
    var prevGY = actualPriceGYs[step - 1];
    var currGY = actualPriceGYs[step];
    var priceDir = currGY - prevGY;  // positive = price moving down (pixel coords)

    // --- Flow accuracy ---
    // Did the flow field at the previous position correctly predict
    // the direction price actually moved?
    if (step - 1 < snap.flowY.length && prevGY >= 0 && prevGY < fullTopo.rows) {
      var predictedFlowY = snap.flowY[step - 1][prevGY];
      if (Math.abs(predictedFlowY) > 0.1 && Math.abs(priceDir) > 0) {
        flowTotal++;
        // Both positive or both negative = correct direction
        if ((predictedFlowY > 0 && priceDir > 0) || (predictedFlowY < 0 && priceDir < 0)) {
          flowCorrect++;
        }
      }
    }

    // --- Valley containment ---
    // Was the actual price position near a predicted valley cell?
    if (step < snap.valleyRows.length) {
      var stepValleys = snap.valleyRows[step];
      valleyChecks++;
      for (var vi = 0; vi < stepValleys.length; vi++) {
        if (Math.abs(stepValleys[vi] - currGY) <= 2) {
          valleyHits++;
          break;
        }
      }
    }

    // --- Ridge respect ---
    // When price approached a ridge, did it bounce?
    if (step < snap.ridgeRows.length) {
      var stepRidges = snap.ridgeRows[step];
      for (var ri = 0; ri < stepRidges.length; ri++) {
        var ridgeDist = Math.abs(stepRidges[ri] - currGY);
        if (ridgeDist <= 3) {
          ridgeApproaches++;
          // Check if price reversed in the next step
          if (step + 1 < steps) {
            var nextDir = actualPriceGYs[step + 1] - currGY;
            var approachDir = priceDir;
            // Bounce = direction reversal
            if ((approachDir > 0 && nextDir < 0) || (approachDir < 0 && nextDir > 0)) {
              ridgeBounces++;
            }
          }
          break;  // only count one ridge per step
        }
      }
    }
  }

  // --- Saddle relevance ---
  // Did price pass near any predicted saddle points?
  var saddleNear = 0;
  for (var si2 = 0; si2 < snap.saddles.length; si2++) {
    var sad = snap.saddles[si2];
    if (sad.gx < actualPriceGYs.length) {
      var saddlePriceGY = actualPriceGYs[sad.gx];
      if (Math.abs(saddlePriceGY - sad.gy) <= 4) {
        saddleNear++;
      }
    }
  }
  var saddleRelevance = (snap.saddles.length > 0) ? saddleNear / snap.saddles.length : 0;

  // Compute accuracies
  var flowAcc   = (flowTotal > 0)         ? flowCorrect / flowTotal             : 0;
  var valleyAcc = (valleyChecks > 0)      ? valleyHits / valleyChecks           : 0;
  var ridgeAcc  = (ridgeApproaches > 0)   ? ridgeBounces / ridgeApproaches     : 0;

  // Weighted overall score
  // Flow direction is the most directly useful, so weight it highest.
  var overall = flowAcc * 0.40
              + valleyAcc * 0.25
              + ridgeAcc * 0.20
              + saddleRelevance * 0.15;

  return {
    flowAccuracy:    flowAcc,
    flowSamples:     flowTotal,
    valleyAccuracy:  valleyAcc,
    valleySamples:   valleyChecks,
    ridgeRespect:    ridgeAcc,
    ridgeSamples:    ridgeApproaches,
    saddleRelevance: saddleRelevance,
    saddleSamples:   snap.saddles.length,
    overallScore:    overall,
    steps:           steps
  };
}


// ================================================================
// CONTOUR RENDERING (optional visual verification overlay)
// ================================================================
// Draws iso-intensity contour lines on the chart canvas.
// Uses marching squares to find contour edges at fixed thresholds.
//
// This is purely for visual debugging / verification — it lets
// you SEE the topology that the prediction engine is using.
// Toggle on/off; doesn't affect prediction at all.
//
// Parameters:
//   ctx        — canvas 2D rendering context
//   topo       — topology object from computeTopology
//   resolution — heatmap grid cell size in pixels
//   levels     — number of contour levels (default 8)
//   options    — { showRidges, showValleys, showSaddles, showFlow }

function renderContours(ctx, topo, resolution, levels, options) {
  if (!levels) levels = 8;
  if (!options) options = {};
  var showRidges  = options.showRidges  !== false;  // on by default
  var showValleys = options.showValleys !== false;
  var showSaddles = options.showSaddles !== false;
  var showFlow    = options.showFlow    || false;    // off by default (noisy)
  var showFill    = options.showFill    || false;    // greyscale elevation fill

  var cols = topo.cols;
  var rows = topo.rows;
  var data = topo.intensity;
  var maxI = topo.refIntensity || topo.maxIntensity;
  if (maxI < 0.001) return;  // nothing to draw

  ctx.save();

  // ---- GREYSCALE ELEVATION FILL ----
  // Renders each grid cell as a filled rectangle whose brightness
  // maps to the light intensity at that position. Bright zones
  // (high S/R) appear white, dark zones (paths of least resistance)
  // appear black/transparent. Drawn BEFORE contour lines so lines
  // appear on top.
  //
  // Uses alpha blending so the chart underneath remains visible.
  // Maximum alpha is 0.45 to keep it subtle enough not to hide
  // candles and beams.
  if (showFill) {
    // With signed elevation:
    //   Positive (resistance) = warm tones (amber/white)
    //   Negative (support)    = cool tones (blue/cyan)
    //   Zero (open space)     = transparent
    var posMax = topo.maxIntensity || maxI;
    var negMax = Math.abs(topo.minIntensity || 0);
    var fillRef = topo.refIntensity || maxI;

    for (var fy = 0; fy < rows; fy++) {
      for (var fx = 0; fx < cols; fx++) {
        var fVal = data[fy * cols + fx];
        var fAbs = Math.abs(fVal);
        if (fAbs < fillRef * 0.02) continue;  // skip near-zero (performance)

        // Normalize by refIntensity so moderate features are visible
        var fNorm = fAbs / fillRef;
        if (fNorm > 1) fNorm = 1;
        var fAlpha = fNorm * 0.45;

        if (fVal > 0) {
          // Resistance: warm amber/white
          // Low intensity → dark amber, high → bright white
          var rr = Math.floor(180 + fNorm * 75);   // 180..255
          var rg = Math.floor(140 + fNorm * 95);   // 140..235
          var rb = Math.floor(60 + fNorm * 60);     // 60..120
          ctx.fillStyle = "rgba(" + rr + "," + rg + "," + rb + "," + fAlpha.toFixed(3) + ")";
        } else {
          // Support: cool blue/cyan
          // Low intensity → dark blue, high → bright cyan
          var sr = Math.floor(40 + fNorm * 40);     // 40..80
          var sg = Math.floor(100 + fNorm * 120);   // 100..220
          var sb = Math.floor(180 + fNorm * 75);    // 180..255
          ctx.fillStyle = "rgba(" + sr + "," + sg + "," + sb + "," + fAlpha.toFixed(3) + ")";
        }

        ctx.fillRect(fx * resolution, fy * resolution, resolution, resolution);
      }
    }
  }

  // ---- CONTOUR LINES (marching squares) ----
  // Draw iso-lines at evenly spaced intensity thresholds.
  // Uses the classic lookup table for which edges of a 2×2 cell
  // the contour crosses.

  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.6;

  // With signed elevation, draw contour lines in both regimes:
  //   Positive levels (resistance) = warm amber lines
  //   Negative levels (support) = cool cyan lines
  //   Zero crossing = white (the S/R boundary)

  var negMax = Math.abs(topo.minIntensity || 0);
  var posMax = topo.maxIntensity || maxI;

  // --- Positive contours (resistance) ---
  for (var li = 1; li <= levels; li++) {
    var threshold = (li / (levels + 1)) * maxI;
    var t = li / levels;  // 0..1 for color interpolation

    // Warm amber: darker at low levels, brighter at high
    var pR = Math.floor(180 + t * 75);
    var pG = Math.floor(130 + t * 100);
    var pB = Math.floor(50 + t * 50);
    ctx.strokeStyle = "rgba(" + pR + "," + pG + "," + pB + ", 0.55)";
    ctx.beginPath();

    for (var cy = 0; cy < rows - 1; cy++) {
      for (var cx = 0; cx < cols - 1; cx++) {
        var tl = data[cy * cols + cx];
        var tr = data[cy * cols + (cx + 1)];
        var bl = data[(cy + 1) * cols + cx];
        var br = data[(cy + 1) * cols + (cx + 1)];

        var caseIdx = 0;
        if (tl >= threshold) caseIdx |= 8;
        if (tr >= threshold) caseIdx |= 4;
        if (br >= threshold) caseIdx |= 2;
        if (bl >= threshold) caseIdx |= 1;
        if (caseIdx === 0 || caseIdx === 15) continue;

        var tEdge = Math.max(0, Math.min(1, (threshold - tl) / (tr - tl + 0.0001)));
        var bEdge = Math.max(0, Math.min(1, (threshold - bl) / (br - bl + 0.0001)));
        var lEdge = Math.max(0, Math.min(1, (threshold - tl) / (bl - tl + 0.0001)));
        var rEdge = Math.max(0, Math.min(1, (threshold - tr) / (br - tr + 0.0001)));

        var px = cx * resolution, py = cy * resolution;
        var pxr = (cx + 1) * resolution, pyr = (cy + 1) * resolution;

        drawContourSegments(ctx, caseIdx,
          px + tEdge * resolution, py,
          px + bEdge * resolution, pyr,
          px, py + lEdge * resolution,
          pxr, py + rEdge * resolution);
      }
    }
    ctx.stroke();
  }

  // --- Negative contours (support) ---
  if (negMax > 0.001) {
    for (var li2 = 1; li2 <= levels; li2++) {
      var threshold2 = -(li2 / (levels + 1)) * negMax;
      var t2 = li2 / levels;

      // Cool cyan: darker at shallow levels, brighter at deep
      var sR = Math.floor(40 + t2 * 40);
      var sG = Math.floor(120 + t2 * 100);
      var sB = Math.floor(180 + t2 * 75);
      ctx.strokeStyle = "rgba(" + sR + "," + sG + "," + sB + ", 0.55)";
      ctx.beginPath();

      for (var cy2 = 0; cy2 < rows - 1; cy2++) {
        for (var cx2 = 0; cx2 < cols - 1; cx2++) {
          // For negative thresholds, flip the comparison:
          // we want cells BELOW the threshold (more negative)
          var tl2 = data[cy2 * cols + cx2];
          var tr2 = data[cy2 * cols + (cx2 + 1)];
          var bl2 = data[(cy2 + 1) * cols + cx2];
          var br2 = data[(cy2 + 1) * cols + (cx2 + 1)];

          var caseIdx2 = 0;
          if (tl2 <= threshold2) caseIdx2 |= 8;
          if (tr2 <= threshold2) caseIdx2 |= 4;
          if (br2 <= threshold2) caseIdx2 |= 2;
          if (bl2 <= threshold2) caseIdx2 |= 1;
          if (caseIdx2 === 0 || caseIdx2 === 15) continue;

          var tEdge2 = Math.max(0, Math.min(1, (threshold2 - tl2) / (tr2 - tl2 + 0.0001)));
          var bEdge2 = Math.max(0, Math.min(1, (threshold2 - bl2) / (br2 - bl2 + 0.0001)));
          var lEdge2 = Math.max(0, Math.min(1, (threshold2 - tl2) / (bl2 - tl2 + 0.0001)));
          var rEdge2 = Math.max(0, Math.min(1, (threshold2 - tr2) / (br2 - tr2 + 0.0001)));

          var px2 = cx2 * resolution, py2 = cy2 * resolution;
          var pxr2 = (cx2 + 1) * resolution, pyr2 = (cy2 + 1) * resolution;

          drawContourSegments(ctx, caseIdx2,
            px2 + tEdge2 * resolution, py2,
            px2 + bEdge2 * resolution, pyr2,
            px2, py2 + lEdge2 * resolution,
            pxr2, py2 + rEdge2 * resolution);
        }
      }
      ctx.stroke();
    }
  }

  // ---- RIDGE OVERLAY ----
  // Draw ridges as connected lines instead of individual cells.
  // Scan each row for runs of adjacent ridge cells and draw them
  // as line segments. This creates visible ridge LINES, not noise.
  if (showRidges) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "rgba(255, 180, 40, 0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (var ri2 = 0; ri2 < rows; ri2++) {
      var inRun = false;
      var runStartX = 0;
      for (var ci2 = 0; ci2 < cols; ci2++) {
        if (topo.ridges[ri2 * cols + ci2]) {
          if (!inRun) {
            runStartX = ci2;
            inRun = true;
          }
        } else if (inRun) {
          // End of a run — draw if it spans at least 2 cells
          if (ci2 - runStartX >= 2) {
            var ry = ri2 * resolution + resolution * 0.5;
            ctx.moveTo(runStartX * resolution, ry);
            ctx.lineTo(ci2 * resolution, ry);
          }
          inRun = false;
        }
      }
      if (inRun && cols - runStartX >= 2) {
        var ryEnd = ri2 * resolution + resolution * 0.5;
        ctx.moveTo(runStartX * resolution, ryEnd);
        ctx.lineTo(cols * resolution, ryEnd);
      }
    }

    // Also scan columns for vertical ridge runs
    for (var ci2b = 0; ci2b < cols; ci2b++) {
      var inRunV = false;
      var runStartY = 0;
      for (var ri2b = 0; ri2b < rows; ri2b++) {
        if (topo.ridges[ri2b * cols + ci2b]) {
          if (!inRunV) {
            runStartY = ri2b;
            inRunV = true;
          }
        } else if (inRunV) {
          if (ri2b - runStartY >= 2) {
            var rx = ci2b * resolution + resolution * 0.5;
            ctx.moveTo(rx, runStartY * resolution);
            ctx.lineTo(rx, ri2b * resolution);
          }
          inRunV = false;
        }
      }
      if (inRunV && rows - runStartY >= 2) {
        var rxEnd = ci2b * resolution + resolution * 0.5;
        ctx.moveTo(rxEnd, runStartY * resolution);
        ctx.lineTo(rxEnd, rows * resolution);
      }
    }
    ctx.stroke();
  }

  // ---- VALLEY OVERLAY ----
  // Draw valleys as thin dotted lines (same connected-run approach).
  if (showValleys) {
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = "rgba(80, 180, 255, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();

    for (var vi2 = 0; vi2 < rows; vi2++) {
      var vInRun = false;
      var vRunStart = 0;
      for (var ci3 = 0; ci3 < cols; ci3++) {
        if (topo.valleys[vi2 * cols + ci3]) {
          if (!vInRun) {
            vRunStart = ci3;
            vInRun = true;
          }
        } else if (vInRun) {
          if (ci3 - vRunStart >= 2) {
            var vy2 = vi2 * resolution + resolution * 0.5;
            ctx.moveTo(vRunStart * resolution, vy2);
            ctx.lineTo(ci3 * resolution, vy2);
          }
          vInRun = false;
        }
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- SADDLE POINT MARKERS ----
  if (showSaddles) {
    ctx.globalAlpha = 0.9;
    for (var si3 = 0; si3 < topo.saddles.length; si3++) {
      var sp = topo.saddles[si3];
      var spx = sp.gx * resolution + resolution * 0.5;
      var spy = sp.gy * resolution + resolution * 0.5;
      var spSize = 3 + Math.min(5, sp.strength * 100);

      // Draw an X mark at saddle points
      ctx.strokeStyle = "rgba(255, 80, 80, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(spx - spSize, spy - spSize);
      ctx.lineTo(spx + spSize, spy + spSize);
      ctx.moveTo(spx + spSize, spy - spSize);
      ctx.lineTo(spx - spSize, spy + spSize);
      ctx.stroke();
    }
  }

  // ---- FLOW FIELD (sparse arrows) ----
  if (showFlow) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = "rgba(200, 200, 255, 0.5)";
    ctx.lineWidth = 1;
    var arrowSpacing = 6;  // draw an arrow every N cells

    for (var fy = arrowSpacing; fy < rows - arrowSpacing; fy += arrowSpacing) {
      for (var fx = arrowSpacing; fx < cols - arrowSpacing; fx += arrowSpacing) {
        var fIdx = fy * cols + fx;
        var ffx = topo.flowX[fIdx];
        var ffy = topo.flowY[fIdx];
        var fConf = topo.confinement[fIdx];

        // Only draw where there's meaningful flow
        if (Math.abs(ffx) < 0.1 && Math.abs(ffy) < 0.1) continue;

        var ax = fx * resolution + resolution * 0.5;
        var ay = fy * resolution + resolution * 0.5;
        var aLen = (3 + fConf * 15) * resolution;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + ffx * aLen, ay + ffy * aLen);
        ctx.stroke();

        // Arrowhead
        var headLen = 3;
        var angle = Math.atan2(ffy, ffx);
        ctx.beginPath();
        ctx.moveTo(ax + ffx * aLen, ay + ffy * aLen);
        ctx.lineTo(
          ax + ffx * aLen - headLen * Math.cos(angle - 0.4),
          ay + ffy * aLen - headLen * Math.sin(angle - 0.4)
        );
        ctx.moveTo(ax + ffx * aLen, ay + ffy * aLen);
        ctx.lineTo(
          ax + ffx * aLen - headLen * Math.cos(angle + 0.4),
          ay + ffy * aLen - headLen * Math.sin(angle + 0.4)
        );
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}


// ================================================================
// drawContourSegments  —  Marching squares line segments
// ================================================================
// Given a case index (0-15) and the four edge crossing points,
// draws the appropriate line segment(s) on the canvas context.
//
// The 16 cases:
//   0, 15: no contour (empty or full cell)
//   1, 14: bottom-left edge
//   2, 13: bottom-right edge
//   3, 12: left-right horizontal
//   4, 11: top-right edge
//   5:     ambiguous (two diagonals) — resolve as top-left + bottom-right
//   6, 9:  top-bottom vertical
//   7, 8:  top-left edge
//   10:    ambiguous — resolve as top-right + bottom-left

function drawContourSegments(ctx, caseIdx, tX, tY, bX, bY, lX, lY, rX, rY) {
  switch (caseIdx) {
    case 1: case 14:
      ctx.moveTo(lX, lY); ctx.lineTo(bX, bY); break;
    case 2: case 13:
      ctx.moveTo(bX, bY); ctx.lineTo(rX, rY); break;
    case 3: case 12:
      ctx.moveTo(lX, lY); ctx.lineTo(rX, rY); break;
    case 4: case 11:
      ctx.moveTo(tX, tY); ctx.lineTo(rX, rY); break;
    case 5:
      // Ambiguous: two segments (top-left + bottom-right)
      ctx.moveTo(tX, tY); ctx.lineTo(lX, lY);
      ctx.moveTo(bX, bY); ctx.lineTo(rX, rY);
      break;
    case 6: case 9:
      ctx.moveTo(tX, tY); ctx.lineTo(bX, bY); break;
    case 7: case 8:
      ctx.moveTo(tX, tY); ctx.lineTo(lX, lY); break;
    case 10:
      // Ambiguous: two segments (top-right + bottom-left)
      ctx.moveTo(tX, tY); ctx.lineTo(rX, rY);
      ctx.moveTo(lX, lY); ctx.lineTo(bX, bY);
      break;
    // cases 0, 15: no contour — do nothing
  }
}


// ================================================================
// FEATURE WEIGHT TRACKER
// ================================================================
// Tracks which topological features are predictive over time using
// EMA (exponential moving average) — same approach as the existing
// calibration system in projection.js.
//
// The prediction engine can query these weights to know how much
// to trust flow direction, valley containment, ridge bounce, etc.
// Features that verify poorly get automatically downweighted.

var topoWeights = {
  flow:    { accuracy: 0.5, samples: 0 },  // start neutral
  valley:  { accuracy: 0.5, samples: 0 },
  ridge:   { accuracy: 0.5, samples: 0 },
  saddle:  { accuracy: 0.5, samples: 0 },
  overall: { accuracy: 0.5, samples: 0 },
  alpha:   0.2  // EMA smoothing (lower = slower adaptation)
};

// updateTopoWeights  —  Incorporate a new verification report
//
// Call this after topoVerify returns results. It updates the
// running accuracy estimates using EMA.

function updateTopoWeights(report) {
  if (!report) return;
  var a = topoWeights.alpha;

  if (report.flowSamples > 0) {
    topoWeights.flow.accuracy = topoWeights.flow.accuracy * (1 - a) + report.flowAccuracy * a;
    topoWeights.flow.samples += report.flowSamples;
  }
  if (report.valleySamples > 0) {
    topoWeights.valley.accuracy = topoWeights.valley.accuracy * (1 - a) + report.valleyAccuracy * a;
    topoWeights.valley.samples += report.valleySamples;
  }
  if (report.ridgeSamples > 0) {
    topoWeights.ridge.accuracy = topoWeights.ridge.accuracy * (1 - a) + report.ridgeRespect * a;
    topoWeights.ridge.samples += report.ridgeSamples;
  }
  if (report.saddleSamples > 0) {
    topoWeights.saddle.accuracy = topoWeights.saddle.accuracy * (1 - a) + report.saddleRelevance * a;
    topoWeights.saddle.samples += report.saddleSamples;
  }

  topoWeights.overall.accuracy = topoWeights.overall.accuracy * (1 - a) + report.overallScore * a;
  topoWeights.overall.samples++;
}

// getTopoForceWeights  —  Returns normalized weights for prediction
//
// The prediction engine uses these to scale how much influence each
// topological feature has on particle forces.
//
// Features with high verified accuracy → high weight.
// Features with low accuracy → low weight (near zero).
// Features with no samples yet → neutral (0.5).
//
// Returns { flow, valley, ridge, saddle } each in [0, 1].

function getTopoForceWeights() {
  return {
    flow:   topoWeights.flow.accuracy,
    valley: topoWeights.valley.accuracy,
    ridge:  topoWeights.ridge.accuracy,
    saddle: topoWeights.saddle.accuracy,
    overall: topoWeights.overall.accuracy,
    totalSamples: topoWeights.overall.samples
  };
}
