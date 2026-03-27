/*
 * ================================================================
 * calibrate-indicators.js  —  Indicator Physics Calibration
 * ================================================================
 * Depends on: config.js (CONFIG), data.js (calcSMA, calcRSI)
 *
 * PURPOSE:
 *   Derives the behavioral physics of MA and RSI from background
 *   (historical) candle data that is COMPLETELY SEPARATE from the
 *   visible chart. This means calibration cannot cheat — it has
 *   zero access to the data being predicted.
 *
 *   What it calibrates (all are ratios, not price-specific):
 *
 *     MA SPRING: When price is X% from its MA, how fast does it
 *       pull back per candle? This is measured as a reversion rate
 *       (0..1 where 1 = snaps back instantly, 0 = never reverts).
 *
 *     MA CROSSING MOMENTUM: When price crosses through the MA, how
 *       far does it typically overshoot before reverting? Measured
 *       as average overshoot distance in MA-gap units.
 *
 *     RSI DEAD ZONE: The range around RSI=50 where mean-reversion
 *       force is noise, not signal. Measured by finding the RSI
 *       levels where next-candle direction prediction exceeds 55%.
 *
 *     RSI REVERSION RATE: Outside the dead zone, how strongly does
 *       RSI pull price back toward neutral? Measured per unit of
 *       RSI deviation from the dead zone edge.
 *
 *     MA/RSI AGREEMENT WEIGHT: When MA says up and RSI says down,
 *       which one wins more often? Provides a relative confidence
 *       ratio for blending.
 *
 *   These parameters are computed once (at animation start or on
 *   demand) and locked for the entire run. The prediction engine
 *   uses them but never modifies them mid-run.
 *
 * SAMPLING APPROACH:
 *   Uses SPARSE sampling — not every candle, but every Nth candle
 *   across the dataset. This avoids overfitting to sequential
 *   patterns and ensures the calibration reflects general behavior.
 *
 * USAGE:
 *   var profile = calibrateIndicators(backgroundCandles);
 *   // profile.maSpring, profile.rsiDeadZone, etc.
 *
 *   // Inside prediction step loop:
 *   var maState = initRunningMA(candles, CONFIG.MA_PERIOD);
 *   var rsiState = initRunningRSI(candles, CONFIG.RSI_PERIOD);
 *   for each step:
 *     var maForce = stepMA(maState, predictedPrice, profile);
 *     var rsiForce = stepRSI(rsiState, predictedPrice, profile);
 * ================================================================
 */


// ================================================================
// calibrateIndicators  —  Derive physics from background candles
// ================================================================
//
// Parameters:
//   candles  — array of candle objects (the background/daily data)
//              Must have at least MA_PERIOD + sampleSpacing candles.
//   maPeriod — MA period (default: CONFIG.MA_PERIOD)
//   rsiPeriod — RSI period (default: CONFIG.RSI_PERIOD)
//
// Returns a calibration profile object with:
//   .maSpring       — reversion rate per candle (0..1)
//   .maOvershoot    — average overshoot past MA crossing (ratio)
//   .maCrossDecay   — how many candles overshoot persists
//   .rsiDeadLow     — lower edge of RSI dead zone (e.g. 38)
//   .rsiDeadHigh    — upper edge of RSI dead zone (e.g. 62)
//   .rsiReversion   — reversion force per RSI unit outside dead zone
//   .maWeight       — relative MA confidence (0..1)
//   .rsiWeight      — relative RSI confidence (0..1)
//   .samples        — how many sample points were used
//   .valid          — true if enough data to calibrate

