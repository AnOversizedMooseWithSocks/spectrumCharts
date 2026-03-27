/*
 * ================================================================
 * regime.js  —  Directional Regime Detection & 3-Path Prediction
 * ================================================================
 * Depends on: config.js (CONFIG)
 *
 * PURPOSE:
 *   Detects whether the market is in a bullish, bearish, or neutral
 *   regime, and uses that to drive THREE prediction paths that each
 *   assume a different future:
 *
 *     BULL PATH  — current regime continues bullish
 *     NEUTRAL    — regime weakens toward sideways
 *     BEAR PATH  — current regime continues bearish
 *
 *   The entry regime determines which path gets the most weight in
 *   the consensus. As virtual candles are generated, each path's
 *   running regime is re-evaluated so the weights can shift.
 *
 *
 * WHAT REGIME MEANS:
 *   Regime is NOT the same as volatility. A market can be:
 *     - High vol + bullish (strong rally with big candles)
 *     - Low vol + bearish  (slow grind down)
 *     - High vol + neutral (choppy, no direction)
 *
 *   Regime score: -1.0 (strong bear) to +1.0 (strong bull)
 *   Regime strength: 0.0 (pure neutral) to 1.0 (strong directional)
 *
 *
 * HOW REGIME AFFECTS PREDICTIONS:
 *   Each signal gets a regime bias that shifts its interpretation:
 *
 *   1. MA SPRING ASYMMETRY
 *      Bull: price above MA → weaker spring (trend is normal)
 *            price below MA → stronger spring (dip gets bought)
 *      Bear: price below MA → weaker spring (trend is normal)
 *            price above MA → stronger spring (rally gets sold)
 *
 *   2. MOMENTUM AMPLIFICATION
 *      Bull: bullish momentum amplified, bearish dampened
 *      Bear: bearish momentum amplified, bullish dampened
 *
 *   3. CORRIDOR/LSSA DIRECTIONAL WEIGHTING
 *      Bull: upward-pointing corridors/LSSA weighted more
 *      Bear: downward-pointing corridors/LSSA weighted more
 *
 *
 * USAGE:
 *   // At prediction entry:
 *   var regime = detectRegime(candles, smaValues, rsiValues, avgRange);
 *   var paths = initPaths(regime);
 *   var pathWeights = getPathWeights(regime);
 *
 *   // In step loop, for each path:
 *   var biased = applyRegimeBias(signal, corrSig, lssaSig, path);
 *
 *   // After each virtual candle:
 *   updatePathRegime(path, vcPrice, prevPrice, runningMA);
 *
 * ================================================================
 */


// ================================================================
// REGIME DETECTION — detectRegime
// ================================================================
// Analyzes recent candle history to determine the current directional
// regime. Uses multiple independent signals that each vote on
// direction, then combines them into a single score.
//
// Parameters:
//   candles   — full candle array
//   smaValues — pre-computed SMA array (same length, nulls for warmup)
//   rsiValues — pre-computed RSI array (same length, nulls for warmup)
//   avgRange  — average candle range (for normalization)
//
// Returns: {
//   score:    -1..+1  (negative=bear, positive=bull)
//   strength:  0..1   (how directional — 0=neutral, 1=strong)
//   label:    "bull" / "bear" / "neutral"
// }

