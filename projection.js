/*
 * ================================================================
 * projection.js  —  Projection Engine (Light-Driven, Calibrated)
 * ================================================================
 * Depends on: config.js (CONFIG, state, ctx, calibration)
 *             coords.js (priceToY)
 *
 * The prediction force field is derived directly from the four
 * color-coded heatmap light grids. Every heatmap control affects
 * the prediction: Rays Only, RES, LENGTH→GLOW, OPACITY, INTENSITY.
 *
 * ---- COLOR FORCE PHYSICS (user-configurable) ----
 *
 * Each beam color has a direction and strength set by the user:
 *   dir:  +1 = push price DOWN,  -1 = push price UP
 *   str:  0..2.0 strength multiplier
 *
 * Defaults:
 *   GREEN  (high, up)   dir=+1, str=1.0 (strong resistance)
 *   YELLOW (high, down) dir=+1, str=0.4 (weak resistance)
 *   BLUE   (low, up)    dir=-1, str=0.4 (weak support)
 *   RED    (low, down)  dir=-1, str=1.0 (strong support)
 *
 * Force per cell = light_value × direction × strength
 * Users can flip directions, zero out colors, or boost them.
 *
 * ---- CALIBRATION ----
 *
 * Tracks past predictions vs actual outcomes. Each time we have
 * new candles that weren't there when the last prediction was made,
 * we compare what we predicted to what actually happened.
 *
 * Per-step bias correction via exponential moving average:
 *   error[k] = actual_price_at_step_k - predicted_price_at_step_k
 *   bias[k]  = EMA(error[k])  (smoothing alpha = 0.3)
 *
 * The bias is added to raw predictions. Over time, if the model
 * consistently overshoots resistance or undershoots support, the
 * correction learns that pattern and compensates.
 *
 * Works during animation playback (each tick verifies prior steps)
 * and across live data refreshes.
 * ================================================================
 */