function calibrateIndicators(candles, maPeriod, rsiPeriod) {
  if (!maPeriod) maPeriod = CONFIG.MA_PERIOD;
  if (!rsiPeriod) rsiPeriod = CONFIG.RSI_PERIOD;

  // Default profile (conservative, works okay without calibration)
  var defaults = {
    maSpring:     0.12,    // 12% reversion per candle
    maOvershoot:  1.5,     // overshoot 1.5x the gap at crossing
    maCrossDecay: 5,       // overshoot lasts ~5 candles
    rsiDeadLow:   38,      // RSI below 38 = oversold signal
    rsiDeadHigh:  62,      // RSI above 62 = overbought signal
    rsiReversion: 0.02,    // force per RSI unit outside dead zone
    maWeight:     0.55,    // slight MA preference when disagreeing
    rsiWeight:    0.45,
    samples:      0,
    valid:        false
  };

  if (!candles || candles.length < maPeriod + 30) {
    return defaults;
  }

  // Compute MA and RSI for the full background dataset
  var sma = calcSMA(candles, maPeriod);
  var rsi = calcRSI(candles, rsiPeriod);

  // ---- SPARSE SAMPLING ----
  // Sample every sampleSpacing candles, starting after indicators
  // have warmed up. Skip first maPeriod + rsiPeriod candles.
  var warmup = Math.max(maPeriod, rsiPeriod + 1) + 2;
  var available = candles.length - warmup - 1;  // -1 because we look one ahead
  if (available < 10) return defaults;

  // Aim for 20-40 sample points spread across the dataset.
  // Fewer samples = less fitting, more generalizable.
  var targetSamples = Math.min(40, Math.max(10, Math.floor(available / 3)));
  var sampleSpacing = Math.max(3, Math.floor(available / targetSamples));

  // ---- MA SPRING MEASUREMENT ----
  // At each sample, measure how much the price-MA gap closes
  // in one candle. If gap goes from 2% to 1.5%, reversion = 0.25.
  var maReversionSum = 0;
  var maReversionCount = 0;

  // ---- MA CROSSING DYNAMICS ----
  // Track overshoots: when price crosses MA, how far does it go
  // before turning back?
  var overshootSum = 0;
  var overshootCount = 0;
  var crossDecaySum = 0;
  var crossDecayCount = 0;

  // ---- RSI DIRECTION ACCURACY AT DIFFERENT LEVELS ----
  // For each RSI bucket, track how often the next candle moves
  // in the mean-reversion direction. This finds the dead zone.
  var rsiBuckets = {};  // rsi_rounded -> { correct, total }
  for (var rb = 0; rb <= 100; rb += 2) {
    rsiBuckets[rb] = { correct: 0, total: 0 };
  }

  // ---- MA/RSI AGREEMENT ----
  // When both have opinions, which one's direction was right?
  var maCorrectWhenDisagree = 0;
  var rsiCorrectWhenDisagree = 0;
  var disagreeCount = 0;

  // ---- Walk through sample points ----
  for (var si = warmup; si < candles.length - 1; si += sampleSpacing) {
    var curr  = candles[si];
    var next  = candles[si + 1];
    var maVal = sma[si];
    var rsiVal = rsi[si];
    var nextMa = sma[si + 1];

    if (maVal === null || nextMa === null) continue;

    // -- MA spring --
    var gap = (curr.c - maVal) / maVal;   // current gap as ratio
    var nextGap = (next.c - nextMa) / nextMa;

    if (Math.abs(gap) > 0.001) {  // skip tiny gaps (noisy)
      // Reversion: how much did the gap shrink?
      // If gap went from 2% to 1.5%, ratio = 1 - (1.5/2.0) = 0.25
      var reversion = 1.0 - (nextGap / gap);
      // Clamp to reasonable range (can overshoot: reversion > 1.0)
      if (reversion > -0.5 && reversion < 2.0) {
        maReversionSum += reversion;
        maReversionCount++;
      }
    }

    // -- MA crossing detection --
    // Check if price crossed through MA between this candle and next
    if (si + 5 < candles.length) {
      var aboveNow = curr.c > maVal;
      var aboveNext = next.c > (sma[si + 1] || maVal);
      if (aboveNow !== aboveNext) {
        // Crossing happened! Measure overshoot.
        var crossGap = Math.abs(gap);
        var maxOvershoot = 0;
        var decaySteps = 0;
        // Look ahead up to 10 candles for the overshoot peak
        for (var look = 2; look <= Math.min(10, candles.length - si - 1); look++) {
          var futureGap = Math.abs((candles[si + look].c - (sma[si + look] || maVal)) / maVal);
          if (futureGap > maxOvershoot) {
            maxOvershoot = futureGap;
            decaySteps = look;
          }
        }
        if (crossGap > 0.001) {
          overshootSum += maxOvershoot / crossGap;
          overshootCount++;
          crossDecaySum += decaySteps;
          crossDecayCount++;
        }
      }
    }

    // -- RSI direction accuracy per level --
    if (rsiVal !== null && rsiVal > 0 && rsiVal < 100) {
      var rsiBucket = Math.round(rsiVal / 2) * 2;  // round to nearest even
      if (rsiBucket >= 0 && rsiBucket <= 100) {
        var priceDir = next.c > curr.c ? 1 : -1;
        // Mean-reversion direction: RSI > 50 → expect down, RSI < 50 → expect up
        var expectedDir = rsiVal > 50 ? -1 : 1;
        rsiBuckets[rsiBucket].total++;
        if (priceDir === expectedDir) {
          rsiBuckets[rsiBucket].correct++;
        }
      }
    }

    // -- MA/RSI agreement --
    if (maVal !== null && rsiVal !== null) {
      var maDir = gap > 0.001 ? 1 : gap < -0.001 ? -1 : 0;  // MA trend direction
      var rsiDir = rsiVal > 55 ? -1 : rsiVal < 45 ? 1 : 0;   // RSI revert direction
      var actualDir = next.c > curr.c ? 1 : -1;

      if (maDir !== 0 && rsiDir !== 0 && maDir !== rsiDir) {
        // They disagree — who was right?
        disagreeCount++;
        if (maDir === actualDir) maCorrectWhenDisagree++;
        if (rsiDir === actualDir) rsiCorrectWhenDisagree++;
      }
    }
  }

  // ---- Compute calibrated values ----

  // MA spring: average reversion rate, clamped to reasonable range
  var maSpring = defaults.maSpring;
  if (maReversionCount >= 5) {
    maSpring = maReversionSum / maReversionCount;
    // Clamp: negative means trending (anti-reversion), cap at 0.5 (very strong spring)
    if (maSpring < 0.0) maSpring = 0.0;    // trending regime → no spring
    if (maSpring > 0.50) maSpring = 0.50;   // very strong reversion
  }

  // MA overshoot
  var maOvershoot = defaults.maOvershoot;
  if (overshootCount >= 3) {
    maOvershoot = overshootSum / overshootCount;
    if (maOvershoot < 0.5) maOvershoot = 0.5;
    if (maOvershoot > 5.0) maOvershoot = 5.0;
  }

  // MA crossing decay
  var maCrossDecay = defaults.maCrossDecay;
  if (crossDecayCount >= 3) {
    maCrossDecay = Math.round(crossDecaySum / crossDecayCount);
    if (maCrossDecay < 2) maCrossDecay = 2;
    if (maCrossDecay > 15) maCrossDecay = 15;
  }

  // RSI dead zone: find where accuracy drops below 55%
  // Scan outward from RSI=50 in both directions.
  var rsiDeadLow = 30;   // start at traditional oversold
  var rsiDeadHigh = 70;  // start at traditional overbought

  // Scan downward from 50 to find where reversion accuracy > 55%
  for (var rLow = 48; rLow >= 20; rLow -= 2) {
    var bucket = rsiBuckets[rLow];
    if (bucket && bucket.total >= 3) {
      var accuracy = bucket.correct / bucket.total;
      if (accuracy >= 0.55) {
        rsiDeadLow = rLow + 2;  // dead zone ends just above this level
        break;
      }
    }
  }

  // Scan upward from 50 to find where reversion accuracy > 55%
  for (var rHigh = 52; rHigh <= 80; rHigh += 2) {
    var bucket2 = rsiBuckets[rHigh];
    if (bucket2 && bucket2.total >= 3) {
      var accuracy2 = bucket2.correct / bucket2.total;
      if (accuracy2 >= 0.55) {
        rsiDeadHigh = rHigh - 2;  // dead zone ends just below this level
        break;
      }
    }
  }

  // RSI reversion rate: average accuracy outside the dead zone,
  // converted to a force magnitude.
  var rsiOutsideCorrect = 0;
  var rsiOutsideTotal = 0;
  for (var rr = 0; rr <= 100; rr += 2) {
    if (rr < rsiDeadLow || rr > rsiDeadHigh) {
      var bkt = rsiBuckets[rr];
      if (bkt && bkt.total > 0) {
        rsiOutsideCorrect += bkt.correct;
        rsiOutsideTotal += bkt.total;
      }
    }
  }
  var rsiReversion = defaults.rsiReversion;
  if (rsiOutsideTotal >= 5) {
    // Scale: 55% accuracy → 0.01, 70% → 0.04, 80% → 0.06
    var rsiAccuracy = rsiOutsideCorrect / rsiOutsideTotal;
    rsiReversion = Math.max(0.005, (rsiAccuracy - 0.5) * 0.15);
    if (rsiReversion > 0.08) rsiReversion = 0.08;
  }

  // MA vs RSI relative weight
  var maWeight = 0.55;
  var rsiWeight = 0.45;
  if (disagreeCount >= 5) {
    var maWinRate = maCorrectWhenDisagree / disagreeCount;
    var rsiWinRate = rsiCorrectWhenDisagree / disagreeCount;
    var totalWin = maWinRate + rsiWinRate;
    if (totalWin > 0.01) {
      maWeight = maWinRate / totalWin;
      rsiWeight = rsiWinRate / totalWin;
    }
    // Don't let either completely dominate
    if (maWeight < 0.2) { maWeight = 0.2; rsiWeight = 0.8; }
    if (rsiWeight < 0.2) { rsiWeight = 0.2; maWeight = 0.8; }
  }

  var totalSamples = Math.floor(available / sampleSpacing);

  return {
    maSpring:      maSpring,
    maOvershoot:   maOvershoot,
    maCrossDecay:  maCrossDecay,
    rsiDeadLow:    rsiDeadLow,
    rsiDeadHigh:   rsiDeadHigh,
    rsiReversion:  rsiReversion,
    maWeight:      maWeight,
    rsiWeight:     rsiWeight,
    samples:       totalSamples,
    valid:         totalSamples >= 10
  };
}