function detectRegime(candles, smaValues, rsiValues, avgRange) {
  var count = candles.length;
  if (count < 10) {
    return { score: 0, strength: 0, label: "neutral" };
  }

  var votes = [];  // each vote: { dir: -1..+1, weight: number }

  // ---- VOTE 1: Recent candle direction (last 10 candles) ----
  // What fraction of recent candles were bullish?
  // 80% green = strong bull vote. 50% = neutral. 20% = strong bear.
  var lookback = Math.min(10, count);
  var bullCount = 0;
  for (var i = count - lookback; i < count; i++) {
    if (candles[i].c > candles[i].o) bullCount++;
  }
  var bullFrac = bullCount / lookback;  // 0..1
  var dirVote = (bullFrac - 0.5) * 2;  // -1..+1
  votes.push({ dir: dirVote, weight: 2.0 });

  // ---- VOTE 2: Price vs MA (last candle) ----
  // Above MA = bull bias, below = bear bias.
  // Distance from MA determines strength.
  if (smaValues && smaValues.length >= count) {
    var lastSma = smaValues[count - 1];
    if (lastSma !== null && lastSma > 0 && avgRange > 0) {
      var lastPrice = candles[count - 1].c;
      var maGap = (lastPrice - lastSma) / avgRange;
      // Clamp to -2..+2, then normalize to -1..+1
      var maVote = Math.max(-2, Math.min(2, maGap)) / 2;
      votes.push({ dir: maVote, weight: 2.5 });
    }
  }

  // ---- VOTE 3: Momentum slope (last 10 candles) ----
  // Rate of price change normalized by avgRange.
  var momSlope = (candles[count - 1].c - candles[count - lookback].c) / lookback;
  var momNorm = momSlope / (avgRange + 0.0001);
  var momVote = Math.max(-1, Math.min(1, momNorm * 2));
  votes.push({ dir: momVote, weight: 1.5 });

  // ---- VOTE 4: RSI position ----
  // RSI > 55 = bull territory, < 45 = bear territory.
  // Extreme RSI (>70 or <30) = strong vote.
  if (rsiValues && rsiValues.length >= count) {
    var lastRsi = rsiValues[count - 1];
    if (lastRsi !== null) {
      var rsiVote = 0;
      if (lastRsi > 55) {
        rsiVote = Math.min(1, (lastRsi - 55) / 25);
      } else if (lastRsi < 45) {
        rsiVote = -Math.min(1, (45 - lastRsi) / 25);
      }
      votes.push({ dir: rsiVote, weight: 1.0 });
    }
  }

  // ---- VOTE 5: Recent streak ----
  // Are the last few candles consistently one direction?
  var streak = 0;
  var streakDir = 0;
  for (var si = count - 1; si >= Math.max(0, count - 8); si--) {
    var cDir = candles[si].c > candles[si].o ? 1 : -1;
    if (si === count - 1) {
      streakDir = cDir;
      streak = 1;
    } else if (cDir === streakDir) {
      streak++;
    } else {
      break;
    }
  }
  // Streak of 3+ is meaningful. 6+ is very strong.
  if (streak >= 3) {
    var streakStrength = Math.min(1, (streak - 2) / 4);
    votes.push({ dir: streakDir * streakStrength, weight: 1.5 });
  }

  // ---- VOTE 6: Buy pressure (last 3 candles) ----
  // If recent candles have consistently high or low buy pressure,
  // that's a regime signal.
  var bpSum = 0;
  var bpCount = 0;
  for (var bpi = count - Math.min(3, count); bpi < count; bpi++) {
    if (candles[bpi].buyPressure !== undefined) {
      bpSum += candles[bpi].buyPressure;
      bpCount++;
    }
  }
  if (bpCount > 0) {
    var avgBp = bpSum / bpCount;
    // buyPressure 0..1, 0.5 = neutral
    var bpVote = (avgBp - 0.5) * 2;  // -1..+1
    votes.push({ dir: bpVote, weight: 1.0 });
  }

  // ---- Combine votes into weighted score ----
  var totalDir = 0;
  var totalWeight = 0;
  for (var vi = 0; vi < votes.length; vi++) {
    totalDir += votes[vi].dir * votes[vi].weight;
    totalWeight += votes[vi].weight;
  }
  var score = totalWeight > 0 ? totalDir / totalWeight : 0;

  // Clamp to -1..+1
  if (score > 1) score = 1;
  if (score < -1) score = -1;

  // Strength is the absolute value (how far from neutral)
  var strength = Math.abs(score);

  // Label
  var label = "neutral";
  if (score > 0.15) label = "bull";
  else if (score < -0.15) label = "bear";

  return {
    score: score,
    strength: strength,
    label: label
  };
}


// ================================================================
// PATH DEFINITIONS — initPaths
// ================================================================
// Creates the 3 prediction paths, each with a different regime
// assumption and appropriate corridor/LSSA weighting.
//
// Each path's "assumption" determines how it biases the pipeline
// signal and how much it trusts directional post-pipeline forces.
//
// Parameters:
//   entryRegime — from detectRegime()
//
// Returns: array of 3 path config objects

