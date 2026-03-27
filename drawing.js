/*
 * ================================================================
 * drawing.js  —  Candle Rendering, Grid, Cross Forces
 * ================================================================
 * Depends on: config.js (CONFIG, ctx), coords.js (priceToY, indexToX)
 *
 * Low-level drawing functions used by the main render loop.
 * ================================================================
 */

// ================================================================
// CANDLE RENDERING
// ================================================================
// Draws standard candlestick chart overlaid on the visualization.
// alpha: transparency (0..1) so candles don't obscure the viz.

function drawCandles(candles, dims, priceMin, priceMax, upColor, downColor, alpha) {
  var count   = candles.length;
  var candleW = dims.chartWidth / CONFIG.CANDLE_COUNT;
  var bodyW   = Math.max(1, candleW * 0.6);

  ctx.globalAlpha = alpha || 1;

  for (var i = 0; i < count; i++) {
    var c  = candles[i];
    var cx = indexToX(i, count, dims.chartLeft, dims.chartWidth);
    var isUp  = c.c >= c.o;
    var color = isUp ? (upColor || CONFIG.CANDLE_UP) : (downColor || CONFIG.CANDLE_DOWN);

    var highY  = priceToY(c.h, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var lowY   = priceToY(c.l, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var openY  = priceToY(c.o, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    var closeY = priceToY(c.c, priceMin, priceMax, dims.chartTop, dims.chartHeight);

    var bodyTop = Math.min(openY, closeY);
    var bodyBot = Math.max(openY, closeY);

    // Wick: thin vertical line from high to low
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();

    // Body: filled rectangle between open and close
    ctx.fillStyle = color;
    var bh = Math.max(1, bodyBot - bodyTop);
    ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bh);
  }

  ctx.globalAlpha = 1;
}


// ================================================================
// GRID / AXIS RENDERING
// ================================================================

function drawGrid(dims, priceMin, priceMax) {
  var priceRange = priceMax - priceMin;

  // Calculate a nice round step size for the grid lines
  var rawStep   = priceRange / 6;
  var magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  var step      = Math.ceil(rawStep / magnitude) * magnitude;

  // Inverse scale factor: text and UI elements drawn at basePx * invS
  // will appear as basePx on screen regardless of zoom level.
  var invS = 1 / state.viewScale;

  ctx.strokeStyle = CONFIG.GRID_COLOR;
  ctx.lineWidth   = 1;
  ctx.fillStyle   = CONFIG.TEXT_COLOR;
  ctx.font        = Math.round(11 * invS) + "px monospace";
  ctx.textAlign   = "right";

  // Grid lines extend across the full world width (not just candle area)
  // so the projection zone has grid lines too when you pan over there.
  var gridRight = dims.width - 65;

  // Price axis labels should stay at the VISIBLE right edge of the
  // screen, not at the world's right edge (which may be off-screen).
  // Since we're inside the canvas transform (translate + scale), we
  // inverse-transform the screen's right edge to get the world-space X.
  var screenW = dims.screenW || dims.width;
  var labelX = (screenW - state.viewOffsetX) / state.viewScale - 4 * invS;

  var startPrice = Math.floor(priceMin / step) * step;
  for (var p = startPrice; p <= priceMax; p += step) {
    var y = priceToY(p, priceMin, priceMax, dims.chartTop, dims.chartHeight);
    if (y >= dims.chartTop && y <= dims.chartTop + dims.chartHeight) {
      ctx.beginPath();
      ctx.moveTo(dims.chartLeft, y);
      ctx.lineTo(gridRight, y);
      ctx.stroke();
      ctx.fillText(p.toFixed(2), labelX, y + 4 * invS);
    }
  }
}


// ================================================================
// MULTI-ASSET CROSS FORCES
// ================================================================
// Computes the gravitational force that one asset exerts on
// another's particle field. BTC with its huge mcap acts like a
// heavy body that subtly pulls SOL and ETH particles in the
// direction of its recent momentum.

function computeCrossForces(candles, dims, mcap) {
  var forces = [];
  if (candles.length < 5) return forces;

  var range    = getPriceRange(candles);
  var recent   = candles.slice(-5);
  var momentum = recent[recent.length - 1].c - recent[0].o;
  var avgPrice = (recent[recent.length - 1].c + recent[0].o) / 2;

  // Position the force at the current average price level
  var y = priceToY(avgPrice, range.priceMin, range.priceMax, dims.chartTop, dims.chartHeight);

  // Strength scales with mcap (mass) and recent momentum
  var massRatio = mcap / CONFIG.MCAP.BTC;  // normalized: BTC = 1.0
  var direction = momentum > 0 ? -1 : 1;   // upward momentum -> push particles up

  forces.push({
    y:         y,
    strength:  Math.abs(momentum / avgPrice) * massRatio * 2,
    direction: direction,
  });

  return forces;
}


// ================================================================
// INDICATOR OVERLAY LINES
// ================================================================
// Draws MA, RSI, and LSR lines on the chart when toggled on.
// These are purely visual — independent of prediction model toggles.

function drawIndicatorOverlays(candles, dims, priceMin, priceMax) {
  var count     = candles.length;
  var chartLeft = dims.chartLeft;
  var chartWidth = dims.chartWidth;
  var chartTop  = dims.chartTop;
  var chartH    = dims.chartHeight;

  // ---- SMA(20) LINE ----
  // Classic moving average line overlaid on the price chart.
  // Orange/gold, dashed.
  if (state.showMA && count >= CONFIG.MA_PERIOD + 1) {
    var smaArr = calcSMA(candles, CONFIG.MA_PERIOD);

    ctx.strokeStyle = "rgba(240,160,48,0.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    var maStarted = false;

    for (var mi = 0; mi < count; mi++) {
      if (smaArr[mi] === null) continue;
      var mx = indexToX(mi, count, chartLeft, chartWidth);
      var my = priceToY(smaArr[mi], priceMin, priceMax, chartTop, chartH);
      if (!maStarted) { ctx.moveTo(mx, my); maStarted = true; }
      else ctx.lineTo(mx, my);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    if (smaArr[count - 1] !== null) {
      var maLastY = priceToY(smaArr[count - 1], priceMin, priceMax, chartTop, chartH);
      ctx.fillStyle = "rgba(240,160,48,0.7)";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "left";
      ctx.fillText("MA" + CONFIG.MA_PERIOD, chartLeft + 6, maLastY - 4);
    }
  }

  // ---- RSI(14) OVERLAY ----
  // RSI is 0..100, drawn scaled to fit the chart height.
  // Purple, with 30/50/70 reference lines.
  // Translucent so it doesn't obscure price action.
  if (state.showRSI && count >= CONFIG.RSI_PERIOD + 2) {
    var rsiArr = calcRSI(candles, CONFIG.RSI_PERIOD);

    // Reference lines at 30, 50, 70 (in chart Y coordinates)
    // RSI 0 = bottom of chart, RSI 100 = top
    var rsi30Y = chartTop + chartH * (1 - 30/100);
    var rsi50Y = chartTop + chartH * (1 - 50/100);
    var rsi70Y = chartTop + chartH * (1 - 70/100);

    ctx.strokeStyle = "rgba(192,96,240,0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    // 30 line (oversold)
    ctx.beginPath();
    ctx.moveTo(chartLeft, rsi30Y);
    ctx.lineTo(chartLeft + chartWidth, rsi30Y);
    ctx.stroke();
    // 70 line (overbought)
    ctx.beginPath();
    ctx.moveTo(chartLeft, rsi70Y);
    ctx.lineTo(chartLeft + chartWidth, rsi70Y);
    ctx.stroke();
    // 50 line (neutral) — dimmer
    ctx.strokeStyle = "rgba(192,96,240,0.08)";
    ctx.beginPath();
    ctx.moveTo(chartLeft, rsi50Y);
    ctx.lineTo(chartLeft + chartWidth, rsi50Y);
    ctx.stroke();
    ctx.setLineDash([]);

    // RSI labels on the right
    ctx.fillStyle = "rgba(192,96,240,0.3)";
    ctx.font = "7px monospace";
    ctx.textAlign = "right";
    ctx.fillText("70", chartLeft + chartWidth - 2, rsi70Y - 2);
    ctx.fillText("30", chartLeft + chartWidth - 2, rsi30Y - 2);

    // RSI line
    ctx.strokeStyle = "rgba(192,96,240,0.7)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var rsiStarted = false;

    for (var ri = 0; ri < count; ri++) {
      if (rsiArr[ri] === null) continue;
      var rx = indexToX(ri, count, chartLeft, chartWidth);
      // Map RSI 0..100 to chartTop+chartH..chartTop
      var ry = chartTop + chartH * (1 - rsiArr[ri] / 100);
      if (!rsiStarted) { ctx.moveTo(rx, ry); rsiStarted = true; }
      else ctx.lineTo(rx, ry);
    }
    ctx.stroke();

    // Current RSI value label
    if (rsiArr[count - 1] !== null) {
      var rsiLastY = chartTop + chartH * (1 - rsiArr[count - 1] / 100);
      var rsiVal = rsiArr[count - 1];
      var rsiColor = rsiVal > 70 ? "rgba(255,80,60,0.8)" :
                     rsiVal < 30 ? "rgba(0,200,120,0.8)" :
                     "rgba(192,96,240,0.7)";
      ctx.fillStyle = rsiColor;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "left";
      ctx.fillText("RSI " + rsiVal.toFixed(0), chartLeft + 6, rsiLastY - 4);
    }
  }

  // ---- LEAST SQUARES REGRESSION LINE ----
  // Fit to the last 30 closes, drawn as a straight line extending
  // across the visible candles and into the projection zone.
  // Cyan/teal, solid.
  // ================================================================
  // LSSA overlay: Least Squares Spectral Analysis composite wave.
  // Decomposes price into cycles and draws the fitted + projected wave.
  // Uses half the visible candles (same as projection.js).
  // Only draws once we have at least 20 candles of lookback.
  // ================================================================
  var lssaN2 = Math.floor(count / 2);
  if (state.showLSR && lssaN2 >= 20) {
    var lssaStart2 = count - lssaN2;
    var n2 = lssaN2;

    // ---- Detrend: fit linear trend to the window ----
    var dsx = 0, dsy = 0, dsxy = 0, dsx2 = 0;
    for (var dli = 0; dli < n2; dli++) {
      dsx  += dli;
      dsy  += candles[lssaStart2 + dli].c;
      dsxy += dli * candles[lssaStart2 + dli].c;
      dsx2 += dli * dli;
    }
    var dDenom = n2 * dsx2 - dsx * dsx;
    var dSlope = 0, dIntercept = 0;
    if (Math.abs(dDenom) > 0.0001) {
      dSlope = (n2 * dsxy - dsx * dsy) / dDenom;
      dIntercept = (dsy - dSlope * dsx) / n2;
    }

    // Compute residuals
    var dResiduals = [];
    for (var dri = 0; dri < n2; dri++) {
      dResiduals.push(candles[lssaStart2 + dri].c - (dSlope * dri + dIntercept));
    }

    // Average range for amplitude threshold
    var dAvgRange = 0;
    var dVolN = Math.min(20, n2);
    for (var dvi = n2 - dVolN; dvi < n2; dvi++) {
      dAvgRange += candles[lssaStart2 + dvi].h - candles[lssaStart2 + dvi].l;
    }
    dAvgRange /= dVolN;

    // ---- Periodogram: scan frequencies ----
    var dFreqs = [];
    var dMinP = 4;
    var dMaxP = Math.floor(n2 * 0.8);
    var dNumF = Math.min(200, Math.floor(n2 / 2));

    for (var dfi = 0; dfi < dNumF; dfi++) {
      var dPeriod = dMinP + (dMaxP - dMinP) * (dfi / Math.max(1, dNumF - 1));
      var dOmega = 2 * Math.PI / dPeriod;

      var dCosS = 0, dSinS = 0;
      for (var dti = 0; dti < n2; dti++) {
        dCosS += dResiduals[dti] * Math.cos(dOmega * dti);
        dSinS += dResiduals[dti] * Math.sin(dOmega * dti);
      }
      var dA = dCosS * 2 / n2;
      var dB = dSinS * 2 / n2;
      var dPow = dA * dA + dB * dB;

      dFreqs.push({ period: dPeriod, freq: dOmega, power: dPow,
                    amp: Math.sqrt(dPow), A: dA, B: dB });
    }

    // ---- Pick top 5 cycles ----
    dFreqs.sort(function(a, b) { return b.power - a.power; });
    var dCycles = [];
    for (var dpi = 0; dpi < dFreqs.length && dCycles.length < 5; dpi++) {
      var dc = dFreqs[dpi];
      if (dc.amp < dAvgRange * 0.05) continue;
      var dClose = false;
      for (var dci = 0; dci < dCycles.length; dci++) {
        var dRat = dc.period / dCycles[dci].period;
        if (dRat > 0.8 && dRat < 1.2) { dClose = true; break; }
      }
      if (dClose) continue;
      dCycles.push(dc);
    }

    if (dCycles.length > 0) {
      // ---- Evaluate composite wave at each position ----
      // Draw from start of window through projection zone
      var projCandles = 30;
      var totalEval = n2 + projCandles;

      // Evaluate function: trend + sum of cycles
      function evalLssa(t) {
        var p = dSlope * t + dIntercept;
        for (var eci = 0; eci < dCycles.length; eci++) {
          p += dCycles[eci].A * Math.cos(dCycles[eci].freq * t)
             + dCycles[eci].B * Math.sin(dCycles[eci].freq * t);
        }
        return p;
      }

      // Build points array
      var lPts = [];
      for (var lpi = 0; lpi <= totalEval; lpi++) {
        var lPrice = evalLssa(lpi);
        var lCandleIdx = lssaStart2 + lpi;
        var lPixelX;
        if (lCandleIdx < count) {
          lPixelX = indexToX(lCandleIdx, count, chartLeft, chartWidth);
        } else {
          var lLastX = indexToX(count - 1, count, chartLeft, chartWidth);
          var lStepW = chartWidth / Math.max(1, count - 1);
          lPixelX = lLastX + (lCandleIdx - count + 1) * lStepW;
        }
        var lPixelY = priceToY(lPrice, priceMin, priceMax, chartTop, chartH);
        lPts.push({ x: lPixelX, y: lPixelY, inWindow: lpi < n2 });
      }

      // Draw fitted region (solid cyan)
      ctx.strokeStyle = "rgba(64,192,240,0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var ldi = 0; ldi < lPts.length; ldi++) {
        if (!lPts[ldi].inWindow && ldi > 0 && lPts[ldi - 1].inWindow) {
          // Transition: finish solid, start dashed
          ctx.stroke();
          ctx.strokeStyle = "rgba(64,192,240,0.7)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 3]);
          ctx.beginPath();
          ctx.moveTo(lPts[ldi].x, lPts[ldi].y);
          continue;
        }
        if (ldi === 0) ctx.moveTo(lPts[ldi].x, lPts[ldi].y);
        else ctx.lineTo(lPts[ldi].x, lPts[ldi].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Label: show number of cycles detected and dominant period
      ctx.fillStyle = "rgba(64,192,240,0.6)";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "left";
      var dominantPeriod = dCycles[0].period.toFixed(0);
      var lCurrPrice = evalLssa(n2 - 1);
      var lCurrY = priceToY(lCurrPrice, priceMin, priceMax, chartTop, chartH);
      ctx.fillText("LSSA " + dCycles.length + " cycles (T₁=" + dominantPeriod + ")",
                   chartLeft + 6, lCurrY - 4);
    }
  }
}