// ================================================================
// PER-STEP MA EVOLUTION
// ================================================================
// Maintains a running simple moving average that evolves with
// each predicted price. The prediction engine calls stepMA() at
// each iteration to get the current MA-based force AND update
// the running average for the next step.
//
// This replaces the old constant maDrift with a dynamic spring
// that responds to the evolving predicted price path.

// initRunningMA  —  Set up the MA state from visible candles
//
// Parameters:
//   candles  — array of visible candle objects
//   period   — MA period (e.g. 20)
//
// Returns a state object for stepMA().

function initRunningMA(candles, period) {
  var count = candles.length;

  // Build the window of the last 'period' close prices
  var window = [];
  var start = Math.max(0, count - period);
  var sum = 0;
  for (var i = start; i < count; i++) {
    window.push(candles[i].c);
    sum += candles[i].c;
  }

  // If we have fewer candles than the period, pad with the earliest price
  while (window.length < period) {
    var padPrice = window[0];
    window.unshift(padPrice);
    sum += padPrice;
  }

  var maValue = sum / period;

  // Track MA direction (slope) over last few values
  // for crossing momentum assessment
  var prevMa = null;
  if (count > period) {
    var prevSum = 0;
    for (var j = count - period - 1; j < count - 1; j++) {
      if (j >= 0) prevSum += candles[j].c;
    }
    if (count - 1 >= period) prevMa = prevSum / period;
  }

  return {
    window:   window,     // rolling price window (length = period)
    writeIdx: 0,          // circular buffer index
    period:   period,
    sum:      sum,
    maValue:  maValue,    // current MA value
    prevMa:   prevMa,     // previous MA (for slope detection)
    lastPrice: candles[count - 1].c,  // last known price
    crossingAge: -1,      // candles since last MA crossing (-1 = none)
    wasAbove: candles[count - 1].c > maValue  // was price above MA?
  };
}