function initPaths(entryRegime) {
  // Each path has:
  //   name          — display name
  //   assumption    — "bull", "neutral", or "bear"
  //   regimeBias    — how much to shift signals toward this assumption
  //                   (0 = no shift, 1 = full shift)
  //   corrWeight    — corridor trust (post-pipeline)
  //   lssaWeight    — LSSA trust (post-pipeline)
  //
  // The entry regime FLIPS what "continuation" means:
  //   In a bull market: bull path = continuation, bear = reversal
  //   In a bear market: bear path = continuation, bull = reversal
  //   Continuation paths get slightly higher corridor trust
  //   (corridors tend to trace the path of least resistance, which
  //   aligns with the prevailing trend).

  var isBull = entryRegime.score > 0.15;
  var isBear = entryRegime.score < -0.15;

  return [
    {
      name: "Bull",
      assumption: "bull",
      regimeBias: 0.6,
      // In a bull regime, bull path follows corridors more (continuation)
      // In a bear regime, bull path is the contrarian — less corridor trust
      corrWeight: isBull ? 0.35 : isBear ? 0.15 : 0.25,
      lssaWeight: 0.15
    },
    {
      name: "Neutral",
      assumption: "neutral",
      regimeBias: 0.0,
      // Neutral path always has balanced corridor/LSSA trust
      corrWeight: 0.25,
      lssaWeight: 0.15
    },
    {
      name: "Bear",
      assumption: "bear",
      regimeBias: 0.6,
      // Mirror of bull path
      corrWeight: isBear ? 0.35 : isBull ? 0.15 : 0.25,
      lssaWeight: 0.15
    }
  ];
}


// ================================================================
// PATH WEIGHTS — getPathWeights
// ================================================================
// The entry regime determines how much to trust each path's
// assumption. A strong bull regime heavily favors the bull path.
// A neutral regime spreads weight more evenly.
//
// Parameters:
//   entryRegime       — from detectRegime()
//   pipelineConfidence — 0..1 from querySignalLayers (optional)
//
// Returns: array of 3 weights (sums to 1.0)

function getPathWeights(entryRegime, pipelineConfidence) {
  var s = entryRegime.score;     // -1..+1
  var str = entryRegime.strength; // 0..1

  // Scale regime strength by pipeline confidence.
  // If the pipeline is uncertain, flatten the path weights toward
  // even — hedge the bet across all three paths.
  var confScale = 1.0;
  if (pipelineConfidence !== undefined && pipelineConfidence < 0.7) {
    // Below 70% confidence: progressively flatten.
    // At 0% confidence → confScale = 0.15 (almost even weights)
    // At 70% → confScale = 1.0 (full regime-driven weights)
    confScale = 0.15 + (pipelineConfidence / 0.7) * 0.85;
  }
  var effectiveStr = str * confScale;

  // Base weights: even split
  var bullW  = 0.333;
  var neutW  = 0.334;
  var bearW  = 0.333;

  // Shift weight toward the regime direction.
  // At full strength (str=1), the dominant path gets ~55%,
  // neutral gets ~30%, opposite gets ~15%.
  // At zero strength, all paths stay ~33%.
  if (s > 0) {
    // Bullish: shift weight from bear to bull
    var shift = effectiveStr * 0.25;
    bullW += shift;
    bearW -= shift * 0.6;
    neutW -= shift * 0.4;
  } else if (s < 0) {
    // Bearish: shift weight from bull to bear
    var shiftB = effectiveStr * 0.25;
    bearW += shiftB;
    bullW -= shiftB * 0.6;
    neutW -= shiftB * 0.4;
  }

  // Floor: no path below 10% (a reversal can always happen)
  if (bullW < 0.10) bullW = 0.10;
  if (neutW < 0.10) neutW = 0.10;
  if (bearW < 0.10) bearW = 0.10;

  // Normalize to 1.0
  var total = bullW + neutW + bearW;
  return [bullW / total, neutW / total, bearW / total];
}


// ================================================================
// REGIME BIAS — applyRegimeBias
// ================================================================
// Modifies the combined signal (pipeline + post-pipeline) based
// on this path's regime assumption.
//
// The bias works by:
//   1. ASYMMETRIC SPRING: Makes the signal respond differently to
//      bullish vs bearish components based on the assumption.
//   2. DIRECTIONAL AMPLIFICATION: Signals aligned with the assumption
//      get a small boost; opposing signals get dampened.
//
// Parameters:
//   signal      — the combined signal from pipeline + corridor/LSSA
//   maSig       — raw MA signal (for asymmetric spring)
//   maGapRanges — how far from MA (for context)
//   corrSig     — corridor signal (for directional weighting)
//   lssaSig     — LSSA signal (for directional weighting)
//   path        — path config (from initPaths)
//   entryRegime — from detectRegime()
//
// Returns: modified signal (same -1..+1 range)