function buildProjection(hmData, resolution, candles, dims, projDims, priceMin, priceMax, assetKey, cachedTopo) {
  var chartTop  = dims.chartTop;
  var chartH    = dims.chartHeight;
  var count     = candles.length;
  var projLeft  = projDims.projLeft;
  var projW     = projDims.projWidth;
  var candleW   = projDims.candleW;
  if (projW < 5 || count < 3) return null;

  var projSlots = Math.max(1, Math.floor(projW / candleW));

  var lastCandle = candles[count - 1];
  var currentPriceY = priceToY(lastCandle.c, priceMin, priceMax, chartTop, chartH);
  var currentPrice  = lastCandle.c;

  // Recent momentum (price change per candle)
  var momCandles = Math.min(10, count);
  var recentMom = (candles[count - 1].c - candles[count - momCandles].c) / momCandles;

  // Volatility estimate (short-term)
  var volSum = 0;
  var volN = Math.min(20, count);
  for (var vi = count - volN; vi < count; vi++) {
    volSum += candles[vi].h - candles[vi].l;
  }
  var avgRange = volSum / volN;

  // Average volume across the visible dataset (used by neural features).
  // Broader than the 5-candle volDrift window — gives the net a sense
  // of whether current volume is typical or extreme.
  var avgVolumeAll = 0;
  for (var avi = 0; avi < count; avi++) {
    avgVolumeAll += candles[avi].v;
  }
  avgVolumeAll /= (count || 1);


  // ================================================================
  // RESISTANCE DENSITY PROFILE (cached)
  // ================================================================
  // Expensive computation — only rebuild when candle count changes.
  // Cached in calibration object keyed by count + chartH.
  //
  // Also pre-computes a grid-resolution density lookup array so
  // sampleForce can do direct array access instead of function calls.

  var densityRows = Math.ceil(chartH);
  var resistDensity;       // pixel-Y resolution (for diagnostics)
  var gridDensity;         // grid resolution (for sampleForce — fast lookup)
  var maxDensity = 0;
  var hmRows = hmData.rows;

  // Cache key: count + chartH determines when to recompute
  var densityCacheKey = count + "-" + densityRows;
  var existingCal2 = calibration[assetKey];
  if (existingCal2 && existingCal2._densityCacheKey === densityCacheKey && existingCal2._resistDensity) {
    // Cache hit — reuse previous computation
    resistDensity = existingCal2._resistDensity;
    gridDensity = existingCal2._gridDensity;
  } else {
    // Cache miss — compute from scratch
    resistDensity = new Float32Array(densityRows);

    for (var dci = 0; dci < count; dci++) {
      var dc = candles[dci];
      var dcRange = dc.h - dc.l;
      if (dcRange < 0.0001 || dc.v < 0.0001) continue;

      var density = dc.v / dcRange;
      var recencyW = 0.3 + 0.7 * (dci / Math.max(1, count - 1));

      var dYTop = Math.floor(priceToY(dc.h, priceMin, priceMax, chartTop, chartH) - chartTop);
      var dYBot = Math.ceil(priceToY(dc.l, priceMin, priceMax, chartTop, chartH) - chartTop);
      if (dYTop < 0) dYTop = 0;
      if (dYBot >= densityRows) dYBot = densityRows - 1;

      for (var dyi = dYTop; dyi <= dYBot; dyi++) {
        resistDensity[dyi] += density * recencyW;
        if (resistDensity[dyi] > maxDensity) maxDensity = resistDensity[dyi];
      }
    }

    // Normalize to 0..1
    if (maxDensity > 0) {
      for (var dni = 0; dni < densityRows; dni++) {
        resistDensity[dni] /= maxDensity;
      }
    }

    // Pre-compute grid-resolution lookup: one density value per grid row.
    // sampleForce works in grid coords (gy), so this avoids per-cell
    // function calls and coordinate conversions in the hot loop.
    gridDensity = new Float32Array(hmRows);
    for (var gdi = 0; gdi < hmRows; gdi++) {
      var gdPixelY = gdi * resolution;
      var gdRow = Math.floor(gdPixelY);  // chartTop-relative pixel row
      if (gdRow >= 0 && gdRow < densityRows) {
        gridDensity[gdi] = resistDensity[gdRow];
      }
    }

    // Store in calibration for next frame's cache hit
    if (existingCal2) {
      existingCal2._densityCacheKey = densityCacheKey;
      existingCal2._resistDensity = resistDensity;
      existingCal2._gridDensity = gridDensity;
    }
  }

  // Fast inline density lookup by grid-Y (used in sampleForce)
  // No function call overhead — direct array access.
  // Returns 0..1 normalized density.

  // Diagnostics only — these use the pixel-resolution array
  var densityAtEntry = 0;
  var entryRow = Math.floor(currentPriceY - chartTop);
  if (entryRow >= 0 && entryRow < densityRows) densityAtEntry = resistDensity[entryRow];

  var avgDensityNearPrice = 0;
  var densityScanR = Math.min(20, Math.floor(densityRows * 0.1));
  var densityScanCount = 0;
  for (var dsi = -densityScanR; dsi <= densityScanR; dsi++) {
    var dsRow = entryRow + dsi;
    if (dsRow >= 0 && dsRow < densityRows) {
      avgDensityNearPrice += resistDensity[dsRow];
      densityScanCount++;
    }
  }
  if (densityScanCount > 0) avgDensityNearPrice /= densityScanCount;

  // ================================================================
  // VOLATILITY REGIME DETECTION
  // ================================================================
  // Compare RECENT volatility (last 5 candles) to BASELINE (last 50).
  // A big move creates a spike: volRatio >> 1.0.
  //
  // When volRatio is high, the model adapts:
  //   - Light field forces are dampened (old S/R levels were just blown through)
  //   - Market forces are dampened (MA/RSI are lagging behind the move)
  //   - Scenario damping increases (predictions should be more cautious)
  //   - Calibration bias corrections are discounted (old patterns don't apply)
  //
  // volRatio 1.0 = normal conditions, no adjustment.
  // volRatio 2.0 = double normal volatility, significant dampening.
  // volRatio 3.0+ = extreme move, heavy dampening.

  var recentVolN = Math.min(5, count);
  var baselineVolN = Math.min(50, count);
  var recentVolSum = 0;
  var baselineVolSum = 0;

  for (var rvi = count - recentVolN; rvi < count; rvi++) {
    recentVolSum += candles[rvi].h - candles[rvi].l;
  }
  for (var bvi = count - baselineVolN; bvi < count; bvi++) {
    baselineVolSum += candles[bvi].h - candles[bvi].l;
  }
  var recentVol   = recentVolSum / recentVolN;
  var baselineVol = baselineVolSum / baselineVolN;
  var volRatio    = baselineVol > 0 ? recentVol / baselineVol : 1.0;

  // Also detect large single-candle moves (gap/spike candles).
  // If the last candle's range is much bigger than average, that
  // single candle probably broke through established S/R levels.
  var lastCandleRange = candles[count - 1].h - candles[count - 1].l;
  var spikeRatio = baselineVol > 0 ? lastCandleRange / baselineVol : 1.0;
  // Use whichever is more extreme
  var effectiveVolRatio = Math.max(volRatio, spikeRatio);

  // Convert to a dampening factor: 1.0 = no dampening, 0.0 = full dampening.
  // Uses an inverse curve: ratio 1.0 → 1.0, ratio 2.0 → 0.5, ratio 3.0 → 0.33.
  var volDampen = state.predVolDamp
    ? 1.0 / Math.max(1.0, effectiveVolRatio)
    : 1.0;  // bypass: no dampening

  // Also compute a damping boost for scenario damping coefficients.
  // In high volatility, increase damping so predictions converge faster
  // instead of oscillating wildly.
  var dampingBoost = state.predVolDamp
    ? Math.min(0.03, (effectiveVolRatio - 1.0) * 0.01)
    : 0;


  // ================================================================
  // HEATMAP GRID REFERENCES
  // ================================================================

  var hmGrids = hmData.grids;
  var hmCols  = hmData.cols;
  // hmRows already declared above (in density profile section)

  var G_GREEN  = 0;  // high, up   → strong resistance
  var G_YELLOW = 1;  // high, down → weak resistance
  var G_BLUE   = 2;  // low, up    → weak support
  var G_RED    = 3;  // low, down  → strong support


  // ================================================================
  // TOPOLOGICAL ANALYSIS OF THE PRESSURE FIELD
  // ================================================================
  // Compute gradient vectors, ridges, valleys, saddle points from
  // the heatmap intensity grids. This gives the prediction engine a
  // richer force field than raw light sampling alone.
  //
  // The topology is computed from the CURRENT grid state (past-only
  // data). As virtual candle beams are painted into the grids during
  // the step loop, the topology is periodically recomputed so each
  // prediction step only sees data up to that point.
  //
  // Controlled by state.predTopo toggle.

  var topo = null;
  var topoForceWeights = null;   // verified accuracy weights from past runs
  if (state.predTopo && typeof computeTopology === "function") {
    // Use pre-computed topology when available (avoids recomputing
    // blur + gradient + ridge detection every frame — ~20-30ms at res=1).
    // The topology is from the CURRENT grid state before virtual beams.
    topo = cachedTopo || computeTopology(hmGrids, hmCols, hmRows, state.colorForce);
    topoForceWeights = (typeof getTopoForceWeights === "function")
      ? getTopoForceWeights()
      : { flow: 0.5, valley: 0.5, ridge: 0.5, saddle: 0.5, overall: 0.5, totalSamples: 0 };
  }

  // Snapshot the topology at the prediction boundary for later verification.
  // This captures what the topology looked like BEFORE any virtual beams
  // were added — the "past-only" view that must be evaluated honestly.
  var topoSnap = null;
  if (topo && typeof topoSnapshot === "function") {
    var boundaryGx = Math.floor(projLeft / resolution);
    topoSnap = topoSnapshot(topo, boundaryGx, Math.min(projSlots, 30));
  }


  // ================================================================
  // SAMPLE COLOR-AWARE FORCE
  // ================================================================
  //   Top-side light (green + yellow) → push price DOWN
  //   Bottom-side light (blue + red)  → push price UP
  //   Green & red are 2.5× stronger than yellow & blue
  //
  // Samples MULTIPLE columns ahead to capture beam trajectories,
  // not just a single vertical slice.
  //
  // Force per color = light_value * direction * strength
  // Direction and strength come from state.colorForce (user-configurable).
  // dir: +1 = push price DOWN (pixel Y up), -1 = push price UP
  // str: 0..2.0 multiplier

  var scanRadius = Math.max(10, Math.floor(chartH * 0.25 / resolution));

  // Read user-configured force settings (still used for visualization
  // and sampleLightEnvironment, but NOT for prediction force)
  var cf = state.colorForce;
  var cfGreen  = cf.green.dir  * cf.green.str;
  var cfYellow = cf.yellow.dir * cf.yellow.str;
  var cfBlue   = cf.blue.dir   * cf.blue.str;
  var cfRed    = cf.red.dir    * cf.red.str;

  // ================================================================
  // sampleForce  —  GRAVITATIONAL LIGHT MODEL + COLOR BIAS
  // ================================================================
  //
  // TWO FORCES combined:
  //
  // 1. GRAVITY (position-dependent): Bright zones are like planets.
  //    Price is attracted from afar, repelled at close range.
  //    Based on TOTAL light intensity — color-blind.
  //
  //   FAR FIELD (distance > crossover):
  //     ATTRACTION. Price drifts TOWARD bright zones. A convergence
  //     of trend lines is where the market's attention is — liquidity
  //     pools there, orders cluster there. Price gets pulled in to
  //     test the level. Brighter = stronger pull from farther away.
  //
  //   NEAR FIELD (distance < crossover):
  //     REPULSION. Once price reaches the bright zone, it bounces.
  //     The denser the convergence, the harder the bounce. This is
  //     the "wall" effect — support holds, resistance rejects.
  //
  // 2. COLOR BIAS (position-independent): Each cell's S/R color
  //    composition creates a directional push.
  //    Support-dominated (blue+red > green+yellow) → pushes UP.
  //    Resistance-dominated (green+yellow > blue+red) → pushes DOWN.
  //    This is the light field telling price which way the pressure
  //    goes, separate from the gravitational attract/repel.
  //
  //    Controlled by state.colorBiasForce (the S/R Bias slider).

  // Color bias strength — read once, used per cell in the scan loop
  var cbForce = (state.colorBiasForce != null) ? state.colorBiasForce : 0.25;

  function sampleForce(gx, gy) {
    if (gx < 0 || gx >= hmCols) return 0;

    var force = 0;
    var colSpread = 4;  // look ahead 4 columns for approaching beams

    for (var cx = 0; cx < colSpread; cx++) {
      var sgx = gx + cx;
      if (sgx >= hmCols) break;
      var colWeight = 1.0 / (1 + cx * 0.25);

      for (var scan = -scanRadius; scan <= scanRadius; scan++) {
        if (scan === 0) continue;

        var sgy = gy + scan;
        if (sgy < 0 || sgy >= hmRows) continue;

        var idx = sgy * hmCols + sgx;

        // Read individual channels for both total brightness and color bias
        var gVal = hmGrids[G_GREEN][idx];
        var yVal = hmGrids[G_YELLOW][idx];
        var bVal = hmGrids[G_BLUE][idx];
        var rVal = hmGrids[G_RED][idx];

        // Total light (weighted by user strength sliders) — for gravity
        var totalLight = gVal * cf.green.str
                       + yVal * cf.yellow.str
                       + bVal * cf.blue.str
                       + rVal * cf.red.str;

        if (totalLight < 0.005) continue;

        var dist = Math.abs(scan);

        // ---- CROSSOVER DISTANCE ----
        // Brighter zones have a larger "surface" — you hit the wall
        // from farther away. Dim zones only repel at point-blank.
        var crossover = 2.0 + Math.sqrt(totalLight) * 2.5;

        // ---- GRAVITATIONAL DIRECTION ----
        // scan < 0 → light is ABOVE → "toward light" = UP (negative pixel-Y)
        // scan > 0 → light is BELOW → "toward light" = DOWN (positive pixel-Y)
        var towardLight = (scan < 0) ? -1.0 : 1.0;

        var cellForce;

        if (dist <= crossover) {
          // ---- NEAR FIELD: REPULSION ----
          var repelStrength = (crossover - dist) / crossover;
          repelStrength = repelStrength * repelStrength;
          cellForce = -towardLight * totalLight * repelStrength * 0.6;
        } else {
          // ---- FAR FIELD: ATTRACTION ----
          var farDist = dist - crossover;
          var attractStrength = 1.0 / (farDist * farDist * 0.08 + 1);
          cellForce = towardLight * totalLight * attractStrength * 0.3;
        }

        // Scale force by resistance density at this cell's price level.
        var cellDensity = (sgy >= 0 && sgy < hmRows) ? gridDensity[sgy] : 0;
        var densityMult = 0.3 + cellDensity * 1.7;

        force += cellForce * colWeight * densityMult;

        // ---- COLOR BIAS DIRECTIONAL FORCE ----
        // Independent of position — based purely on what COLOR the
        // light is. Support light (blue+red) pushes price UP (negative
        // pixel-Y). Resistance light (green+yellow) pushes price DOWN
        // (positive pixel-Y). Falls off with distance so nearby color
        // matters more than distant color.
        if (cbForce > 0.001) {
          var support = (bVal * cf.blue.str + rVal * cf.red.str);
          var resist  = (gVal * cf.green.str + yVal * cf.yellow.str);
          var bias = resist - support;  // positive = push DOWN, negative = push UP

          // Distance falloff: nearby cells have much stronger influence
          var proxWeight = 1.0 / (dist * 0.15 + 1);

          force += bias * proxWeight * colWeight * cbForce * 0.15;
        }
      }
    }

    return force;
  }


  // ================================================================
  // sampleLightEnvironment  —  Rich snapshot of the light field
  // ================================================================
  // Captures a detailed picture of the beam environment around a
  // given grid position. Used for pattern study: when a prediction
  // is wrong, what did the light look like?
  //
  // Returns an object with:
  //   green, yellow, blue, red  — total weighted light per channel
  //   netForce       — combined force (positive = push down)
  //   totalLight     — sum of all channels
  //   resistAbove    — how much top-side light is above this position
  //   supportBelow   — how much bottom-side light is below this position
  //   balance        — resistAbove vs supportBelow ratio (-1..+1)
  //   dominantColor  — which channel has the most light ("green"/"yellow"/"blue"/"red")

  function sampleLightEnvironment(gx, gy) {
    var env = {
      green: 0, yellow: 0, blue: 0, red: 0,
      netForce: 0, totalLight: 0,
      resistAbove: 0, supportBelow: 0, balance: 0,
      dominantColor: "none",
    };

    if (gx < 0 || gx >= hmCols) return env;

    var colSpread = 5;   // sample 5 columns ahead
    var scanR = Math.max(20, Math.floor(chartH * 0.25 / resolution));

    for (var cx = 0; cx < colSpread; cx++) {
      var sgx = gx + cx;
      if (sgx >= hmCols) break;
      var colW = 1.0 / (1 + cx * 0.2);

      for (var scan = -scanR; scan <= scanR; scan++) {
        var sgy = gy + scan;
        if (sgy < 0 || sgy >= hmRows) continue;

        var idx = sgy * hmCols + sgx;
        var g = hmGrids[G_GREEN][idx];
        var y = hmGrids[G_YELLOW][idx];
        var b = hmGrids[G_BLUE][idx];
        var r = hmGrids[G_RED][idx];
        var total = g + y + b + r;
        if (total < 0.005) continue;

        var dist = Math.abs(scan) + 1;
        var prox = 1.0 / (dist * 0.05 + 1);
        var w = prox * colW;

        env.green  += g * w;
        env.yellow += y * w;
        env.blue   += b * w;
        env.red    += r * w;

        // Resistance above: green+yellow light that is above this position
        // Support below: blue+red light that is below this position
        if (scan < 0) {
          // This cell is above current price (lower Y = higher price)
          env.resistAbove += (g + y) * w;
        } else if (scan > 0) {
          // This cell is below current price (higher Y = lower price)
          env.supportBelow += (b + r) * w;
        }
      }
    }

    env.totalLight = env.green + env.yellow + env.blue + env.red;
    env.netForce = env.green  * cfGreen
                 + env.yellow * cfYellow
                 + env.blue   * cfBlue
                 + env.red    * cfRed;

    // Balance: +1 means much more resistance above, -1 means much more support below
    var resistSupport = env.resistAbove + env.supportBelow;
    if (resistSupport > 0.01) {
      env.balance = (env.resistAbove - env.supportBelow) / resistSupport;
    }

    // Dominant color
    var maxCh = Math.max(env.green, env.yellow, env.blue, env.red);
    if (maxCh > 0.01) {
      if (maxCh === env.green)       env.dominantColor = "green";
      else if (maxCh === env.yellow) env.dominantColor = "yellow";
      else if (maxCh === env.blue)   env.dominantColor = "blue";
      else                           env.dominantColor = "red";
    }

    return env;
  }


  // ================================================================
  // LAYERED SIGNAL PIPELINE TRAINING
  // ================================================================
  // Training is now done in the SIGNAL SCALE CALIBRATION section below
  // (after all signal infrastructure is ready: sampleForce, queryFlowLive,
  // MA/RSI state, LSSA, corridor). That section samples all 7 raw signals
  // at visible candle positions and feeds them to trainSignalLayers().
  //
  // The old trainNeuralFromLight() backward-compat wrapper still works
  // if called, but the full pipeline needs all signals — not just light.
  //
  // neuralMaxLight, neuralAvgBody, neuralAvgVolume are still set here
  // for backward compatibility with any code that reads them.
  if (typeof sampleLightEnvironment === "function") {
    var _maxLight = 0.1;
    for (var _mli = 0; _mli < count; _mli++) {
      var _mlx = indexToX(_mli, count, dims.chartLeft, dims.chartWidth);
      var _mly = priceToY(candles[_mli].c, priceMin, priceMax, dims.chartTop, dims.chartHeight);
      var _mlgx = Math.floor(_mlx / resolution);
      var _mlgy = Math.floor(_mly / resolution);
      var _mlEnv = sampleLightEnvironment(_mlgx, _mlgy);
      if (_mlEnv.totalLight > _maxLight) _maxLight = _mlEnv.totalLight;
    }
    neuralMaxLight = _maxLight;
    var _totalBody = 0, _totalVol = 0;
    for (var _si = 0; _si < count; _si++) {
      _totalBody += Math.abs(candles[_si].c - candles[_si].o);
      _totalVol += candles[_si].v;
    }
    neuralAvgBody = _totalBody / count;
    neuralAvgVolume = _totalVol / count;
    if (neuralAvgBody < 0.0001) neuralAvgBody = avgRange * 0.3;
  }


  // ================================================================
  // GRAVITATIONAL FIELD AT PREDICTION ENTRY
  // ================================================================
  // With the gravity model, we don't need a separate entry bias
  // system — sampleForce already computes the net gravitational
  // pull (attract from far, repel from near). The entry bias just
  // seeds the initial velocity in the direction the gravity field
  // is already pulling.
  //
  // We also measure the field structure for the confidence gate:
  //   - lightAbove / lightBelow: wall intensities
  //   - attractorStrength: is there a dominant bright zone nearby?
  //   - channelWidth / channelStrength: how contained is price?

  var entryGx = Math.floor(projLeft / resolution);
  var entryGy = Math.floor(currentPriceY / resolution);

  // Sample the gravity field at the entry point.
  // This gives us the net pull direction and magnitude.
  var entryGravity = state.predLight ? sampleForce(entryGx, entryGy) : 0;

  // Also scan for structural metrics (confidence gate needs these).
  var corridorScanR = Math.max(30, Math.floor(chartH * 0.4 / resolution));
  var lightAbove = 0;
  var lightBelow = 0;
  var wallAboveWeightedDist = 0;
  var wallBelowWeightedDist = 0;
  // Track the brightest cell above and below for attractor detection
  var peakAbove = 0;
  var peakBelow = 0;
  var peakAboveDist = 0;
  var peakBelowDist = 0;

  for (var csCol = 0; csCol < 5; csCol++) {
    var csGx = entryGx + csCol;
    if (csGx >= hmCols) break;
    var csColW = 1.0 / (1 + csCol * 0.2);

    for (var csScan = 1; csScan <= corridorScanR; csScan++) {
      // Above (lower pixel Y = higher price)
      var csGyUp = entryGy - csScan;
      if (csGyUp >= 0 && csGyUp < hmRows) {
        var csIdxUp = csGyUp * hmCols + csGx;
        var csLightUp = hmGrids[G_GREEN][csIdxUp] * cf.green.str
                      + hmGrids[G_YELLOW][csIdxUp] * cf.yellow.str
                      + hmGrids[G_BLUE][csIdxUp] * cf.blue.str
                      + hmGrids[G_RED][csIdxUp] * cf.red.str;
        var csProxUp = 1.0 / (csScan * 0.05 + 1);
        lightAbove += csLightUp * csProxUp * csColW;
        wallAboveWeightedDist += csLightUp * csProxUp * csColW * csScan;
        if (csLightUp * csColW > peakAbove) {
          peakAbove = csLightUp * csColW;
          peakAboveDist = csScan;
        }
      }

      // Below (higher pixel Y = lower price)
      var csGyDown = entryGy + csScan;
      if (csGyDown >= 0 && csGyDown < hmRows) {
        var csIdxDown = csGyDown * hmCols + csGx;
        var csLightDown = hmGrids[G_GREEN][csIdxDown] * cf.green.str
                        + hmGrids[G_YELLOW][csIdxDown] * cf.yellow.str
                        + hmGrids[G_BLUE][csIdxDown] * cf.blue.str
                        + hmGrids[G_RED][csIdxDown] * cf.red.str;
        var csProxDown = 1.0 / (csScan * 0.05 + 1);
        lightBelow += csLightDown * csProxDown * csColW;
        wallBelowWeightedDist += csLightDown * csProxDown * csColW * csScan;
        if (csLightDown * csColW > peakBelow) {
          peakBelow = csLightDown * csColW;
          peakBelowDist = csScan;
        }
      }
    }
  }

  // lightBias: which direction is the net gravity pulling?
  // Positive entryGravity = gravity pulls DOWN (pixel-Y increases)
  // Normalize to -1..+1 range for storage and confidence gate.
  var totalLightAtEntry = lightAbove + lightBelow;
  var lightBias = 0;
  if (totalLightAtEntry > 0.01) {
    lightBias = (lightAbove - lightBelow) / totalLightAtEntry;
    if (lightBias > 1) lightBias = 1;
    if (lightBias < -1) lightBias = -1;
  }

  // Channel metrics (for confidence gate)
  var avgWallAboveDist = lightAbove > 0.01 ? wallAboveWeightedDist / lightAbove : corridorScanR;
  var avgWallBelowDist = lightBelow > 0.01 ? wallBelowWeightedDist / lightBelow : corridorScanR;
  var channelWidth = avgWallAboveDist + avgWallBelowDist;
  var channelStrength = 1.0 / (1 + channelWidth * 0.02);

  // Attractor strength: how bright is the strongest nearby zone?
  // A dominant attractor means there's a clear "target" level.
  var attractorStrength = Math.max(peakAbove, peakBelow);

  // lightDrift: persistent per-step nudge in the gravity direction.
  // This is much gentler than the old color-directional push —
  // the real work is done by sampleForce during the step loop.
  // lightDrift just ensures the initial trajectory is seeded correctly.
  var lightDrift = state.predLight
    ? entryGravity * 0.15 * volDampen
    : 0;

  // lightVyBias: initial velocity nudge from the gravity field.
  // Stronger than lightDrift because it's a one-time kick.
  var lightVyBias = state.predLight
    ? entryGravity * 0.4 * volDampen
    : 0;


  // ================================================================
  // MARKET FORCE COMPUTATION
  // ================================================================
  // Each component produces a per-step drift in pixel-Y terms.
  // Positive = push price DOWN (pixel Y increases).
  // Negative = push price UP (pixel Y decreases).
  // All are computed from the real candle data (not predictions).
  // They blend with the light field force during simulation.

  // -- MOVING AVERAGE FORCE (per-step evolution) --
  // OLD: Computed a constant maDrift from the last candle's MA distance.
  // NEW: Initializes a running MA that evolves with each predicted price.
  //      The spring force is computed per-step inside the prediction loop,
  //      using calibrated spring constants from background candle data.
  //
  // maDrift is kept at 0 here for backward compatibility with the
  // weightedMA/marketDrift system. The real work happens in stepMA()
  // during the step loop.
  var maDrift = 0;
  var runningMA = null;
  var indCalib = indicatorCalibration;  // from calibrate-indicators.js
  if (!indCalib) {
    // No calibration available — use defaults
    indCalib = {
      maSpring: 0.12, maOvershoot: 1.5, maCrossDecay: 5,
      rsiDeadLow: 38, rsiDeadHigh: 62, rsiReversion: 0.02,
      maWeight: 0.55, rsiWeight: 0.45, samples: 0, valid: false
    };
  }

  if (state.predMA && count >= CONFIG.MA_PERIOD + 1
      && typeof initRunningMA === "function") {
    runningMA = initRunningMA(candles, CONFIG.MA_PERIOD);
  }

  // -- RSI FORCE (per-step evolution) --
  // Same approach: initialized here, evolved per-step in the loop.
  var rsiDrift = 0;
  var runningRSI = null;
  if (state.predRSI && count >= CONFIG.RSI_PERIOD + 2
      && typeof initRunningRSI === "function") {
    runningRSI = initRunningRSI(candles, CONFIG.RSI_PERIOD);
  }

  // -- VOLUME FORCE --
  // Buy pressure > 0.5 → more buyers → push UP.
  // Buy pressure < 0.5 → more sellers → push DOWN.
  // Weighted by recent volume relative to average.
  var volDrift = 0;
  if (state.predVol && count >= 5) {
    // Average buy pressure over last 5 candles
    var bpSum = 0;
    var volWtSum = 0;
    var avgVolume = 0;
    for (var vpi = count - 5; vpi < count; vpi++) {
      avgVolume += candles[vpi].v;
    }
    avgVolume /= 5;

    for (var vpi2 = count - 5; vpi2 < count; vpi2++) {
      var bp = candles[vpi2].buyPressure || 0.5;
      // Weight by volume: high-volume candles matter more
      var volWt = avgVolume > 0 ? candles[vpi2].v / avgVolume : 1;
      bpSum += (bp - 0.5) * volWt;
      volWtSum += volWt;
    }
    if (volWtSum > 0) {
      var netBuyPressure = bpSum / volWtSum;  // -0.5 (all sell) to +0.5 (all buy)
      // Buy pressure → push UP (negative pixel-Y)
      volDrift = -netBuyPressure * chartH * 0.008;
    }
  }

  // ================================================================
  // LSSA — LEAST SQUARES SPECTRAL ANALYSIS
  // ================================================================
  // Decomposes recent price history into overlapping SINE WAVES
  // (cycles). Finds the dominant rhythms — maybe a 12-candle swing,
  // a 30-candle swing, a 60-candle swing all happening at once.
  // Then extrapolates ALL those waves forward simultaneously.
  //
  // The result is a WAVY prediction that goes up AND down because
  // the cycles continue oscillating. This captures the natural
  // rhythm of price action — not just "price goes up" or "price
  // goes down" but "price oscillates within a structure."
  //
  // Method:
  //   1. Take the last N candle closes (half the chart)
  //   2. Remove the linear trend (detrend)
  //   3. Scan frequencies to build a periodogram (power spectrum)
  //   4. Pick the top K strongest cycles
  //   5. Fit amplitude + phase for each cycle via least squares
  //   6. Extrapolate: trend + sum of all fitted sinusoids
  //
  // This is the technique that produces "convincing prediction
  // charts" — price really is composed of overlapping cycles,
  // and projecting those cycles forward captures the probable
  // shape of future movement.

  var lssaDrift = 0;
  var lssaCycles = null;
  var lssaTrendSlope = 0;
  var lssaTrendIntercept = 0;
  var lssaN = Math.floor(count / 2);
  var MAX_CYCLES = 5;

  if (state.predLSR && lssaN >= 20) {

    // ---- LSSA CACHE: skip recomputation if candle count unchanged ----
    var lssaCacheKey = count + "-" + lssaN;
    var existingCal3 = calibration[assetKey];
    if (existingCal3 && existingCal3._lssaCacheKey === lssaCacheKey && existingCal3._lssaCycles) {
      // Cache hit — reuse previous LSSA results
      lssaCycles = existingCal3._lssaCycles;
      lssaTrendSlope = existingCal3._lssaTrendSlope;
      lssaTrendIntercept = existingCal3._lssaTrendIntercept;
      lssaDrift = existingCal3._lssaDrift;
    } else {
      // Cache miss — full LSSA computation
      var lssaStart = count - lssaN;
      var nLssa = lssaN;

    // ---- Step 1: Collect price data ----
    var lssaPrices = [];
    for (var li = 0; li < nLssa; li++) {
      lssaPrices.push(candles[lssaStart + li].c);
    }

    // ---- Step 2: Remove linear trend ----
    // Fit y = slope*x + intercept, then subtract it.
    // The cycles are in the RESIDUAL after detrending.
    var lsumX = 0, lsumY = 0, lsumXY = 0, lsumX2 = 0;
    for (var ldi = 0; ldi < nLssa; ldi++) {
      lsumX  += ldi;
      lsumY  += lssaPrices[ldi];
      lsumXY += ldi * lssaPrices[ldi];
      lsumX2 += ldi * ldi;
    }
    var trendDenom = nLssa * lsumX2 - lsumX * lsumX;
    if (Math.abs(trendDenom) > 0.0001) {
      lssaTrendSlope = (nLssa * lsumXY - lsumX * lsumY) / trendDenom;
      lssaTrendIntercept = (lsumY - lssaTrendSlope * lsumX) / nLssa;
    }

    // Detrended residuals
    var residuals = [];
    for (var lri = 0; lri < nLssa; lri++) {
      residuals.push(lssaPrices[lri] - (lssaTrendSlope * lri + lssaTrendIntercept));
    }

    // ---- Step 3: Periodogram — scan frequencies for power ----
    // Test frequencies from the longest meaningful cycle (full window)
    // down to the shortest (4 candles = minimum swing).
    //
    // For each frequency ω, compute:
    //   A = (2/N) * Σ residual[t] * cos(ω*t)
    //   B = (2/N) * Σ residual[t] * sin(ω*t)
    //   power = A² + B²

    var freqResults = [];
    var minPeriod = 4;
    var maxPeriod = Math.floor(nLssa * 0.8);
    var numFreqs = Math.min(80, Math.floor(nLssa / 2));

    for (var lfi = 0; lfi < numFreqs; lfi++) {
      var period = minPeriod + (maxPeriod - minPeriod) * (lfi / Math.max(1, numFreqs - 1));
      var omega = 2 * Math.PI / period;

      var cosSum = 0, sinSum = 0;
      for (var lti = 0; lti < nLssa; lti++) {
        cosSum += residuals[lti] * Math.cos(omega * lti);
        sinSum += residuals[lti] * Math.sin(omega * lti);
      }

      var lA = cosSum * 2 / nLssa;
      var lB = sinSum * 2 / nLssa;
      var power = lA * lA + lB * lB;

      freqResults.push({
        period: period,
        freq: omega,
        power: power,
        amp: Math.sqrt(power),
        A: lA,
        B: lB,
      });
    }

    // ---- Step 4: Pick the top K strongest cycles ----
    // Sort by power, take top MAX_CYCLES. Skip cycles too similar
    // in period to one already selected (within 20%).
    freqResults.sort(function(a, b) { return b.power - a.power; });

    lssaCycles = [];
    for (var lpi = 0; lpi < freqResults.length && lssaCycles.length < MAX_CYCLES; lpi++) {
      var candidate = freqResults[lpi];
      if (candidate.amp < avgRange * 0.05) continue;

      var tooClose = false;
      for (var lci = 0; lci < lssaCycles.length; lci++) {
        var pRatio = candidate.period / lssaCycles[lci].period;
        if (pRatio > 0.8 && pRatio < 1.2) { tooClose = true; break; }
      }
      if (tooClose) continue;

      lssaCycles.push(candidate);
    }

    // ---- Step 5: Compute instantaneous drift at current point ----
    // d/dt [slope*t + Σ A*cos(ωt) + B*sin(ωt)]
    //   = slope + Σ [-A*ω*sin(ωt) + B*ω*cos(ωt)]
    var tLast = nLssa - 1;
    var instantSlope = lssaTrendSlope;
    for (var lsi = 0; lsi < lssaCycles.length; lsi++) {
      var cyc = lssaCycles[lsi];
      instantSlope += -cyc.A * cyc.freq * Math.sin(cyc.freq * tLast)
                    +  cyc.B * cyc.freq * Math.cos(cyc.freq * tLast);
    }
    lssaDrift = -(instantSlope / (priceMax - priceMin)) * chartH * 0.5;

      // Store in cache for next frame
      if (existingCal3) {
        existingCal3._lssaCacheKey = lssaCacheKey;
        existingCal3._lssaCycles = lssaCycles;
        existingCal3._lssaTrendSlope = lssaTrendSlope;
        existingCal3._lssaTrendIntercept = lssaTrendIntercept;
        existingCal3._lssaDrift = lssaDrift;
      }
    }  // end else (cache miss)
  }  // end if (state.predLSR && lssaN >= 20)

  // Project price at a given step beyond the last data point.
  // step=1 → first prediction candle, step=2 → second, etc.
  // Returns trend + sum of all fitted sinusoids at that point.
  function lssaProjectPrice(step) {
    if (!lssaCycles || lssaCycles.length === 0) return null;
    var t = lssaN - 1 + step;
    var price = lssaTrendSlope * t + lssaTrendIntercept;
    for (var ci2 = 0; ci2 < lssaCycles.length; ci2++) {
      var cyc2 = lssaCycles[ci2];
      price += cyc2.A * Math.cos(cyc2.freq * t) + cyc2.B * Math.sin(cyc2.freq * t);
    }
    return price;
  }

  // -- STREAK EXHAUSTION / PULLBACK DETECTOR --
  // The #1 accuracy killer: predicting continuation when a pullback is due.
  //
  // In trending markets, candles don't go the same direction forever.
  // They trend for N candles, pull back for 1-2, then resume.
  // If we know the typical streak length, we can detect when we're
  // overdue for a pullback and apply counter-trend force.
  //
  // Method:
  //   1. Count the current streak (consecutive same-direction candles)
  //   2. Measure the average streak length over recent history
  //   3. If current streak > average, pullback probability rises
  //   4. Apply counter-trend force proportional to how overextended we are
  //
  // This is the ONLY force strong enough to override the light field
  // during trends, because it's based on a different kind of information:
  // not where S/R levels are, but how long the market has been pushing
  // in one direction without resting.

  var cycleDrift = 0;
  if (state.predCycle && count >= 15) {

    // Step 1: Count the current streak
    var currentDir = candles[count - 1].c > candles[count - 1].o ? 1 : -1;
    var streak = 1;
    for (var sti = count - 2; sti >= 0; sti--) {
      var sDir = candles[sti].c > candles[sti].o ? 1 : -1;
      if (sDir === currentDir) streak++;
      else break;
    }

    // Step 2: Measure typical streak lengths over last 60 candles
    // Scan for all streaks and compute the average
    var lookback = Math.min(60, count);
    var streakLengths = [];
    var runLen = 1;
    for (var sli = count - lookback + 1; sli < count; sli++) {
      var prevDir2 = candles[sli - 1].c > candles[sli - 1].o ? 1 : -1;
      var curDir2 = candles[sli].c > candles[sli].o ? 1 : -1;
      if (curDir2 === prevDir2) {
        runLen++;
      } else {
        streakLengths.push(runLen);
        runLen = 1;
      }
    }
    if (runLen > 0) streakLengths.push(runLen);

    // Average and max streak
    var avgStreak = 2;  // default fallback
    var maxStreak = 3;
    if (streakLengths.length >= 3) {
      var stSum = 0;
      for (var ssi = 0; ssi < streakLengths.length; ssi++) {
        stSum += streakLengths[ssi];
        if (streakLengths[ssi] > maxStreak) maxStreak = streakLengths[ssi];
      }
      avgStreak = stSum / streakLengths.length;
    }

    // Step 3: Calculate exhaustion level
    // How far past the average streak are we?
    // exhaustion 0 = at or below average (no pullback expected)
    // exhaustion 1 = at max historical streak (pullback very likely)
    // exhaustion > 1 = beyond all recent history (extreme)
    var exhaustion = 0;
    if (streak > avgStreak) {
      var overshoot = streak - avgStreak;
      var headroom = Math.max(1, maxStreak - avgStreak);
      exhaustion = overshoot / headroom;
      if (exhaustion > 2) exhaustion = 2;  // cap
    }

    // Step 4: Also measure the streak's price magnitude
    // A streak of 5 tiny candles is less exhausted than 5 big ones.
    // Accumulated move / average candle range = "how far have we stretched?"
    var streakMove = Math.abs(candles[count - 1].c - candles[count - streak].o);
    var stretchRatio = avgRange > 0.0001 ? streakMove / (avgRange * streak) : 1;
    // stretchRatio > 1 = each candle in the streak is bigger than average → more exhausted
    // stretchRatio < 1 = small grinding candles → less exhausted

    // Combine: exhaustion from count AND from magnitude
    var totalExhaustion = exhaustion * (0.5 + stretchRatio * 0.5);

    // Step 5: Counter-trend nudge ONLY on extreme exhaustion (>0.8).
    // Most streaks don't trigger this. It's a rare safety valve.
    if (totalExhaustion > 0.8) {
      // Gentle nudge only on extreme exhaustion. Only the excess counts.
      cycleDrift = currentDir * (totalExhaustion - 0.8) * chartH * 0.002;
    }

    // Step 6: Fresh reversal after a truly long streak = confirmed pullback.
    if (count >= 2) {
      var prevCDir = candles[count - 2].c > candles[count - 2].o ? 1 : -1;
      var lastCDir = candles[count - 1].c > candles[count - 1].o ? 1 : -1;
      if (lastCDir !== prevCDir) {
        var endedStreak = 1;
        for (var esi = count - 3; esi >= 0; esi--) {
          var esDir = candles[esi].c > candles[esi].o ? 1 : -1;
          if (esDir === prevCDir) endedStreak++;
          else break;
        }
        // Only boost if streak was well above average (not every reversal)
        if (endedStreak > avgStreak * 1.5) {
          cycleDrift += -lastCDir * chartH * 0.001;
        }
      }
    }
  }

  // -- MICRO WIND TUNNEL (Momentum / Continuance) --
  // Runs a small, fast particle simulation through the last N candles
  // to measure aerodynamic flow. This captures momentum dynamics that
  // simple math can't:
  //
  //   SMOOTH GRIND: Small consistent candles create laminar flow.
  //     Particles exit with coherent velocity → strong continuation force.
  //     Like a smooth wind tunnel: air flows evenly, no turbulence.
  //
  //   SPIKE: One big candle creates a massive obstruction.
  //     Particles deflect hard, creating wake turbulence behind it.
  //     Exit velocities are chaotic → weak/reversed force.
  //     Like putting a wall in a wind tunnel: backwash, eddies.
  //
  //   CHOPPY: Random candle sizes → mixed deflections.
  //     Particles exit with moderate coherence → weak force.
  //
  // ENHANCEMENTS:
  //   1. WICK-WEIGHTED FORCES: Upper wicks create downward drafts
  //      (sellers rejected the high), lower wicks create upward drafts
  //      (buyers defended the low). Separate from body forces.
  //
  //   2. BODY-TO-RANGE TURBULENCE: Doji candles (tiny body, big wicks)
  //      increase local turbulence. Marubozu candles (big body, no wicks)
  //      produce clean laminar flow.
  //
  //   3. CANDLE PATTERN DETECTION: 2-candle patterns (engulfing, harami)
  //      add directional bias to the last obstacle. Detected patterns
  //      amplify or dampen the final candle's force.

  var momDrift = 0;
  var patternSignal = 0;  // from candle pattern detection: -1..+1

  if (state.predMom && count >= 10) {
    var momN = Math.min(20, count);
    var momStart = count - momN;

    var simW = momN * 10;
    var simH = 200;

    var momPriceMin = Infinity, momPriceMax = -Infinity;
    for (var mpi = momStart; mpi < count; mpi++) {
      if (candles[mpi].l < momPriceMin) momPriceMin = candles[mpi].l;
      if (candles[mpi].h > momPriceMax) momPriceMax = candles[mpi].h;
    }
    var momPriceRange = momPriceMax - momPriceMin;
    if (momPriceRange < 0.0001) momPriceRange = 0.0001;

    var momPrToY = function(p) {
      return simH * (1 - (p - momPriceMin) / momPriceRange);
    };

    // ---- Build enhanced obstacles ----
    var obstacles = [];
    for (var oi = 0; oi < momN; oi++) {
      var mc = candles[momStart + oi];
      var cx = (oi + 0.5) * 10;
      var bodyTop = Math.min(momPrToY(mc.o), momPrToY(mc.c));
      var bodyBot = Math.max(momPrToY(mc.o), momPrToY(mc.c));
      var wickTop = momPrToY(mc.h);
      var wickBot = momPrToY(mc.l);
      var bodyH = Math.max(1, bodyBot - bodyTop);
      var totalRange = wickBot - wickTop;  // full high-to-low in sim coords

      // Wick lengths (in sim coords, always positive)
      var upperWickLen = bodyTop - wickTop;    // above the body
      var lowerWickLen = wickBot - bodyBot;    // below the body

      // Body-to-range ratio: 1.0 = Marubozu (all body), 0.0 = Doji (no body)
      var bodyRatio = totalRange > 1 ? bodyH / totalRange : 0.5;

      // Local turbulence multiplier from body ratio:
      // Doji (bodyRatio ≈ 0) → high turbulence (2.0x)
      // Marubozu (bodyRatio ≈ 1) → low turbulence (0.2x)
      var localTurbulence = 0.2 + (1 - bodyRatio) * 1.8;

      obstacles.push({
        cx: cx,
        bodyTop: bodyTop,
        bodyBot: bodyBot,
        wickTop: wickTop,
        wickBot: wickBot,
        bodyH: bodyH,
        forceR: 8 + bodyH * 0.5,
        dir: mc.c >= mc.o ? -1 : 1,
        // Wick forces: separate from body deflection
        upperWickLen: upperWickLen,
        lowerWickLen: lowerWickLen,
        wickForceR: 6 + Math.max(upperWickLen, lowerWickLen) * 0.4,
        // Turbulence from body-to-range ratio
        turbulence: localTurbulence,
        bodyRatio: bodyRatio,
      });
    }

    // ---- Candle Pattern Detection (last 2-3 candles) ----
    // Detected patterns add a directional signal that modifies
    // the last obstacle's force and the overall drift.
    //
    // patternSignal: -1 = strong bullish, +1 = strong bearish, 0 = none

    if (momN >= 2) {
      var lastC = candles[count - 1];
      var prevC = candles[count - 2];
      var lastBody = Math.abs(lastC.c - lastC.o);
      var prevBody = Math.abs(prevC.c - prevC.o);
      var lastRange = lastC.h - lastC.l;
      var prevRange = prevC.h - prevC.l;
      var lastBull = lastC.c > lastC.o;
      var prevBull = prevC.c > prevC.o;

      // -- BULLISH ENGULFING: bearish candle followed by larger bullish candle
      // whose body completely contains the previous body
      if (!prevBull && lastBull && lastBody > prevBody * 1.1 &&
          lastC.o <= prevC.c && lastC.c >= prevC.o) {
        patternSignal = -0.7;  // bullish
      }

      // -- BEARISH ENGULFING: bullish candle followed by larger bearish candle
      if (prevBull && !lastBull && lastBody > prevBody * 1.1 &&
          lastC.o >= prevC.c && lastC.c <= prevC.o) {
        patternSignal = 0.7;   // bearish
      }

      // -- HAMMER: small body at top, long lower wick, in downtrend context
      // Signals buyers defended the low → bullish reversal
      var lastUpperWick = lastC.h - Math.max(lastC.o, lastC.c);
      var lastLowerWick = Math.min(lastC.o, lastC.c) - lastC.l;
      if (lastLowerWick > lastBody * 2 && lastUpperWick < lastBody * 0.5 &&
          lastRange > 0.001) {
        // Check if we're in a recent downtrend (last 5 candles declining)
        if (count >= 5 && candles[count - 5].c > lastC.c) {
          patternSignal = -0.5;  // bullish reversal signal
        }
      }

      // -- SHOOTING STAR: small body at bottom, long upper wick, in uptrend
      // Signals sellers rejected the high → bearish reversal
      if (lastUpperWick > lastBody * 2 && lastLowerWick < lastBody * 0.5 &&
          lastRange > 0.001) {
        if (count >= 5 && candles[count - 5].c < lastC.c) {
          patternSignal = 0.5;   // bearish reversal signal
        }
      }

      // -- BULLISH HARAMI: large bearish followed by small bullish inside it
      if (!prevBull && lastBull && lastBody < prevBody * 0.5 &&
          lastC.o > prevC.c && lastC.c < prevC.o) {
        patternSignal = -0.3;  // weak bullish
      }

      // -- BEARISH HARAMI: large bullish followed by small bearish inside it
      if (prevBull && !lastBull && lastBody < prevBody * 0.5 &&
          lastC.o < prevC.c && lastC.c > prevC.o) {
        patternSignal = 0.3;   // weak bearish
      }

      // -- DOJI at key position: indecision → reduces all signals
      var lastBodyRatio = lastRange > 0.001 ? lastBody / lastRange : 0.5;
      if (lastBodyRatio < 0.1) {
        // True doji: nearly no body. Dampen any pattern signal.
        patternSignal *= 0.3;
      }

      // -- MARUBOZU: big body, no wicks → strong continuation
      if (lastBodyRatio > 0.85) {
        // Strong conviction candle. Amplify in the candle's direction.
        var maruDir = lastBull ? -0.4 : 0.4;
        patternSignal += maruDir;
      }

      // -- THREE WHITE SOLDIERS / THREE BLACK CROWS (if we have 3 candles)
      if (momN >= 3) {
        var c3 = candles[count - 3];
        var c3Bull = c3.c > c3.o;
        var c3Body = Math.abs(c3.c - c3.o);
        // Three consecutive bullish with increasing bodies
        if (c3Bull && prevBull && lastBull &&
            prevBody > c3Body * 0.8 && lastBody > prevBody * 0.8) {
          patternSignal -= 0.4;  // bullish continuation
        }
        // Three consecutive bearish with increasing bodies
        if (!c3Bull && !prevBull && !lastBull &&
            prevBody > c3Body * 0.8 && lastBody > prevBody * 0.8) {
          patternSignal += 0.4;  // bearish continuation
        }
      }

      // Clamp pattern signal
      if (patternSignal > 1) patternSignal = 1;
      if (patternSignal < -1) patternSignal = -1;

      // Apply pattern signal to the last obstacle:
      // amplify or reverse its directional force
      if (obstacles.length > 0 && Math.abs(patternSignal) > 0.1) {
        var lastObs = obstacles[obstacles.length - 1];
        // Pattern overrides the body direction if strong enough
        lastObs.dir = patternSignal > 0 ? 1 : -1;
        // And amplifies the force radius
        lastObs.forceR *= 1 + Math.abs(patternSignal) * 0.5;
        lastObs.bodyH *= 1 + Math.abs(patternSignal) * 0.3;
      }
    }

    // ---- Spawn particles ----
    var numParts = 40;
    var simParts = [];
    for (var spi = 0; spi < numParts; spi++) {
      simParts.push({
        x: 0,
        y: (spi / (numParts - 1)) * simH,
        vx: 1.5,
        vy: 0,
      });
    }

    // ---- Run enhanced simulation ----
    var simSteps = simW + 30;
    var simDamping = 0.96;

    for (var ss2 = 0; ss2 < simSteps; ss2++) {
      for (var sp = 0; sp < simParts.length; sp++) {
        var pt = simParts[sp];
        var fx = 0, fy = 0;
        var localTurb = 0.05;  // base turbulence

        for (var oi2 = 0; oi2 < obstacles.length; oi2++) {
          var ob = obstacles[oi2];
          var dx2 = pt.x - ob.cx;
          var midY = (ob.bodyTop + ob.bodyBot) / 2;
          var dy2 = pt.y - midY;
          var dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 1;

          // ---- BODY DEFLECTION (same as before) ----
          if (dist2 < ob.forceR) {
            var strength = (1 - dist2 / ob.forceR) * 0.3;
            fy += strength * (dy2 / dist2);
            fx += strength * (dx2 / dist2) * 0.3;
            fy += ob.dir * strength * 0.2 * (ob.bodyH / simH);
          }

          // ---- WICK FORCES (NEW) ----
          // Upper wick: pushes particles DOWNWARD (rejection at the high).
          // The longer the upper wick, the stronger the downdraft.
          // Only affects particles near the wick zone (above the body).
          if (ob.upperWickLen > 2) {
            var wickMidY = (ob.wickTop + ob.bodyTop) / 2;
            var dyw = pt.y - wickMidY;
            var distW = Math.sqrt(dx2 * dx2 + dyw * dyw) + 1;
            if (distW < ob.wickForceR && pt.y < ob.bodyTop + 5) {
              var wStr = (1 - distW / ob.wickForceR) * 0.2;
              // Push DOWN: sellers rejected this level
              fy += wStr * (ob.upperWickLen / simH) * 3;
            }
          }

          // Lower wick: pushes particles UPWARD (defense at the low).
          if (ob.lowerWickLen > 2) {
            var wickMidYL = (ob.bodyBot + ob.wickBot) / 2;
            var dywl = pt.y - wickMidYL;
            var distWL = Math.sqrt(dx2 * dx2 + dywl * dywl) + 1;
            if (distWL < ob.wickForceR && pt.y > ob.bodyBot - 5) {
              var wStrL = (1 - distWL / ob.wickForceR) * 0.2;
              // Push UP: buyers defended this level
              fy -= wStrL * (ob.lowerWickLen / simH) * 3;
            }
          }

          // ---- BODY-TO-RANGE TURBULENCE (NEW) ----
          // Increase local turbulence near doji candles,
          // decrease near marubozu candles.
          if (Math.abs(dx2) < 8) {
            localTurb = Math.max(localTurb, ob.turbulence * 0.08);
          }

          // ---- Body collision (same as before) ----
          if (pt.x > ob.cx - 4 && pt.x < ob.cx + 4 &&
              pt.y > ob.bodyTop && pt.y < ob.bodyBot) {
            var toTop = pt.y - ob.bodyTop;
            var toBot = ob.bodyBot - pt.y;
            if (toTop < toBot) {
              fy -= 0.8;
            } else {
              fy += 0.8;
            }
          }
        }

        // Turbulence: scaled by the nearest candle's body-to-range ratio
        fy += (Math.random() - 0.5) * localTurb;
        fx += 0.08;  // constant rightward wind

        pt.vx = (pt.vx + fx) * simDamping;
        pt.vy = (pt.vy + fy) * simDamping;

        var spd = Math.sqrt(pt.vx * pt.vx + pt.vy * pt.vy);
        if (spd > 4) {
          pt.vx = (pt.vx / spd) * 4;
          pt.vy = (pt.vy / spd) * 4;
        }

        pt.x += pt.vx;
        pt.y += pt.vy;

        if (pt.y < 0) { pt.y = 0; pt.vy = Math.abs(pt.vy) * 0.3; }
        if (pt.y > simH) { pt.y = simH; pt.vy = -Math.abs(pt.vy) * 0.3; }
      }
    }

    // ---- Measure exit statistics ----
    var exitVySum = 0;
    var exitVyAbsSum = 0;
    for (var ep = 0; ep < simParts.length; ep++) {
      exitVySum += simParts[ep].vy;
      exitVyAbsSum += Math.abs(simParts[ep].vy);
    }
    var avgExitVy = exitVySum / simParts.length;
    var avgExitAbsVy = exitVyAbsSum / simParts.length;

    var coherence = avgExitAbsVy > 0.001
      ? Math.abs(avgExitVy) / avgExitAbsVy
      : 0;

    // Base drift from particle flow
    momDrift = avgExitVy * coherence * chartH * 0.004;

    // Add candle pattern signal as an additional nudge.
    // Pattern signal is independent of the particle sim — it's a
    // discrete pattern recognition overlay. Scale it so a strong
    // pattern (+/- 1.0) adds about the same force as moderate
    // particle coherence.
    momDrift += patternSignal * chartH * 0.001;
  }

  // ================================================================
  // LIGHT-INFORMED FORCE WEIGHTING
  // ================================================================
  // The light field doesn't just add its own force — it MODULATES
  // every other force based on the structural context it reveals.
  //
  // Think of it like a trader who has drawn trend lines on a chart:
  //   - "Momentum says UP, but I can see a wall of resistance
  //      right above — I'll discount that momentum signal."
  //   - "Volume says buyers are strong, AND the light shows a
  //      clear attractor above — double down on that signal."
  //   - "The chart is a mess of overlapping lines, nothing is
  //      clear — I'll sit this one out."
  //
  // The light provides four kinds of feedback to other forces:
  //
  // 1. RESISTANCE FEEDBACK: Is a force pushing INTO a wall?
  //    If momentum says UP but there's a bright wall above,
  //    dampen momentum. If momentum says UP and the path above
  //    is dark (clear), boost momentum.
  //
  // 2. SUPPORT FEEDBACK: Is there a floor backing up the force?
  //    If mean-revert says "bounce up" and there's strong light
  //    below (support), boost the signal. If no support below,
  //    dampen it — the bounce has no foundation.
  //
  // 3. GRAVITY ALIGNMENT: Does the force agree with the light's
  //    gravitational pull? Forces aligned with gravity get a boost.
  //    Forces fighting gravity get dampened.
  //
  // 4. SIGNAL CLARITY: How clear is the light field overall?
  //    Confused light (low channelStrength, scattered beams) →
  //    dampen ALL forces. Clear structure → let forces speak.

  // Compute light-based multipliers for upward and downward forces.
  // "Upward" = negative pixel-Y drift = bullish.
  // "Downward" = positive pixel-Y drift = bearish.

  var lightUpWeight   = 1.0;  // multiplier for bullish forces
  var lightDownWeight = 1.0;  // multiplier for bearish forces
  var lightClarity    = 1.0;  // global multiplier from signal quality

  if (state.predLight && totalLightAtEntry > 1) {

    // ---- ASYMMETRIC RESISTANCE / SUPPORT FEEDBACK ----
    //
    // DATA-DRIVEN INSIGHT from 1000+ samples across all experiments:
    //   Bear boosted (wall above → dampen up): 53-57% accurate ✓
    //   Bull boosted (wall below → boost up):  31-38% accurate ✗
    //
    // The light field reliably detects RESISTANCE CEILINGS:
    //   After a drop, broken highs form a real wall that price
    //   struggles to reclaim. The light correctly says "don't go up."
    //
    // But the light FAILS at detecting SUPPORT FLOORS:
    //   After a rise, broken lows don't form reliable support on
    //   short timeframes. Price falls through them easily.
    //   When light says "don't go down" — it's usually wrong.
    //
    // SOLUTION: Full strength for ceiling feedback (bear boost).
    //           Minimal effect for floor feedback (bull boost).
    //           This captures the 57% bear edge without the 31% bull poison.

    if (lightAbove > 0.01 && lightBelow > 0.01) {
      var wallRatio = lightAbove / lightBelow;

      if (wallRatio > 1.2) {
        // CEILING DETECTED: more light above than below.
        // This is our strong signal — trust it fully.
        // Dampen upward forces (heading into the wall),
        // boost downward forces (wall pushes back).
        var ceilingFactor = Math.min(2.0, wallRatio);
        lightUpWeight   *= 1.0 / (ceilingFactor * 0.6 + 0.4);
        lightDownWeight *= 0.6 + ceilingFactor * 0.2;
      } else if (wallRatio < 0.83) {
        // FLOOR DETECTED: more light below than above.
        // This is our WEAK signal — apply only a gentle nudge.
        // Don't aggressively boost upward — that's the 31% trap.
        // Just slightly note the floor exists, no strong opinion.
        var floorFactor = Math.min(2.0, 1.0 / wallRatio);
        // Very gentle: 25% of the strength of ceiling feedback
        lightDownWeight *= 1.0 / (floorFactor * 0.15 + 0.85);  // barely dampens down
        // Do NOT boost up — that's what caused 31% bull accuracy
        // lightUpWeight stays at 1.0
      }
    } else if (lightAbove > 0.01 && lightBelow < 0.01) {
      // Wall above only — strong ceiling signal, trust it
      lightUpWeight   *= 0.6;
      lightDownWeight *= 1.2;
    } else if (lightBelow > 0.01 && lightAbove < 0.01) {
      // Wall below only — weak floor signal, barely react
      lightDownWeight *= 0.9;  // gentle, not aggressive
      // lightUpWeight stays at 1.0 — do NOT boost bulls
    }

    // ---- GRAVITY ALIGNMENT (also asymmetric) ----
    // Bearish gravity (pulling down toward bright zones above that
    // were broken) is more reliable than bullish gravity.
    // Apply full strength to bearish pull, half to bullish pull.
    if (Math.abs(entryGravity) > 0.01) {
      var gravNorm = Math.min(1.0, Math.abs(entryGravity) * 0.5);
      if (entryGravity < 0) {
        // Gravity pulls UP (bullish) — half strength, less reliable
        lightUpWeight   *= 1.0 + gravNorm * 0.15;  // up to +15% (was +30%)
        lightDownWeight *= 1.0 - gravNorm * 0.10;  // up to -10% (was -20%)
      } else {
        // Gravity pulls DOWN (bearish) — full strength, reliable
        lightDownWeight *= 1.0 + gravNorm * 0.3;   // up to +30%
        lightUpWeight   *= 1.0 - gravNorm * 0.2;   // up to -20%
      }
    }

    // ---- SIGNAL CLARITY ----
    // How well-defined is the light field? A clear channel with
    // distinct walls = high clarity. Scattered, noisy light
    // with no structure = low clarity → dampen everything.
    //
    // Uses channelStrength (tight channel = clear) and the ratio
    // of dominant wall to total light (concentrated = clear,
    // spread evenly = noise).
    var dominance = Math.max(lightAbove, lightBelow) / (totalLightAtEntry + 0.01);
    // dominance near 1.0 = one side overwhelms = clear structure
    // dominance near 0.5 = balanced = could be channel OR chaos
    // channelStrength near 1.0 = tight walls = clear
    // channelStrength near 0.0 = wide/absent walls = unclear

    // Combine: need EITHER tight channel OR strong dominance for clarity
    lightClarity = Math.max(channelStrength, dominance * 0.8);
    // Floor at 0.4 so we never completely silence the other forces
    if (lightClarity < 0.4) lightClarity = 0.4;
    if (lightClarity > 1.0) lightClarity = 1.0;
  }

  // ---- Apply light weights to each force ----
  // Each force gets multiplied by the appropriate directional weight
  // AND the clarity weight. A force of zero stays zero.
  //
  // Negative drift = bullish (pixel-Y decreasing = price rising)
  // Positive drift = bearish (pixel-Y increasing = price falling)

  function applyLightWeight(drift) {
    if (drift < 0) return drift * lightUpWeight * lightClarity;
    if (drift > 0) return drift * lightDownWeight * lightClarity;
    return 0;
  }

  var weightedMA      = applyLightWeight(maDrift);
  var weightedRSI     = applyLightWeight(rsiDrift);
  var weightedVol     = applyLightWeight(volDrift);
  var weightedLSSA    = applyLightWeight(lssaDrift);
  var weightedMom     = applyLightWeight(momDrift);
  var weightedCycle   = applyLightWeight(cycleDrift);

  // -- COMBINED MARKET DRIFT --
  // Now informed by the light field's structural context.
  // Forces pushing into walls are dampened. Forces aligned with
  // gravity are boosted. Confused light dampens everything.
  var marketDrift = (weightedMA + weightedRSI + weightedVol
                   + weightedLSSA + weightedMom + weightedCycle) * volDampen;


  // ================================================================
  // CONFIDENCE GATE (Terrain-Aware)
  // ================================================================
  // Uses the corridor model to assess prediction quality.
  //
  // The light field is now treated as terrain, not directional force.
  // Confidence metrics reflect how well-defined the channel is:
  //
  // Quality inputs (each 0..1):
  //   1. CHANNEL CONTAINMENT (wt 3.0) — strong walls on both sides?
  //   2. WALL SYMMETRY       (wt 2.0) — balanced vs one-sided?
  //   3. LIGHT AMOUNT        (wt 1.0) — enough trend lines to read?
  //   4. ATTRACTOR PRESENCE  (wt 2.0) — dominant bright target nearby?
  //   5. VOLATILITY REGIME   (wt 1.5) — low vol = more predictable
  //   6. VOLUME CONVICTION   (wt 1.0) — directional volume pressure
  //   7. RECENT ACCURACY     (wt 1.5) — wrong-after-wrong penalty
  //
  // Threshold: 0.75 = confident. Below = NO CALL.

  // First, sample the light environment at the entry point.
  // We need this for the confidence gate AND for storage later.
  var predLightEnvEarly = sampleLightEnvironment(entryGx, entryGy);

  var qScores = [];  // { score: 0..1, weight: number, name: string }

  // 1. CHANNEL CONTAINMENT — the corridor model's key metric.
  // A particle in a well-defined channel (strong walls on both sides)
  // is more predictable than one in open space. channelStrength is
  // already computed: 1.0 = tight channel, 0.0 = wide open.
  // Both walls need to be present — one wall is just a floor/ceiling.
  if (state.predLight && totalLightAtEntry > 1) {
    var hasAboveWall = lightAbove > totalLightAtEntry * 0.15;
    var hasBelowWall = lightBelow > totalLightAtEntry * 0.15;
    // Both walls present = real channel; one wall = half-channel (weaker)
    var containScore = channelStrength;
    if (!hasAboveWall || !hasBelowWall) containScore *= 0.5;
    qScores.push({ score: containScore, weight: 3.0, name: "channel" });
  }

  // 2. WALL SYMMETRY — how balanced are the walls?
  // A channel with roughly equal walls above and below is more
  // predictable (price oscillates inside) than one with a huge wall
  // on one side and nothing on the other.
  if (state.predLight && totalLightAtEntry > 1) {
    // |lightBias| near 0 = symmetric walls, near 1 = one-sided
    // We want MODERATE asymmetry (0.2-0.6) — some bias for direction
    // but not so extreme that it's the post-crash pattern.
    var asymmetry = Math.abs(lightBias);
    // Score: peaks at ~0.3 asymmetry, low at 0 (no direction) and 1 (extreme)
    var symScore;
    if (asymmetry < 0.5) {
      symScore = 0.3 + asymmetry * 1.2;  // 0.3 at balance, 0.9 at 0.5
    } else {
      symScore = 0.9 - (asymmetry - 0.5) * 1.4;  // 0.9 at 0.5, 0.2 at 1.0
    }
    if (symScore < 0) symScore = 0;
    if (symScore > 1) symScore = 1;
    qScores.push({ score: symScore, weight: 2.0, name: "wallSym" });
  }

  // 3. LIGHT FIELD STRENGTH (how much light is there at all?)
  // A dark chart = no trend lines = no information = low confidence.
  // Also: is there a dominant bright attractor nearby?
  if (state.predLight) {
    var lightPresence = Math.min(1.0, totalLightAtEntry * 0.001);
    qScores.push({ score: lightPresence, weight: 1.0, name: "lightAmt" });

    // Attractor: is there a dominant bright peak that price can gravitate toward?
    var attractScore = Math.min(1.0, attractorStrength * 0.8);
    qScores.push({ score: attractScore, weight: 2.0, name: "attractor" });
  }

  // 4. VOLATILITY REGIME (inverse: low vol = high confidence)
  var volConfidence = volDampen;
  qScores.push({ score: volConfidence, weight: 1.5, name: "volRegime" });

  // 5. VOLUME CONVICTION
  if (state.predVol && count >= 5) {
    var bpAvg = 0;
    for (var bpi = count - Math.min(5, count); bpi < count; bpi++) {
      bpAvg += (candles[bpi].buyPressure || 0.5);
    }
    bpAvg /= Math.min(5, count);
    var volConviction = Math.min(1.0, Math.abs(bpAvg - 0.5) * 5);
    qScores.push({ score: volConviction, weight: 1.0, name: "volConv" });
  }

  // 6. RECENT ACCURACY PENALTY (wrong-after-wrong clustering)
  // Light study showed 3 wrong-after-wrong vs 1 wrong-after-right.
  // When the last prediction was wrong, errors tend to cluster.
  // Check the last 1-3 calibration results and penalize if recent misses.
  // Note: calibration[assetKey] may not exist yet on the first frame.
  var recentAccScore = 0.7;  // default: neutral-ish
  var existingCal = calibration[assetKey];
  if (existingCal && existingCal.firstCandleResults && existingCal.firstCandleResults.length > 0) {
    var fcLen2 = existingCal.firstCandleResults.length;
    var lookbackN = Math.min(3, fcLen2);
    var recentHits = 0;
    for (var rai2 = fcLen2 - lookbackN; rai2 < fcLen2; rai2++) {
      recentHits += existingCal.firstCandleResults[rai2].dirOk;
    }
    // 3/3 correct = 1.0, 2/3 = 0.67, 1/3 = 0.33, 0/3 = 0.0
    recentAccScore = recentHits / lookbackN;
  }
  qScores.push({ score: recentAccScore, weight: 1.5, name: "recentAcc" });

  // Compute weighted average confidence (legacy — kept for qScores diagnostics)
  var confidence = 0;
  var isConfident = false;
  var isSuppressed = false;

  if (qScores.length > 0) {
    var totalWeight = 0;
    var weightedSum = 0;
    for (var qi = 0; qi < qScores.length; qi++) {
      weightedSum += qScores[qi].score * qScores[qi].weight;
      totalWeight += qScores[qi].weight;
    }
    confidence = weightedSum / totalWeight;  // 0..1 (terrain quality)
  }

  // ---- PIPELINE-NATIVE CONFIDENCE ----
  // The real confidence comes from the trained pipeline itself:
  //   1. Meta net decisiveness (is one direction clearly winning?)
  //   2. Specialist agreement (do terrain, indicator, energy agree?)
  //   3. Regime strength (is the directional regime clear?)
  //
  // This is computed AFTER training (below) by querying the pipeline
  // at the entry position. It drives path weight flattening and
  // regime bias softening — the actual behavioral response to
  // uncertainty. No more suppression / NO CALL — the system always
  // predicts, it just hedges more when uncertain.
  var pipelineConfidence = 0.5;  // default until pipeline is queried
  var pipelineCompleteness = 1.0; // fraction of active specialists (1/3, 2/3, or 3/3)

  // confMultiplier no longer dampens forces — the pipeline handles
  // signal weighting internally. Keep the variable at 1.0 so old
  // code paths that reference it still work.
  var confMultiplier = 1.0;


  // ================================================================
  // CALIBRATION: PER-DISTANCE ACCURACY TRACKING
  // ================================================================
  // Every prediction stores consensus prices for all future steps.
  // When new candles appear, each verifiable step is scored at its
  // DISTANCE: "I predicted this candle when it was N candles away."
  //
  // This gives us accuracy curves:
  //   distanceStats[1] = how accurate is the +1 candle prediction?
  //   distanceStats[5] = how accurate at 5 candles out?
  //   distanceStats[20] = how accurate at 20 candles out?
  //
  // The bias correction weights closer predictions more heavily
  // because they're more reliable.
  //
  // The HEADLINE SCORE is always the +1 candle accuracy — because
  // if the very next candle is wrong, you could get liquidated.

  var EMA_ALPHA = 0.3;
  var MAX_DIST = 200;  // track up to 200 candles ahead

  if (!calibration[assetKey]) {
    calibration[assetKey] = {
      bias:         new Float64Array(MAX_DIST),
      dirCorrect:   new Float64Array(MAX_DIST),
      absErrPct:    new Float64Array(MAX_DIST),
      sampleCount:  new Uint32Array(MAX_DIST),
      pendingPredictions: [],
      totalSamples: 0,
      // Rolling window of last N first-candle (+1) results for stable headline display.
      // Each entry: { dirOk: 0|1, errPct: number }
      firstCandleResults: [],
      // Accuracy over time: each entry = { tick, dirRate, errPct } recorded
      // once per new first-candle evaluation. Used for the sparkline chart.
      accuracyHistory: [],
      // ---- PER-SCENARIO ACCURACY (#1: weighted consensus) ----
      // Tracks how often each scenario gets the +1 candle direction right.
      // Used to weight their contribution to the consensus.
      // Key = scenario name, value = { dirCorrect: EMA 0..1, sampleCount: int }
      scenarioStats: {},
      // ---- LIGHT ENVIRONMENT STUDY ----
      // Detailed records of high-confidence predictions (>90%) for pattern analysis.
      // Each entry captures the full light environment, predicted vs actual movement,
      // and the prior candle's record. Used to find patterns in when light-based
      // predictions fail — what does the light field look like when we're wrong?
      lightStudy: [],
      // ---- TEMPORAL SMOOTHING ----
      // Previous frames' consensus prices for blending.
      // Averaging current + 2 prior projections smooths out
      // noise from single unusual candles and captures trajectory.
      prevConsensusPrices: null,
      prevCandleCount: 0,
      prev2ConsensusPrices: null,
      prev2CandleCount: 0,
    };
  }
  var cal = calibration[assetKey];

  // ---- Evaluate ALL pending predictions against new candles ----
  // A prediction made at candleCount=50 with 30 consensus prices
  // covers candles 51..80. When we're at candle 55, we can verify
  // steps 1..5 at distances 5,4,3,2,1 (distance = how far ahead
  // we predicted when we made the prediction).
  //
  // When we're at candle 60, we verify steps 1..10 at distances
  // 10,9,...,1. The SAME actual candle 55 gets scored multiple
  // times at different distances from different predictions.

  var pendingKept = [];

  for (var pi3 = 0; pi3 < cal.pendingPredictions.length; pi3++) {
    var prev = cal.pendingPredictions[pi3];
    var distanceWhenMade = count - prev.candleCount;

    // How many steps of this prediction can we verify now?
    var verifiable = Math.min(distanceWhenMade, prev.consensusPrices.length);

    // Only evaluate NEW steps since last evaluation (prevents duplicates).
    // lastEvaluatedSteps tracks how many steps we've already scored.
    var alreadyDone = prev.lastEvaluatedSteps || 0;

    if (verifiable > alreadyDone) {
      for (var vi2 = alreadyDone; vi2 < verifiable; vi2++) {
        var actualIdx = prev.candleCount + vi2;
        if (actualIdx >= count) break;

        var actualPrice = candles[actualIdx].c;
        var predictedPrice = prev.consensusPrices[vi2];
        var stepDistance = vi2 + 1;  // 1-indexed: step 0 = "+1 candle"

        if (stepDistance >= MAX_DIST) continue;

        var error = actualPrice - predictedPrice;
        var absPctErr = prev.currentPrice !== 0
          ? Math.abs(error / prev.currentPrice) * 100
          : 0;

        // Direction: did we predict the right direction for this step?
        // For the first candle (+1), use the weighted majority vote (#2)
        // when available — it's more robust than checking if the blended
        // consensus price crossed currentPrice. A single outlier scenario
        // can flip the blended price but can't flip a weighted vote.
        // For further distances, fall back to price comparison.
        var predDir;
        if (stepDistance === 1 && prev.votedDirection) {
          predDir = prev.votedDirection;
        } else {
          predDir = predictedPrice > prev.currentPrice ? 1 : -1;
        }
        var actDir  = actualPrice > prev.currentPrice ? 1 : -1;
        var dirOk   = (predDir === actDir) ? 1.0 : 0.0;

        // Update per-distance stats via EMA.
        // Bias is stored as a PERCENTAGE of price (error / basePrice)
        // so it's meaningful across timeframes in multi-res charts.
        // A 15m candle and a 4h candle both measure bias in the same
        // units: "what fraction of price did we miss by?"
        var d = stepDistance;
        var biasPct = prev.currentPrice > 0
          ? error / prev.currentPrice
          : 0;

        if (cal.sampleCount[d] === 0) {
          cal.bias[d] = biasPct;
          cal.dirCorrect[d] = dirOk;
          cal.absErrPct[d] = absPctErr;
        } else {
          cal.bias[d] = cal.bias[d] * (1 - EMA_ALPHA) + biasPct * EMA_ALPHA;
          cal.dirCorrect[d] = cal.dirCorrect[d] * (1 - EMA_ALPHA) + dirOk * EMA_ALPHA;
          cal.absErrPct[d] = cal.absErrPct[d] * (1 - EMA_ALPHA) + absPctErr * EMA_ALPHA;
        }
        cal.sampleCount[d]++;

        // Store first-candle results in a rolling window for stable headline display.
        // Only record once per prediction (flag prevents duplicates on re-evaluation).
        if (stepDistance === 1 && !prev.firstCandleScored) {
          cal.firstCandleResults.push({
            dirOk: dirOk,
            errPct: absPctErr,
            confident: prev.confident || false,
            suppressed: prev.suppressed || false,
          });
          prev.firstCandleScored = true;

          // ---- LIGHT ENVIRONMENT STUDY ----
          // Record ALL predictions for pattern analysis, regardless of
          // confidence level. During experiments we need the full picture
          // to find where the signal actually lives.
          if (prev.lightEnv) {
            var actualCandle = candles[actualIdx];
            var predMovePct = ((predictedPrice - prev.currentPrice) / prev.currentPrice) * 100;
            var actMovePct  = ((actualPrice - prev.currentPrice) / prev.currentPrice) * 100;

            // Prior study record (if exists) — the one before this
            var priorRecord = cal.lightStudy.length > 0
              ? cal.lightStudy[cal.lightStudy.length - 1]
              : null;

            cal.lightStudy.push({
              tick:       prev.candleCount,          // when prediction was made
              confidence: prev.confidence,
              correct:    dirOk === 1.0,

              // What we predicted
              predDirection:   predDir,                // 1=bull, -1=bear
              predMovePct:     predMovePct,            // predicted % move
              voteStrength:    prev.voteStrength,      // how unanimous was the vote

              // What actually happened
              actDirection:    actDir,                  // 1=bull, -1=bear
              actMovePct:      actMovePct,              // actual % move
              actCandle: {                              // the actual outcome candle
                open:  actualCandle.o,
                high:  actualCandle.h,
                low:   actualCandle.l,
                close: actualCandle.c,
                volume: actualCandle.v,
                direction: actualCandle.c > actualCandle.o ? 1 : -1,
                bodyRatio: (actualCandle.h - actualCandle.l) > 0.0001
                  ? Math.abs(actualCandle.c - actualCandle.o) / (actualCandle.h - actualCandle.l) : 0,
              },

              // Light environment at prediction time
              lightEnv:      prev.lightEnv,
              lightBias:     prev.lightBias || 0,
              channelWidth:  prev.channelWidth || 0,
              channelStrength: prev.channelStrength || 0,
              attractorStrength: prev.attractorStrength || 0,
              lightUpWeight: prev.lightUpWeight || 1,
              lightDownWeight: prev.lightDownWeight || 1,
              lightClarity: prev.lightClarity || 1,
              trapScore: prev.trapScore || 0,
              trapApplied: prev.trapApplied || false,
              densityAtEntry: prev.densityAtEntry || 0,
              avgDensityNearPrice: prev.avgDensityNearPrice || 0,

              // Market context at prediction time
              lastCandle:    prev.lastCandle,          // candle before prediction
              volRatio:      prev.volRatio || 1,
              recentMom:     prev.recentMom || 0,

              // Prior record reference (for sequence analysis)
              priorCorrect:    priorRecord ? priorRecord.correct : null,
              priorDirection:  priorRecord ? priorRecord.actDirection : null,
              priorLightEnv:   priorRecord ? priorRecord.lightEnv : null,
              priorLastCandle: priorRecord ? priorRecord.lastCandle : null,
            });

            // Cap at 500 records to avoid memory bloat
            if (cal.lightStudy.length > 500) {
              cal.lightStudy = cal.lightStudy.slice(-500);
            }
          }

          // ---- Score each scenario individually (#1: weighted consensus) ----
          // If this prediction stored per-scenario +1 prices, score each one.
          // This feeds the scenarioStats that weight future consensus building.
          if (prev.scenarioFirstPrices && prev.scenarioNames) {
            for (var scEval = 0; scEval < prev.scenarioNames.length; scEval++) {
              var scName = prev.scenarioNames[scEval];
              var scPredPrice = prev.scenarioFirstPrices[scEval];
              var scPredDir = scPredPrice > prev.currentPrice ? 1 : -1;
              var scDirOk = (scPredDir === actDir) ? 1.0 : 0.0;

              // Initialize stats for this scenario if first time seeing it
              if (!cal.scenarioStats[scName]) {
                cal.scenarioStats[scName] = { dirCorrect: scDirOk, sampleCount: 1 };
              } else {
                // Update via EMA so recent performance matters more
                var scStat = cal.scenarioStats[scName];
                scStat.dirCorrect = scStat.dirCorrect * (1 - EMA_ALPHA) + scDirOk * EMA_ALPHA;
                scStat.sampleCount++;
              }
            }
          }

          // ---- Score layered pipeline with blame attribution ----
          // Each layer is scored INDEPENDENTLY against the actual outcome.
          // A specialist that was right keeps its accuracy even if the
          // meta net got it wrong. Blame goes where it belongs.
          if (prev.slLayerOpinions && typeof scoreLayerPrediction === "function") {
            scoreLayerPrediction(prev.slLayerOpinions, actDir);
          }

          if (cal.firstCandleResults.length > 50) {
            cal.firstCandleResults = cal.firstCandleResults.slice(-50);
          }

          // Snapshot rolling accuracy for the over-time chart.
          // Compute rolling avg from last 10 first-candle results.
          var fcLen = cal.firstCandleResults.length;
          var snapWindow = Math.min(10, fcLen);
          var snapStart = fcLen - snapWindow;
          var snapDirSum = 0;
          var snapErrSum = 0;
          // Also compute confident-only rolling stats
          var confDirSum = 0;
          var confCount = 0;
          for (var sni = snapStart; sni < fcLen; sni++) {
            snapDirSum += cal.firstCandleResults[sni].dirOk;
            snapErrSum += cal.firstCandleResults[sni].errPct;
            if (cal.firstCandleResults[sni].confident) {
              confDirSum += cal.firstCandleResults[sni].dirOk;
              confCount++;
            }
          }
          cal.accuracyHistory.push({
            tick: count,
            dirRate: (snapDirSum / snapWindow) * 100,
            errPct: snapErrSum / snapWindow,
            raw: dirOk,
            confident: prev.confident || false,
            // Confident-only accuracy (NaN if no confident predictions in window)
            confDirRate: confCount > 0 ? (confDirSum / confCount) * 100 : -1,
            confCount: confCount,
          });
          // Keep last 200 snapshots
          if (cal.accuracyHistory.length > 200) {
            cal.accuracyHistory = cal.accuracyHistory.slice(-200);
          }
        }
      }
      prev.lastEvaluatedSteps = verifiable;
      cal.totalSamples++;
    }

    // Keep predictions that still have unverified steps
    if (distanceWhenMade < prev.consensusPrices.length) {
      pendingKept.push(prev);
    }
    // Also keep recent ones even if fully verified (for distance variety)
    // But cap total pending to avoid memory growth
  }
  // Keep only the last 50 pending predictions
  cal.pendingPredictions = pendingKept.slice(-50);

  // ---- TOPOLOGY VERIFICATION ----
  // If we have a previous topology snapshot (from a prior frame's
  // prediction boundary), and new candles have arrived since then,
  // verify how well the topological features predicted price movement.
  //
  // This updates the global topoWeights EMA so that future predictions
  // know which topology features to trust more/less.
  if (topo && cal._prevTopoSnap && typeof topoVerify === "function") {
    var snap = cal._prevTopoSnap;
    var snapStartCandle = snap._candleCountAtSnapshot || 0;
    var newCandlesSinceSnap = count - snapStartCandle;

    // Need at least 3 new candles to have a meaningful verification
    if (newCandlesSinceSnap >= 3) {
      // Build actual price path in grid-Y coordinates
      var actualGYs = [];
      for (var tvi = 0; tvi < Math.min(snap.lookAhead, newCandlesSinceSnap); tvi++) {
        var tvIdx = snapStartCandle + tvi;
        if (tvIdx >= count) break;
        var tvPriceY = priceToY(candles[tvIdx].c, priceMin, priceMax, chartTop, chartH);
        actualGYs.push(Math.floor(tvPriceY / resolution));
      }

      if (actualGYs.length >= 3) {
        var topoReport = topoVerify(snap, topo, actualGYs);
        if (topoReport && typeof updateTopoWeights === "function") {
          updateTopoWeights(topoReport);
        }
      }
      // Clear consumed snapshot so we don't re-verify the same data
      cal._prevTopoSnap = null;
    }
  }

  // Store current snapshot for future verification (next frame with new candles)
  if (topoSnap) {
    topoSnap._candleCountAtSnapshot = count;
    cal._prevTopoSnap = topoSnap;
  }


  // ---- Build per-distance confidence weights for bias correction ----
  // The bias at distance D is weighted by how accurate we are at that
  // distance. Close predictions (d=1,2,3) are usually more accurate
  // so their bias corrections carry more weight.
  var distWeights = new Float64Array(MAX_DIST);
  for (var dw = 1; dw < MAX_DIST; dw++) {
    if (cal.sampleCount[dw] > 0) {
      // Weight = direction accuracy × inverse distance
      // More accurate + closer = stronger correction
      distWeights[dw] = cal.dirCorrect[dw] / dw;
    }
  }

  // ---- Compute headline accuracy from last 10 first-candle results ----
  var accuracy = null;
  var fcResults = cal.firstCandleResults;
  var HEADLINE_WINDOW = 10;

  if (fcResults.length >= 3) {  // need at least 3 to be meaningful
    // Take the last N results (or all if fewer than N)
    var windowSize = Math.min(HEADLINE_WINDOW, fcResults.length);
    var windowStart = fcResults.length - windowSize;

    var fcDirSum = 0;
    var fcErrSum = 0;
    for (var fci = windowStart; fci < fcResults.length; fci++) {
      fcDirSum += fcResults[fci].dirOk;
      fcErrSum += fcResults[fci].errPct;
    }

    // Collect per-distance breakdown for display (from EMA stats)
    var distBreakdown = [];
    var checkDists = [1, 3, 5, 10, 20];
    for (var cdi = 0; cdi < checkDists.length; cdi++) {
      var dd = checkDists[cdi];
      if (dd < MAX_DIST && cal.sampleCount[dd] > 0) {
        distBreakdown.push({
          distance: dd,
          dirRate: cal.dirCorrect[dd] * 100,
          errPct: cal.absErrPct[dd],
          samples: cal.sampleCount[dd],
        });
      }
    }

    // Compute run-average: ALL first-candle results in this run
    var runDirSum = 0;
    var runErrSum = 0;
    // Confident-only run stats
    var confRunDirSum = 0;
    var confRunErrSum = 0;
    var confRunCount = 0;
    // Suppressed-call stats (calls we would have suppressed — are they actually worse?)
    var suppRunDirSum = 0;
    var suppRunCount = 0;
    for (var rai = 0; rai < fcResults.length; rai++) {
      runDirSum += fcResults[rai].dirOk;
      runErrSum += fcResults[rai].errPct;
      if (fcResults[rai].confident) {
        confRunDirSum += fcResults[rai].dirOk;
        confRunErrSum += fcResults[rai].errPct;
        confRunCount++;
      }
      if (fcResults[rai].suppressed) {
        suppRunDirSum += fcResults[rai].dirOk;
        suppRunCount++;
      }
    }

    accuracy = {
      // Headline: rolling average of last 10 first-candle predictions
      firstCandleDirRate: (fcDirSum / windowSize) * 100,
      firstCandleErrPct:  fcErrSum / windowSize,
      firstCandleSamples: windowSize,
      firstCandleTotal:   fcResults.length,
      // Run average: entire run from start to now
      runDirRate: (runDirSum / fcResults.length) * 100,
      runErrPct:  runErrSum / fcResults.length,
      // Confident-only run stats (the key metric — calls we WOULD make)
      confDirRate: confRunCount > 0 ? (confRunDirSum / confRunCount) * 100 : -1,
      confErrPct:  confRunCount > 0 ? confRunErrSum / confRunCount : -1,
      confCount:   confRunCount,
      confPct:     fcResults.length > 0 ? Math.round((confRunCount / fcResults.length) * 100) : 0,
      // Suppressed-call stats (calls we AVOIDED — verifies the gate works)
      suppDirRate: suppRunCount > 0 ? (suppRunDirSum / suppRunCount) * 100 : -1,
      suppCount:   suppRunCount,
      // Per-distance breakdown
      distBreakdown: distBreakdown,
      totalSamples: cal.totalSamples,
    };
  }


  // ================================================================
  // ITERATIVE PREDICTION WITH VIRTUAL CANDLE LIGHT EMISSION
  // ================================================================
  // Unlike the old approach (run all scenarios through a static light
  // field), this builds predictions one candle at a time:
  //
  //   1. Run all scenarios one step → compute consensus price
  //   2. Create a virtual candle at that price (O/H/L/C)
  //   3. Paint light beams from that candle's H and L into the grids
  //   4. The next step reads from the UPDATED grids
  //   5. Repeat
  //
  // This means each predicted candle's light affects subsequent
  // predictions — the same feedback loop as real candles.

  var momPx = -(recentMom / (priceMax - priceMin)) * chartH * 0.5;

  // Combined bias for initial velocities: light + market forces
  var combinedBias = lightVyBias + marketDrift * 2;

  // ================================================================
  // SCENARIOS — ALL BUILT ON THE LSSA BASE PATH
  // ================================================================
  // LSSA provides the probable shape of future price movement —
  // the rhythm, the turns, the range. It's the river bed.
  //
  // Each scenario adds its own force ON TOP of the LSSA path:
  //   - Momentum: "LSSA says we turn here, but momentum is strong
  //     enough to push past the turn"
  //   - Mean Revert: "LSSA says continue, but we're overextended
  //     and should snap back sooner"
  //   - Breakout: "LSSA says oscillate in range, but the trend
  //     is so strong we break out of the cycle"
  //
  // The `lssaSpring` parameter controls how tightly each scenario
  // follows the LSSA path:
  //   0.20 = tight: mostly follows the cyclic shape
  //   0.10 = moderate: LSSA guides but forces can pull away
  //   0.05 = loose: LSSA is a gentle suggestion, forces dominate
  //
  // When LSSA is disabled (no cycles found), spring is 0 and
  // scenarios behave like before — pure force-driven.

  // ================================================================
  // REGIME DETECTION & 3-PATH INITIALIZATION
  // ================================================================
  // Instead of 8 hand-configured scenarios, the system now produces
  // 3 paths based on directional regime assumptions:
  //
  //   BULL PATH  — assumes the current regime continues bullish
  //   NEUTRAL    — assumes the regime weakens toward sideways
  //   BEAR PATH  — assumes the current regime continues bearish
  //
  // The entry regime (detected from recent candle history) determines
  // which path gets the most weight in the consensus. As virtual
  // candles are generated, each path's running regime is re-evaluated
  // and weights can shift.

  var hasLssa = lssaCycles && lssaCycles.length > 0;

  // Pre-compute SMA and RSI arrays for regime detection and training.
  // These are full-dataset arrays needed both here (for detectRegime)
  // and later in the signal pipeline training section.
  var ssSma = (typeof calcSMA === "function") ? calcSMA(candles, CONFIG.MA_PERIOD) : null;
  var ssRsi = (typeof calcRSI === "function") ? calcRSI(candles, CONFIG.RSI_PERIOD) : null;

  // Detect the current directional regime from recent history.
  // Uses candle direction, price vs MA, momentum, RSI position,
  // streaks, and buy pressure — all voting on bull/bear/neutral.
  var entryRegime = { score: 0, strength: 0, label: "neutral" };
  if (typeof detectRegime === "function") {
    entryRegime = detectRegime(candles, ssSma, ssRsi, avgRange);
  }

  // Initialize the 3 prediction paths.
  // Each path has a regime assumption, corridor/LSSA trust weights,
  // and a bias strength that shifts signal interpretation.
  var scenarios = [];
  if (typeof initPaths === "function") {
    scenarios = initPaths(entryRegime);
  } else {
    // Fallback if regime.js not loaded
    scenarios = [
      { name: "Bull",    assumption: "bull",    regimeBias: 0.6, corrWeight: 0.25, lssaWeight: 0.15, cannonWeight: 0.20 },
      { name: "Neutral", assumption: "neutral", regimeBias: 0.0, corrWeight: 0.25, lssaWeight: 0.15, cannonWeight: 0.20 },
      { name: "Bear",    assumption: "bear",    regimeBias: 0.6, corrWeight: 0.25, lssaWeight: 0.15, cannonWeight: 0.20 }
    ];
  }

  // Path weights: how much each path contributes to the consensus.
  // Entry regime determines initial weights. Per-path accuracy from
  // calibration also factors in (if available).
  var scenarioWeights = [0.333, 0.334, 0.333];
  if (typeof getPathWeights === "function") {
    scenarioWeights = getPathWeights(entryRegime);
  }

  // Blend in per-path accuracy from calibration (if available).
  // Paths that have been right more often get a boost.
  var MIN_SAMPLES_FOR_WEIGHTING = 5;
  var accAdjusted = false;
  for (var swi = 0; swi < scenarios.length; swi++) {
    var scName = scenarios[swi].name;
    if (cal.scenarioStats[scName] &&
        cal.scenarioStats[scName].sampleCount >= MIN_SAMPLES_FOR_WEIGHTING) {
      var accW = cal.scenarioStats[scName].dirCorrect;
      accW = accW * accW;  // squared for sharper discrimination
      scenarioWeights[swi] *= Math.max(0.3, accW * 2);
      accAdjusted = true;
    }
  }
  // Re-normalize if accuracy was blended in
  if (accAdjusted) {
    var twSum = 0;
    for (var twi = 0; twi < scenarioWeights.length; twi++) twSum += scenarioWeights[twi];
    if (twSum > 0) {
      for (var twn = 0; twn < scenarioWeights.length; twn++) scenarioWeights[twn] /= twSum;
    }
  }

  var numScenarios = scenarios.length;

  // Initialize per-path running regime state for re-evaluation.
  // Each path tracks its own regime as virtual candles are generated.
  var runningRegimes = [];
  for (var rri = 0; rri < numScenarios; rri++) {
    if (typeof initRunningRegime === "function") {
      runningRegimes.push(initRunningRegime(entryRegime));
    } else {
      runningRegimes.push({ score: 0, strength: 0, totalCandles: 0,
        bullCandles: 0, bearCandles: 0, streak: 0, streakDir: 0, cumulativeMove: 0 });
    }
  }

  // ---- CANDLE-SIZED STEP CONSTRAINT ----
  // Each prediction step moves by at most one candle BODY's worth.
  // Using avg body (open-close distance) not avg range (high-low),
  // because range is 2-3x the body and leads to unrealistic jumps.
  //
  // A large price move can ONLY happen as a series of small steps
  // that each independently agree on the direction.
  var bodySum = 0;
  var bodySqSum = 0;   // for standard deviation
  var wickUpSum = 0;   // average upper wick size
  var wickDownSum = 0; // average lower wick size
  var statN = Math.min(20, count);
  for (var bsi = count - statN; bsi < count; bsi++) {
    var bdy = Math.abs(candles[bsi].c - candles[bsi].o);
    bodySum += bdy;
    bodySqSum += bdy * bdy;
    var bodyHi = Math.max(candles[bsi].o, candles[bsi].c);
    var bodyLo = Math.min(candles[bsi].o, candles[bsi].c);
    wickUpSum += candles[bsi].h - bodyHi;
    wickDownSum += bodyLo - candles[bsi].l;
  }
  var avgBody = bodySum / statN;
  // Standard deviation of body sizes — tells us what's "normal" vs "extreme"
  var bodyVariance = (bodySqSum / statN) - (avgBody * avgBody);
  if (bodyVariance < 0) bodyVariance = 0;
  var bodyStdDev = Math.sqrt(bodyVariance);
  // Average wick sizes (used for virtual candle wick generation)
  var avgWickUp = wickUpSum / statN;
  var avgWickDown = wickDownSum / statN;

  // Safety: body should be at least 20% of range and at most 80%
  if (avgBody < avgRange * 0.2) avgBody = avgRange * 0.2;
  if (avgBody > avgRange * 0.8) avgBody = avgRange * 0.8;
  // Ensure stdDev is meaningful (at least 10% of avgBody)
  if (bodyStdDev < avgBody * 0.1) bodyStdDev = avgBody * 0.1;

  var maxStepPx = (avgBody / (priceMax - priceMin)) * chartH;
  if (maxStepPx < 1) maxStepPx = 1;
  // No artificial cap — maxStepPx should match the actual average
  // candle body. The old cap (chartH * 0.015) was chopping it to
  // 60-70% of reality, making predictions physically incapable
  // of producing candle-sized moves.

  // Per-scenario running state
  // No velocity — each step is a fresh terrain reading.
  // No carry-forward — each step decides independently, which
  // produces the natural zigzag of real price action.
  var scState = [];
  for (var si = 0; si < numScenarios; si++) {
    scState.push({ py: currentPriceY, prevMove: 0 });
  }

  // Storage for results
  var allPaths = [];
  for (var api = 0; api < numScenarios; api++) {
    allPaths.push({ name: scenarios[api].name, path: [], color: "neut" });
  }
  var virtualCandles = [];
  var prevConsensusPrice = currentPrice;

  // Track virtual candle occlusion zones (not used for painting anymore,
  // but kept for potential future use by other systems).
  var vcOccZones = [];

  // The real paintBeam from buildHeatmap — handles LENGTH→GLOW,
  // beam width, occlusion attenuation, everything. No reimplementation.
  var realPaintBeam = hmData.paintBeam;

  // Combined tip array: recent real candles + virtual candles (grows each step).
  // Used to build H-H / L-L sight lines to each new virtual candle,
  // exactly the same geometry as the real chart's beam system.
  //
  // Each entry: { x, hy, ly, h, l }
  var chartLeft  = dims.chartLeft;
  var chartWidth = dims.chartWidth;
  var lookback   = Math.min(20, count);  // connect back to last 20 real candles
  var allTips = [];
  for (var rti = count - lookback; rti < count; rti++) {
    var rc = candles[rti];
    var rcx = indexToX(rti, count, chartLeft, chartWidth);
    allTips.push({
      x:  rcx,
      hy: priceToY(rc.h, priceMin, priceMax, chartTop, chartH),
      ly: priceToY(rc.l, priceMin, priceMax, chartTop, chartH),
      h:  rc.h,
      l:  rc.l,
    });
  }

  // (wickRatio removed — avgWickUp/avgWickDown used instead for
  //  timeframe-adaptive virtual candle wicks)

  // ---- STREAK STATISTICS from real candles ----
  // Measure how many consecutive same-direction candles typically
  // occur in this dataset. This calibrates the per-step exhaustion
  // force — after N consecutive steps in one direction, apply a
  // counter-force because real price action rarely goes straight.
  //
  // Count all streaks in the visible candles, compute the average
  // and max. Typical values: avg ~2-3, max ~5-8.
  var streakLengths = [];
  var curStreakLen = 1;
  for (var ski = 1; ski < count; ski++) {
    var prevDir = candles[ski - 1].c >= candles[ski - 1].o ? 1 : -1;
    var curDir  = candles[ski].c >= candles[ski].o ? 1 : -1;
    if (curDir === prevDir) {
      curStreakLen++;
    } else {
      streakLengths.push(curStreakLen);
      curStreakLen = 1;
    }
  }
  if (curStreakLen > 1) streakLengths.push(curStreakLen);

  var avgStreakLen = 3;  // default
  if (streakLengths.length >= 3) {
    var streakSum = 0;
    for (var sli = 0; sli < streakLengths.length; sli++) {
      streakSum += streakLengths[sli];
    }
    avgStreakLen = streakSum / streakLengths.length;
    if (avgStreakLen < 2) avgStreakLen = 2;
    if (avgStreakLen > 8) avgStreakLen = 8;
  }

  // Per-path streak tracking for the avgStreakLen hard ceiling.
  // The geometric ray test uses allPaths[].path directly — this
  // only tracks simple up/down direction for the empirical limit.
  var scStreaks = [];
  for (var ssi = 0; ssi < scenarios.length; ssi++) {
    scStreaks.push({ count: 0, dir: 0 });
  }

  // ---- REAL-CHART LIGHT INTENSITY BASELINE ----
  // Measure the typical and peak light intensity in the REAL candle
  // zone (before the prediction boundary). This tells us what
  // "normal" brightness looks like for actual price action.
  //
  // During prediction, if the local intensity exceeds this baseline,
  // it means the virtual beams are stacking unrealistically (a streak
  // of aligned prediction candles creates a corridor brighter than
  // anything in the real chart). That anomalous brightness is treated
  // as a REVERSAL SIGNAL — the prediction is doing something real
  // markets don't do, so it's probably time to turn around.
  var realLightBaseline = 0;  // 85th percentile intensity in real zone
  var realLightMax = 0;       // peak intensity in real zone

  // Sample a column near the prediction boundary (last real candle area)
  var boundaryGx = Math.floor(projLeft / resolution);
  if (boundaryGx > 2) {
    // Sample the last 20% of the real candle zone
    var sampleStartGx = Math.floor(boundaryGx * 0.8);

    // Use histogram binning instead of push+sort for the 85th percentile.
    // At res=1 this avoids sorting ~400K values per frame.
    var rlBinCount = 256;
    var rlBins = new Uint32Array(rlBinCount);
    var rlNonZero = 0;

    for (var rlgx = sampleStartGx; rlgx < boundaryGx; rlgx++) {
      for (var rlgy = 0; rlgy < hmRows; rlgy++) {
        var rlIdx = rlgy * hmCols + rlgx;
        var rlVal = hmGrids[0][rlIdx] + hmGrids[1][rlIdx]
                  + hmGrids[2][rlIdx] + hmGrids[3][rlIdx];
        if (rlVal > 0.01) {
          if (rlVal > realLightMax) realLightMax = rlVal;
          rlNonZero++;
        }
      }
    }

    if (rlNonZero > 10 && realLightMax > 0.01) {
      // Second pass: bin values
      var rlScale = (rlBinCount - 1) / realLightMax;
      for (var rlgx2 = sampleStartGx; rlgx2 < boundaryGx; rlgx2++) {
        for (var rlgy2 = 0; rlgy2 < hmRows; rlgy2++) {
          var rlIdx2 = rlgy2 * hmCols + rlgx2;
          var rlVal2 = hmGrids[0][rlIdx2] + hmGrids[1][rlIdx2]
                     + hmGrids[2][rlIdx2] + hmGrids[3][rlIdx2];
          if (rlVal2 > 0.01) {
            rlBins[(rlVal2 * rlScale) | 0]++;
          }
        }
      }
      // Walk bins to find 85th percentile
      var rlTarget = Math.floor(rlNonZero * 0.85);
      var rlCum = 0;
      for (var rlb = 0; rlb < rlBinCount; rlb++) {
        rlCum += rlBins[rlb];
        if (rlCum >= rlTarget) {
          realLightBaseline = (rlb + 0.5) / rlScale;
          break;
        }
      }
    }
  }
  // If baseline is too low, use a reasonable default
  if (realLightBaseline < 0.1) realLightBaseline = realLightMax * 0.5;
  if (realLightBaseline < 0.01) realLightBaseline = 1.0;

  // ---- LIVE GRID APPROACH (no frozen snapshot) ----
  // All terrain signals (light, topo, neural) read the LIVE grids
  // which include virtual beams from prior prediction steps. Each
  // predicted candle creates S/R that influences the next — the same
  // way real candles interact.
  //
  // The old frozen-grid approach prevented feedback but made the
  // prediction zone go dark: no light data meant the core signals
  // (light, topo) went silent a few steps past the last real candle.
  //
  // Safety against runaway feedback is handled by:
  //   1. Intensity reversal check: when live brightness exceeds the
  //      real-candle baseline by 1.5x+, the signal is dampened or
  //      flipped. This catches self-reinforcing beam corridors.
  //   2. Delta-from-average candle sizing: virtual candle bodies and
  //      ranges are soft-capped to the statistical distribution of
  //      real candles, so extreme moves can't create extreme beams.
  //   3. Streak exhaustion: consecutive same-direction steps get
  //      dampened regardless of what the terrain says.

  // ================================================================
  // SIGNAL PIPELINE TRAINING + SCALE CALIBRATION
  // ================================================================
  // This section does TWO things:
  //
  // 1) TRAIN the layered signal pipeline (trainSignalLayers) by
  //    sampling ALL available raw signals at visible candle positions,
  //    building full training vectors, and letting each specialist
  //    learn its domain from the data.
  //
  // 2) CALIBRATE the signal scale factor so the pipeline's output
  //    magnitude maps to realistic candle body sizes.
  //
  // CRITICAL: Uses ONLY real candle positions. Prediction candle
  // data NEVER feeds into this calculation.

  var signalScale = 1.0;  // default: no scaling

  // ssSma and ssRsi already computed above (before regime detection).

  // ---- Build training samples from recent visible candles ----
  // Each sample captures the full signal vector at a candle position
  // plus the actual next-candle outcome as the label.
  var slTrainingSamples = [];
  var signalSamples = [];  // for scale calibration (pipeline output magnitudes)

  var sampleStart = Math.max(10, count - 80);  // up to 80 recent candles
  for (var ssi = sampleStart; ssi < count - 1; ssi++) {
    var ssCx = indexToX(ssi, count, dims.chartLeft, dims.chartWidth);
    var ssCy = priceToY(candles[ssi].c, priceMin, priceMax, chartTop, chartH);
    var ssGx = Math.floor(ssCx / resolution);
    var ssGy = Math.floor(ssCy / resolution);

    // ---- Light signal (same formula as step loop) ----
    var ssLightSig = 0;
    var ssLightIntensity = 0;
    if (state.predLight) {
      var ssRawForce = sampleForce(ssGx, ssGy);
      ssLightSig = ssRawForce / (maxStepPx * 2 + 0.001);
      if (ssLightSig > 1) ssLightSig = 1;
      if (ssLightSig < -1) ssLightSig = -1;
      // Local intensity for enrichment
      if (ssGx >= 0 && ssGx < hmCols && ssGy >= 0 && ssGy < hmRows) {
        var ssCI = ssGy * hmCols + ssGx;
        var ssIntTotal = hmGrids[0][ssCI] + hmGrids[1][ssCI] + hmGrids[2][ssCI] + hmGrids[3][ssCI];
        ssLightIntensity = realLightBaseline > 0.01 ? Math.min(1, ssIntTotal / realLightBaseline) : 0;
      }
    }

    // ---- Topo signal (same formula as step loop) ----
    var ssTopoSig = 0;
    if (state.predTopo && typeof queryFlowLive === "function") {
      var ssCf = state.colorForce;
      var ssFlow = queryFlowLive(hmGrids, hmCols, hmRows, ssGx, ssGy, ssCf);
      if (ssFlow && Math.abs(ssFlow.fy) > 0.05) {
        ssTopoSig = ssFlow.fy * (0.5 + ssFlow.conf * 1.5);
        if (ssTopoSig > 1) ssTopoSig = 1;
        if (ssTopoSig < -1) ssTopoSig = -1;
      }
    }

    // ---- MA signal (same quadratic formula as step loop) ----
    var ssMaSig = 0;
    var ssMaGapRanges = 0;
    if (ssSma && ssi < ssSma.length && ssSma[ssi] !== null && state.predMA) {
      var ssMaGap = candles[ssi].c - ssSma[ssi];
      ssMaGapRanges = ssMaGap / (avgRange + 0.0001);
      var ssAbsGapR = Math.abs(ssMaGapRanges);
      ssMaSig = (ssMaGapRanges > 0 ? 1 : -1) * ssAbsGapR * ssAbsGapR * 0.2;
      if (ssMaSig > 1) ssMaSig = 1;
      if (ssMaSig < -1) ssMaSig = -1;
    }

    // ---- RSI signal (same formula as step loop) ----
    var ssRsiSig = 0;
    var ssRsiVal = 50;
    if (ssRsi && ssi < ssRsi.length && ssRsi[ssi] !== null && state.predRSI) {
      ssRsiVal = ssRsi[ssi];
      if (ssRsiVal > indCalib.rsiDeadHigh) {
        ssRsiSig = (ssRsiVal - indCalib.rsiDeadHigh) / 20;
      } else if (ssRsiVal < indCalib.rsiDeadLow) {
        ssRsiSig = -(indCalib.rsiDeadLow - ssRsiVal) / 20;
      }
      if (ssRsiSig > 1) ssRsiSig = 1;
      if (ssRsiSig < -1) ssRsiSig = -1;
    }

    // ---- Momentum signal (same formula as step loop) ----
    var ssMomSig = 0;
    if (ssi >= 10) {
      var ssMom = (candles[ssi].c - candles[ssi - 10].c) / 10;
      ssMomSig = -(ssMom / (avgRange + 0.0001)) * 0.5;
      if (ssMomSig > 0.8) ssMomSig = 0.8;
      if (ssMomSig < -0.8) ssMomSig = -0.8;
    }

    // ---- Energy enrichment features ----
    var ssVolRatio = avgVolumeAll > 0 ? candles[ssi].v / avgVolumeAll : 1;
    var ssBP = candles[ssi].buyPressure !== undefined ? candles[ssi].buyPressure : 0.5;
    var ssCandleBody = Math.abs(candles[ssi].c - candles[ssi].o);
    var ssBodySize = avgBody > 0 ? ssCandleBody / avgBody : 1;

    // ---- Label: next candle direction ----
    var ssNextCandle = candles[ssi + 1];
    var ssMove = ssNextCandle.c - candles[ssi].c;
    var ssMoveRatio = avgRange > 0 ? ssMove / avgRange : 0;
    var ssStrength = Math.min(Math.abs(ssMoveRatio) / 1.5, 1.0);

    // Build the training sample (trainable signals only).
    // Corridor and LSSA are NOT included — they're forward-looking
    // signals that have no historical values at past candle positions.
    // They're applied as post-pipeline forces in the step loop.
    slTrainingSamples.push({
      lightSig:       ssLightSig,
      topoSig:        ssTopoSig,
      lightIntensity: ssLightIntensity,
      maSig:          ssMaSig,
      rsiSig:         ssRsiSig,
      maGapRanges:    ssMaGapRanges,
      rsiValue:       ssRsiVal,
      momSig:         ssMomSig,
      volumeRatio:    ssVolRatio,
      buyPressure:    ssBP,
      bodySize:       ssBodySize,
      label: {
        up:   ssMoveRatio > 0 ? ssStrength : 0,
        down: ssMoveRatio < 0 ? ssStrength : 0,
        flat: 1.0 - ssStrength
      }
    });
  }

  // ---- Train the layered pipeline ----
  if (typeof trainSignalLayers === "function" && slTrainingSamples.length >= 15) {
    trainSignalLayers(slTrainingSamples, assetKey);
  }

  // ---- ACTIVE SPECIALISTS ----
  // When a signal toggle is OFF, that signal goes in as 0 to the pipeline.
  // But 0 isn't "no opinion" — it's misinformation ("price is exactly at MA").
  // A specialist trained on zeros produces garbage, not silence.
  //
  // Track which specialists have REAL data. Blind specialists will have
  // their output replaced with neutral (0.33/0.33/0.34) in querySignalLayers
  // so they don't corrupt the coordinators and meta net.
  //
  // Terrain:   needs predLight OR predTopo (light field or topology)
  // Indicator: needs predMA OR predRSI (at least one indicator)
  // Energy:    always active (momSig, volumeRatio, buyPressure, bodySize
  //            are computed from candle data regardless of toggles)
  var activeSpecialists = {
    terrain:   state.predLight || (state.predTopo && typeof queryFlowLive === "function"),
    indicator: state.predMA || state.predRSI,
    energy:    true  // always has real data from candles
  };

  // ---- Signal scale calibration from pipeline output ----
  if (slReady && typeof querySignalLayers === "function") {
    var scaleLookback = Math.min(40, slTrainingSamples.length);
    var scaleStart = slTrainingSamples.length - scaleLookback;
    for (var ssci = scaleStart; ssci < slTrainingSamples.length; ssci++) {
      var ssResult = querySignalLayers(slTrainingSamples[ssci], activeSpecialists);
      if (Math.abs(ssResult.signal) > 0.01) {
        signalSamples.push(Math.abs(ssResult.signal));
      }
    }
  } else {
    // Fallback: if pipeline isn't ready, sample raw forces for scale
    var ssFallbackN = Math.min(40, count);
    for (var ssFi = count - ssFallbackN; ssFi < count; ssFi++) {
      var ssFx = indexToX(ssFi, count, dims.chartLeft, dims.chartWidth);
      var ssFy = priceToY(candles[ssFi].c, priceMin, priceMax, chartTop, chartH);
      var ssFgx = Math.floor(ssFx / resolution);
      var ssFgy = Math.floor(ssFy / resolution);
      if (state.predLight) {
        var ssFraw = sampleForce(ssFgx, ssFgy);
        var ssFsig = Math.abs(ssFraw / (maxStepPx * 2 + 0.001));
        if (ssFsig > 0.01 && ssFsig <= 1) signalSamples.push(ssFsig);
      }
    }
  }

  // Compute scale factor: median signal → should produce ~1.0 (one body)
  if (signalSamples.length >= 5) {
    signalSamples.sort(function(a, b) { return a - b; });
    var medianSig = signalSamples[Math.floor(signalSamples.length * 0.5)];
    if (medianSig > 0.01) {
      // Scale so median signal → 70% of a candle body (leaving room for
      // above-median signals to produce larger candles naturally)
      signalScale = 0.7 / medianSig;
      // Safety clamp: don't scale below 1x or above 8x
      if (signalScale < 1.0) signalScale = 1.0;
      if (signalScale > 8.0) signalScale = 8.0;
    }
  }

  // Track MA and RSI values per prediction step for visual overlay.
  // These let you SEE the evolving MA/RSI in the projection zone,
  // not just trust that the spring forces are working.
  var projMaValues = [];   // { x, price } per step
  var projRsiValues = [];  // { x, value } per step (RSI 0-100)

  // ---- PIPELINE CONFIDENCE PROBE ----
  // Query the trained pipeline at the entry position to measure
  // how confident it is BEFORE the step loop starts. This drives:
  //   - Path weight flattening (uncertain → even weights)
  //   - Regime bias softening (uncertain → less directional)
  //   - Post-pipeline force reduction (uncertain → less corridor/LSSA)
  //
  // Uses the last training sample (closest to the prediction entry)
  // as a representative query.
  if (slReady && typeof querySignalLayers === "function" && slTrainingSamples.length > 0) {
    var probeResult = querySignalLayers(slTrainingSamples[slTrainingSamples.length - 1], activeSpecialists);
    pipelineConfidence = probeResult.pipelineConfidence || probeResult.confidence || 0.5;

    // Scale confidence by pipeline completeness: if only 1 of 3 specialists
    // is seeing real data, the pipeline's overall confidence is capped.
    pipelineCompleteness = probeResult.completeness || 1.0;
    pipelineConfidence *= pipelineCompleteness;

    // Blend with regime strength: a strong regime + decisive pipeline = high confidence
    // A weak regime + indecisive pipeline = low confidence
    pipelineConfidence = pipelineConfidence * 0.7 + entryRegime.strength * 0.3;
    if (pipelineConfidence > 1) pipelineConfidence = 1;

    // Update the display-facing confidence and flags
    confidence = pipelineConfidence;
    isConfident = pipelineConfidence >= 0.6;
    isSuppressed = false;  // never suppress — always predict, just hedge

    // Update path weights with pipeline confidence
    if (typeof getPathWeights === "function") {
      scenarioWeights = getPathWeights(entryRegime, pipelineConfidence);

      // Re-apply per-path accuracy blend (same logic as initial setup).
      // The getPathWeights call above gives confidence-flattened weights;
      // accuracy from calibration history adjusts on top of that.
      for (var awi = 0; awi < scenarios.length; awi++) {
        var awName = scenarios[awi].name;
        if (cal.scenarioStats[awName] &&
            cal.scenarioStats[awName].sampleCount >= MIN_SAMPLES_FOR_WEIGHTING) {
          var awAcc = cal.scenarioStats[awName].dirCorrect;
          awAcc = awAcc * awAcc;
          scenarioWeights[awi] *= Math.max(0.3, awAcc * 2);
        }
      }
      // Re-normalize
      var awSum = 0;
      for (var awi2 = 0; awi2 < scenarioWeights.length; awi2++) awSum += scenarioWeights[awi2];
      if (awSum > 0) {
        for (var awi3 = 0; awi3 < scenarioWeights.length; awi3++) scenarioWeights[awi3] /= awSum;
      }
    }
  }

  // ---- CORRIDOR PATHFINDING (slime mold lookahead) ----
  // Trace corridors through the total-pressure topology to find where
  // the paths of least resistance lead. This gives the prediction
  // engine lookahead: "the corridor ahead curves upward over 20 steps."
  //
  // maxStepGy constrains the corridor: each step can't move more than
  // one average candle body in grid cells. Entry regime info lets
  // corridor scoring favor momentum-aligned paths.

  // maxStepGy: maximum step size in grid cells (for corridor + signal)
  var maxStepGy = maxStepPx / resolution;
  if (maxStepGy < 0.5) maxStepGy = 0.5;

  var corridorData = null;
  if (state.predCorridor && topo && typeof traceCorridors === "function") {
    var corridorSteps = Math.max(projSlots, hmCols - entryGx - 1);
    var corridorOpts = {
      entrySlope: entryRegime ? entryRegime.score : 0,  // positive = bullish
      maxStepGy:  maxStepGy                              // max Y movement per column
    };

    // Pass cannon exhaustion zones as grid-Y ranges so corridor
    // pathfinding can penalize routing through resistance zones
    // and favor routing along support zones.
    if (state.predCannon && typeof _cannonExhaustion !== "undefined" &&
        _cannonExhaustion && _cannonExhaustion.zones && _cannonExhaustion.zones.length > 0) {
      var czones = _cannonExhaustion.zones;
      var gridZones = [];
      for (var czi = 0; czi < czones.length; czi++) {
        var cz = czones[czi];
        // Convert price range to grid-Y range:
        // gridY = (priceMax - price) / (priceMax - priceMin) * rows
        var priceRange = priceMax - priceMin;
        if (priceRange > 0.001) {
          var gYMin = (priceMax - cz.priceMax) / priceRange * hmRows;
          var gYMax = (priceMax - cz.priceMin) / priceRange * hmRows;
          gridZones.push({
            gyMin:    Math.max(0, Math.min(gYMin, gYMax)),
            gyMax:    Math.min(hmRows - 1, Math.max(gYMin, gYMax)),
            type:     cz.type,       // "support" or "resistance"
            strength: cz.strength
          });
        }
      }
      if (gridZones.length > 0) {
        corridorOpts.exhaustionZones = gridZones;
      }
    }

    corridorData = traceCorridors(topo, entryGx, entryGy, corridorSteps, 15, 30, corridorOpts);
  }

  // (maxStepGy already computed above for corridor + signal normalization)

  // Capture the pipeline's per-layer opinions from the FIRST prediction
  // step (the +1 candle). This gets stored with the pending prediction
  // so scoreLayerPrediction can attribute blame to the right layers
  // when the actual outcome is known.
  var firstStepLayerOpinions = null;

  // ---- Step-by-step iteration ----
  for (var step = 0; step < projSlots; step++) {
    var slotX = projLeft + (step + 0.5) * candleW;
    var gxSlot = Math.floor(slotX / resolution);

    // ---- PER-STEP INDICATOR STATE UPDATE ----
    // Evolve running MA and RSI with the previous step's consensus
    // price. This updates the shared indicator state (MA value, RSI
    // level) that each scenario will query individually below.
    //
    // The FORCE is NOT computed here — it's computed per-scenario
    // inside the scenario loop, based on each scenario's own position
    // relative to the MA. This way every scenario gets its own spring
    // tension proportional to how far IT has strayed from the MA.

    if (runningMA && typeof stepMA === "function") {
      stepMA(runningMA, prevConsensusPrice, indCalib, chartH);
      projMaValues.push({ x: slotX, price: runningMA.maValue });
    }
    if (runningRSI && typeof stepRSI === "function") {
      stepRSI(runningRSI, prevConsensusPrice, indCalib, chartH);
      projRsiValues.push({ x: slotX, value: runningRSI.rsiValue });
    }

    // -- Run each scenario one step: READ TERRAIN, TAKE ONE STEP --
    // No velocity accumulation. Each step is a fresh terrain reading.
    // The terrain (light field + topology + indicators) suggests a
    // direction, and the scenario takes one candle-sized step that way.
    //
    // Scenarios differ by how they WEIGHT the signals:
    //   - Trend scenarios trust momentum and flow more
    //   - Revert scenarios trust MA spring and RSI more
    //   - Neutral scenarios trust the light field terrain
    //
    // A large price move can ONLY happen as a series of small steps
    // that each independently agree on the direction.
    for (var sci = 0; sci < numScenarios; sci++) {
      var sc = scenarios[sci];
      var ss = scState[sci];

      var gx = Math.floor(slotX / resolution);
      var gy = Math.floor(ss.py / resolution);

      // ---- TERRAIN SIGNALS (each normalized to roughly -1..+1) ----
      // Positive = push price DOWN (pixel Y increases)
      // Negative = push price UP (pixel Y decreases)

      // Signal 1: Light force field (sampleForce on LIVE grids)
      // Reads the current grid state which includes both real candle
      // beams AND virtual candle beams from prior prediction steps.
      // Each predicted candle creates S/R that influences the next —
      // the same way real candles do. The intensity reversal check
      // (below) catches runaway feedback by comparing live brightness
      // to the real-candle baseline.
      var lightSig = 0;
      var localIntensity = 0;  // for intensity reversal check
      if (state.predLight) {
        var rawForce = sampleForce(gx, gy);

        lightSig = rawForce / (maxStepPx * 2 + 0.001);
        if (lightSig > 1) lightSig = 1;
        if (lightSig < -1) lightSig = -1;

        // Measure local brightness (for intensity reversal below)
        if (gx >= 0 && gx < hmCols && gy >= 0 && gy < hmRows) {
          var cellIdx = gy * hmCols + gx;
          localIntensity = hmGrids[0][cellIdx] + hmGrids[1][cellIdx]
                         + hmGrids[2][cellIdx] + hmGrids[3][cellIdx];
        }
      }

      // Signal 2: Topology flow (gradient on LIVE grids)
      // Reads evolving light field including virtual beam S/R.
      var topoSig = 0;
      if (state.predTopo && typeof queryFlowLive === "function") {
        var cf2 = state.colorForce;
        var flow = queryFlowLive(hmGrids, hmCols, hmRows, gx, gy, cf2);
        if (flow && Math.abs(flow.fy) > 0.05) {
          topoSig = flow.fy * (0.5 + flow.conf * 1.5);
          if (topoSig > 1) topoSig = 1;
          if (topoSig < -1) topoSig = -1;
        }

        // Ridge repulsion: nearby ridges push us away
        if (typeof queryRidgeLive === "function") {
          var ridge = queryRidgeLive(hmGrids, hmCols, hmRows, gx, gy, cf2, 5);
          if (ridge && ridge.dist > 0 && ridge.dist < 4) {
            var repel = -ridge.dy / (ridge.dist * ridge.dist + 1) * ridge.intensity * 0.3;
            if (repel > 0.5) repel = 0.5;
            if (repel < -0.5) repel = -0.5;
            topoSig += repel;
          }
        }
      }

      // Signal 3: MA spring (pull toward moving average)
      // QUADRATIC scaling: small gaps → gentle pull, large gaps →
      // overwhelming pull that no other signal can override.
      //
      // Real market behavior: price can wander 1-2 candle ranges from
      // MA without consequence, but at 3+ ranges the snap-back is
      // almost guaranteed. Linear scaling can't model this — the
      // light terrain can always vote harder. Quadratic means the MA
      // wins at distance regardless of what the terrain says.
      var maSig = 0;
      var maGapRanges = 0;  // stored for the hard override below
      if (runningMA && state.predMA) {
        var scenarioPrice = priceMax - ((ss.py - chartTop) / chartH) * (priceMax - priceMin);
        var maGapAbs = scenarioPrice - runningMA.maValue;
        maGapRanges = maGapAbs / (avgRange + 0.0001);  // positive = above MA

        // Quadratic: sign(gap) * gap² * scale
        // 0.5 ranges → 0.05, 1 range → 0.20, 2 ranges → 0.80, 2.5 → saturates at 1.0
        var absGapR = Math.abs(maGapRanges);
        maSig = (maGapRanges > 0 ? 1 : -1) * absGapR * absGapR * 0.2;
        if (maSig > 1) maSig = 1;
        if (maSig < -1) maSig = -1;

        // During post-crossing: reduce spring (let overshoot happen)
        if (runningMA.crossingAge >= 0 && runningMA.crossingAge < indCalib.maCrossDecay) {
          var crossFade = runningMA.crossingAge / indCalib.maCrossDecay;
          maSig *= 0.2 + 0.8 * crossFade * crossFade;
        }
      }

      // Signal 4: RSI mean-reversion
      // Rescaled: 10 RSI units past dead zone → signal ~0.5
      var rsiSig = 0;
      if (runningRSI && runningRSI.valid && state.predRSI) {
        var rsiVal = runningRSI.rsiValue;
        if (rsiVal > indCalib.rsiDeadHigh) {
          rsiSig = (rsiVal - indCalib.rsiDeadHigh) / 20;
        } else if (rsiVal < indCalib.rsiDeadLow) {
          rsiSig = -(indCalib.rsiDeadLow - rsiVal) / 20;
        }
        if (rsiSig > 1) rsiSig = 1;
        if (rsiSig < -1) rsiSig = -1;
      }

      // Signal 5: LSSA cyclic path (computed unconditionally when available)
      // Per-scenario weighting happens in the post-pipeline forces section.
      var lssaSig = 0;
      if (hasLssa) {
        var lssaTarget = lssaProjectPrice(step + 1);
        if (lssaTarget !== null) {
          var lssaTargetY = priceToY(lssaTarget, priceMin, priceMax, chartTop, chartH);
          var lssaDelta = lssaTargetY - ss.py;
          // Normalize: if LSSA target is 1 candle away, signal ~0.5
          lssaSig = lssaDelta / (maxStepPx * 2 + 0.001);
          if (lssaSig > 1) lssaSig = 1;
          if (lssaSig < -1) lssaSig = -1;
        }
      }

      // Signal 6: Momentum (recent price direction)
      var momSig = -(recentMom / (avgRange + 0.0001)) * 0.5;
      if (momSig > 0.8) momSig = 0.8;
      if (momSig < -0.8) momSig = -0.8;

      // Signal 7: Corridor pathfinding (slime mold lookahead)
      // Uses pre-traced corridors to pull the scenario toward where
      // the paths of least resistance lead. This is the "global"
      // complement to the "local" topo signal — topo reads the
      // gradient at your feet, corridor tells you where the valley
      // goes over the horizon.
      var corrSig = 0;
      var corrClarity = 0;
      if (state.predCorridor && corridorData && typeof corridorSignal === "function") {
        var scGyGrid = ss.py / resolution;
        var cs = corridorSignal(corridorData, step, scGyGrid, maxStepGy);
        corrClarity = cs.clarity;
        // Clarity modulates but doesn't crush: even a vague corridor
        // should pull meaningfully. Min 50% signal at zero clarity.
        corrSig = cs.signal * (0.5 + cs.clarity * 0.5);
        if (corrSig > 1) corrSig = 1;
        if (corrSig < -1) corrSig = -1;
      }

      // ---- CANNON EXHAUSTION SIGNAL ----
      // Queries momentum exhaustion zones: where do cannon balls
      // consistently die? Those price levels are where momentum
      // reverses. Support zones push up, resistance zones push down.
      var cannonSig = 0;
      if (state.predCannon && typeof cannonSignal === "function") {
        var cns = cannonSignal(ss.py, dims, priceMin, priceMax);
        cannonSig = cns.signal * (0.5 + cns.clarity * 0.5);
        if (cannonSig > 1) cannonSig = 1;
        if (cannonSig < -1) cannonSig = -1;
      }

      // ---- LAYERED SIGNAL PIPELINE ----
      // Pass TRAINABLE signals through the trained pipeline:
      //   Specialists (terrain, indicator, energy) →
      //   Coordinators (structure, dynamics) →
      //   Meta decision net → pipeline signal
      //
      // Corridor and LSSA are NOT pipeline inputs — they're
      // forward-looking signals that can't be trained historically.
      // They're applied as post-pipeline forces below.
      var signal = 0;
      var slStepOpinions = null;  // stored for blame attribution later

      if (slReady && typeof querySignalLayers === "function") {
        // Local light intensity for the enrichment feature
        var slLocalIntNorm = 0;
        if (localIntensity > 0 && realLightBaseline > 0.01) {
          slLocalIntNorm = Math.min(1, localIntensity / realLightBaseline);
        }

        // Energy enrichment: volume, buy pressure, body size from last candle
        var slVolRatio = avgVolumeAll > 0 ? lastCandle.v / avgVolumeAll : 1;
        var slBuyP = lastCandle.buyPressure !== undefined ? lastCandle.buyPressure : 0.5;
        var slBodySize = avgBody > 0 ? Math.abs(lastCandle.c - lastCandle.o) / avgBody : 1;

        // RSI raw value for enrichment
        var slRsiVal = (runningRSI && runningRSI.valid) ? runningRSI.rsiValue : 50;

        var slResult = querySignalLayers({
          lightSig:       lightSig,
          topoSig:        topoSig,
          lightIntensity: slLocalIntNorm,
          maSig:          maSig,
          rsiSig:         rsiSig,
          maGapRanges:    maGapRanges,
          rsiValue:       slRsiVal,
          momSig:         momSig,
          volumeRatio:    slVolRatio,
          buyPressure:    slBuyP,
          bodySize:       slBodySize
        }, activeSpecialists);

        signal = slResult.signal;
        slStepOpinions = slResult.opinions;

        // Capture first-step opinions from the first scenario.
        // At step 0, all scenarios start at the same position (currentPriceY)
        // so they all see the same signals and produce the same opinions.
        // This gets stored in the pending prediction for blame attribution.
        if (step === 0 && sci === 0 && slStepOpinions) {
          firstStepLayerOpinions = slStepOpinions;
        }

      } else {
        // ---- FALLBACK: simple average of active trainable signals ----
        // Used when pipeline isn't trained (too few samples, etc.)
        var fbSignals = [lightSig, topoSig, maSig, rsiSig, momSig];
        var fbSum = 0;
        var fbCount = 0;
        for (var fbi = 0; fbi < fbSignals.length; fbi++) {
          if (Math.abs(fbSignals[fbi]) > 0.01) {
            fbSum += fbSignals[fbi];
            fbCount++;
          }
        }
        if (fbCount > 0) signal = fbSum / fbCount;
      }

      // ---- POST-PIPELINE FORCES: Corridor + LSSA ----
      // These are forward-looking projection signals that CAN'T be
      // trained at historical candle positions (corridor is traced from
      // the entry point into the future, LSSA is a spectral projection).
      //
      // CRITICAL: This is a WEIGHTED AVERAGE, not an additive blend.
      // The pipeline was calibrated so its signal magnitude produces
      // realistic candle bodies. If we ADD corridor/LSSA on top, the
      // total signal exceeds what was calibrated, producing oversized
      // candles → intensity reversal → signal flip → oscillation.
      //
      // Instead, the pipeline and post-pipeline forces share a fixed
      // budget of 1.0. More corridor trust = less pipeline trust.
      // The total signal magnitude stays within the calibrated range.

      // Collect active post-pipeline forces and their weights.
      // KEY INSIGHT: when pipeline confidence is LOW, the corridor and
      // LSSA should get MORE weight, not less. Low pipeline confidence
      // means "the trained pipeline doesn't know" — the corridor
      // (terrain-based pathfinding) and LSSA (spectral projection) are
      // independent of the pipeline and may be the only clear signals.
      //
      // So we INVERT the scaling: low confidence = boost corridor/LSSA.
      var ppConfBoost = 1.0;
      if (pipelineConfidence < 0.7) {
        // At 0% pipeline confidence → 2.5x corridor/LSSA weight
        // At 50% → 1.4x, at 70%+ → 1.0x (normal)
        ppConfBoost = 1.0 + (1.0 - pipelineConfidence / 0.7) * 1.5;
      }
      var ppCorrW = 0;
      var ppLssaW = 0;
      var ppCannonW = 0;
      if (Math.abs(corrSig) > 0.01)    ppCorrW = (sc.corrWeight || 0) * ppConfBoost;
      if (Math.abs(lssaSig) > 0.01)    ppLssaW = (sc.lssaWeight || 0) * ppConfBoost;
      if (Math.abs(cannonSig) > 0.01)  ppCannonW = (sc.cannonWeight || 0) * ppConfBoost;
      var ppTotalW = ppCorrW + ppLssaW + ppCannonW;

      // The pipeline gets the remaining share of the weight budget.
      // Scale by BOTH confidence AND completeness. A pipeline with
      // only 1 of 3 specialists active should have very low authority.
      // At completeness 0.33: floor is 3-10%. At 1.0: floor is 10-30%.
      var ppPipeFloor = (pipelineConfidence >= 0.7 ? 0.3 : 0.10 + pipelineConfidence * 0.28)
                      * pipelineCompleteness;
      if (ppPipeFloor < 0.03) ppPipeFloor = 0.03;  // absolute minimum
      var ppPipeW = Math.max(ppPipeFloor, 1.0 - ppTotalW);

      // Normalize so all weights sum to exactly 1.0
      var ppSumW = ppPipeW + ppTotalW;
      ppPipeW    /= ppSumW;
      ppCorrW    /= ppSumW;
      ppLssaW    /= ppSumW;
      ppCannonW  /= ppSumW;

      // Weighted average: signal stays within -1..+1 range
      signal = signal    * ppPipeW
             + corrSig   * ppCorrW
             + lssaSig   * ppLssaW
             + cannonSig * ppCannonW;

      // Safety clamp: weighted average should stay in -1..+1 but
      // protect against numerical edge cases.
      if (signal > 1) signal = 1;
      if (signal < -1) signal = -1;

      // ---- REGIME BIAS ----
      // Each path (bull/neutral/bear) applies a directional bias
      // to the blended signal based on its regime assumption.
      //
      // Bull path: amplifies bullish signals, dampens bearish,
      //   weakens MA spring when price is above MA (trend is normal).
      // Bear path: mirror image.
      // Neutral path: no bias — pure pipeline output.
      //
      // This is WHERE the 3 paths diverge from each other.
      if (typeof applyRegimeBias === "function") {
        signal = applyRegimeBias(signal, maSig, maGapRanges, corrSig, lssaSig, sc, entryRegime, pipelineConfidence);
      }

      // NOTE: No hard MA override. The quadratic MA signal in the
      // weighted combination is strong enough (0.8 at 2 ranges) and
      // it works WITH the other signals instead of overriding them.
      // The hard override created a dead zone at equilibrium where
      // all signals cancelled to zero → flat prediction line.

      // ---- 3-RAY STRAIGHT LINE DETECTION ----
      // Uses actual candle geometry: each step has a body with
      // top (y - halfBody), center (y), and bottom (y + halfBody).
      //
      // Shoot 3 rays from the first to last candle in the window:
      //   TOP RAY:    top[first] → top[last]
      //   CENTER RAY: center[first] → center[last]
      //   BOTTOM RAY: bottom[first] → bottom[last]
      //
      // A ray "intersects" a candle if it passes between that
      // candle's top and bottom. Count consecutive intersections
      // for each ray walking forward from candle 2.
      //
      // Classification:
      //   3 rays hit 3+: pure straight line (tight channel)
      //   2 rays hit 3+: strong line (slight expansion/contraction)
      //   center only:   straight direction, volatility present
      //   top/bot only:  breakout or reversal forming
      //   none:          not straight — no escape needed
      var scSt = scStreaks[sci];
      var pathSoFar = allPaths[sci].path;
      var pathCount = pathSoFar.length;
      var halfBody = maxStepPx * 0.5;

      // Build the test window: recent path + planned position
      var plannedPy = ss.py + signal * maxStepPx * signalScale;
      var testLen = Math.min(pathCount + 1, 15);
      var testStart = Math.max(0, pathCount - testLen + 1);

      // Gather centers and compute tops/bottoms
      var rayCenters = [];
      var rayTops = [];
      var rayBots = [];
      for (var rti = testStart; rti < pathCount; rti++) {
        var rc = pathSoFar[rti].y;
        rayCenters.push(rc);
        rayTops.push(rc - halfBody);
        rayBots.push(rc + halfBody);
      }
      // Add planned position as the last entry
      rayCenters.push(plannedPy);
      rayTops.push(plannedPy - halfBody);
      rayBots.push(plannedPy + halfBody);

      var nPts = rayCenters.length;

      // For each of the 3 rays, count consecutive candle intersections
      // starting from candle index 1 (candle 0 defines the ray origin).
      // A ray from point[0] to point[last] at intermediate index i:
      //   rayY = startY + (endY - startY) * (i / (nPts - 1))
      // Intersects candle i if rayY falls between rayTops[i] and rayBots[i].
      var centerHits = 0, topHits = 0, botHits = 0;

      if (nPts >= 4) {
        // Center ray: center[0] → center[last]
        var cStart = rayCenters[0], cEnd = rayCenters[nPts - 1];
        var cRun = 0;
        for (var ci = 1; ci < nPts - 1; ci++) {
          var cRayY = cStart + (cEnd - cStart) * (ci / (nPts - 1));
          if (cRayY >= rayTops[ci] && cRayY <= rayBots[ci]) {
            cRun++;
          } else { break; }  // consecutive — stop at first miss
        }
        centerHits = cRun;

        // Top ray: top[0] → top[last]
        var tStart = rayTops[0], tEnd = rayTops[nPts - 1];
        var tRun = 0;
        for (var ti = 1; ti < nPts - 1; ti++) {
          var tRayY = tStart + (tEnd - tStart) * (ti / (nPts - 1));
          if (tRayY >= rayTops[ti] && tRayY <= rayBots[ti]) {
            tRun++;
          } else { break; }
        }
        topHits = tRun;

        // Bottom ray: bottom[0] → bottom[last]
        var bStart = rayBots[0], bEnd = rayBots[nPts - 1];
        var bRun = 0;
        for (var bi = 1; bi < nPts - 1; bi++) {
          var bRayY = bStart + (bEnd - bStart) * (bi / (nPts - 1));
          if (bRayY >= rayTops[bi] && bRayY <= rayBots[bi]) {
            bRun++;
          } else { break; }
        }
        botHits = bRun;
      }

      // Classify the straight line
      var raysOver3 = (centerHits >= 3 ? 1 : 0) + (topHits >= 3 ? 1 : 0) + (botHits >= 3 ? 1 : 0);
      var straightLen = Math.max(centerHits, topHits, botHits) + 2;  // +2 for endpoints
      var straightScore = 0;  // 0..1 severity

      if (raysOver3 >= 3) {
        straightScore = 1.0;    // all 3: pure channel, locked in
      } else if (raysOver3 >= 2) {
        straightScore = 0.8;    // 2 of 3: strong line
      } else if (centerHits >= 3) {
        straightScore = 0.6;    // center only: direction locked, some body variation
      } else if (topHits >= 3 || botHits >= 3) {
        straightScore = 0.4;    // edge only: one side aligned = breakout forming
      }
      // else: 0.0 = not straight

      // ---- APPLY TRAJECTORY TAX + ESCAPE ----
      // Scale by straightScore: a pure 3-ray line gets full force,
      // a partial 1-ray line gets reduced force.
      if (straightScore > 0 && straightLen > 3) {
        var overSteps = straightLen - 3;

        // Exponential continuation tax (same as before)
        var trajStartIdx = Math.max(0, pathCount - straightLen);
        var trajSlopePixels = (ss.py - pathSoFar[trajStartIdx].y) / straightLen;
        var stepScaleVal = maxStepPx * signalScale;
        var trajSignal = stepScaleVal > 0.01 ? trajSlopePixels / stepScaleVal : 0;
        var continuationSig = trajSignal;
        var deviationSig = signal - continuationSig;
        var continuationKept = Math.pow(0.5, overSteps * straightScore);
        signal = continuationSig * continuationKept + deviationSig;

        // Escape force: corridor → topo → light field probe
        // Strength scales with BOTH straightLen AND straightScore
        var escapeStrength = Math.min(0.9, overSteps * 0.15) * straightScore;
        var postTaxDelta = Math.abs(signal - trajSignal * continuationKept);
        var needsEscape = postTaxDelta < 0.08 || Math.abs(signal) < 0.05;

        if (needsEscape && escapeStrength > 0.05) {
          if (Math.abs(corrSig) > 0.02) {
            signal += corrSig * escapeStrength;
          } else if (Math.abs(topoSig) > 0.02) {
            signal += topoSig * escapeStrength * 0.7;
          } else if (state.predLight && typeof sampleForce === "function") {
            var probeStepPx = Math.max(2, Math.round(maxStepPx * 0.5));
            var bestProbeForce = 0;
            for (var pDir = -1; pDir <= 1; pDir += 2) {
              for (var pMult = 1; pMult <= 3; pMult++) {
                var probeGy = Math.floor((ss.py + pDir * probeStepPx * pMult) / resolution);
                if (probeGy < 0 || probeGy >= hmRows) continue;
                var pForce = sampleForce(gx, probeGy);
                if (Math.abs(pForce) > Math.abs(bestProbeForce)) {
                  bestProbeForce = pForce;
                }
              }
            }
            if (Math.abs(bestProbeForce) > 0.01) {
              var flatNudge = bestProbeForce / (maxStepPx * 2 + 0.001);
              if (flatNudge > 1) flatNudge = 1;
              if (flatNudge < -1) flatNudge = -1;
              signal += flatNudge * escapeStrength;
            }
          }
        }

        if (signal > 1) signal = 1;
        if (signal < -1) signal = -1;
      }

      // Also apply dataset's average streak length as a hard ceiling.
      var sigDir = signal > 0.02 ? 1 : signal < -0.02 ? -1 : 0;
      if (sigDir !== 0 && sigDir === scSt.dir) {
        scSt.count++;
      } else if (sigDir !== 0) {
        scSt.dir = sigDir;
        scSt.count = 1;
      }
      if (scSt.count > avgStreakLen) {
        var avgOver = scSt.count - avgStreakLen;
        var avgDamp = 1.0 / (1 + avgOver * 0.8);
        signal *= avgDamp;
      }

      // ---- INTENSITY REVERSAL ----
      // When virtual candle beams stack into a corridor brighter than
      // anything the real chart produced, the prediction is doing
      // something markets don't do. The brightness IS the signal.
      //
      // Controlled by predIntRev toggle.
      if (state.predIntRev && localIntensity > 0 && realLightBaseline > 0.01) {
        var intensityRatio = localIntensity / realLightBaseline;

        if (intensityRatio > 1.5) {
          var excess = intensityRatio - 1.5;

          if (intensityRatio < 3.0) {
            // 1.5x-3x: dampen toward zero (growing doubt)
            signal *= 1.0 / (1 + excess * 1.5);
          } else {
            // 3x+: flip the signal. Brighter = harder reversal.
            // 3x → flip to -30%. 5x → -50%. 10x → -70%.
            var flipStrength = Math.min(0.7, (intensityRatio - 3.0) * 0.1);
            signal = -signal * flipStrength;
          }
        }
      }

      // ---- MINIMUM STEP ----
      // Ensures candles always move at least 30% of avg body size.
      // When disabled, very weak signals produce tiny candles (realistic
      // but can look like a flat line if all signals cancel out).
      // Controlled by predMinStep toggle.
      if (state.predMinStep) {
        var minSignal = 0.3;  // 30% of a candle body minimum movement
        if (Math.abs(signal) < minSignal) {
        // Signal is too weak — boost to minimum while keeping direction.
        // If signal is essentially zero, use LSSA direction as tiebreaker.
        if (Math.abs(signal) < 0.02) {
          // Signal is dead — use LSSA direction if available, else alternate
          if (Math.abs(lssaSig) > 0.02) {
            signal = (lssaSig > 0 ? 1 : -1) * minSignal;
          } else {
            // No LSSA either — mild alternation to prevent flat line
            // Use step parity for the scenario to create variation
            signal = ((step + sci) % 3 === 0 ? -1 : 1) * minSignal * 0.5;
          }
        } else {
          // Weak but not dead — preserve direction, boost magnitude
          signal = (signal > 0 ? 1 : -1) * minSignal;
        }
      }
      }  // end predMinStep

      // ---- DENORMALIZE STEP SIZE ----
      // maxStepPx = one average real candle body (in pixels).
      // signalScale compensates for the fact that the weighted signal
      // combination structurally compresses values (signals rarely
      // reach ±1.0). The scale factor is measured from actual signal
      // magnitudes at VISIBLE candle positions on this chart.
      //
      // CRITICAL: maxStepPx, signalScale, avgBody, bodyStdDev, and
      // all sizing parameters are computed ONLY from real candles,
      // NEVER from prediction candles. Using prediction candle sizes
      // to determine future prediction candle sizes creates a feedback
      // loop that compounds in one direction.
      var stepMove = signal * maxStepPx * signalScale;

      // Distance fade: reduces step size further from prediction entry.
      // Controlled by predDistFade toggle (OFF by default).
      if (state.predDistFade) {
        var distFade = 1.0 / (1.0 + step * 0.012);
        stepMove *= distFade;
      }

      ss.py += stepMove;
      ss.prevMove = stepMove;

      // Soft clamp
      if (ss.py < chartTop) ss.py = chartTop;
      if (ss.py > chartTop + chartH) ss.py = chartTop + chartH;

      var price = priceMax - ((ss.py - chartTop) / chartH) * (priceMax - priceMin);

      // Apply calibration bias correction (if enabled).
      //
      // The bias is stored as a PERCENTAGE of price (not raw dollars),
      // making it valid across timeframes in multi-res charts. A bias
      // of +0.002 means "we consistently undershoot by 0.2% of price."
      //
      // GUARDRAILS (prevent feedback-loop oscillation):
      //   1. Require 10+ samples AND >65% direction accuracy.
      //   2. Cap correction to ±0.3% of current price.
      //   3. Smooth across neighboring distances.
      //   4. Gentle multiplier (0.3) so corrections ramp in slowly.
      var biasD = step + 1;
      if (state.predCalib && biasD < MAX_DIST && cal.sampleCount[biasD] > 10) {
        var dirAcc = cal.dirCorrect[biasD];

        if (dirAcc > 0.65) {
          // Smooth: average with neighboring distances
          var smoothBias = cal.bias[biasD];
          var smoothN = 1;
          if (biasD > 1 && cal.sampleCount[biasD - 1] > 5) {
            smoothBias += cal.bias[biasD - 1];
            smoothN++;
          }
          if (biasD + 1 < MAX_DIST && cal.sampleCount[biasD + 1] > 5) {
            smoothBias += cal.bias[biasD + 1];
            smoothN++;
          }
          smoothBias /= smoothN;

          // Cap to ±0.3% of price (percentage units)
          var biasCap = 0.003;
          if (smoothBias > biasCap) smoothBias = biasCap;
          if (smoothBias < -biasCap) smoothBias = -biasCap;

          // Scale by accuracy above 65% threshold
          var biasWeight = Math.min(1.0, (dirAcc - 0.65) / 0.20) * 0.3;

          // Convert percentage bias back to dollars using current price
          price += smoothBias * biasWeight * price;
          ss.py = priceToY(price, priceMin, priceMax, chartTop, chartH);
          if (ss.py < chartTop) ss.py = chartTop;
          if (ss.py > chartTop + chartH) ss.py = chartTop + chartH;
          price = priceMax - ((ss.py - chartTop) / chartH) * (priceMax - priceMin);
        }
      }

      allPaths[sci].path.push({ x: slotX, y: ss.py, price: price, slot: step + 1 });
    }

    // -- Compute WEIGHTED consensus price for this step (#1) --
    // Each scenario contributes proportionally to its tracked accuracy.
    // Better-performing scenarios have more say in where the consensus lands.
    var consensusPrice = 0;
    for (var ci = 0; ci < numScenarios; ci++) {
      consensusPrice += allPaths[ci].path[step].price * scenarioWeights[ci];
    }

    // NOTE: No consensus-level streak exhaustion. The per-scenario
    // streak tracking already limits individual runs, and the weighted
    // average of 8 scenarios provides natural smoothing. Adding
    // consensus blending toward prevConsensusPrice creates stickiness
    // that makes lines go flat.

    // -- Create a virtual candle at the consensus price --
    //
    // ALL SIZING CONSTANTS (avgBody, bodyStdDev, avgWickUp, avgWickDown)
    // are computed from REAL candles only, before the step loop.
    // Virtual candle sizes NEVER feed back into sizing calculations.
    //
    // DELTA-FROM-AVERAGE SIZING: Virtual candles should look like the
    // real candles on this chart. Instead of a hard "2x avgRange" cap,
    // we use the statistical distribution of actual candle bodies:
    //
    //   - Body within avg ± 2σ: passes through unchanged (normal move)
    //   - Body beyond avg + 2σ: soft-capped with diminishing returns
    //     Only 30% of the excess beyond 2σ passes through.
    //     This keeps extreme candles in check without hard clipping.
    //
    // Wicks are proportional to the average observed wick sizes, not
    // a fixed ratio. This means 5m candles get tiny wicks and daily
    // candles get appropriately larger wicks — timeframe-adaptive.

    var vcOpen  = prevConsensusPrice;
    var vcClose = consensusPrice;

    // Soft-cap the body: pull extreme moves toward average
    var body = vcClose - vcOpen;
    var absBody = Math.abs(body);
    var bodyThreshold = avgBody + 2 * bodyStdDev;  // "normal" ceiling

    if (absBody > bodyThreshold) {
      // Excess beyond 2σ gets compressed — only 30% passes through.
      // A move of avgBody + 4σ becomes avgBody + 2σ + 0.6σ = avg + 2.6σ
      // instead of the full avg + 4σ. Keeps candles realistic without
      // the hard cliff of a flat cap.
      var excess = absBody - bodyThreshold;
      var cappedBody = bodyThreshold + excess * 0.3;
      vcClose = vcOpen + (body > 0 ? cappedBody : -cappedBody);
      consensusPrice = vcClose;
    }

    // Wicks: proportional to observed averages, scaled by body magnitude.
    // Bigger bodies get proportionally bigger wicks (more volatile candles
    // have more wick). The ratio is body/avgBody so a half-sized body
    // gets half-sized wicks, a full-sized body gets average wicks.
    var bodyScale = avgBody > 0 ? Math.min(absBody / avgBody, 2.0) : 1.0;
    var vcHigh  = Math.max(vcOpen, vcClose) + avgWickUp * bodyScale * 0.8;
    var vcLow   = Math.min(vcOpen, vcClose) - avgWickDown * bodyScale * 0.8;

    // Final range soft-cap: same delta-from-average approach
    var vcRange = vcHigh - vcLow;
    var rangeThreshold = avgRange + 2 * bodyStdDev;
    if (vcRange > rangeThreshold) {
      var rangeExcess = vcRange - rangeThreshold;
      var cappedRange = rangeThreshold + rangeExcess * 0.3;
      var vcMid = (vcHigh + vcLow) / 2;
      vcHigh = vcMid + cappedRange / 2;
      vcLow  = vcMid - cappedRange / 2;
    }

    var vcOY = priceToY(vcOpen,  priceMin, priceMax, chartTop, chartH);
    var vcCY = priceToY(vcClose, priceMin, priceMax, chartTop, chartH);
    var vcHY = priceToY(vcHigh,  priceMin, priceMax, chartTop, chartH);
    var vcLY = priceToY(vcLow,   priceMin, priceMax, chartTop, chartH);

    virtualCandles.push({
      x: slotX, o: vcOpen, h: vcHigh, l: vcLow, c: vcClose,
      oY: vcOY, hY: vcHY, lY: vcLY, cY: vcCY,
    });

    // -- Paint light from this virtual candle using real paintBeam --
    //
    // Same process as real candles: build H-H and L-L sight lines
    // from previous tips to this one. If clear, paint the base line
    // and extend a ray rightward. Uses the real paintBeam from
    // buildHeatmap — no reimplementation, identical beam behavior.

    // Only emit virtual beams if V.Beams toggle is on.
    if (state.predVBeam) {

      // ---- MARK VIRTUAL CANDLE IN OCCLUSION GRID ----
      // This is the critical fix for the "flashlight" effect.
      // Without this, paintBeam steps through the grid and finds
      // no candle body for virtual candles — beams pass through
      // at full intensity. With this, virtual candle bodies cast
      // shadows on subsequent beams, just like real candles do.
      //
      // Uses the same H-L range marking as real candles in
      // heatmap.js (lines 110-132). Virtual candle IDs are offset
      // past real candle IDs to avoid collision.
      var occGrid = hmData.occGrid;
      if (occGrid) {
        var vcSlotLeft  = slotX - candleW * 0.5;
        var vcSlotRight = slotX + candleW * 0.5;
        var vcGxMin = Math.floor(vcSlotLeft / resolution);
        var vcGxMax = Math.ceil(vcSlotRight / resolution);
        var vcGyMin = Math.floor(vcHY / resolution);   // high Y (smaller = higher on screen)
        var vcGyMax = Math.ceil(vcLY / resolution);     // low Y (larger = lower on screen)
        if (vcGxMin < 0) vcGxMin = 0;
        if (vcGxMax >= hmCols) vcGxMax = hmCols - 1;
        if (vcGyMin < 0) vcGyMin = 0;
        if (vcGyMax >= hmRows) vcGyMax = hmRows - 1;

        // Unique ID: offset past all real candle IDs
        var vcOccId = count + step + 1;
        for (var voy = vcGyMin; voy <= vcGyMax; voy++) {
          for (var vox = vcGxMin; vox <= vcGxMax; vox++) {
            occGrid[voy * hmCols + vox] = vcOccId;
          }
        }

        // Bridge gap to previous virtual candle (same as heatmap.js
        // does for adjacent real candles — prevents light leaking
        // through the seam between slots).
        if (step > 0 && virtualCandles.length >= 2) {
          var prevVC = virtualCandles[virtualCandles.length - 2];
          var bridgeHigh = Math.min(vcHY, prevVC.hY);
          var bridgeLow  = Math.max(vcLY, prevVC.lY);
          if (bridgeLow > bridgeHigh) {
            var bGxMin = Math.floor((slotX - candleW) / resolution);
            var bGxMax = Math.ceil(slotX / resolution);
            var bGyMin = Math.floor(bridgeHigh / resolution);
            var bGyMax = Math.ceil(bridgeLow / resolution);
            if (bGxMin < 0) bGxMin = 0;
            if (bGxMax >= hmCols) bGxMax = hmCols - 1;
            if (bGyMin < 0) bGyMin = 0;
            if (bGyMax >= hmRows) bGyMax = hmRows - 1;
            for (var bry = bGyMin; bry <= bGyMax; bry++) {
              for (var brx = bGxMin; brx <= bGxMax; brx++) {
                if (occGrid[bry * hmCols + brx] === 0) {
                  occGrid[bry * hmCols + brx] = vcOccId;
                }
              }
            }
          }
        }
      }

      // Add this virtual candle to the combined tip array
      allTips.push({
        x:  slotX,
        hy: vcHY,
        ly: vcLY,
        h:  vcHigh,
        l:  vcLow,
      });

      var dstTipIdx = allTips.length - 1;
      var dst = allTips[dstTipIdx];

      // Build sight lines from every prior tip to this virtual candle.
      // Matches the real beam system in sightlines.js + heatmap.js:
      //
      //   1. Base sight lines: H-H and L-L connections with occlusion
      //      check, volume/intensity weight approximation, span boost.
      //
      //   2. Extended rays: Only from peaks (H-H) or troughs (L-L),
      //      collision-walked through occGrid until hitting a candle,
      //      with beam spread and momentum-based intensity.
      //
      // Virtual candles lack real volume and indicator data, so we
      // use neutral weight values (0.7 — midpoint of 0.4..1.0 range
      // that the real system produces).

      var vbeamStr = (state.predVBeamStr != null ? state.predVBeamStr : 1.0);

      // ---- Peak/trough detection for ray filtering ----
      // Recomputed each step as allTips grows. Matches sightlines.js:
      //   Peak:   tip.h >= both neighbors' highs
      //   Trough: tip.l <= both neighbors' lows
      //   Both peak AND trough → disqualify from both
      //   First/last tips always qualify (no neighbor on one side).
      var tipCount = allTips.length;
      var tipIsPeak   = [];
      var tipIsTrough = [];
      for (var pti = 0; pti < tipCount; pti++) {
        var ptPrevH = (pti > 0)             ? allTips[pti - 1].h : -Infinity;
        var ptNextH = (pti < tipCount - 1)  ? allTips[pti + 1].h : -Infinity;
        tipIsPeak.push(allTips[pti].h >= ptPrevH && allTips[pti].h >= ptNextH);

        var ptPrevL = (pti > 0)             ? allTips[pti - 1].l : Infinity;
        var ptNextL = (pti < tipCount - 1)  ? allTips[pti + 1].l : Infinity;
        tipIsTrough.push(allTips[pti].l <= ptPrevL && allTips[pti].l <= ptNextL);
      }
      // Small candle squeezed between bigger ones — not a meaningful
      // emitter. Same disqualification as sightlines.js.
      for (var pti2 = 0; pti2 < tipCount; pti2++) {
        if (tipIsPeak[pti2] && tipIsTrough[pti2]) {
          tipIsPeak[pti2]   = false;
          tipIsTrough[pti2] = false;
        }
      }

      // ---- Beam spread setup (matches sightlines.js) ----
      var vbSpreadDeg = state.beamSpread || 0;
      var vbSpreadRad = vbSpreadDeg * (Math.PI / 180);
      var vbSubRayCount = vbSpreadDeg < 0.5
        ? 1
        : Math.min(1 + Math.round(vbSpreadDeg * 0.8), 15);

      // Neutral weight factors for virtual candles (no real volume
      // or indicator data). The real system multiplies by:
      //   srcWeight * (0.4 + volWeight * 0.6) * (0.4 + intWeight * 0.6)
      // With average vol/int weights ~0.5, that's roughly 1.0 * 0.7 * 0.7 ≈ 0.49.
      // We use that as a flat multiplier so virtual beams have comparable
      // brightness to real beams rather than running hotter.
      var vbNeutralWeight = 0.49;

      for (var srcTipIdx = 0; srcTipIdx < dstTipIdx; srcTipIdx++) {
        var src = allTips[srcTipIdx];
        if (src.x >= dst.x) continue;

        // --- H-H connection ---
        var hhBlocked = false;
        for (var ki = srcTipIdx + 1; ki < dstTipIdx; ki++) {
          var mid = allTips[ki];
          var t = (mid.x - src.x) / (dst.x - src.x);
          var linePrice = src.h + t * (dst.h - src.h);
          if (linePrice <= mid.h && linePrice >= mid.l) {
            hhBlocked = true;
            break;
          }
        }

        if (!hhBlocked) {
          var hhDx = dst.x - src.x;
          var hhDy = dst.hy - src.hy;
          var hhLen = Math.sqrt(hhDx * hhDx + hhDy * hhDy);
          if (hhLen > 1) {
            // Base sight line intensity: span boost * neutral weights * vol dampen
            var hhGrid = hmGrids[beamGridIdx("h", src.hy, dst.hy)];
            var hhSpan = dstTipIdx - srcTipIdx;
            var hhInt = (0.5 + Math.min(1.0, hhSpan / 10) * 0.5)
                      * vbNeutralWeight * volDampen * vbeamStr;

            // Paint base sight line (src high → dst high)
            realPaintBeam(hhGrid, src.x, src.hy, dst.x, dst.hy, hhInt, -1);

            // ---- Extended ray (only from peaks, matching sightlines.js) ----
            if (tipIsPeak[dstTipIdx]) {
              var hhBaseAngle = Math.atan2(hhDy, hhDx);
              var hhNdx = hhDx / hhLen;
              var hhNdy = hhDy / hhLen;

              // Emit sub-rays across beam spread (1 ray if spread is off)
              for (var hhSri = 0; hhSri < vbSubRayCount; hhSri++) {
                var hhSubAngle;
                if (vbSubRayCount === 1) {
                  hhSubAngle = hhBaseAngle;
                } else {
                  var hhT = hhSri / (vbSubRayCount - 1);  // 0..1
                  hhSubAngle = hhBaseAngle + vbSpreadRad * (hhT - 0.5);
                }

                var hhRndx = Math.cos(hhSubAngle);
                var hhRndy = Math.sin(hhSubAngle);

                // Spread falloff: center ray full strength, edges dimmer
                var hhSpreadFO = 1.0;
                if (vbSubRayCount > 1) {
                  var hhOC = Math.abs((hhSri / (vbSubRayCount - 1)) - 0.5) * 2;
                  hhSpreadFO = 1.0 - hhOC * 0.5;  // edge = 50% brightness
                }

                // Collision-walk: march from dst tip until hitting a candle
                // in occGrid or leaving the canvas. Matches sightlines.js
                // step-march behavior.
                var hhRayStep = 2;
                var hhRx = dst.x + hhRndx * hhRayStep;
                var hhRy = dst.hy + hhRndy * hhRayStep;
                var hhExtDist = 0;
                var hhMaxDist = Math.sqrt(dims.width * dims.width
                              + (dims.height || chartH) * (dims.height || chartH));

                while (hhExtDist < hhMaxDist) {
                  if (hhRx < 0 || hhRx >= dims.width * 2
                   || hhRy < 0 || hhRy >= (dims.height || chartTop + chartH)) break;

                  // Check occGrid for collision with a different candle
                  var hhGx = (hhRx / resolution) | 0;
                  var hhGy = (hhRy / resolution) | 0;
                  if (hhGx >= 0 && hhGx < hmCols && hhGy >= 0 && hhGy < hmRows) {
                    var hhOccVal = occGrid[hhGy * hmCols + hhGx];
                    // Hit a candle that isn't our dst virtual candle
                    if (hhOccVal > 0 && hhOccVal !== vcOccId) break;
                  }

                  hhRx += hhRndx * hhRayStep;
                  hhRy += hhRndy * hhRayStep;
                  hhExtDist += hhRayStep;
                }

                // Only paint if the ray traveled some distance
                if (hhExtDist > 2) {
                  // Momentum-based intensity (matches sightlines.js ray formula):
                  //   (0.4 + momNorm * 0.8) * spreadFalloff * weight
                  var hhMomNorm = Math.min(1.0, hhExtDist / 200);
                  var hhRayInt = (0.4 + hhMomNorm * 0.8)
                              * hhSpreadFO * volDampen * vbeamStr;
                  var hhRayGrid = hmGrids[beamGridIdx("h", dst.hy, hhRy)];
                  realPaintBeam(hhRayGrid, dst.x, dst.hy, hhRx, hhRy, hhRayInt, -1);
                }
              }
            }
          }
        }

        // --- L-L connection ---
        var llBlocked = false;
        for (var ki2 = srcTipIdx + 1; ki2 < dstTipIdx; ki2++) {
          var mid2 = allTips[ki2];
          var t2 = (mid2.x - src.x) / (dst.x - src.x);
          var linePrice2 = src.l + t2 * (dst.l - src.l);
          if (linePrice2 <= mid2.h && linePrice2 >= mid2.l) {
            llBlocked = true;
            break;
          }
        }

        if (!llBlocked) {
          var llDx = dst.x - src.x;
          var llDy = dst.ly - src.ly;
          var llLen = Math.sqrt(llDx * llDx + llDy * llDy);
          if (llLen > 1) {
            var llGrid = hmGrids[beamGridIdx("l", src.ly, dst.ly)];
            var llSpan = dstTipIdx - srcTipIdx;
            var llInt = (0.5 + Math.min(1.0, llSpan / 10) * 0.5)
                      * vbNeutralWeight * volDampen * vbeamStr;

            // Paint base sight line (src low → dst low)
            realPaintBeam(llGrid, src.x, src.ly, dst.x, dst.ly, llInt, -1);

            // ---- Extended ray (only from troughs, matching sightlines.js) ----
            if (tipIsTrough[dstTipIdx]) {
              var llBaseAngle = Math.atan2(llDy, llDx);
              var llNdx = llDx / llLen;
              var llNdy = llDy / llLen;

              for (var llSri = 0; llSri < vbSubRayCount; llSri++) {
                var llSubAngle;
                if (vbSubRayCount === 1) {
                  llSubAngle = llBaseAngle;
                } else {
                  var llT = llSri / (vbSubRayCount - 1);
                  llSubAngle = llBaseAngle + vbSpreadRad * (llT - 0.5);
                }

                var llRndx = Math.cos(llSubAngle);
                var llRndy = Math.sin(llSubAngle);

                var llSpreadFO = 1.0;
                if (vbSubRayCount > 1) {
                  var llOC = Math.abs((llSri / (vbSubRayCount - 1)) - 0.5) * 2;
                  llSpreadFO = 1.0 - llOC * 0.5;
                }

                // Collision-walk from dst low tip
                var llRayStep = 2;
                var llRx = dst.x + llRndx * llRayStep;
                var llRy = dst.ly + llRndy * llRayStep;
                var llExtDist = 0;
                var llMaxDist = Math.sqrt(dims.width * dims.width
                              + (dims.height || chartH) * (dims.height || chartH));

                while (llExtDist < llMaxDist) {
                  if (llRx < 0 || llRx >= dims.width * 2
                   || llRy < 0 || llRy >= (dims.height || chartTop + chartH)) break;

                  var llGx = (llRx / resolution) | 0;
                  var llGy = (llRy / resolution) | 0;
                  if (llGx >= 0 && llGx < hmCols && llGy >= 0 && llGy < hmRows) {
                    var llOccVal = occGrid[llGy * hmCols + llGx];
                    if (llOccVal > 0 && llOccVal !== vcOccId) break;
                  }

                  llRx += llRndx * llRayStep;
                  llRy += llRndy * llRayStep;
                  llExtDist += llRayStep;
                }

                if (llExtDist > 2) {
                  var llMomNorm = Math.min(1.0, llExtDist / 200);
                  var llRayInt = (0.4 + llMomNorm * 0.8)
                              * llSpreadFO * volDampen * vbeamStr;
                  var llRayGrid = hmGrids[beamGridIdx("l", dst.ly, llRy)];
                  realPaintBeam(llRayGrid, dst.x, dst.ly, llRx, llRy, llRayInt, -1);
                }
              }
            }
          }
        }
      }
    }

    // NOTE: Topology forces during prediction use the PAST-ONLY topology
    // (computed once before the step loop). This ensures no future data
    // leaks into the force field. A display-only recompute happens AFTER
    // the loop finishes so the contour overlay shows virtual beam effects.

    // ---- PER-STEP REGIME RE-EVALUATION ----
    // After each virtual candle, update each path's running regime
    // based on what that path predicted. If the bull path keeps
    // generating bearish candles, its regime weakens — which can
    // shift path weights in subsequent steps.
    if (typeof updatePathRegime === "function") {
      for (var rpi = 0; rpi < numScenarios; rpi++) {
        var rpPrice = allPaths[rpi].path[step].price;
        var rpPrev = step > 0 ? allPaths[rpi].path[step - 1].price : currentPrice;
        var rpMA = runningMA ? runningMA.maValue : null;
        updatePathRegime(runningRegimes[rpi], rpPrice, rpPrev, currentPrice, rpMA);
      }
    }

    // Dynamically adjust path weights every 5 steps based on
    // how well each path's regime assumption is playing out.
    if (step > 0 && step % 5 === 0 && typeof adjustPathWeights === "function") {
      scenarioWeights = adjustPathWeights(scenarioWeights, runningRegimes, 3);
    }

    prevConsensusPrice = consensusPrice;
  }

  // ---- RECOMPUTE TOPOLOGY FOR DISPLAY ----
  // The prediction step loop used the PAST-ONLY topology (correct —
  // no future data in the force field). But for the contour overlay,
  // we want to show the full picture including virtual beam effects.
  // This single recompute runs ONCE after all steps, not per-step.
  //
  // The prediction forces are NOT affected — this is purely visual.
  if (topo && state.predVBeam && typeof computeTopology === "function") {
    topo = computeTopology(hmGrids, hmCols, hmRows, state.colorForce);
  }

  // Color paths based on where they end up
  for (var pci = 0; pci < allPaths.length; pci++) {
    var endPrice = allPaths[pci].path[allPaths[pci].path.length - 1].price;
    if (endPrice > currentPrice * 1.001) allPaths[pci].color = "bull";
    else if (endPrice < currentPrice * 0.999) allPaths[pci].color = "bear";
  }


  // ================================================================
  // BUILD WEIGHTED CONSENSUS & DIRECTION VOTE (#1 + #2)
  // ================================================================
  // The consensus price at each step uses the accuracy-weighted
  // average (same weights used in the step loop above).
  //
  // For DIRECTION, we use a weighted majority vote (#2).
  // Each scenario votes up or down based on its +1 candle price,
  // and the vote is weighted by that scenario's accuracy.
  // This is more robust than checking if the blended price crossed
  // the current price — a single wild outlier can't flip the direction.

  var consensusPrices = [];
  for (var cs = 0; cs < projSlots; cs++) {
    var priceSum = 0;
    for (var cp = 0; cp < allPaths.length; cp++) {
      priceSum += allPaths[cp].path[cs].price * scenarioWeights[cp];
    }
    consensusPrices.push(priceSum);
  }

  // ================================================================
  // TEMPORAL SMOOTHING — blend with previous frame's projection
  // ================================================================
  // A single unusual candle can whip the entire projection because
  // LSSA, forces, and light all recompute from scratch each frame.
  // Averaging the current projection with the prior frame's projection
  // (shifted by 1 candle) smooths out noise while still responding
  // to real changes.
  //
  // The blend factor (0.5) means: 50% current frame, 50% previous.
  // This acts like a 2-frame moving average on the projection itself.
  //
  // Alignment: if we had N candles last frame and N+1 now, the prior
  // frame's step[k] predicted the same future candle as our step[k-1].
  // So we offset by the candle count difference when blending.

  // ================================================================
  // TEMPORAL SMOOTHING — blend with 2 previous frames' projections
  // ================================================================
  // A single unusual candle can whip the projection. Blending with
  // the 2 prior frames creates a 3-frame moving average that:
  //   - Smooths out single-candle noise
  //   - Captures the trajectory (3 points define a curve)
  //   - Responds to sustained changes within 2-3 candles
  //
  // Weights: current 45%, previous 35%, prev-prev 20%.
  // Heavier on current so it still responds, but the two prior
  // frames provide stabilizing inertia and directional context.

  var W_CURR = 0.45;
  var W_PREV = 0.35;
  var W_PREV2 = 0.20;

  var hasPrev  = cal.prevConsensusPrices && cal.prevConsensusPrices.length > 0;
  var hasPrev2 = cal.prev2ConsensusPrices && cal.prev2ConsensusPrices.length > 0;

  if (hasPrev) {
    var candleShift = count - cal.prevCandleCount;
    var candleShift2 = hasPrev2 ? count - cal.prev2CandleCount : 0;

    for (var smi = 0; smi < consensusPrices.length; smi++) {
      var prevIdx = smi + candleShift;
      var prev2Idx = hasPrev2 ? smi + candleShift2 : -1;

      var hasPrevVal  = prevIdx >= 0 && prevIdx < cal.prevConsensusPrices.length;
      var hasPrev2Val = hasPrev2 && prev2Idx >= 0 && prev2Idx < cal.prev2ConsensusPrices.length;

      if (hasPrevVal && hasPrev2Val) {
        // Full 3-frame blend
        consensusPrices[smi] = consensusPrices[smi] * W_CURR
                             + cal.prevConsensusPrices[prevIdx] * W_PREV
                             + cal.prev2ConsensusPrices[prev2Idx] * W_PREV2;
      } else if (hasPrevVal) {
        // 2-frame blend (no prev2 yet — early in run)
        consensusPrices[smi] = consensusPrices[smi] * 0.55
                             + cal.prevConsensusPrices[prevIdx] * 0.45;
      }
    }
  }

  // Shift storage: prev → prev2, current → prev
  cal.prev2ConsensusPrices = cal.prevConsensusPrices;
  cal.prev2CandleCount = cal.prevCandleCount;
  cal.prevConsensusPrices = consensusPrices.slice();
  cal.prevCandleCount = count;


  // ================================================================
  // FORWARD ECHO — incorporate past predictions about the future
  // ================================================================
  // Past predictions stored consensus prices for future candles.
  // As time passes, those predictions approach their target time.
  // If a prediction made 10 candles ago said "price will be $90 at
  // this point" and distance-10 predictions have been 60% accurate,
  // that's useful information we should factor in.
  //
  // For each step in the current projection, we scan past pending
  // predictions that have a consensus price for that same future
  // candle. Each past prediction is weighted by:
  //   1. The per-distance accuracy at the distance it was made from
  //   2. A recency bias (newer predictions slightly preferred)
  //
  // The echo is blended into the consensus as a gentle pull —
  // it can't override the current model, but it adds the "memory"
  // of what the system previously expected to happen at this time.
  //
  // This creates temporal coherence: if the model consistently
  // predicted a price level at a future time from multiple prior
  // frames, the current prediction gives that level extra weight.
  // Conversely, a one-off wild prediction from a single prior frame
  // gets very little weight because it's one voice among many.

  var ECHO_BLEND = 0.25;  // max influence of the echo (0.25 = up to 25%)
  var MIN_ECHO_ACCURACY = 0.45;  // only use predictions from distances that beat this threshold

  if (cal.pendingPredictions.length > 1 && cal.sampleCount[1] > 3) {
    for (var eStep = 0; eStep < consensusPrices.length; eStep++) {
      // What future candle does this step predict?
      var targetCandle = count + eStep + 1;

      var echoWeightSum = 0;
      var echoPriceSum = 0;
      var echoCount = 0;

      // Scan pending predictions for ones that cover this target candle
      for (var epi = 0; epi < cal.pendingPredictions.length; epi++) {
        var ePred = cal.pendingPredictions[epi];

        // Skip the current prediction (which we just made)
        if (ePred.candleCount === count) continue;

        // What step index in this past prediction covers targetCandle?
        var ePredStep = targetCandle - ePred.candleCount - 1;
        if (ePredStep < 0 || ePredStep >= ePred.consensusPrices.length) continue;

        // What distance was this prediction from the target?
        var eDist = targetCandle - ePred.candleCount;
        if (eDist < 1 || eDist >= 200) continue;

        // How accurate has this distance been?
        var eAcc = (cal.sampleCount[eDist] > 2) ? cal.dirCorrect[eDist] : 0.5;
        if (eAcc < MIN_ECHO_ACCURACY) continue;

        // Recency weight: newer predictions are slightly more relevant.
        // A prediction made 1 candle ago gets weight 1.0.
        // A prediction made 20 candles ago gets weight ~0.5.
        var candlesAgo = count - ePred.candleCount;
        var recency = 1.0 / (1.0 + candlesAgo * 0.05);

        // Combined weight: accuracy × recency
        // Accuracy is raised to power 2 so that 0.7 accuracy ≫ 0.5 accuracy
        var eWeight = (eAcc * eAcc) * recency;

        echoPriceSum += ePred.consensusPrices[ePredStep] * eWeight;
        echoWeightSum += eWeight;
        echoCount++;
      }

      // Blend the echo into the consensus if we have enough contributing predictions
      if (echoCount >= 2 && echoWeightSum > 0.01) {
        var echoPrice = echoPriceSum / echoWeightSum;
        // Scale the blend by how many predictions contributed
        // (more agreement = stronger echo)
        var echoConfidence = Math.min(1.0, echoCount / 8);  // 8+ predictions = full confidence
        var blend = ECHO_BLEND * echoConfidence;
        consensusPrices[eStep] = consensusPrices[eStep] * (1 - blend)
                               + echoPrice * blend;
      }
    }
  }

  // ================================================================
  // TRAP DETECTOR — fakeout / bull trap / bear trap scoring
  // ================================================================
  // When a setup looks "too obvious," it's often a trap. This system
  // scores how trap-like the current situation is by combining signals
  // that historically precede fakeouts:
  //
  //   1. LSSA vs MOMENTUM disagreement — cycle says turn, momentum
  //      says continue. One of them is wrong.
  //   2. VOLUME DIVERGENCE — price extreme on weak volume means
  //      weak conviction behind the move.
  //   3. STREAK EXHAUSTION — overextended run is ripe for reversal.
  //   4. LIGHT IMBALANCE — extreme one-sidedness means the big
  //      move already happened; "obvious" continuation is the trap.
  //   5. WICK REJECTION — long wick on last candle = the market
  //      tested a level and got slapped back. The "test" was the trap.
  //   6. SCENARIO SPLIT — when scenarios are evenly divided, the
  //      market is at a decision point where traps happen.
  //
  // When trapScore > threshold, the first-step consensus delta is
  // partially inverted: "the setup says UP but the trap indicators
  // say this is a fake — lean DOWN."
  //
  // The trap application is recorded so calibration can track whether
  // trap-detected predictions are actually more accurate inverted.

  var trapScore = 0;
  var trapSignals = {};  // for diagnostics

  // 1. LSSA vs MOMENTUM DISAGREEMENT
  // If LSSA cycle direction and momentum point opposite ways,
  // one of them is setting up a trap. Score = how strongly they disagree.
  if (hasLssa && Math.abs(momDrift) > 0.001 && Math.abs(lssaDrift) > 0.001) {
    // lssaDrift and momDrift are in pixel-Y: negative = bullish, positive = bearish
    var lssaDir = lssaDrift < 0 ? 1 : -1;  // 1 = bullish, -1 = bearish
    var momDir  = momDrift < 0 ? 1 : -1;
    if (lssaDir !== momDir) {
      // They disagree — strength of disagreement
      var disagreeStr = Math.min(1.0, (Math.abs(lssaDrift) + Math.abs(momDrift)) * 5);
      trapScore += disagreeStr * 0.25;
      trapSignals.lssaVsMom = disagreeStr;
    }
  }

  // 2. VOLUME DIVERGENCE
  // Price making extreme moves but volume declining = weak conviction.
  // Compare last candle's volume to 10-candle average.
  if (count >= 10) {
    var volAvg10 = 0;
    for (var tvi = count - 10; tvi < count; tvi++) {
      volAvg10 += candles[tvi].v;
    }
    volAvg10 /= 10;

    var lastVol = candles[count - 1].v;
    var lastBody = Math.abs(candles[count - 1].c - candles[count - 1].o);

    // Big body + low volume = divergence
    if (volAvg10 > 0 && lastBody > avgRange * 0.5) {
      var volRatioTrap = lastVol / volAvg10;
      if (volRatioTrap < 0.7) {
        // Volume is < 70% of average on a significant candle — suspicious
        var volDivScore = Math.min(1.0, (0.7 - volRatioTrap) * 3);
        trapScore += volDivScore * 0.20;
        trapSignals.volDiv = volDivScore;
      }
    }
  }

  // 3. STREAK EXHAUSTION (already computed earlier)
  // totalExhaustion > 0.8 was the threshold for pullback detection.
  // For traps, anything > 0.5 contributes.
  if (typeof totalExhaustion !== "undefined" && totalExhaustion > 0.5) {
    var exhaustTrap = Math.min(1.0, (totalExhaustion - 0.5) * 2);
    trapScore += exhaustTrap * 0.20;
    trapSignals.exhaustion = exhaustTrap;
  }

  // 4. LIGHT IMBALANCE EXTREMITY
  // |lightBias| > 0.7 = very one-sided light field.
  // Proved across 600+ samples: extreme imbalance → the "obvious"
  // direction is often wrong.
  var absLightBias = Math.abs(lightBias);
  if (absLightBias > 0.5) {
    var lightTrap = Math.min(1.0, (absLightBias - 0.5) * 2);
    trapScore += lightTrap * 0.15;
    trapSignals.lightImbalance = lightTrap;
  }

  // 5. WICK REJECTION on last 1-2 candles
  // A long wick in the trend direction means the market tested that
  // level and got rejected. The "test" is the trap — the real move
  // is the rejection direction.
  if (count >= 2) {
    var trapC = candles[count - 1];
    var trapRange = trapC.h - trapC.l;
    if (trapRange > 0.001) {
      var upperWick = trapC.h - Math.max(trapC.o, trapC.c);
      var lowerWick = Math.min(trapC.o, trapC.c) - trapC.l;
      var bodySize = Math.abs(trapC.c - trapC.o);

      // Upper wick > 2x body in an uptrend context = bull trap wick
      if (upperWick > bodySize * 2 && upperWick > trapRange * 0.4) {
        // Check if we were going up (last 3 candles trending up)
        if (count >= 4 && candles[count - 3].c < candles[count - 1].h) {
          var wickTrap = Math.min(1.0, upperWick / trapRange);
          trapScore += wickTrap * 0.15;
          trapSignals.wickReject = wickTrap;
        }
      }
      // Lower wick > 2x body in a downtrend context = bear trap wick
      if (lowerWick > bodySize * 2 && lowerWick > trapRange * 0.4) {
        if (count >= 4 && candles[count - 3].c > candles[count - 1].l) {
          var wickTrapL = Math.min(1.0, lowerWick / trapRange);
          trapScore += wickTrapL * 0.15;
          trapSignals.wickReject = wickTrapL;
        }
      }
    }
  }

  // 6. SCENARIO SPLIT — how evenly divided are the scenarios?
  // Count bull vs bear scenarios by their +1 price.
  var trapBulls = 0, trapBears = 0;
  for (var tsi = 0; tsi < allPaths.length; tsi++) {
    if (allPaths[tsi].path[0].price > currentPrice) trapBulls++;
    else trapBears++;
  }
  // Perfect split (4/4) = most trap-like. Strong agreement (7/1) = less.
  var splitRatio = Math.min(trapBulls, trapBears) / Math.max(1, allPaths.length);
  // splitRatio 0.5 = perfect split, 0.125 = 7/1 agreement
  if (splitRatio > 0.35) {
    var splitTrap = (splitRatio - 0.35) / 0.15;  // 0.35→0, 0.5→1.0
    if (splitTrap > 1) splitTrap = 1;
    trapScore += splitTrap * 0.10;
    trapSignals.scenarioSplit = splitTrap;
  }

  // Cap trap score at 1.0
  if (trapScore > 1.0) trapScore = 1.0;

  // ---- APPLY TRAP INVERSION ----
  // When trap score is high enough, partially invert the first-step
  // delta. The "normal" prediction says price moves by +delta; the
  // "trap" prediction says it moves by -delta instead.
  //
  // Blend: high trap score → more inversion weight.
  //   trapScore 0.0–0.4: no effect (normal conditions)
  //   trapScore 0.4–0.6: gentle inversion blend (5–15%)
  //   trapScore 0.6–0.8: moderate inversion (15–30%)
  //   trapScore 0.8–1.0: strong inversion (30–40%)
  //
  // Only applied to the first few steps (near-term) where traps
  // play out. Distant steps keep the normal consensus.

  var trapApplied = false;
  var trapInvertPct = 0;

  if (trapScore > 0.4 && consensusPrices.length > 0) {
    trapApplied = true;
    // Map trapScore to inversion percentage: 0.4→0%, 1.0→40%
    trapInvertPct = Math.min(0.40, (trapScore - 0.4) * 0.67);

    // Apply inversion to the first 5 steps, fading with distance
    var trapSteps = Math.min(5, consensusPrices.length);
    for (var tpi = 0; tpi < trapSteps; tpi++) {
      var normalDelta = consensusPrices[tpi] - currentPrice;
      var invertedDelta = -normalDelta;
      // Fade inversion with step: full at step 0, half at step 4
      var trapFade = 1.0 - (tpi / trapSteps) * 0.5;
      var invertBlend = trapInvertPct * trapFade;
      // Blend: (1-blend)*normal + blend*inverted
      var blendedDelta = normalDelta * (1 - invertBlend) + invertedDelta * invertBlend;
      consensusPrices[tpi] = currentPrice + blendedDelta;
    }
  }

  // ---- Weighted direction vote for the +1 candle (#2) ----
  // Each scenario votes: is my +1 price above or below currentPrice?
  // Votes are weighted by scenario accuracy. The majority (by weight) wins.
  var bullVoteWeight = 0;
  var bearVoteWeight = 0;
  var scenarioFirstPrices = [];  // stored for per-scenario scoring later
  var scenarioNames = [];

  for (var vti = 0; vti < allPaths.length; vti++) {
    var firstPrice = allPaths[vti].path[0].price;
    scenarioFirstPrices.push(firstPrice);
    scenarioNames.push(allPaths[vti].name);

    if (firstPrice > currentPrice) {
      bullVoteWeight += scenarioWeights[vti];
    } else {
      bearVoteWeight += scenarioWeights[vti];
    }
  }

  // votedDirection: 1 = bullish, -1 = bearish
  // Used in calibration scoring instead of comparing blended price.
  var votedDirection = bullVoteWeight >= bearVoteWeight ? 1 : -1;
  // How decisive was the vote? 1.0 = unanimous, 0.5 = split
  var voteStrength = Math.max(bullVoteWeight, bearVoteWeight);

  // Store this prediction for future per-distance evaluation.
  // Now includes per-scenario data for individual scoring and
  // the weighted direction vote for more robust direction tracking.
  //
  // Light environment snapshot: captured at prediction time so we can
  // study what the light field looked like when we were right vs wrong.
  // Light environment already captured early (for confidence gate).
  // Reuse it here for storage in pending predictions.

  // Last candle summary: the candle immediately before this prediction.
  // Gives context about what was happening right before we predicted.
  var lastC = candles[count - 1];
  var prevC = count >= 2 ? candles[count - 2] : null;
  var lastCandleInfo = {
    open: lastC.o, high: lastC.h, low: lastC.l, close: lastC.c,
    volume: lastC.v,
    direction: lastC.c > lastC.o ? 1 : -1,           // 1 = bullish, -1 = bearish
    bodyRatio: (lastC.h - lastC.l) > 0.0001           // body size vs total range
      ? Math.abs(lastC.c - lastC.o) / (lastC.h - lastC.l) : 0,
    range: lastC.h - lastC.l,
    // Gap from prior candle (how much did we jump?)
    gap: prevC ? (lastC.o - prevC.c) : 0,
  };

  cal.pendingPredictions.push({
    candleCount: count,
    currentPrice: currentPrice,
    consensusPrices: consensusPrices,
    confident: isConfident,
    confidence: confidence,
    suppressed: isSuppressed,
    // Per-scenario data for individual accuracy tracking (#1)
    scenarioFirstPrices: scenarioFirstPrices,
    scenarioNames: scenarioNames,
    // Weighted direction vote for robust scoring (#2)
    votedDirection: votedDirection,
    voteStrength: voteStrength,
    // Light environment at prediction time (for pattern study)
    lightEnv: predLightEnvEarly,
    // Last candle context
    lastCandle: lastCandleInfo,
    // Volatility regime
    volRatio: effectiveVolRatio,
    volDampen: volDampen,
    // Net light bias and momentum at entry
    lightBias: lightBias,
    // Corridor metrics (terrain model)
    channelWidth: channelWidth,
    channelStrength: channelStrength,
    lightAbove: lightAbove,
    lightBelow: lightBelow,
    // Gravity model metrics
    attractorStrength: attractorStrength,
    peakAboveDist: peakAboveDist,
    peakBelowDist: peakBelowDist,
    // Light-informed force weights
    lightUpWeight: lightUpWeight,
    lightDownWeight: lightDownWeight,
    lightClarity: lightClarity,
    // Trap detection
    trapScore: trapScore,
    trapApplied: trapApplied,
    // Resistance density
    densityAtEntry: densityAtEntry,
    avgDensityNearPrice: avgDensityNearPrice,
    recentMom: recentMom,
    // Layered pipeline per-layer opinions from step 0 (for blame attribution)
    slLayerOpinions: firstStepLayerOpinions,
  });
  // Cap pending predictions
  if (cal.pendingPredictions.length > 50) {
    cal.pendingPredictions = cal.pendingPredictions.slice(-50);
  }


  // ================================================================
  // ENDPOINT HISTOGRAM & TARGETS
  // ================================================================

  var yBins = Math.ceil(chartH);
  var endHist = new Float32Array(yBins);
  var endMax = 0;
  var sampleStart = Math.floor(projSlots * 0.8);

  for (var pi = 0; pi < allPaths.length; pi++) {
    var p = allPaths[pi].path;
    for (var si2 = sampleStart; si2 < p.length; si2++) {
      var bin = Math.round(p[si2].y - chartTop);
      var spread2 = 5;
      for (var b2 = -spread2; b2 <= spread2; b2++) {
        var idx2 = bin + b2;
        if (idx2 >= 0 && idx2 < yBins) {
          var f = 1.0 - Math.abs(b2) / (spread2 + 1);
          endHist[idx2] += f;
          if (endHist[idx2] > endMax) endMax = endHist[idx2];
        }
      }
    }
  }

  var targets = [];
  for (var y = 3; y < yBins - 3; y++) {
    var v = endHist[y];
    if (v < endMax * 0.2) continue;
    if (v > endHist[y-1] && v > endHist[y+1] && v > endHist[y-2] && v > endHist[y+2]) {
      var price2 = priceMax - (y / yBins) * (priceMax - priceMin);
      targets.push({ y: y, price: price2, strength: v / endMax });
    }
  }
  targets.sort(function(a, b) { return b.strength - a.strength; });
  targets = targets.slice(0, 5);

  // Bias: weighted vote for overall direction (#2)
  // Uses scenario weights instead of simple majority counting.
  var wBullSum = 0, wBearSum = 0;
  for (var bi = 0; bi < allPaths.length; bi++) {
    var endP = allPaths[bi].path[allPaths[bi].path.length - 1].price;
    if (endP > currentPrice) wBullSum += scenarioWeights[bi];
    else wBearSum += scenarioWeights[bi];
  }
  var biasDir = wBullSum > wBearSum ? "bullish" : wBearSum > wBullSum ? "bearish" : "neutral";
  var biasConf = Math.round(Math.max(wBullSum, wBearSum) * 100);

  return {
    allPaths: allPaths,
    projSlots: projSlots,
    yBins: yBins,
    candleW: candleW,
    currentPrice: currentPrice,
    currentPriceY: currentPriceY,
    endHist: endHist,
    endMax: endMax,
    targets: targets,
    biasDir: biasDir,
    biasConf: biasConf,
    calSamples: cal.totalSamples,
    accuracy: accuracy,
    // Per-distance direction accuracy for coloring the consensus line.
    distAcc: cal.dirCorrect,
    distSamples: cal.sampleCount,
    volRatio: effectiveVolRatio,
    volDampen: volDampen,
    confidence: confidence,
    isConfident: isConfident,
    accuracyHistory: cal.accuracyHistory,
    virtualCandles: virtualCandles,
    // New: per-scenario weights and vote data for diagnostics
    scenarioWeights: scenarioWeights,
    scenarioNames: scenarioNames,
    votedDirection: votedDirection,
    voteStrength: voteStrength,
    lightStudyCount: cal.lightStudy.length,
    // Trap detection
    trapScore: trapScore,
    trapApplied: trapApplied,
    trapInvertPct: trapInvertPct,
    trapSignals: trapSignals,
    // Resistance density
    densityAtEntry: densityAtEntry,
    avgDensityNearPrice: avgDensityNearPrice,
    isSuppressed: isSuppressed,
    qScores: qScores,
    // Light-informed force weighting diagnostics
    lightWeights: {
      upWeight: lightUpWeight,
      downWeight: lightDownWeight,
      clarity: lightClarity,
      gravity: entryGravity,
    },
    // Topology data (for contour overlay rendering and diagnostics)
    topology: topo,
    topoWeights: topoForceWeights,
    // Indicator calibration (for diagnostics display)
    indicatorProfile: indCalib,
    // Neural net diagnostics (brain.js direction classifier)
    // When the layered pipeline is active, these reflect its stats.
    // The old neuralReady/neuralStats names are kept for backward compat
    // with rendering code. slStats has the full 6-layer breakdown.
    neuralReady: slReady || neuralNetReady,
    neuralStats: neuralNetStats,
    slReady: slReady,
    slStats: typeof slStats !== "undefined" ? slStats : null,
    // Regime detection diagnostics
    entryRegime: entryRegime,
    regimeDiag: typeof getRegimeDiagnostics === "function"
      ? getRegimeDiagnostics(entryRegime, scenarioWeights, runningRegimes) : null,
    avgStreakLen: avgStreakLen,
    realLightBaseline: realLightBaseline,
    projMaValues: projMaValues,
    projRsiValues: projRsiValues,
    // Corridor pathfinding data (for visualization overlay)
    corridorData: corridorData,
  };
}