// stepMA  —  Advance the running MA by one predicted price
//
// Parameters:
//   maState  — state from initRunningMA or previous stepMA call
//   price    — the predicted consensus price for this step
//   profile  — calibration profile from calibrateIndicators()
//   chartH   — chart height in pixels (for force scaling)
//
// Returns a force value in pixel-Y terms:
//   Negative = push price UP (bullish)
//   Positive = push price DOWN (bearish)
//
// Also mutates maState to reflect the new MA value.

function stepMA(maState, price, profile, chartH) {
  // Update the running MA: replace the oldest price in the window
  var oldPrice = maState.window[maState.writeIdx];
  maState.window[maState.writeIdx] = price;
  maState.sum = maState.sum - oldPrice + price;
  maState.writeIdx = (maState.writeIdx + 1) % maState.period;

  // Store previous MA for slope calculation
  maState.prevMa = maState.maValue;
  maState.maValue = maState.sum / maState.period;

  // Gap between price and MA (as ratio)
  var gap = (price - maState.maValue) / (maState.maValue || 1);

  // Detect MA crossing
  var isAbove = price > maState.maValue;
  if (isAbove !== maState.wasAbove) {
    // Just crossed! Reset the crossing age counter.
    maState.crossingAge = 0;
    maState.wasAbove = isAbove;
  } else if (maState.crossingAge >= 0) {
    maState.crossingAge++;
  }

  // ---- SPRING FORCE ----
  // Pull price back toward the MA. Strength proportional to:
  //   1. The gap size (further away = stronger pull)
  //   2. The calibrated spring constant
  //   3. Diminished during post-crossing momentum phase
  //
  // This creates the "rubber band" effect: price stretches away
  // from MA, tension builds, eventually snaps back.
  //
  // Scale factor 1.2: needs to be strong enough to compete with
  // the light force field (typically 1-5 pixels). A 1% gap with
  // maSpring=0.12 and chartH=600 gives ~0.86px — meaningful but
  // not dominant. At 3% gap it's ~2.6px, enough to rein in
  // runaway predictions.

  var springForce = -gap * profile.maSpring * chartH * 1.2;

  // ---- CROSSING MOMENTUM ----
  // After a crossing, price has momentum through the MA.
  // Reduce the spring for a few candles to let the overshoot happen
  // naturally, then gradually restore it.
  if (maState.crossingAge >= 0 && maState.crossingAge < profile.maCrossDecay) {
    var crossFade = maState.crossingAge / profile.maCrossDecay;
    // During early crossing: spring is reduced (let momentum carry)
    // crossFade goes 0 → 1 over maCrossDecay candles
    // Spring multiplier goes 0.2 → 1.0
    var crossMult = 0.2 + 0.8 * crossFade * crossFade;
    springForce *= crossMult;
  }

  // ---- MA SLOPE BIAS ----
  // A rising MA adds a slight upward bias (momentum continuation).
  // A falling MA adds a slight downward bias.
  // This captures the trend-following aspect of MA, not just mean-reversion.
  var maSlope = 0;
  if (maState.prevMa && maState.prevMa > 0) {
    maSlope = (maState.maValue - maState.prevMa) / maState.prevMa;
  }
  // Slope adds a gentle drift: 0.1% MA rise → small upward push
  var slopeBias = -maSlope * chartH * 0.5;

  maState.lastPrice = price;

  // Combine spring + slope, weighted by the profile's MA confidence
  return (springForce + slopeBias) * profile.maWeight;
}