function applyRegimeBias(signal, maSig, maGapRanges, corrSig, lssaSig, path, entryRegime, pipelineConfidence) {
  if (path.assumption === "neutral") {
    // Neutral path: no bias applied. Pure pipeline output.
    return signal;
  }

  // Regime direction: +1 for bull assumption, -1 for bear
  var regDir = path.assumption === "bull" ? -1 : 1;
  // NOTE: regDir uses SIGNAL convention (negative = price up = bullish)

  // Bias strength scales with path's regimeBias, entry regime strength,
  // AND pipeline confidence. Low confidence → softer bias → paths
  // converge (the visual spread narrows as uncertainty increases).
  var confFactor = 1.0;
  if (pipelineConfidence !== undefined && pipelineConfidence < 0.7) {
    confFactor = 0.2 + (pipelineConfidence / 0.7) * 0.8;
  }
  var biasStr = path.regimeBias * Math.max(0.3, entryRegime.strength) * confFactor;

  // ---- 1. ASYMMETRIC MA SPRING ----
  // In a bull assumption, price above MA is "normal" — reduce the
  // spring pulling it back down. Price below MA is "a dip to buy" —
  // increase the spring pulling it back up.
  //
  // maSig > 0 = price above MA, spring pulling down
  // maSig < 0 = price below MA, spring pulling up
  //
  // We don't modify maSig directly (it's already baked into the
  // pipeline signal). Instead, we add a small directional nudge
  // that partially counteracts the spring in the trend direction.
  var maAdjust = 0;
  if (Math.abs(maSig) > 0.05) {
    // For bull: when maSig > 0 (above MA, spring pulling down),
    // add a small upward counterforce. Signal is inverted.
    var springOpposesRegime = (maSig > 0 && regDir < 0) || (maSig < 0 && regDir > 0);
    if (springOpposesRegime) {
      // Spring is pulling against our assumed regime direction.
      // Reduce its effect by adding a counter-nudge.
      // Stronger when price is close to MA (small gap),
      // weaker when far away (let the spring win at extremes).
      var gapFade = 1.0 / (1 + Math.abs(maGapRanges));
      maAdjust = regDir * Math.abs(maSig) * 0.3 * biasStr * gapFade;
    }
  }

  // ---- 2. DIRECTIONAL AMPLIFICATION ----
  // Signals already pointing in our assumed direction get a boost.
  // Signals opposing it get dampened. This is subtle — just 15-20%
  // at full bias — enough to create path divergence without
  // overriding the pipeline's terrain reading.
  var ampFactor = 1.0;
  var signalMatchesRegime = (signal < -0.02 && regDir < 0) || (signal > 0.02 && regDir > 0);
  var signalOpposesRegime = (signal < -0.02 && regDir > 0) || (signal > 0.02 && regDir < 0);
  if (signalMatchesRegime) {
    ampFactor = 1.0 + biasStr * 0.20;  // up to 20% boost
  } else if (signalOpposesRegime) {
    ampFactor = 1.0 - biasStr * 0.15;  // up to 15% dampen
  }

  var result = signal * ampFactor + maAdjust;

  // Clamp
  if (result > 1) result = 1;
  if (result < -1) result = -1;

  return result;
}


// ================================================================
// PER-STEP REGIME RE-EVALUATION — initRunningRegime / updatePathRegime
// ================================================================
// Tracks regime state per-path as virtual candles are generated.
// After each step, the virtual candle's direction and position
// update a rolling regime assessment.
//
// If the bull path generates several bearish candles, that's a
// signal the bull assumption may be weakening — and the path
// weights should shift.

function initRunningRegime(entryRegime) {
  return {
    score: entryRegime.score,
    strength: entryRegime.strength,
    bullCandles: 0,     // count of bullish virtual candles
    bearCandles: 0,     // count of bearish virtual candles
    totalCandles: 0,
    streak: 0,          // current same-direction streak
    streakDir: 0,       // direction of current streak
    cumulativeMove: 0   // net price change from entry
  };
}

// Called after each virtual candle to update the running regime.
//
// Parameters:
//   state     — from initRunningRegime()
//   vcClose   — virtual candle close price
//   vcOpen    — virtual candle open price
//   entryPrice — original entry price (for cumulative move)
//   runningMA — current running MA value (or null)