// ================================================================
// renderProjection  —  draw paths, histogram, labels
// ================================================================

function renderProjection(projData, dims, projDims, priceMin, priceMax) {
  if (!projData || !projDims || projDims.projWidth < 5) return;
  ctx.save();

  var projLeft  = projDims.projLeft;
  var projRight = projDims.projLeft + projDims.projWidth;
  var chartTop  = dims.chartTop;
  var chartH    = dims.chartHeight;
  var slots     = projData.projSlots;
  var yBins     = projData.yBins;
  var candleW   = projData.candleW;

  // ---- Dark background ----
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(projLeft, chartTop, projDims.projWidth, chartH);

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(projLeft, chartTop);
  ctx.lineTo(projLeft, chartTop + chartH);
  ctx.stroke();
  ctx.setLineDash([]);

  // ---- Virtual predicted candles ----
  // Drawn as semi-transparent candlesticks so you can see the
  // predicted price action and where light is being emitted from.
  if (projData.virtualCandles && projData.virtualCandles.length > 0) {
    var vcArr = projData.virtualCandles;
    var vcBodyW = Math.max(1, candleW * 0.5);

    for (var vci = 0; vci < vcArr.length; vci++) {
      var vc = vcArr[vci];
      var vcIsUp = vc.c >= vc.o;
      // Fade further predictions more
      var vcAlpha = 0.35 - (vci / vcArr.length) * 0.2;
      if (vcAlpha < 0.08) vcAlpha = 0.08;

      var vcColor = vcIsUp ? "rgba(0,192,135," + vcAlpha.toFixed(3) + ")"
                           : "rgba(255,71,87," + vcAlpha.toFixed(3) + ")";

      // Wick
      ctx.strokeStyle = vcColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vc.x, vc.hY);
      ctx.lineTo(vc.x, vc.lY);
      ctx.stroke();

      // Body
      ctx.fillStyle = vcColor;
      var bodyTop = Math.min(vc.oY, vc.cY);
      var bodyBot = Math.max(vc.oY, vc.cY);
      var bodyH = Math.max(1, bodyBot - bodyTop);
      ctx.fillRect(vc.x - vcBodyW / 2, bodyTop, vcBodyW, bodyH);
    }
  }

  // ---- Current price dashed line ----
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(projLeft, projData.currentPriceY);
  ctx.lineTo(projRight, projData.currentPriceY);
  ctx.stroke();
  ctx.setLineDash([]);

  // ---- Draw all predicted paths ----
  var colorMap = {
    bull: { r: 0, g: 210, b: 130 },
    bear: { r: 255, g: 130, b: 60 },
    neut: { r: 160, g: 170, b: 210 },
  };

  for (var pi = 0; pi < projData.allPaths.length; pi++) {
    var ap = projData.allPaths[pi];
    var path = ap.path;
    var c = colorMap[ap.color];
    if (path.length < 2) continue;

    ctx.strokeStyle = "rgba(" + c.r + "," + c.g + "," + c.b + ",0.25)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(projLeft, projData.currentPriceY);
    for (var si = 0; si < path.length; si++) {
      ctx.lineTo(path[si].x, path[si].y);
    }
    ctx.stroke();
  }

  // ---- Consensus path (average of all) ----
  var consensus = [];
  for (var step = 0; step < slots; step++) {
    var sumY = 0;
    for (var ci = 0; ci < projData.allPaths.length; ci++) {
      sumY += projData.allPaths[ci].path[step].y;
    }
    var avgY = sumY / projData.allPaths.length;
    var avgPrice = priceMax - ((avgY - chartTop) / chartH) * (priceMax - priceMin);
    consensus.push({ x: projLeft + (step + 0.5) * candleW, y: avgY, price: avgPrice, slot: step + 1 });
  }

  // Glow (soft white behind the line)
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(projLeft, projData.currentPriceY);
  for (var ci2 = 0; ci2 < consensus.length; ci2++) ctx.lineTo(consensus[ci2].x, consensus[ci2].y);
  ctx.stroke();

  // Accuracy-colored consensus line.
  // Each segment is colored by how accurate we are at that distance:
  //   Green (bright) = high accuracy at this distance → trust this part
  //   Yellow = moderate accuracy → use with caution
  //   Red (dim) = low accuracy → unreliable
  //   Gray = no calibration data yet → unknown
  // Line also gets thinner with lower accuracy.
  var distAcc = projData.distAcc;
  var distSamples = projData.distSamples;
  var prevX = projLeft;
  var prevY = projData.currentPriceY;

  for (var ci3 = 0; ci3 < consensus.length; ci3++) {
    var dist = ci3 + 1;  // 1-indexed distance
    var acc2 = (distAcc && dist < distAcc.length && distSamples[dist] > 2)
      ? distAcc[dist]  // 0..1 direction accuracy
      : -1;            // no data

    // Color ramp: accuracy → color
    var segR, segG, segB, segA, segW;
    if (acc2 < 0) {
      // No data: white/gray, moderate width
      segR = 180; segG = 190; segB = 210; segA = 0.5; segW = 2.0;
    } else if (acc2 >= 0.65) {
      // Good: bright green
      var gn = (acc2 - 0.65) / 0.35;  // 0..1 within green range
      segR = 0; segG = Math.round(180 + gn * 75); segB = Math.round(100 + gn * 50);
      segA = 0.6 + gn * 0.35;
      segW = 2.0 + gn * 1.5;
    } else if (acc2 >= 0.50) {
      // Moderate: yellow/amber
      var yn = (acc2 - 0.50) / 0.15;  // 0..1 within yellow range
      segR = 240; segG = Math.round(160 + yn * 60); segB = 40;
      segA = 0.4 + yn * 0.2;
      segW = 1.5 + yn * 0.5;
    } else {
      // Poor: red/dim
      var rn = acc2 / 0.50;  // 0..1 within red range
      segR = 220; segG = Math.round(60 * rn); segB = 50;
      segA = 0.2 + rn * 0.2;
      segW = 1.0 + rn * 0.5;
    }

    ctx.strokeStyle = "rgba(" + segR + "," + segG + "," + segB + "," + segA.toFixed(2) + ")";
    ctx.lineWidth = segW;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(consensus[ci3].x, consensus[ci3].y);
    ctx.stroke();

    prevX = consensus[ci3].x;
    prevY = consensus[ci3].y;
  }

  // Label consensus points (with accuracy % shown)
  if (state.showProjInfo) {
  var labelIdxs = [0, Math.floor(consensus.length / 2), consensus.length - 1];
  var cpInvS = 1 / state.viewScale;
  for (var li = 0; li < labelIdxs.length; li++) {
    var idx = labelIdxs[li];
    if (idx >= consensus.length) continue;
    var pt = consensus[idx];
    var ptDist = idx + 1;
    var ptAcc = (distAcc && ptDist < distAcc.length && distSamples[ptDist] > 2)
      ? distAcc[ptDist] : -1;

    // Price label
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "bold " + Math.round(9 * cpInvS) + "px monospace";
    ctx.textAlign = "center";
    ctx.fillText(pt.price.toFixed(2), pt.x, pt.y - 8 * cpInvS);

    // Distance + accuracy label
    var accLabel = ptAcc >= 0 ? " " + (ptAcc * 100).toFixed(0) + "%" : "";
    ctx.fillStyle = ptAcc >= 0.65 ? "rgba(0,220,140,0.6)" :
                    ptAcc >= 0.50 ? "rgba(240,200,40,0.5)" :
                    ptAcc >= 0    ? "rgba(220,80,50,0.5)" :
                    "rgba(255,255,255,0.3)";
    ctx.font = Math.round(8 * cpInvS) + "px monospace";
    ctx.fillText("+" + pt.slot + accLabel, pt.x, pt.y - 18 * cpInvS);

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  } // end showProjInfo — consensus labels

  // ---- Endpoint histogram on the right edge ----
  var histW = Math.min(40, projDims.projWidth * 0.3);
  if (projData.endMax > 0) {
    for (var hy = 0; hy < yBins; hy++) {
      var hv = projData.endHist[hy];
      if (hv < 0.1) continue;
      var norm = hv / projData.endMax;
      var barW = norm * histW;
      var alpha = 0.1 + norm * 0.4;
      ctx.fillStyle = "rgba(180,200,255," + alpha.toFixed(3) + ")";
      ctx.fillRect(projRight - barW - 2, chartTop + hy, barW, 1);
    }
  }

  // ---- Target diamonds at histogram peaks ----
  var tdInvS = 1 / state.viewScale;
  for (var ti = 0; ti < projData.targets.length; ti++) {
    var tgt = projData.targets[ti];
    var ty = chartTop + tgt.y;
    var confPct = Math.round(tgt.strength * 100);

    var dx = projRight - histW - 12;
    ctx.fillStyle = "rgba(255,255,255," + (0.4 + tgt.strength * 0.5).toFixed(2) + ")";
    ctx.beginPath();
    ctx.moveTo(dx, ty - 4);
    ctx.lineTo(dx + 4, ty);
    ctx.lineTo(dx, ty + 4);
    ctx.lineTo(dx - 4, ty);
    ctx.closePath();
    ctx.fill();

    if (state.showProjInfo) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = "bold " + Math.round(9 * tdInvS) + "px monospace";
      ctx.textAlign = "right";
      ctx.fillText(tgt.price.toFixed(2) + " " + confPct + "%", dx - 6, ty + 3 * tdInvS);
    }

    ctx.strokeStyle = "rgba(255,255,255," + (0.06 + tgt.strength * 0.12).toFixed(3) + ")";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(projLeft, ty);
    ctx.lineTo(projRight - histW - 2, ty);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- PROJECTION ZONE TEXT OVERLAY ----
  // Controlled by state.showProjInfo — toggle hides ALL text labels
  // (header, direction, target, confidence, accuracy sparkline, stats)
  // while keeping the visual elements (lines, candles, histogram, diamonds).
  if (state.showProjInfo) {

  var invS = 1 / state.viewScale;
  var midX = projLeft + projDims.projWidth / 2;

  // Visible viewport edges in world coordinates
  var screenW = dims.screenW || dims.width;
  var screenH = dims.screenH || dims.height;
  var visTop  = (-state.viewOffsetY / state.viewScale) + 10 * invS;
  var visBot  = ((screenH - state.viewOffsetY) / state.viewScale) - 10 * invS;

  // Clamp midX to stay within the visible horizontal range too,
  // so labels don't disappear when the projection zone is partially off-screen
  var visLeft  = -state.viewOffsetX / state.viewScale;
  var visRight = (screenW - state.viewOffsetX) / state.viewScale;
  var labelX = midX;
  if (labelX < visLeft + 40 * invS) labelX = visLeft + 40 * invS;
  if (labelX > visRight - 40 * invS) labelX = visRight - 40 * invS;

  // ---- Header ----
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = Math.round(9 * invS) + "px monospace";
  ctx.textAlign = "center";
  ctx.fillText("PROJECTION (+" + slots + " candles)", labelX, visTop + 12 * invS);

  // ---- Direction + confidence ----
  {
    var biasLabel = projData.biasDir === "bullish" ? "▲ BULLISH" :
                    projData.biasDir === "bearish" ? "▼ BEARISH" : "◆ NEUTRAL";
    var biasCol = projData.biasDir === "bullish" ? "rgba(0,220,130,0.8)" :
                  projData.biasDir === "bearish" ? "rgba(255,130,60,0.8)" :
                  "rgba(180,180,200,0.7)";

    ctx.fillStyle = biasCol;
    ctx.font = "bold " + Math.round(12 * invS) + "px monospace";
    ctx.fillText(biasLabel + " (" + projData.biasConf + "%)", labelX, visTop + 28 * invS);

    // ---- Target price ----
    if (consensus.length > 0) {
      var finalP = consensus[consensus.length - 1].price;
      var change = finalP - projData.currentPrice;
      var changePct = ((change / projData.currentPrice) * 100).toFixed(2);
      var changeStr = (change >= 0 ? "+" : "") + changePct + "%";

      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = Math.round(9 * invS) + "px monospace";
      ctx.fillText("Target: " + finalP.toFixed(2) + " (" + changeStr + ")", labelX, visTop + 42 * invS);
    }

    // ---- Confidence level ----
    if (projData.isConfident) {
      ctx.fillStyle = "rgba(0,220,130,0.5)";
      ctx.font = Math.round(8 * invS) + "px monospace";
      ctx.fillText("confident (" + (projData.confidence * 100).toFixed(0) + "%)", labelX, visTop + 54 * invS);
    } else {
      ctx.fillStyle = "rgba(255,200,80,0.4)";
      ctx.font = Math.round(8 * invS) + "px monospace";
      ctx.fillText("hedging (" + (projData.confidence * 100).toFixed(0) + "%)", labelX, visTop + 54 * invS);
    }

    // ---- Volatility warning (only when dampening is significant) ----
    if (projData.volRatio > 1.8) {
      ctx.fillStyle = projData.volRatio > 2.5
        ? "rgba(255,70,60,0.6)" : "rgba(255,180,40,0.5)";
      ctx.font = Math.round(8 * invS) + "px monospace";
      ctx.fillText("high volatility (" + projData.volRatio.toFixed(1) + "x)", labelX, visTop + 66 * invS);
    }
  }

  // ---- Accuracy sparkline chart ----
  // Anchored below the header block at the top of the projection zone
  // so it's always clearly visible (previously at the bottom where it
  // was often obscured by other overlays).
  var accHist = projData.accuracyHistory;

  // Vertical start for accuracy section: below the last header item.
  // Volatility warning (when shown) ends at ~visTop + 66*invS;
  // add a gap so the sparkline sits comfortably below it.
  var accSectionTop = visTop + 78 * invS;

  if (accHist && accHist.length >= 3) {
    var chartW2 = Math.min(projDims.projWidth - 20, 250);
    var chartH2 = 40;
    var chartX2 = projLeft + (projDims.projWidth - chartW2) / 2;
    var chartY2 = accSectionTop + 12 * invS;  // gap for title text above

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(chartX2 - 2, chartY2 - 2, chartW2 + 4, chartH2 + 4);

    // 50% baseline (coin flip)
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    var baselineY = chartY2 + chartH2 * 0.5;
    ctx.moveTo(chartX2, baselineY);
    ctx.lineTo(chartX2 + chartW2, baselineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 50% label
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.font = Math.round(7 * invS) + "px monospace";
    ctx.textAlign = "left";
    ctx.fillText("50%", chartX2 + 2, baselineY - 2 * invS);

    // Total average reference line
    var accForChart = projData.accuracy;
    if (accForChart) {
      var runAvgY = chartY2 + chartH2 - (accForChart.runDirRate / 100) * chartH2;
      var ravgColor;
      if (accForChart.runDirRate >= 65) ravgColor = "rgba(0,220,130,";
      else if (accForChart.runDirRate >= 50) ravgColor = "rgba(240,200,40,";
      else ravgColor = "rgba(255,80,60,";

      ctx.strokeStyle = ravgColor + "0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(chartX2, runAvgY);
      ctx.lineTo(chartX2 + chartW2, runAvgY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = ravgColor + "0.6)";
      ctx.font = "bold " + Math.round(7 * invS) + "px monospace";
      ctx.textAlign = "right";
      ctx.fillText("AVG " + accForChart.runDirRate.toFixed(0) + "%", chartX2 + chartW2 - 2, runAvgY - 2 * invS);
    }

    var hLen = accHist.length;
    var pointSpacing = chartW2 / Math.max(1, hLen - 1);

    // Hit/miss dots
    for (var di = 0; di < hLen; di++) {
      var dx = chartX2 + di * pointSpacing;
      var dotColor = accHist[di].raw > 0.5
        ? "rgba(0,220,130,0.5)" : "rgba(255,70,60,0.35)";
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      var dotY = accHist[di].raw > 0.5 ? chartY2 + 3 : chartY2 + chartH2 - 3;
      ctx.arc(dx, dotY, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rolling direction accuracy line
    ctx.beginPath();
    ctx.strokeStyle = "rgba(100,220,180,0.5)";
    ctx.lineWidth = 1.5;
    for (var si2 = 0; si2 < hLen; si2++) {
      var sx = chartX2 + si2 * pointSpacing;
      var sy = chartY2 + chartH2 - (accHist[si2].dirRate / 100) * chartH2;
      if (si2 === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Latest value label
    var lastSnap = accHist[hLen - 1];
    var lastDirY = chartY2 + chartH2 - (lastSnap.dirRate / 100) * chartH2;
    ctx.fillStyle = "rgba(100,220,180,0.7)";
    ctx.font = "bold " + Math.round(7 * invS) + "px monospace";
    ctx.textAlign = "right";
    ctx.fillText(lastSnap.dirRate.toFixed(0) + "%", chartX2 + chartW2 + 1, lastDirY + 3 * invS);

    // Chart title
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.font = Math.round(7 * invS) + "px monospace";
    ctx.textAlign = "center";
    ctx.fillText("direction accuracy — " + hLen + " predictions",
                 chartX2 + chartW2 / 2, chartY2 - 5 * invS);

    // Move accSectionTop past the chart for stats below
    accSectionTop = chartY2 + chartH2 + 6 * invS;
  }

  // ---- Simple accuracy stats (below sparkline, or below header if no sparkline) ----
  var acc = projData.accuracy;
  if (acc) {
    var accY = accSectionTop + 10 * invS;

    var fc = acc.firstCandleDirRate;
    var fcColor;
    if (fc >= 65) fcColor = "rgba(0,220,130,0.8)";
    else if (fc >= 50) fcColor = "rgba(240,200,40,0.8)";
    else fcColor = "rgba(255,80,60,0.8)";

    ctx.font = "bold " + Math.round(9 * invS) + "px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = fcColor;
    ctx.fillText("Last 10: " + fc.toFixed(0) + "%", labelX - 40 * invS, accY);

    var totalColor;
    if (acc.runDirRate >= 65) totalColor = "rgba(0,220,130,0.6)";
    else if (acc.runDirRate >= 50) totalColor = "rgba(240,200,40,0.6)";
    else totalColor = "rgba(255,80,60,0.6)";

    ctx.font = Math.round(8 * invS) + "px monospace";
    ctx.fillStyle = totalColor;
    ctx.fillText("Total: " + acc.runDirRate.toFixed(0) + "% (" + acc.firstCandleTotal + " samples)", labelX + 60 * invS, accY);
  } else {
    var calLabel = projData.calSamples > 0
      ? projData.allPaths.length + " paths — " + projData.calSamples + " verified"
      : projData.allPaths.length + " paths — use Play to calibrate";
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.font = Math.round(8 * invS) + "px monospace";
    ctx.textAlign = "center";
    ctx.fillText(calLabel, labelX, visBot - 6 * invS);
  }

  } // end showProjInfo — text overlay

  // ---- PROJECTED MA LINE (continuation into prediction zone) ----
  // Same orange/gold dashed style as the real chart's MA overlay.
  // Shows where the running MA goes as it digests predicted prices,
  // so you can visually verify the MA spring is behaving sensibly.
  if (projData.projMaValues && projData.projMaValues.length > 1 && state.predMA) {
    ctx.strokeStyle = "rgba(240,160,48,0.6)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    for (var pmi = 0; pmi < projData.projMaValues.length; pmi++) {
      var pmv = projData.projMaValues[pmi];
      var pmY = priceToY(pmv.price, priceMin, priceMax, chartTop, chartH);
      if (pmi === 0) ctx.moveTo(pmv.x, pmY);
      else ctx.lineTo(pmv.x, pmY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- PROJECTED RSI LINE (continuation into prediction zone) ----
  // Same purple style as the real chart's RSI overlay.
  // RSI 0..100 mapped to chart height (0=bottom, 100=top).
  if (projData.projRsiValues && projData.projRsiValues.length > 1 && state.predRSI) {
    ctx.strokeStyle = "rgba(192,96,240,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var pri = 0; pri < projData.projRsiValues.length; pri++) {
      var prv = projData.projRsiValues[pri];
      // Map RSI 0..100 to chartTop+chartH..chartTop (same as drawing.js)
      var prY = chartTop + chartH * (1 - prv.value / 100);
      if (pri === 0) ctx.moveTo(prv.x, prY);
      else ctx.lineTo(prv.x, prY);
    }
    ctx.stroke();
  }

  ctx.restore();
}


// ================================================================
// LIGHT STUDY: Console Inspection Helpers
// ================================================================
// Call these from the browser console to examine collected data.
//
//   dumpLightStudy()        — print all records as a table
//   dumpLightStudy("wrong") — only incorrect predictions
//   dumpLightStudy("right") — only correct predictions
//   lightStudyJSON()        — get raw JSON for export
//   lightStudySummary()     — quick stats overview

function dumpLightStudy(filter, asset) {
  var ak = asset || state.asset;
  var cal = calibration[ak];
  if (!cal || !cal.lightStudy || cal.lightStudy.length === 0) {
    console.log("No light study data for " + ak + ". Run animation with Calibrate on.");
    return;
  }

  var records = cal.lightStudy;
  if (filter === "wrong") records = records.filter(function(r) { return !r.correct; });
  if (filter === "right") records = records.filter(function(r) { return r.correct; });

  // Format for console.table
  var rows = [];
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var le = r.lightEnv || {};
    rows.push({
      tick:       r.tick,
      conf:       (r.confidence * 100).toFixed(0) + "%",
      correct:    r.correct ? "YES" : "NO",
      predDir:    r.predDirection > 0 ? "BULL" : "BEAR",
      actDir:     r.actDirection > 0 ? "BULL" : "BEAR",
      predMove:   r.predMovePct.toFixed(3) + "%",
      actMove:    r.actMovePct.toFixed(3) + "%",
      voteStr:    (r.voteStrength * 100).toFixed(0) + "%",
      green:      le.green  ? le.green.toFixed(1)  : "0",
      yellow:     le.yellow ? le.yellow.toFixed(1) : "0",
      blue:       le.blue   ? le.blue.toFixed(1)   : "0",
      red:        le.red    ? le.red.toFixed(1)    : "0",
      netForce:   le.netForce ? le.netForce.toFixed(2) : "0",
      balance:    le.balance  ? le.balance.toFixed(2)  : "0",
      dominant:   le.dominantColor || "none",
      totalLight: le.totalLight ? le.totalLight.toFixed(1) : "0",
      volRatio:   r.volRatio ? r.volRatio.toFixed(2) : "1",
      lastDir:    r.lastCandle ? (r.lastCandle.direction > 0 ? "BULL" : "BEAR") : "-",
      lastBody:   r.lastCandle ? r.lastCandle.bodyRatio.toFixed(2) : "-",
      priorOk:    r.priorCorrect === null ? "-" : (r.priorCorrect ? "YES" : "NO"),
    });
  }

  console.log("Light Study: " + records.length + " records"
    + (filter ? " (filter: " + filter + ")" : "") + " for " + ak);
  console.table(rows);
  return rows;
}

function lightStudyJSON(asset) {
  var ak = asset || state.asset;
  var cal = calibration[ak];
  if (!cal || !cal.lightStudy) return "[]";
  return JSON.stringify(cal.lightStudy, null, 2);
}

function lightStudySummary(asset) {
  var ak = asset || state.asset;
  var cal = calibration[ak];
  if (!cal || !cal.lightStudy || cal.lightStudy.length === 0) {
    console.log("No light study data for " + ak);
    return;
  }

  var records = cal.lightStudy;
  var total = records.length;
  var correct = 0;
  var wrong = 0;

  // Aggregate light environment stats for correct vs wrong
  var rightEnv = { green: 0, yellow: 0, blue: 0, red: 0, netForce: 0, balance: 0, count: 0 };
  var wrongEnv = { green: 0, yellow: 0, blue: 0, red: 0, netForce: 0, balance: 0, count: 0 };
  // Track dominant color distribution
  var rightDominant = {};
  var wrongDominant = {};
  // Track sequences: wrong after right, wrong after wrong, etc.
  var wrongAfterRight = 0;
  var wrongAfterWrong = 0;
  var rightAfterWrong = 0;
  var rightAfterRight = 0;

  // ---- BINNED ANALYSIS ----
  // Balance bins: 10 bins from 0.0 to 1.0 (absolute balance)
  var balBins = [];
  for (var bb = 0; bb < 10; bb++) {
    balBins.push({ lo: bb * 0.1, hi: (bb + 1) * 0.1, right: 0, wrong: 0 });
  }

  // Force ratio bins: |netForce| / totalLight
  // 5 bins from 0.0 to 1.0
  var forceBins = [];
  for (var fb = 0; fb < 5; fb++) {
    forceBins.push({ lo: fb * 0.2, hi: (fb + 1) * 0.2, right: 0, wrong: 0 });
  }

  // Total light bins: split into low/med/high based on data range
  var totalLights = [];

  // Dominant color accuracy breakdown
  var colorAcc = { green: { right: 0, wrong: 0 }, yellow: { right: 0, wrong: 0 },
                   blue: { right: 0, wrong: 0 }, red: { right: 0, wrong: 0 },
                   none: { right: 0, wrong: 0 } };

  // Balance SIGN matters: does the light correctly predict direction?
  // Positive balance = more resist above = should push DOWN = bearish
  // Negative balance = more support below = should push UP = bullish
  // "Light agrees" = balance sign matches the predicted direction
  var lightAgreeRight = 0;
  var lightAgreeWrong = 0;
  var lightDisagreeRight = 0;
  var lightDisagreeWrong = 0;

  for (var i = 0; i < total; i++) {
    var r = records[i];
    var le = r.lightEnv || {};
    var bucket = r.correct ? rightEnv : wrongEnv;
    var domMap = r.correct ? rightDominant : wrongDominant;

    if (r.correct) correct++;
    else wrong++;

    bucket.green    += le.green || 0;
    bucket.yellow   += le.yellow || 0;
    bucket.blue     += le.blue || 0;
    bucket.red      += le.red || 0;
    bucket.netForce += le.netForce || 0;
    bucket.balance  += le.balance || 0;
    bucket.count++;

    var dom = le.dominantColor || "none";
    domMap[dom] = (domMap[dom] || 0) + 1;

    // Color accuracy
    if (colorAcc[dom]) {
      if (r.correct) colorAcc[dom].right++;
      else colorAcc[dom].wrong++;
    }

    // Balance bin
    var absBal = Math.abs(le.balance || 0);
    var balIdx = Math.min(9, Math.floor(absBal * 10));
    if (r.correct) balBins[balIdx].right++;
    else balBins[balIdx].wrong++;

    // Force ratio bin
    var tl = le.totalLight || 0;
    var fr = tl > 1 ? Math.abs(le.netForce || 0) / tl : 0;
    var forceIdx = Math.min(4, Math.floor(fr * 5));
    if (r.correct) forceBins[forceIdx].right++;
    else forceBins[forceIdx].wrong++;

    // Total light values for percentile binning
    totalLights.push({ tl: tl, correct: r.correct });

    // Light direction agreement
    // balance > 0 means more resistance above → bearish bias
    // predDirection: 1 = bull, -1 = bear
    var lightSaysBear = (le.balance || 0) > 0;
    var predBear = r.predDirection < 0;
    var agrees = (lightSaysBear === predBear);
    if (agrees) {
      if (r.correct) lightAgreeRight++;
      else lightAgreeWrong++;
    } else {
      if (r.correct) lightDisagreeRight++;
      else lightDisagreeWrong++;
    }

    // Sequence tracking
    if (r.priorCorrect !== null) {
      if (r.correct && r.priorCorrect)   rightAfterRight++;
      if (r.correct && !r.priorCorrect)  rightAfterWrong++;
      if (!r.correct && r.priorCorrect)  wrongAfterRight++;
      if (!r.correct && !r.priorCorrect) wrongAfterWrong++;
    }
  }

  // Average the buckets
  function avg(bucket) {
    if (bucket.count === 0) return bucket;
    return {
      green:    (bucket.green / bucket.count).toFixed(1),
      yellow:   (bucket.yellow / bucket.count).toFixed(1),
      blue:     (bucket.blue / bucket.count).toFixed(1),
      red:      (bucket.red / bucket.count).toFixed(1),
      netForce: (bucket.netForce / bucket.count).toFixed(2),
      balance:  (bucket.balance / bucket.count).toFixed(2),
      count:    bucket.count,
    };
  }

  console.log("=== LIGHT STUDY SUMMARY: " + ak + " ===");
  console.log("Total: " + total + " | Correct: " + correct
    + " (" + (correct / total * 100).toFixed(1) + "%)"
    + " | Wrong: " + wrong
    + " (" + (wrong / total * 100).toFixed(1) + "%)");
  console.log("");
  console.log("Avg light environment when CORRECT:");
  console.table([avg(rightEnv)]);
  console.log("Dominant colors when correct:", rightDominant);
  console.log("");
  console.log("Avg light environment when WRONG:");
  console.table([avg(wrongEnv)]);
  console.log("Dominant colors when wrong:", wrongDominant);

  // ---- BINNED ACCURACY: BALANCE ----
  // This is the key table. Where does accuracy cross 50%? 60%? 70%?
  console.log("");
  console.log("=== ACCURACY BY BALANCE BIN (|balance|) ===");
  console.log("Find the threshold where the light field becomes predictive.");
  var balRows = [];
  for (var bi2 = 0; bi2 < balBins.length; bi2++) {
    var bbin = balBins[bi2];
    var bTotal = bbin.right + bbin.wrong;
    if (bTotal === 0) continue;
    var bRate = (bbin.right / bTotal * 100);
    var bar = "";
    for (var bx = 0; bx < Math.round(bRate / 5); bx++) bar += "█";
    balRows.push({
      range: bbin.lo.toFixed(1) + "-" + bbin.hi.toFixed(1),
      right: bbin.right,
      wrong: bbin.wrong,
      total: bTotal,
      accuracy: bRate.toFixed(1) + "%",
      chart: bar,
    });
  }
  console.table(balRows);

  // ---- BINNED ACCURACY: FORCE RATIO ----
  console.log("");
  console.log("=== ACCURACY BY FORCE RATIO (|netForce|/totalLight) ===");
  console.log("Higher = light field agrees on direction. Lower = cancels out.");
  var forceRows = [];
  for (var fi = 0; fi < forceBins.length; fi++) {
    var fbin = forceBins[fi];
    var fTotal = fbin.right + fbin.wrong;
    if (fTotal === 0) continue;
    var fRate = (fbin.right / fTotal * 100);
    var fbar = "";
    for (var fx = 0; fx < Math.round(fRate / 5); fx++) fbar += "█";
    forceRows.push({
      range: fbin.lo.toFixed(1) + "-" + fbin.hi.toFixed(1),
      right: fbin.right,
      wrong: fbin.wrong,
      total: fTotal,
      accuracy: fRate.toFixed(1) + "%",
      chart: fbar,
    });
  }
  console.table(forceRows);

  // ---- ACCURACY BY DOMINANT COLOR ----
  console.log("");
  console.log("=== ACCURACY BY DOMINANT COLOR ===");
  var colorRows = [];
  var colorNames = ["green", "yellow", "blue", "red", "none"];
  for (var ci = 0; ci < colorNames.length; ci++) {
    var cn = colorNames[ci];
    var cc = colorAcc[cn];
    var cTotal = cc.right + cc.wrong;
    if (cTotal === 0) continue;
    colorRows.push({
      color: cn,
      right: cc.right,
      wrong: cc.wrong,
      total: cTotal,
      accuracy: (cc.right / cTotal * 100).toFixed(1) + "%",
    });
  }
  console.table(colorRows);

  // ---- LIGHT DIRECTION AGREEMENT ----
  // Does the balance sign correctly predict the eventual direction?
  console.log("");
  console.log("=== LIGHT DIRECTION AGREEMENT ===");
  console.log("'Agrees' = balance sign matches predicted direction.");
  console.log("If agree+right >> disagree+right, the light field has directional signal.");
  var agreeTotal = lightAgreeRight + lightAgreeWrong;
  var disagreeTotal = lightDisagreeRight + lightDisagreeWrong;
  console.table([
    { group: "Light AGREES w/ prediction",
      right: lightAgreeRight, wrong: lightAgreeWrong, total: agreeTotal,
      accuracy: agreeTotal > 0 ? (lightAgreeRight / agreeTotal * 100).toFixed(1) + "%" : "n/a" },
    { group: "Light DISAGREES w/ prediction",
      right: lightDisagreeRight, wrong: lightDisagreeWrong, total: disagreeTotal,
      accuracy: disagreeTotal > 0 ? (lightDisagreeRight / disagreeTotal * 100).toFixed(1) + "%" : "n/a" },
  ]);

  // ---- TOTAL LIGHT ANALYSIS ----
  // Sort by total light and split into thirds
  console.log("");
  console.log("=== ACCURACY BY TOTAL LIGHT (low/med/high thirds) ===");
  totalLights.sort(function(a, b) { return a.tl - b.tl; });
  var third = Math.ceil(totalLights.length / 3);
  var lightTercs = [
    { label: "Low", start: 0, end: third },
    { label: "Med", start: third, end: third * 2 },
    { label: "High", start: third * 2, end: totalLights.length },
  ];
  var tlRows = [];
  for (var ti = 0; ti < lightTercs.length; ti++) {
    var t = lightTercs[ti];
    var tRight = 0, tWrong = 0, tMinTL = Infinity, tMaxTL = 0;
    for (var tj = t.start; tj < Math.min(t.end, totalLights.length); tj++) {
      if (totalLights[tj].correct) tRight++;
      else tWrong++;
      if (totalLights[tj].tl < tMinTL) tMinTL = totalLights[tj].tl;
      if (totalLights[tj].tl > tMaxTL) tMaxTL = totalLights[tj].tl;
    }
    var tTotal2 = tRight + tWrong;
    tlRows.push({
      tercile: t.label,
      range: tMinTL.toFixed(0) + " - " + tMaxTL.toFixed(0),
      right: tRight,
      wrong: tWrong,
      total: tTotal2,
      accuracy: tTotal2 > 0 ? (tRight / tTotal2 * 100).toFixed(1) + "%" : "n/a",
    });
  }
  console.table(tlRows);

  // ---- CHANNEL WIDTH ANALYSIS (TERRAIN MODEL) ----
  // Narrow channels should be more predictive in the terrain model.
  // channelWidth comes from the corridor detection system.
  // Only available for records made with the terrain model active.
  var channelRecords = [];
  for (var cwi = 0; cwi < records.length; cwi++) {
    var cw = records[cwi].channelWidth;
    if (cw !== undefined && cw > 0) {
      channelRecords.push({ cw: cw, cs: records[cwi].channelStrength || 0, correct: records[cwi].correct });
    }
  }
  if (channelRecords.length >= 5) {
    console.log("");
    console.log("=== ACCURACY BY CHANNEL WIDTH (terrain model) ===");
    console.log("Narrow channel = strong walls = more contained. Does it predict better?");
    channelRecords.sort(function(a, b) { return a.cw - b.cw; });
    var cwThird = Math.ceil(channelRecords.length / 3);
    var cwTercs = [
      { label: "Narrow", start: 0, end: cwThird },
      { label: "Medium", start: cwThird, end: cwThird * 2 },
      { label: "Wide",   start: cwThird * 2, end: channelRecords.length },
    ];
    var cwRows = [];
    for (var cwt = 0; cwt < cwTercs.length; cwt++) {
      var cwTrc = cwTercs[cwt];
      var cwRight = 0, cwWrong = 0, cwMin = Infinity, cwMax = 0;
      for (var cwj = cwTrc.start; cwj < Math.min(cwTrc.end, channelRecords.length); cwj++) {
        if (channelRecords[cwj].correct) cwRight++;
        else cwWrong++;
        if (channelRecords[cwj].cw < cwMin) cwMin = channelRecords[cwj].cw;
        if (channelRecords[cwj].cw > cwMax) cwMax = channelRecords[cwj].cw;
      }
      var cwTotal = cwRight + cwWrong;
      cwRows.push({
        tercile: cwTrc.label,
        widthRange: cwMin.toFixed(0) + " - " + cwMax.toFixed(0),
        right: cwRight,
        wrong: cwWrong,
        total: cwTotal,
        accuracy: cwTotal > 0 ? (cwRight / cwTotal * 100).toFixed(1) + "%" : "n/a",
      });
    }
    console.table(cwRows);
  }

  // ---- ATTRACTOR STRENGTH ANALYSIS (GRAVITY MODEL) ----
  // Does the presence of a strong nearby bright zone predict accuracy?
  // If the gravity model is working, strong attractors = clear target = better predictions.
  var attractRecords = [];
  for (var asi = 0; asi < records.length; asi++) {
    var astr = records[asi].attractorStrength;
    if (astr !== undefined && astr > 0) {
      attractRecords.push({ str: astr, correct: records[asi].correct });
    }
  }
  if (attractRecords.length >= 5) {
    console.log("");
    console.log("=== ACCURACY BY ATTRACTOR STRENGTH (gravity model) ===");
    console.log("Strong attractor = dominant bright zone nearby = clear target level.");
    attractRecords.sort(function(a, b) { return a.str - b.str; });
    var asThird = Math.ceil(attractRecords.length / 3);
    var asTercs = [
      { label: "Weak",   start: 0, end: asThird },
      { label: "Medium", start: asThird, end: asThird * 2 },
      { label: "Strong", start: asThird * 2, end: attractRecords.length },
    ];
    var asRows = [];
    for (var ast = 0; ast < asTercs.length; ast++) {
      var asTrc = asTercs[ast];
      var asRight = 0, asWrong = 0, asMin = Infinity, asMax = 0;
      for (var asj = asTrc.start; asj < Math.min(asTrc.end, attractRecords.length); asj++) {
        if (attractRecords[asj].correct) asRight++;
        else asWrong++;
        if (attractRecords[asj].str < asMin) asMin = attractRecords[asj].str;
        if (attractRecords[asj].str > asMax) asMax = attractRecords[asj].str;
      }
      var asTotal = asRight + asWrong;
      asRows.push({
        tercile: asTrc.label,
        strRange: asMin.toFixed(2) + " - " + asMax.toFixed(2),
        right: asRight,
        wrong: asWrong,
        total: asTotal,
        accuracy: asTotal > 0 ? (asRight / asTotal * 100).toFixed(1) + "%" : "n/a",
      });
    }
    console.table(asRows);
  }

  // ---- LIGHT CLARITY ANALYSIS ----
  // Does signal clarity correlate with accuracy?
  // If so, we can use it as a confidence gate filter.
  var clarityRecords = [];
  for (var cli = 0; cli < records.length; cli++) {
    var clar = records[cli].lightClarity;
    if (clar !== undefined && clar > 0) {
      clarityRecords.push({ cl: clar, correct: records[cli].correct });
    }
  }
  if (clarityRecords.length >= 5) {
    console.log("");
    console.log("=== ACCURACY BY LIGHT CLARITY ===");
    console.log("High clarity = clear structure, forces speak. Low = noise, forces dampened.");
    clarityRecords.sort(function(a, b) { return a.cl - b.cl; });
    var clThird = Math.ceil(clarityRecords.length / 3);
    var clTercs = [
      { label: "Low",  start: 0, end: clThird },
      { label: "Med",  start: clThird, end: clThird * 2 },
      { label: "High", start: clThird * 2, end: clarityRecords.length },
    ];
    var clRows = [];
    for (var clt = 0; clt < clTercs.length; clt++) {
      var clTrc = clTercs[clt];
      var clRight = 0, clWrong = 0, clMin = 2, clMax = 0;
      for (var clj = clTrc.start; clj < Math.min(clTrc.end, clarityRecords.length); clj++) {
        if (clarityRecords[clj].correct) clRight++;
        else clWrong++;
        if (clarityRecords[clj].cl < clMin) clMin = clarityRecords[clj].cl;
        if (clarityRecords[clj].cl > clMax) clMax = clarityRecords[clj].cl;
      }
      var clTotal = clRight + clWrong;
      clRows.push({
        tercile: clTrc.label,
        range: clMin.toFixed(2) + " - " + clMax.toFixed(2),
        right: clRight,
        wrong: clWrong,
        total: clTotal,
        accuracy: clTotal > 0 ? (clRight / clTotal * 100).toFixed(1) + "%" : "n/a",
      });
    }
    console.table(clRows);
  }

  // ---- LIGHT WEIGHT DIRECTION ANALYSIS ----
  // When light boosts upward forces, are upward predictions better?
  // When light boosts downward forces, are downward predictions better?
  var lwBullBoosted = { right: 0, wrong: 0 };   // upWeight > downWeight
  var lwBearBoosted = { right: 0, wrong: 0 };   // downWeight > upWeight
  var lwBalanced    = { right: 0, wrong: 0 };    // roughly equal
  for (var lwi = 0; lwi < records.length; lwi++) {
    var uw = records[lwi].lightUpWeight;
    var dw = records[lwi].lightDownWeight;
    if (uw === undefined) continue;
    var bucket;
    if (uw > dw * 1.1)      bucket = lwBullBoosted;
    else if (dw > uw * 1.1) bucket = lwBearBoosted;
    else                     bucket = lwBalanced;
    if (records[lwi].correct) bucket.right++;
    else bucket.wrong++;
  }
  var lwTotal1 = lwBullBoosted.right + lwBullBoosted.wrong;
  var lwTotal2 = lwBearBoosted.right + lwBearBoosted.wrong;
  var lwTotal3 = lwBalanced.right + lwBalanced.wrong;
  if (lwTotal1 + lwTotal2 + lwTotal3 >= 5) {
    console.log("");
    console.log("=== ACCURACY BY LIGHT WEIGHT DIRECTION ===");
    console.log("Does light correctly boost the winning side?");
    console.table([
      { direction: "Bull boosted (↑ > ↓)", right: lwBullBoosted.right, wrong: lwBullBoosted.wrong,
        total: lwTotal1, accuracy: lwTotal1 > 0 ? (lwBullBoosted.right / lwTotal1 * 100).toFixed(1) + "%" : "n/a" },
      { direction: "Bear boosted (↓ > ↑)", right: lwBearBoosted.right, wrong: lwBearBoosted.wrong,
        total: lwTotal2, accuracy: lwTotal2 > 0 ? (lwBearBoosted.right / lwTotal2 * 100).toFixed(1) + "%" : "n/a" },
      { direction: "Balanced (↑ ≈ ↓)", right: lwBalanced.right, wrong: lwBalanced.wrong,
        total: lwTotal3, accuracy: lwTotal3 > 0 ? (lwBalanced.right / lwTotal3 * 100).toFixed(1) + "%" : "n/a" },
    ]);
  }

  // ---- RESISTANCE DENSITY ANALYSIS ----
  // Does the "cost to push through" at the entry price predict accuracy?
  // High density = lots of volume at this level = strong S/R = more predictable?
  // Or does high density mean congestion and randomness?
  var densityRecords = [];
  for (var rdi = 0; rdi < records.length; rdi++) {
    var rdDens = records[rdi].densityAtEntry;
    var rdAvg = records[rdi].avgDensityNearPrice;
    if (rdDens !== undefined && rdDens > 0) {
      densityRecords.push({ entry: rdDens, avg: rdAvg || 0, correct: records[rdi].correct });
    }
  }
  if (densityRecords.length >= 5) {
    console.log("");
    console.log("=== ACCURACY BY RESISTANCE DENSITY (volume/price cost) ===");
    console.log("High density = expensive zone (lots of volume). Low = cheap passage.");
    densityRecords.sort(function(a, b) { return a.entry - b.entry; });
    var rdThird = Math.ceil(densityRecords.length / 3);
    var rdTercs = [
      { label: "Thin (low vol)", start: 0, end: rdThird },
      { label: "Medium", start: rdThird, end: rdThird * 2 },
      { label: "Thick (high vol)", start: rdThird * 2, end: densityRecords.length },
    ];
    var rdRows = [];
    for (var rdt = 0; rdt < rdTercs.length; rdt++) {
      var rdTrc = rdTercs[rdt];
      var rdRight = 0, rdWrong = 0, rdMin = 2, rdMax = 0;
      for (var rdj = rdTrc.start; rdj < Math.min(rdTrc.end, densityRecords.length); rdj++) {
        if (densityRecords[rdj].correct) rdRight++;
        else rdWrong++;
        if (densityRecords[rdj].entry < rdMin) rdMin = densityRecords[rdj].entry;
        if (densityRecords[rdj].entry > rdMax) rdMax = densityRecords[rdj].entry;
      }
      var rdTotal = rdRight + rdWrong;
      rdRows.push({
        tercile: rdTrc.label,
        range: rdMin.toFixed(2) + " - " + rdMax.toFixed(2),
        right: rdRight,
        wrong: rdWrong,
        total: rdTotal,
        accuracy: rdTotal > 0 ? (rdRight / rdTotal * 100).toFixed(1) + "%" : "n/a",
      });
    }
    console.table(rdRows);

    // Also check: does the SURROUNDING density (not just at entry) matter?
    console.log("");
    console.log("=== ACCURACY BY NEARBY DENSITY (area around entry price) ===");
    densityRecords.sort(function(a, b) { return a.avg - b.avg; });
    var rdRows2 = [];
    for (var rdt2 = 0; rdt2 < rdTercs.length; rdt2++) {
      var rdTrc2 = rdTercs[rdt2];
      var rdRight2 = 0, rdWrong2 = 0, rdMin2 = 2, rdMax2 = 0;
      for (var rdj2 = rdTrc2.start; rdj2 < Math.min(rdTrc2.end, densityRecords.length); rdj2++) {
        if (densityRecords[rdj2].correct) rdRight2++;
        else rdWrong2++;
        if (densityRecords[rdj2].avg < rdMin2) rdMin2 = densityRecords[rdj2].avg;
        if (densityRecords[rdj2].avg > rdMax2) rdMax2 = densityRecords[rdj2].avg;
      }
      var rdTotal2 = rdRight2 + rdWrong2;
      rdRows2.push({
        tercile: rdTrc2.label,
        range: rdMin2.toFixed(2) + " - " + rdMax2.toFixed(2),
        right: rdRight2,
        wrong: rdWrong2,
        total: rdTotal2,
        accuracy: rdTotal2 > 0 ? (rdRight2 / rdTotal2 * 100).toFixed(1) + "%" : "n/a",
      });
    }
    console.table(rdRows2);
  }

  // ---- TRAP SCORE ANALYSIS ----
  // Does the trap detector help? When trapScore is high, is the
  // INVERTED prediction more accurate than the normal one?
  // "Correct" here still means the normal prediction direction was right.
  // So if trap-detected predictions have LOW accuracy, the inversion is helping.
  var trapRecords = [];
  for (var tri = 0; tri < records.length; tri++) {
    var trScore = records[tri].trapScore;
    if (trScore !== undefined) {
      trapRecords.push({ score: trScore, applied: records[tri].trapApplied || false,
                         correct: records[tri].correct });
    }
  }
  if (trapRecords.length >= 5) {
    console.log("");
    console.log("=== ACCURACY BY TRAP SCORE ===");
    console.log("High trap score + LOW accuracy = inversion is justified.");
    console.log("High trap score + HIGH accuracy = traps are not real, disable inversion.");

    // Bin by trap score ranges
    var trapBins = [
      { label: "No trap (0-20%)", lo: 0, hi: 0.20, right: 0, wrong: 0 },
      { label: "Low (20-40%)", lo: 0.20, hi: 0.40, right: 0, wrong: 0 },
      { label: "Medium (40-60%)", lo: 0.40, hi: 0.60, right: 0, wrong: 0 },
      { label: "High (60-80%)", lo: 0.60, hi: 0.80, right: 0, wrong: 0 },
      { label: "Extreme (80-100%)", lo: 0.80, hi: 1.01, right: 0, wrong: 0 },
    ];
    for (var tbi = 0; tbi < trapRecords.length; tbi++) {
      var tr = trapRecords[tbi];
      for (var tbj = 0; tbj < trapBins.length; tbj++) {
        if (tr.score >= trapBins[tbj].lo && tr.score < trapBins[tbj].hi) {
          if (tr.correct) trapBins[tbj].right++;
          else trapBins[tbj].wrong++;
          break;
        }
      }
    }
    var trapRows = [];
    for (var tbk = 0; tbk < trapBins.length; tbk++) {
      var tb = trapBins[tbk];
      var tbTotal = tb.right + tb.wrong;
      if (tbTotal === 0) continue;
      trapRows.push({
        range: tb.label,
        right: tb.right,
        wrong: tb.wrong,
        total: tbTotal,
        accuracy: (tb.right / tbTotal * 100).toFixed(1) + "%",
        verdict: tb.right / tbTotal < 0.45 ? "→ INVERT" :
                 tb.right / tbTotal > 0.55 ? "→ TRUST" : "→ coin flip",
      });
    }
    console.table(trapRows);

    // Also show: trap-applied vs not-applied accuracy
    var trapOn = { right: 0, wrong: 0 };
    var trapOff = { right: 0, wrong: 0 };
    for (var tai = 0; tai < trapRecords.length; tai++) {
      var bucket = trapRecords[tai].applied ? trapOn : trapOff;
      if (trapRecords[tai].correct) bucket.right++;
      else bucket.wrong++;
    }
    var taOnT = trapOn.right + trapOn.wrong;
    var taOffT = trapOff.right + trapOff.wrong;
    console.log("");
    console.log("Trap inversion applied vs not:");
    console.table([
      { mode: "Trap ON (inverted)", right: trapOn.right, wrong: trapOn.wrong,
        total: taOnT, accuracy: taOnT > 0 ? (trapOn.right / taOnT * 100).toFixed(1) + "%" : "n/a" },
      { mode: "Trap OFF (normal)", right: trapOff.right, wrong: trapOff.wrong,
        total: taOffT, accuracy: taOffT > 0 ? (trapOff.right / taOffT * 100).toFixed(1) + "%" : "n/a" },
    ]);
  }

  // ---- SEQUENCES ----
  console.log("");
  console.log("Sequences:");
  console.log("  Right after right: " + rightAfterRight);
  console.log("  Right after wrong: " + rightAfterWrong);
  console.log("  Wrong after right: " + wrongAfterRight);
  console.log("  Wrong after wrong: " + wrongAfterWrong);

  // ---- EXPERIMENT RECOMMENDATIONS ----
  console.log("");
  console.log("=== EXPERIMENT NOTES ===");
  var activeForces = [];
  if (state.predLight)  activeForces.push("Light");
  if (state.predVol)    activeForces.push("Volume");
  if (state.predMom)    activeForces.push("Momentum");
  if (state.predCycle)  activeForces.push("Pullback");
  if (state.predMA)     activeForces.push("MA");
  if (state.predRSI)    activeForces.push("RSI");
  if (state.predLSR)    activeForces.push("LSSA");
  if (state.predCalib)  activeForces.push("Calibrate");
  if (state.predVBeam)  activeForces.push("V.Beams");
  console.log("Active forces: " + activeForces.join(", "));
  if (activeForces.length > 3) {
    console.log("⚠ Multiple forces active. For clean light study,");
    console.log("  disable everything except Light, V.Beams, Conf Gate.");
  }
  console.log("Samples: " + total + (total < 100 ? " (need 100+ for reliable bins)" : " ✓"));
}


// ================================================================
// CONFIDENCE GATE STATS: Console Helper
// ================================================================
// Call from the browser console:
//
//   confGateStats()        — show confident vs suppressed accuracy
//   confGateStats("SOL")   — for a specific asset
//
// This is the key metric: are the calls we MAKE more accurate than
// the calls we AVOID? If yes, the confidence gate is working.
// Target: confident calls >75%, suppressed calls <50%.

function confGateStats(asset) {
  var ak = asset || state.asset;
  var cal = calibration[ak];
  if (!cal || !cal.firstCandleResults || cal.firstCandleResults.length === 0) {
    console.log("No calibration data for " + ak + ". Run animation with Calibrate on.");
    return;
  }

  var results = cal.firstCandleResults;
  var total = results.length;

  // Split by confident vs suppressed
  var confRight = 0, confWrong = 0;
  var suppRight = 0, suppWrong = 0;
  var otherRight = 0, otherWrong = 0;

  for (var i = 0; i < total; i++) {
    var r = results[i];
    if (r.confident) {
      if (r.dirOk > 0.5) confRight++;
      else confWrong++;
    } else if (r.suppressed) {
      if (r.dirOk > 0.5) suppRight++;
      else suppWrong++;
    } else {
      if (r.dirOk > 0.5) otherRight++;
      else otherWrong++;
    }
  }

  var confTotal = confRight + confWrong;
  var suppTotal = suppRight + suppWrong;
  var otherTotal = otherRight + otherWrong;

  console.log("=== CONFIDENCE GATE STATS: " + ak + " ===");
  console.log("Total predictions: " + total);
  console.log("");

  if (confTotal > 0) {
    var confRate = (confRight / confTotal * 100).toFixed(1);
    console.log("CONFIDENT calls (above 75% threshold):");
    console.log("  " + confTotal + " calls, " + confRight + " right, " + confWrong + " wrong → " + confRate + "% accuracy");
    console.log("  " + (confTotal / total * 100).toFixed(0) + "% of all predictions made a call");
  } else {
    console.log("CONFIDENT: no calls yet (threshold may be too high)");
  }

  if (suppTotal > 0) {
    var suppRate = (suppRight / suppTotal * 100).toFixed(1);
    console.log("");
    console.log("SUPPRESSED calls (below 75% threshold — would have been NO CALL):");
    console.log("  " + suppTotal + " calls, " + suppRight + " right, " + suppWrong + " wrong → " + suppRate + "% accuracy");
    if (confTotal > 0) {
      var delta = parseFloat(confRate) - parseFloat(suppRate);
      console.log("  Gate DELTA: confident is " + delta.toFixed(1) + "pp better than suppressed");
      if (delta > 10) console.log("  ✓ Gate is working well — suppressed calls ARE worse.");
      else if (delta > 0) console.log("  ~ Gate is slightly positive. May need tuning.");
      else console.log("  ✗ Gate not helping — suppressed calls are as good as confident. Lower threshold?");
    }
  }

  if (otherTotal > 0) {
    console.log("");
    console.log("OTHER (not confident, not suppressed — conf gate may be off):");
    console.log("  " + otherTotal + " calls → " + (otherRight / otherTotal * 100).toFixed(1) + "% accuracy");
  }

  // Per-scenario stats if available
  if (cal.scenarioStats) {
    console.log("");
    console.log("Per-scenario accuracy (EMA, used for consensus weighting):");
    var scRows = [];
    for (var scName in cal.scenarioStats) {
      if (cal.scenarioStats.hasOwnProperty(scName)) {
        var sc = cal.scenarioStats[scName];
        scRows.push({
          scenario: scName,
          dirCorrect: (sc.dirCorrect * 100).toFixed(1) + "%",
          weight: (sc.dirCorrect * sc.dirCorrect * 100).toFixed(1) + "%",  // squared weight
          samples: sc.sampleCount,
        });
      }
    }
    scRows.sort(function(a, b) {
      return parseFloat(b.dirCorrect) - parseFloat(a.dirCorrect);
    });
    console.table(scRows);
  }
}
