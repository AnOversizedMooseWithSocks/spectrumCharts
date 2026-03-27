/*
 * ================================================================
 * data.js  —  Data Generation & Indicator Calculations
 * ================================================================
 * Depends on: config.js (CONFIG)
 *
 * Produces realistic-looking OHLCV candles and computes technical
 * indicators (SMA, RSI) used to weight beam/line intensity.
 * ================================================================
 */

// ================================================================
// DATA GENERATION
// ================================================================
// Produces realistic-looking OHLCV candles with trending behavior.
// Uses a simple seeded PRNG so the chart is consistent across reloads.
//
// Each candle: { o, h, l, c, v, time }
//   o = open, h = high, l = low, c = close, v = volume

function generateCandles(basePrice, volatilityPct, count, seed) {
  var candles = [];
  var price = basePrice;

  // Seeded pseudo-random number generator (Lehmer / Park-Miller)
  var s = seed || 42;
  function rand() {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  }

  for (var i = 0; i < count; i++) {
    var vol = basePrice * volatilityPct;

    // Drift: slight mean-reversion toward the base price
    var drift = (basePrice - price) * 0.002 + (rand() - 0.5) * vol * 0.3;
    var open  = price + drift;

    // Random move with slight upward bias
    var move  = (rand() - 0.48) * vol;
    var close = open + move;

    // Wicks extend beyond the body
    var high = Math.max(open, close) + rand() * vol * 0.4;
    var low  = Math.min(open, close) - rand() * vol * 0.4;

    // Volume: base + random + proportional to move size
    var volume = 1000 + rand() * 9000 + Math.abs(move) * 500;

    candles.push({
      o: +open.toFixed(2),
      h: +high.toFixed(2),
      l: +low.toFixed(2),
      c: +close.toFixed(2),
      v: +volume.toFixed(0),
      buyPressure: 0.4 + rand() * 0.2,  // random buy pressure for generated data
      trades: Math.floor(50 + rand() * 200),
      time: Date.now() - (count - i) * 60000,
    });

    price = close;  // next candle opens near this close
  }

  return candles;
}


// Compute normalized volume weights for a set of candles.
// Returns an array of 0..1 values where 1 = highest volume candle.
// Uses sqrt scaling so high volume is important but doesn't dominate.
function calcVolumeWeights(candles) {
  var weights = [];
  var maxVol = 0;
  for (var i = 0; i < candles.length; i++) {
    if (candles[i].v > maxVol) maxVol = candles[i].v;
  }
  if (maxVol === 0) maxVol = 1;
  for (var j = 0; j < candles.length; j++) {
    weights.push(Math.sqrt(candles[j].v / maxVol));
  }
  return weights;
}


// ================================================================
// INDICATOR CALCULATIONS (MA, RSI)
// ================================================================
// Used to weight beam intensity. A candle that's far from the
// moving average or at extreme RSI casts a different strength
// beam depending on the selected intensity mode.

// Simple Moving Average of closing prices.
// Returns an array the same length as candles, with null for
// the first (period-1) entries where there isn't enough data.
function calcSMA(candles, period) {
  var result = [];
  var sum = 0;
  for (var i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= period) {
      sum -= candles[i - period].c;
    }
    if (i >= period - 1) {
      result.push(sum / period);
    } else {
      result.push(null);
    }
  }
  return result;
}

// RSI (Relative Strength Index).
// Returns an array the same length as candles, with null for
// the first (period) entries. Values range 0..100.
// RSI > 70 = overbought, RSI < 30 = oversold, 50 = neutral.
function calcRSI(candles, period) {
  var result = [null]; // first candle has no change
  var gains = [];
  var losses = [];

  // Calculate price changes
  for (var i = 1; i < candles.length; i++) {
    var change = candles[i].c - candles[i - 1].c;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // Not enough data yet
  for (var j = 0; j < period - 1; j++) {
    result.push(null);
  }

  // Initial average gain/loss (simple average of first N periods)
  var avgGain = 0;
  var avgLoss = 0;
  for (var k = 0; k < period; k++) {
    avgGain += gains[k];
    avgLoss += losses[k];
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - (100 / (1 + rs)));

  // Smoothed RSI for remaining candles
  for (var m = period; m < gains.length; m++) {
    avgGain = (avgGain * (period - 1) + gains[m]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[m]) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - (100 / (1 + rs)));
  }

  return result;
}

// Compute per-candle intensity weights based on the selected
// intensity mode. Returns an array of multipliers (0..1 range,
// where 1 = brightest).
function calcIntensityWeights(candles, mode) {
  var weights = [];
  var count = candles.length;

  if (mode === "none") {
    // Uniform: all candles emit equally
    for (var i = 0; i < count; i++) weights.push(1.0);
    return weights;
  }

  if (mode === "ma_far" || mode === "ma_near") {
    var sma = calcSMA(candles, CONFIG.MA_PERIOD);

    // Find the max distance from MA for normalization
    var maxDist = 0;
    for (var j = 0; j < count; j++) {
      if (sma[j] !== null) {
        var d = Math.abs(candles[j].c - sma[j]);
        if (d > maxDist) maxDist = d;
      }
    }
    if (maxDist === 0) maxDist = 1;

    for (var k = 0; k < count; k++) {
      if (sma[k] === null) {
        weights.push(0.3); // not enough data yet, dim
      } else {
        var dist = Math.abs(candles[k].c - sma[k]) / maxDist; // 0..1
        if (mode === "ma_far") {
          // Brighter when far from MA (extreme moves glow)
          weights.push(0.15 + dist * 0.85);
        } else {
          // Brighter when near MA (mean-reversion zones glow)
          weights.push(0.15 + (1 - dist) * 0.85);
        }
      }
    }
    return weights;
  }

  if (mode === "rsi_far" || mode === "rsi_near") {
    var rsi = calcRSI(candles, CONFIG.RSI_PERIOD);

    for (var n = 0; n < count; n++) {
      if (rsi[n] === null) {
        weights.push(0.3);
      } else {
        // Distance from RSI 50 (neutral), normalized to 0..1
        var distFromNeutral = Math.abs(rsi[n] - 50) / 50;
        if (mode === "rsi_far") {
          // Brighter at extremes (overbought/oversold glow)
          weights.push(0.15 + distFromNeutral * 0.85);
        } else {
          // Brighter near neutral (consolidation zones glow)
          weights.push(0.15 + (1 - distFromNeutral) * 0.85);
        }
      }
    }
    return weights;
  }

  // Fallback: uniform
  for (var f = 0; f < count; f++) weights.push(1.0);
  return weights;
}