// ================================================================
// PER-STEP RSI EVOLUTION
// ================================================================
// Maintains a running RSI that evolves with each predicted price.
// Uses the standard Wilder smoothing (same as calcRSI in data.js).

// initRunningRSI  —  Set up RSI state from visible candles
//
// Parameters:
//   candles — array of visible candle objects
//   period  — RSI period (e.g. 14)
//
// Returns a state object for stepRSI().

function initRunningRSI(candles, period) {
  var count = candles.length;

  if (count < period + 2) {
    // Not enough data — return a neutral state
    return {
      avgGain:   0,
      avgLoss:   0,
      rsiValue:  50,
      period:    period,
      lastPrice: count > 0 ? candles[count - 1].c : 0,
      valid:     false
    };
  }

  // Compute gains/losses
  var gains = [];
  var losses = [];
  for (var i = 1; i < count; i++) {
    var change = candles[i].c - candles[i - 1].c;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // Initial average gain/loss from first N periods
  var avgGain = 0;
  var avgLoss = 0;
  for (var k = 0; k < period; k++) {
    avgGain += gains[k];
    avgLoss += losses[k];
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth through remaining data (same as calcRSI)
  for (var m = period; m < gains.length; m++) {
    avgGain = (avgGain * (period - 1) + gains[m]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[m]) / period;
  }

  var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  var rsiValue = 100 - (100 / (1 + rs));

  return {
    avgGain:   avgGain,
    avgLoss:   avgLoss,
    rsiValue:  rsiValue,
    period:    period,
    lastPrice: candles[count - 1].c,
    valid:     true
  };
}

// stepRSI  —  Advance the running RSI by one predicted price
//
// Parameters:
//   rsiState — state from initRunningRSI or previous stepRSI call
//   price    — the predicted consensus price for this step
//   profile  — calibration profile from calibrateIndicators()
//   chartH   — chart height in pixels (for force scaling)
//
// Returns a force value in pixel-Y terms:
//   Negative = push price UP (bullish — oversold recovery)
//   Positive = push price DOWN (bearish — overbought reversal)
//
// Also mutates rsiState to reflect the new RSI value.

function stepRSI(rsiState, price, profile, chartH) {
  if (!rsiState.valid) return 0;

  var period = rsiState.period;

  // Update running RSI with the new price
  var change = price - rsiState.lastPrice;
  var gain = change > 0 ? change : 0;
  var loss = change < 0 ? -change : 0;

  rsiState.avgGain = (rsiState.avgGain * (period - 1) + gain) / period;
  rsiState.avgLoss = (rsiState.avgLoss * (period - 1) + loss) / period;

  var rs = rsiState.avgLoss === 0 ? 100 : rsiState.avgGain / rsiState.avgLoss;
  rsiState.rsiValue = 100 - (100 / (1 + rs));
  rsiState.lastPrice = price;

  // ---- DEAD ZONE CHECK ----
  // Inside the calibrated dead zone: no force (noise territory).
  // Outside: mean-reversion force proportional to distance from edge.
  var rsiVal = rsiState.rsiValue;
  var force = 0;

  if (rsiVal > profile.rsiDeadHigh) {
    // Overbought: push DOWN (positive pixel-Y)
    var deviation = rsiVal - profile.rsiDeadHigh;
    force = deviation * profile.rsiReversion * chartH * 0.1;
  } else if (rsiVal < profile.rsiDeadLow) {
    // Oversold: push UP (negative pixel-Y)
    var deviation2 = profile.rsiDeadLow - rsiVal;
    force = -deviation2 * profile.rsiReversion * chartH * 0.1;
  }
  // Inside dead zone: force stays 0

  // Scale by RSI confidence weight
  return force * profile.rsiWeight;
}


// ================================================================
// GLOBAL CALIBRATION CACHE
// ================================================================
// Stores the most recent calibration profile. Computed once when
// animation starts or when explicitly requested. Persists across
// frames but resets when data source changes.
//
// The prediction engine reads from this; only calibrateIndicators
// writes to it.

var indicatorCalibration = null;  // set by runCalibration()

// runCalibration  —  Convenience function called from main.js
//
// Uses backgroundData for the specified asset (or falls back to
// the visible candle data's first half if no background exists).
//
// Parameters:
//   assetKey — "SOL", "BTC", or "ETH"
//
// Stores result in indicatorCalibration and returns it.

function runCalibration(assetKey) {
  var bgCandles = backgroundData[assetKey];

  if (bgCandles && bgCandles.length >= 30) {
    // Best case: calibrate from background (daily/4h/1h) data.
    // This is completely separate from the visible chart.
    indicatorCalibration = calibrateIndicators(bgCandles);
    console.log("[calibrate] Using " + bgCandles.length + " background candles"
              + " → spring:" + indicatorCalibration.maSpring.toFixed(3)
              + " rsiDead:" + indicatorCalibration.rsiDeadLow
              + "-" + indicatorCalibration.rsiDeadHigh
              + " maWt:" + indicatorCalibration.maWeight.toFixed(2)
              + " rsiWt:" + indicatorCalibration.rsiWeight.toFixed(2)
              + " (" + indicatorCalibration.samples + " samples)");
  } else {
    // Fallback: no background data available.
    // Use conservative defaults — don't try to calibrate from
    // the same data we're predicting.
    indicatorCalibration = calibrateIndicators(null);
    console.log("[calibrate] No background data — using defaults");
  }

  return indicatorCalibration;
}