function updatePathRegime(state, vcClose, vcOpen, entryPrice, runningMA) {
  var isBull = vcClose > vcOpen;
  state.totalCandles++;
  if (isBull) state.bullCandles++;
  else state.bearCandles++;

  // Update streak
  var dir = isBull ? 1 : -1;
  if (dir === state.streakDir) {
    state.streak++;
  } else {
    state.streakDir = dir;
    state.streak = 1;
  }

  // Cumulative move from entry
  state.cumulativeMove = vcClose - entryPrice;

  // Recompute score from the virtual candle history.
  // This is a lightweight version of detectRegime using only
  // the virtual candle data.
  var bullFrac = state.totalCandles > 0
    ? state.bullCandles / state.totalCandles : 0.5;
  var vcDirVote = (bullFrac - 0.5) * 2;  // -1..+1

  // MA position vote (if available)
  var maVote = 0;
  if (runningMA && runningMA > 0) {
    var maGap = vcClose - runningMA;
    maVote = Math.max(-1, Math.min(1, maGap * 5));
  }

  // Cumulative move vote
  var cumVote = 0;
  if (entryPrice > 0) {
    var cumPct = state.cumulativeMove / entryPrice;
    cumVote = Math.max(-1, Math.min(1, cumPct * 50));
  }

  // Blend: heavier weight on recent direction (vcDirVote)
  state.score = vcDirVote * 0.5 + maVote * 0.3 + cumVote * 0.2;
  if (state.score > 1) state.score = 1;
  if (state.score < -1) state.score = -1;
  state.strength = Math.abs(state.score);
}


// ================================================================
// DYNAMIC PATH WEIGHT ADJUSTMENT — adjustPathWeights
// ================================================================
// After several steps, the running regimes may show that one path's
// assumption is playing out better than the others. Shift weights
// toward the path whose assumption matches reality.
//
// Parameters:
//   baseWeights    — from getPathWeights() (array of 3)
//   runningRegimes — array of 3 running regime states
//   minSteps       — don't adjust until this many steps (default 3)
//
// Returns: adjusted weights (array of 3, sums to 1.0)

function adjustPathWeights(baseWeights, runningRegimes, minSteps) {
  if (!minSteps) minSteps = 3;

  // Don't adjust until we have enough virtual candles
  if (!runningRegimes || !runningRegimes[0] ||
      runningRegimes[0].totalCandles < minSteps) {
    return baseWeights.slice();
  }

  // Score each path: does the running regime match the assumption?
  // Bull path (idx 0): running score > 0 = matching
  // Neutral path (idx 1): running score near 0 = matching
  // Bear path (idx 2): running score < 0 = matching
  var matchScores = [0, 0, 0];

  // Bull path match: how positive is the running regime?
  matchScores[0] = (runningRegimes[0].score + 1) / 2;  // 0..1
  // Neutral path match: how close to zero?
  matchScores[1] = 1.0 - Math.abs(runningRegimes[1].score);  // 0..1
  // Bear path match: how negative is the running regime?
  matchScores[2] = (1 - runningRegimes[2].score) / 2;  // 0..1

  // Blend match scores into base weights.
  // Match score influence grows with step count (more data = more trust).
  var stepConfidence = Math.min(1.0, runningRegimes[0].totalCandles / 15);
  var blendFactor = stepConfidence * 0.3;  // max 30% adjustment

  var adjusted = [];
  for (var wi = 0; wi < 3; wi++) {
    adjusted.push(baseWeights[wi] * (1 - blendFactor) + matchScores[wi] * blendFactor);
  }

  // Floor
  for (var fi = 0; fi < 3; fi++) {
    if (adjusted[fi] < 0.08) adjusted[fi] = 0.08;
  }

  // Normalize
  var total = adjusted[0] + adjusted[1] + adjusted[2];
  for (var ni = 0; ni < 3; ni++) {
    adjusted[ni] /= total;
  }

  return adjusted;
}


// ================================================================
// DIAGNOSTICS — getRegimeDiagnostics
// ================================================================
// Returns a summary for the UI overlay.

function getRegimeDiagnostics(entryRegime, pathWeights, runningRegimes) {
  return {
    entryScore:  entryRegime.score,
    entryLabel:  entryRegime.label,
    entryStrength: entryRegime.strength,
    weights: {
      bull:    pathWeights[0],
      neutral: pathWeights[1],
      bear:    pathWeights[2]
    },
    running: runningRegimes ? {
      bull:    runningRegimes[0] ? runningRegimes[0].score : 0,
      neutral: runningRegimes[1] ? runningRegimes[1].score : 0,
      bear:    runningRegimes[2] ? runningRegimes[2].score : 0
    } : null
  };
}
