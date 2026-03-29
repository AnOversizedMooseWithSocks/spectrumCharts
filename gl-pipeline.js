/*
 * ================================================================
 * gl-pipeline.js  —  Unified GPU Beam + Heatmap Pipeline
 * ================================================================
 * Replaces: gl-beams.js + webgl-heatmap.js
 * Depends on: config.js (state)
 *             Must be loaded BEFORE heatmap.js
 *
 * ARCHITECTURE — why this is fast:
 *
 * The old pipeline had THREE fatal performance problems:
 *
 *   1. PER-FRAGMENT OCCLUSION MARCH: the beam fragment shader
 *      walked up to 800 texelFetch steps for every single pixel.
 *      At resolution=1 on 1920×1080, that's 2 million fragments
 *      per beam quad × 800 steps × thousands of beams = billions
 *      of texture reads. Three.js shadow maps do O(1) per fragment.
 *
 *   2. GPU→CPU→GPU ROUND-TRIP: beam FBO rendered on an offscreen
 *      WebGL context → synchronous readPixels (stall) → CPU Y-flip
 *      unpack → repack into float texture → upload to a DIFFERENT
 *      WebGL context → render. All the data bounced to main memory
 *      and back for no reason.
 *
 *   3. RESOLUTION = FRAGMENT COUNT: resolution=1 meant the grid
 *      had ~2M cells, so every GPU and CPU operation scaled with it.
 *
 * THE FIX — three changes that work together:
 *
 *   1. CPU BEAM SEGMENTATION: march ONCE per beam on CPU. Split
 *      each beam at candle crossings, pre-compute intensity for
 *      each segment. A beam crossing 3 candles becomes 4 segments.
 *      This is O(beam_length) per beam, done once. The GPU fragment
 *      shader becomes trivial: perpendicular falloff + one
 *      texelFetch for candle interior check. No loop, no march.
 *      ~5 ALU ops per fragment instead of ~800 texture reads.
 *
 *   2. SINGLE WEBGL2 CONTEXT: beam accumulation renders into FBO.
 *      Display pass reads FBO texture directly with a color-mapping
 *      shader. No readPixels for display. For physics (prediction
 *      engine), readback only happens when requested.
 *
 *   3. BILINEAR UPSCALE: computation runs at whatever resolution
 *      the slider says. Display upscales with GL_LINEAR filtering
 *      so even coarse grids look smooth on screen.
 *
 * RESULT: the GPU does what GPUs are good at (simple math on
 * millions of pixels) instead of what they're bad at (long serial
 * texture-fetch loops in the fragment shader).
 * ================================================================
 */


// ----------------------------------------------------------------
// STATE — single WebGL2 context, shared resources
// ----------------------------------------------------------------
var glPipeline = {
  canvas:       null,    // offscreen <canvas>
  gl:           null,    // WebGL2 context

  // ---- Beam accumulation pass ----
  beamProg:     null,    // shader program for beam segments
  beamFBO:      null,    // framebuffer (render target)
  beamFBOTex:   null,    // RGBA32F color attachment
  occTex:       null,    // R16UI occlusion grid texture
  attenTex:     null,    // R32F attenuation (shadow map) texture
  beamVAO:      null,    // vertex array (quad + instances)
  quadBuf:      null,    // base quad vertices
  idxBuf:       null,    // quad triangle indices
  instanceBuf:  null,    // instance buffer for segment params
  // Beam uniforms
  uBCols:       null,
  uBRows:       null,
  uBOpacity:    null,    // (kept for candle-interior skip logic)
  uBHalfWidth:  null,

  // ---- Display pass (color mapping) ----
  dispProg:     null,    // shader program for color mapping
  dispVAO:      null,    // VAO for fullscreen triangle
  uDRefVal:     null,
  uDAccent:     null,
  uDUseAccent:  null,

  // ---- PBO for async readback ----
  pbo:          null,    // pixel buffer object
  pboFence:     null,    // sync fence for async readback
  pboReady:     false,   // true when PBO data is available
  pboCols:      0,       // dimensions of last PBO readback
  pboRows:      0,

  // ---- Tracking ----
  ready:        false,
  lastCols:     0,       // FBO dimensions (detect resize)
  lastRows:     0,
  maxSegments:  0,       // instance buffer capacity
  callCount:    0,
  tooSlow:      false,
};


// ================================================================
// HISTOGRAM-BASED PERCENTILE (replaces the deadly sort)
// ================================================================
// The old renderHeatmap did this EVERY FRAME:
//   1. Push all non-zero values from 4 grids into a JS array
//   2. Sort the entire array
//   3. Pick the 85th percentile element
//
// At res=1 (2M cells), that's 8M scans + sort of ~4M values
// = 200-400ms PER FRAME. This was the single biggest bottleneck.
//
// This function does the same thing in O(n) with zero allocation:
//   1. Find max value (one pass)
//   2. Bin into 1024 histogram buckets (one pass)
//   3. Walk buckets to find 85th percentile
//
// Called ONCE at build time, result cached in the heatmap object.
// renderHeatmap reads the cached value — zero per-frame cost.

function _computeRefVal(grids, cellCount) {
  var BIN_COUNT = 1024;

  // Pass 1: find max across all 4 grids
  var maxVal = 0;
  for (var gi = 0; gi < 4; gi++) {
    var g = grids[gi];
    for (var i = 0; i < cellCount; i++) {
      if (g[i] > maxVal) maxVal = g[i];
    }
  }
  if (maxVal < 0.01) return 1.0;

  // Pass 2: bin all non-zero values into histogram
  var bins = new Uint32Array(BIN_COUNT);
  var scale = (BIN_COUNT - 1) / maxVal;
  var totalNonZero = 0;

  for (var gi2 = 0; gi2 < 4; gi2++) {
    var g2 = grids[gi2];
    for (var i2 = 0; i2 < cellCount; i2++) {
      var v = g2[i2];
      if (v > 0.01) {
        bins[(v * scale) | 0]++;
        totalNonZero++;
      }
    }
  }
  if (totalNonZero === 0) return 1.0;

  // Walk bins to find 85th percentile
  var target = Math.floor(totalNonZero * 0.85);
  var cumulative = 0;
  for (var b = 0; b < BIN_COUNT; b++) {
    cumulative += bins[b];
    if (cumulative >= target) {
      var refVal = (b + 0.5) / scale;
      return refVal * 2.0;  // include 2× display dimming factor
    }
  }

  return maxVal * 2.0;
}


// ================================================================
// ATTENUATION TEXTURE (the "shadow map")
// ================================================================
// For each grid cell, stores the cumulative light survival factor
// from the left edge. A beam's attenuation from source to fragment
// = atten[fragment] / atten[source]. This is the prefix-product
// trick: range product = prefix[B] / prefix[A].
//
// Built on CPU with a single left-to-right sweep per row: O(cols×rows).
// At res=1 (1920×1080): ~2M iterations ≈ 2-3ms. Then uploaded as a
// float texture. The GPU beam shader does ONE lookup per fragment.
//
// This replaces the entire CPU segmentBeams march AND the old
// per-fragment occlusion loop. No per-beam marching anywhere.

var _attenBuf = null;     // Float32Array for the attenuation data
var _attenBufSize = 0;    // current capacity

function buildAttenTexture(occGrid, cols, rows, opacity) {
  var cellCount = cols * rows;
  if (cellCount !== _attenBufSize) {
    _attenBuf = new Float32Array(cellCount);
    _attenBufSize = cellCount;
  }

  var factor = 1.0 - opacity;

  // Sweep each row left to right. When we encounter a new candle
  // body (different ID from the last one), multiply the running
  // product by (1-opacity). Store the running product at each cell.
  for (var y = 0; y < rows; y++) {
    var rowOff = y * cols;
    var atten = 1.0;
    var lastCandle = 0;  // 0 = no candle

    for (var x = 0; x < cols; x++) {
      var cellId = occGrid[rowOff + x];
      if (cellId > 0 && cellId !== lastCandle) {
        // New candle crossing — attenuate
        atten *= factor;
        lastCandle = cellId;
      } else if (cellId === 0) {
        lastCandle = 0;  // reset when we leave a candle
      }
      _attenBuf[rowOff + x] = atten;
    }
  }

  return _attenBuf;
}


// ================================================================
// CPU BEAM SEGMENTATION (legacy fallback)
// ================================================================
// Kept for CPU fallback path. The GPU attenuation texture path
// (gpuAccumBeamsDirect) eliminates the need for segmentation.
// This is only used when the GPU pipeline isn't available.

var _segBuf      = null;   // reusable Float32Array
var _segBufCap   = 0;      // capacity in segments

function segmentBeams(beamData, beamCount, occGrid, cols, rows, opacity, candleStepHint) {
  // candleStepHint: approximate candle width in grid cells.
  // At res=1 with 50 candles on 1920px, candles are ~38 cells wide.
  // At res=6, they're ~6 cells wide.
  // Step by max(1, hint/3) — enough resolution to catch thin candles
  // but avoids checking 38 identical cells per candle at fine res.
  // This makes segmentation ~3× faster at res=1.
  var marchStep = 1;
  if (candleStepHint && candleStepHint > 3) {
    marchStep = Math.max(1, Math.floor(candleStepHint / 3));
  }

  var estSegments = beamCount * 4;
  if (estSegments > _segBufCap) {
    _segBufCap = Math.max(estSegments, Math.ceil(_segBufCap * 1.5));
    _segBuf = new Float32Array(_segBufCap * 7);
  }

  var segCount = 0;
  var attenFactor = 1.0 - opacity;

  for (var b = 0; b < beamCount; b++) {
    var off = b * 7;
    var x1        = beamData[off];
    var y1        = beamData[off + 1];
    var x2        = beamData[off + 2];
    var y2        = beamData[off + 3];
    var intensity = beamData[off + 4];
    var gridIdx   = beamData[off + 5];
    var skipSrcId = beamData[off + 6];

    var dx = x2 - x1;
    var dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;

    var ndx = dx / len;
    var ndy = dy / len;

    // Adaptive step: march by marchStep cells instead of 1.
    // At res=1 with 38-cell candles, steps by ~12 cells.
    var steps = Math.ceil(len / marchStep);
    if (steps > 2000) steps = 2000;
    var stepDist = len / steps;

    var currentIntensity = intensity;
    var lastOccCandle = -1;
    var segStartX = x1;
    var segStartY = y1;
    var skipId = skipSrcId | 0;

    for (var s = 0; s <= steps; s++) {
      var dist = s * stepDist;
      var px = x1 + ndx * dist;
      var py = y1 + ndy * dist;
      var gx = px | 0;
      var gy = py | 0;

      if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
        var cellId = occGrid[gy * cols + gx];
        if (cellId > 0 && cellId !== skipId && cellId !== lastOccCandle) {
          // Candle crossing! Emit the segment up to here.
          if (currentIntensity > 0.005) {
            // Grow buffer if needed
            if (segCount >= _segBufCap) {
              _segBufCap = Math.ceil(_segBufCap * 1.5);
              var newBuf = new Float32Array(_segBufCap * 7);
              newBuf.set(_segBuf);
              _segBuf = newBuf;
            }

            var sOff = segCount * 7;
            _segBuf[sOff]     = segStartX;
            _segBuf[sOff + 1] = segStartY;
            _segBuf[sOff + 2] = px;
            _segBuf[sOff + 3] = py;
            _segBuf[sOff + 4] = currentIntensity;
            _segBuf[sOff + 5] = gridIdx;
            _segBuf[sOff + 6] = skipSrcId;
            segCount++;
          }

          // Attenuate and start new segment
          currentIntensity *= attenFactor;
          lastOccCandle = cellId;
          segStartX = px;
          segStartY = py;

          if (currentIntensity < 0.005) break;
        }
      }
    }

    // Emit the final segment (from last crossing to beam end)
    if (currentIntensity > 0.005) {
      if (segCount >= _segBufCap) {
        _segBufCap = Math.ceil(_segBufCap * 1.5);
        var newBuf2 = new Float32Array(_segBufCap * 7);
        newBuf2.set(_segBuf);
        _segBuf = newBuf2;
      }

      var fOff = segCount * 7;
      _segBuf[fOff]     = segStartX;
      _segBuf[fOff + 1] = segStartY;
      _segBuf[fOff + 2] = x2;
      _segBuf[fOff + 3] = y2;
      _segBuf[fOff + 4] = currentIntensity;
      _segBuf[fOff + 5] = gridIdx;
      _segBuf[fOff + 6] = skipSrcId;
      segCount++;
    }
  }

  return { segments: _segBuf, count: segCount };
}


// ================================================================
// SHADER SOURCE — Beam Accumulation (pre-segmented, no march)
// ================================================================
// CPU segments beams at candle crossings. Each segment has
// pre-computed intensity. Fragment shader just does perpendicular
// falloff + one texelFetch for candle interior skip.

var PIPE_BEAM_VS = [
  "#version 300 es",
  "",
  "layout(location = 0) in vec2 aPos;",
  "layout(location = 1) in vec4 aStartEnd;",
  "layout(location = 2) in vec3 aParams;",
  "",
  "uniform float uCols;",
  "uniform float uRows;",
  "uniform float uHalfWidth;",
  "",
  "out float vPerpNorm;",
  "out float vT;",
  "flat out float vIntensity;",
  "flat out float vGridIdx;",
  "flat out float vSkipSrcId;",
  "flat out vec2  vFragBase;",
  "flat out vec2  vBeamDir;",
  "flat out float vBeamLen;",
  "",
  "void main() {",
  "  vec2 start = aStartEnd.xy;",
  "  vec2 end   = aStartEnd.zw;",
  "  vec2 dir   = end - start;",
  "  float len  = length(dir);",
  "",
  "  if (len < 0.25) {",
  "    gl_Position = vec4(-9.0, -9.0, 0.0, 1.0);",
  "    return;",
  "  }",
  "",
  "  vec2 norm = dir / len;",
  "  vec2 perp = vec2(-norm.y, norm.x);",
  "  float expandedHW = uHalfWidth + 1.0;",
  "",
  "  vec2 pos = start + norm * (aPos.x * len)",
  "                   + perp * (aPos.y * expandedHW);",
  "",
  "  gl_Position = vec4(",
  "    pos.x / uCols * 2.0 - 1.0,",
  "    1.0 - pos.y / uRows * 2.0,",
  "    0.0, 1.0",
  "  );",
  "",
  "  vT         = aPos.x;",
  "  vPerpNorm  = aPos.y;",
  "  vIntensity = aParams.x;",
  "  vGridIdx   = aParams.y;",
  "  vSkipSrcId = aParams.z;",
  "  vFragBase  = start;",
  "  vBeamDir   = norm;",
  "  vBeamLen   = len;",
  "}",
].join("\n");


// Fragment shader: O(1) per fragment. No loop. No march.
// Intensity is pre-computed by CPU segmentation.
// Just perpendicular falloff + one texelFetch for candle skip.

var PIPE_BEAM_FS = [
  "#version 300 es",
  "precision highp float;",
  "precision highp usampler2D;",
  "",
  "uniform usampler2D uOccGrid;",
  "uniform float uCols;",
  "uniform float uRows;",
  "uniform float uHalfWidth;",
  "",
  "in float vPerpNorm;",
  "in float vT;",
  "flat in float vIntensity;",
  "flat in float vGridIdx;",
  "flat in float vSkipSrcId;",
  "flat in vec2  vFragBase;",
  "flat in vec2  vBeamDir;",
  "flat in float vBeamLen;",
  "",
  "out vec4 fragColor;",
  "",
  "void main() {",
  "  float expandedHW = uHalfWidth + 1.0;",
  "",
  "  // Perpendicular falloff (quadratic)",
  "  float perpDist = abs(vPerpNorm) * expandedHW;",
  "  float distNorm = perpDist / expandedHW;",
  "  float falloff  = 1.0 - distNorm * distNorm;",
  "  if (falloff <= 0.0) discard;",
  "",
  "  // Fragment position in grid space",
  "  vec2 fragPos = vFragBase + vBeamDir * (vT * vBeamLen)",
  "              + vec2(-vBeamDir.y, vBeamDir.x) * (vPerpNorm * expandedHW);",
  "  int fgx = int(fragPos.x);",
  "  int fgy = int(fragPos.y);",
  "",
  "  // Candle interior skip (one texelFetch)",
  "  int skipId = int(vSkipSrcId);",
  "  if (fgx >= 0 && fgx < int(uCols) && fgy >= 0 && fgy < int(uRows)) {",
  "    uint cellId = texelFetch(uOccGrid, ivec2(fgx, fgy), 0).r;",
  "    if (cellId > 0u && int(cellId) != skipId) discard;",
  "  }",
  "",
  "  // Intensity is PRE-COMPUTED by CPU segmentation. No march.",
  "  float value = vIntensity * falloff;",
  "  if (value < 0.001) discard;",
  "",
  "  int idx = int(vGridIdx);",
  "  fragColor = vec4(0.0);",
  "  if      (idx == 0) fragColor.r = value;",
  "  else if (idx == 1) fragColor.g = value;",
  "  else if (idx == 2) fragColor.b = value;",
  "  else               fragColor.a = value;",
  "}",
].join("\n");


// ================================================================
// SHADER SOURCE — Display Pass (color mapping)
// ================================================================
// Reads the beam FBO texture (still on GPU, no readback needed),
// maps each RGBA channel to its display color, outputs to canvas.

var PIPE_DISP_VS = [
  "#version 300 es",
  "void main() {",
  "  // Fullscreen triangle: 3 vertices cover the entire screen",
  "  vec2 pos = vec2(gl_VertexID % 2, gl_VertexID / 2) * 2.0;",
  "  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);",
  "}",
].join("\n");

var PIPE_DISP_FS = [
  "#version 300 es",
  "precision mediump float;",
  "",
  "uniform sampler2D uBeamTex;     // beam FBO (RGBA32F)",
  "uniform float uRefVal;          // normalization reference",
  "uniform bool uUseAccent;        // multi-asset tinting",
  "uniform vec3 uAccent;           // accent color",
  "",
  "out vec4 fragColor;",
  "",
  "vec3 applyRamp(float raw, vec3 baseCol) {",
  "  return baseCol * raw * 0.4;",
  "}",
  "",
  "void main() {",
  "  // Sample the beam FBO texture with BILINEAR filtering.",
  "  // NO Y-flip needed: the beam vertex shader already maps",
  "  // grid y=0 to clip y=+1 (top of FBO texture). The FBO",
  "  // and canvas share the same orientation.",
  "  ivec2 texSize = textureSize(uBeamTex, 0);",
  "  vec2 uv = gl_FragCoord.xy / vec2(texSize);",
  "",
  "  vec4 packed = texture(uBeamTex, uv);",
  "",
  "  // Normalize by reference value",
  "  float invRef = 1.0 / uRefVal;",
  "  float greenVal  = packed.r * invRef;",
  "  float yellowVal = packed.g * invRef;",
  "  float blueVal   = packed.b * invRef;",
  "  float redVal    = packed.a * invRef;",
  "",
  "  float total = greenVal + yellowVal + blueVal + redVal;",
  "  if (total < 0.001) discard;",
  "",
  "  vec3 color;",
  "  if (uUseAccent) {",
  "    float scale = min(total * 0.4, 1.0);",
  "    color = uAccent * scale;",
  "  } else {",
  "    vec3 cGreen  = vec3(0.118, 0.863, 0.353);",
  "    vec3 cYellow = vec3(0.941, 0.784, 0.157);",
  "    vec3 cBlue   = vec3(0.157, 0.549, 1.000);",
  "    vec3 cRed    = vec3(0.941, 0.196, 0.196);",
  "",
  "    color = applyRamp(greenVal, cGreen)",
  "         + applyRamp(yellowVal, cYellow)",
  "         + applyRamp(blueVal, cBlue)",
  "         + applyRamp(redVal, cRed);",
  "  }",
  "",
  "  // Reinhard tone mapping: compress any brightness into 0..1",
  "  // while preserving color ratios (= hue). 1.6 gain compensates",
  "  // for Reinhard dimming at low intensities.",
  "  color = color / (1.0 + color) * 1.6;",
  "  color = min(color, vec3(1.0));",
  "  fragColor = vec4(color, 0.6);",
  "}",
].join("\n");


// ================================================================
// HELPER: compile a shader, return it or null on failure
// ================================================================
function _pipeCompile(gl, type, source, label) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[gl-pipeline] " + label + " error:", gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function _pipeLink(gl, vs, fs, label) {
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[gl-pipeline] " + label + " link error:", gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}


// ================================================================
// INITIALIZATION — single context, two shader programs
// ================================================================

function initGLPipeline() {
  try {
    glPipeline.canvas = document.createElement("canvas");
    var gl = glPipeline.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      console.warn("[gl-pipeline] WebGL2 not available");
      return false;
    }

    // Float FBO support required
    var floatExt = gl.getExtension("EXT_color_buffer_float");
    if (!floatExt) {
      console.warn("[gl-pipeline] EXT_color_buffer_float not available");
      return false;
    }

    // Also need float texture filtering for bilinear display upscale
    gl.getExtension("OES_texture_float_linear");

    glPipeline.gl = gl;

    // ---- Compile beam accumulation program ----
    var bvs = _pipeCompile(gl, gl.VERTEX_SHADER, PIPE_BEAM_VS, "beam VS");
    var bfs = _pipeCompile(gl, gl.FRAGMENT_SHADER, PIPE_BEAM_FS, "beam FS");
    if (!bvs || !bfs) return false;

    var bprog = _pipeLink(gl, bvs, bfs, "beam");
    if (!bprog) return false;
    glPipeline.beamProg = bprog;

    glPipeline.uBCols      = gl.getUniformLocation(bprog, "uCols");
    glPipeline.uBRows      = gl.getUniformLocation(bprog, "uRows");
    glPipeline.uBHalfWidth = gl.getUniformLocation(bprog, "uHalfWidth");

    // ---- Compile display program ----
    var dvs = _pipeCompile(gl, gl.VERTEX_SHADER, PIPE_DISP_VS, "disp VS");
    var dfs = _pipeCompile(gl, gl.FRAGMENT_SHADER, PIPE_DISP_FS, "disp FS");
    if (!dvs || !dfs) return false;

    var dprog = _pipeLink(gl, dvs, dfs, "display");
    if (!dprog) return false;
    glPipeline.dispProg = dprog;

    glPipeline.uDRefVal    = gl.getUniformLocation(dprog, "uRefVal");
    glPipeline.uDAccent    = gl.getUniformLocation(dprog, "uAccent");
    glPipeline.uDUseAccent = gl.getUniformLocation(dprog, "uUseAccent");

    // ---- Base quad geometry (shared by beam pass) ----
    var quadVerts = new Float32Array([
      0, -1,    // v0: segment start, bottom edge
      1, -1,    // v1: segment end,   bottom edge
      0,  1,    // v2: segment start, top edge
      1,  1,    // v3: segment end,   top edge
    ]);
    glPipeline.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glPipeline.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    var quadIdx = new Uint16Array([0, 1, 2, 2, 1, 3]);
    glPipeline.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glPipeline.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIdx, gl.STATIC_DRAW);

    // ---- Instance buffer (allocated on demand) ----
    glPipeline.instanceBuf = gl.createBuffer();
    glPipeline.maxSegments = 0;

    // ---- Beam VAO: vertex + instance attribute layout ----
    glPipeline.beamVAO = gl.createVertexArray();
    gl.bindVertexArray(glPipeline.beamVAO);

    // Attribute 0: aPos (vec2, per-vertex)
    gl.bindBuffer(gl.ARRAY_BUFFER, glPipeline.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Attributes 1-2: per-instance (from instance buffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, glPipeline.instanceBuf);

    // Attribute 1: aStartEnd (vec4: x1,y1,x2,y2) — offset 0, stride 28
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);

    // Attribute 2: aParams (vec3: intensity,gridIdx,skipSrcId) — offset 16, stride 28
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(2, 1);

    // Index buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glPipeline.idxBuf);
    gl.bindVertexArray(null);

    // ---- Display VAO (fullscreen triangle, no vertex data) ----
    glPipeline.dispVAO = gl.createVertexArray();

    // ---- OccGrid texture ----
    glPipeline.occTex = gl.createTexture();

    // ---- Attenuation texture (R32F, the "shadow map") ----
    glPipeline.attenTex = gl.createTexture();

    // ---- Beam FBO + color attachment ----
    glPipeline.beamFBO    = gl.createFramebuffer();
    glPipeline.beamFBOTex = gl.createTexture();

    // ---- PBO for async readback ----
    glPipeline.pbo = gl.createBuffer();

    glPipeline.ready = true;
    console.log("[gl-pipeline] Unified GPU pipeline initialized");
    return true;

  } catch (e) {
    console.warn("[gl-pipeline] Init failed:", e);
    return false;
  }
}


// ================================================================
// ENSURE FBO SIZE — (re)allocate when grid dimensions change
// ================================================================
function _ensurePipeFBO(gl, cols, rows) {
  if (cols === glPipeline.lastCols && rows === glPipeline.lastRows) return;

  // Beam FBO texture (RGBA32F)
  gl.bindTexture(gl.TEXTURE_2D, glPipeline.beamFBOTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0,
                gl.RGBA, gl.FLOAT, null);
  // LINEAR filtering for bilinear upscale in display pass.
  // Falls back to nearest-neighbor if OES_texture_float_linear
  // isn't available (still works, just blockier).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Attach to FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, glPipeline.beamFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                          gl.TEXTURE_2D, glPipeline.beamFBOTex, 0);

  var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn("[gl-pipeline] FBO incomplete:", status);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Pre-allocate PBO for readback at this size
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, glPipeline.pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, cols * rows * 4 * 4, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  glPipeline.pboReady = false;

  glPipeline.lastCols = cols;
  glPipeline.lastRows = rows;
}


// ================================================================
// ENSURE INSTANCE BUFFER CAPACITY
// ================================================================
function _ensurePipeInstBuf(gl, segCount) {
  if (segCount <= glPipeline.maxSegments) return;

  var newCap = Math.max(segCount, Math.ceil(glPipeline.maxSegments * 1.5));
  gl.bindBuffer(gl.ARRAY_BUFFER, glPipeline.instanceBuf);
  gl.bufferData(gl.ARRAY_BUFFER, newCap * 7 * 4, gl.DYNAMIC_DRAW);
  glPipeline.maxSegments = newCap;
}


// ================================================================
// UPLOAD OCCLUSION GRID — same format as before (R16UI)
// ================================================================
function _uploadPipeOccGrid(gl, occGrid, cols, rows) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glPipeline.occTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, cols, rows, 0,
                gl.RED_INTEGER, gl.UNSIGNED_SHORT, occGrid);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}


// ================================================================
// gpuAccumBeams — PASS 1: render beam segments into FBO
// ================================================================
// Takes pre-segmented beam data (from segmentBeams) and renders
// all segments in one instanced draw call. Additive blending
// accumulates intensity into the RGBA32F FBO.
//
// Parameters:
//   segData   — Float32Array of segments (7 floats each)
//   segCount  — number of segments
//   occGrid   — Uint16Array for candle-interior skip (1 texelFetch)
//   cols, rows — grid dimensions
//
// Returns true on success.

// ================================================================
// gpuAccumBeams — render pre-segmented beams into FBO
// ================================================================
// Takes CPU-segmented beam data (from segmentBeams) and renders
// all segments in one instanced draw call. Additive blending
// accumulates intensity. Fragment shader is trivial: just
// perpendicular falloff + candle interior skip.
//
// Parameters:
//   segData   — Float32Array of segments (7 floats each)
//   segCount  — number of segments
//   occGrid   — Uint16Array for candle-interior skip
//   cols, rows — grid dimensions

function gpuAccumBeams(segData, segCount, occGrid, cols, rows) {
  if (!glPipeline.ready || segCount === 0) return false;
  if (glPipeline.tooSlow) return false;

  var gl = glPipeline.gl;
  var BEAM_HALF_WIDTH = 3.0;
  var t0 = performance.now();

  _ensurePipeFBO(gl, cols, rows);
  _ensurePipeInstBuf(gl, segCount);

  // Upload occlusion grid to texture unit 0
  _uploadPipeOccGrid(gl, occGrid, cols, rows);

  // Upload segment instance data
  gl.bindBuffer(gl.ARRAY_BUFFER, glPipeline.instanceBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, segData, 0, segCount * 7);

  glPipeline.canvas.width  = cols;
  glPipeline.canvas.height = rows;

  // Render into FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, glPipeline.beamFBO);
  gl.viewport(0, 0, cols, rows);

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);

  gl.useProgram(glPipeline.beamProg);
  gl.uniform1f(glPipeline.uBCols, cols);
  gl.uniform1f(glPipeline.uBRows, rows);
  gl.uniform1f(glPipeline.uBHalfWidth, BEAM_HALF_WIDTH);

  // Bind occGrid to unit 0
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glPipeline.occTex);
  gl.uniform1i(gl.getUniformLocation(glPipeline.beamProg, "uOccGrid"), 0);

  // ONE draw call for all segments
  gl.bindVertexArray(glPipeline.beamVAO);
  gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, segCount);
  gl.bindVertexArray(null);

  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  glPipeline.pboReady = false;

  // Performance check
  glPipeline.callCount++;
  var elapsed = performance.now() - t0;
  if (glPipeline.callCount >= 3 && elapsed > 100) {
    glPipeline.tooSlow = true;
    console.warn("[gl-pipeline] GPU too slow (" + elapsed.toFixed(0)
      + "ms) — falling back to CPU");
  }

  return true;
}


// ================================================================
// gpuDisplayHeatmap — PASS 2: color mapping, draw to 2D canvas
// ================================================================
// Reads the beam FBO texture DIRECTLY (no readPixels!) and renders
// the color-mapped heatmap onto the offscreen WebGL canvas. The
// caller then draws this canvas onto the main 2D canvas.
//
// Parameters:
//   mainCtx   — the main 2D canvas context
//   canvasW, canvasH — display size in pixels
//   refVal    — normalization reference (85th percentile × 2.0)
//   accentHex — optional multi-asset tint color

function gpuDisplayHeatmap(mainCtx, canvasW, canvasH, refVal, accentHex) {
  if (!glPipeline.ready) return false;

  var gl = glPipeline.gl;
  var cols = glPipeline.lastCols;
  var rows = glPipeline.lastRows;
  if (cols === 0 || rows === 0) return false;

  // Resize the offscreen canvas to match the grid resolution.
  // The 2D canvas drawImage will upscale it to canvasW × canvasH.
  if (glPipeline.canvas.width !== cols || glPipeline.canvas.height !== rows) {
    glPipeline.canvas.width  = cols;
    glPipeline.canvas.height = rows;
  }

  // ---- Render to default framebuffer (the canvas backbuffer) ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cols, rows);

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);  // additive with alpha

  // Bind display shader
  gl.useProgram(glPipeline.dispProg);
  gl.uniform1f(glPipeline.uDRefVal, refVal);

  if (accentHex) {
    var ar = parseInt(accentHex.slice(1, 3), 16) / 255;
    var ag = parseInt(accentHex.slice(3, 5), 16) / 255;
    var ab = parseInt(accentHex.slice(5, 7), 16) / 255;
    gl.uniform1i(glPipeline.uDUseAccent, 1);
    gl.uniform3f(glPipeline.uDAccent, ar, ag, ab);
  } else {
    gl.uniform1i(glPipeline.uDUseAccent, 0);
    gl.uniform3f(glPipeline.uDAccent, 0, 0, 0);
  }

  // Bind beam FBO texture to unit 0 (the accumulated beam data)
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glPipeline.beamFBOTex);
  gl.uniform1i(gl.getUniformLocation(glPipeline.dispProg, "uBeamTex"), 0);

  // Draw fullscreen triangle
  gl.bindVertexArray(glPipeline.dispVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);

  gl.disable(gl.BLEND);

  // ---- Composite onto the main 2D canvas ----
  mainCtx.save();
  mainCtx.globalCompositeOperation = "lighter";
  mainCtx.imageSmoothingEnabled = true;   // bilinear upscale
  mainCtx.drawImage(glPipeline.canvas, 0, 0, cols, rows,
                    0, 0, canvasW, canvasH);
  mainCtx.restore();

  return true;
}


// ================================================================
// gpuReadbackGrids — read FBO data back to CPU for physics
// ================================================================
// This is the ONLY place readPixels happens. Called by the physics
// consumers (prediction engine, topology, corridor) when they need
// CPU-side grid data. NOT called for display.
//
// Uses synchronous readPixels for now. The PBO async path is
// available for future optimization (one-frame-behind readback).
//
// Parameters:
//   outGrids — array of 4 Float32Arrays [green, yellow, blue, red]
//
// Returns true on success.

// Pooled readback buffer — reused across frames to avoid GC pressure
var _pipeReadBuf    = null;
var _pipeReadBufLen = 0;

function gpuReadbackGrids(outGrids) {
  if (!glPipeline.ready) return false;

  var gl   = glPipeline.gl;
  var cols = glPipeline.lastCols;
  var rows = glPipeline.lastRows;
  if (cols === 0 || rows === 0) return false;

  // Pool the readback buffer (only reallocate when grid size changes)
  var needed = cols * rows * 4;
  if (needed !== _pipeReadBufLen) {
    _pipeReadBuf = new Float32Array(needed);
    _pipeReadBufLen = needed;
  }

  // Read from beam FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, glPipeline.beamFBO);

  // Synchronous readback
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, _pipeReadBuf);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Unpack RGBA → 4 separate grids (with Y-flip)
  for (var gy = 0; gy < rows; gy++) {
    var fboRow = rows - 1 - gy;
    var srcOff = fboRow * cols * 4;
    var dstOff = gy * cols;
    for (var gx = 0; gx < cols; gx++) {
      var si = srcOff + gx * 4;
      var di = dstOff + gx;
      outGrids[0][di] = _pipeReadBuf[si];        // R → green
      outGrids[1][di] = _pipeReadBuf[si + 1];    // G → yellow
      outGrids[2][di] = _pipeReadBuf[si + 2];    // B → blue
      outGrids[3][di] = _pipeReadBuf[si + 3];    // A → red
    }
  }

  return true;
}


// ================================================================
// gpuStartAsyncReadback / gpuFinishAsyncReadback — PBO path
// ================================================================
// For future optimization: kick off a readback at the end of one
// frame, retrieve the data at the start of the NEXT frame.
// The prediction engine gets one-frame-old grid data, which is
// fine since it's already working with cached snapshots.
//
// NOT ACTIVE YET — included for when we want to push further.

function gpuStartAsyncReadback() {
  if (!glPipeline.ready) return;
  var gl = glPipeline.gl;
  var cols = glPipeline.lastCols;
  var rows = glPipeline.lastRows;

  gl.bindFramebuffer(gl.FRAMEBUFFER, glPipeline.beamFBO);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, glPipeline.pbo);

  // Async read into PBO (returns immediately)
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, 0);

  // Create fence to check completion
  glPipeline.pboFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  glPipeline.pboCols  = cols;
  glPipeline.pboRows  = rows;

  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function gpuFinishAsyncReadback(outGrids) {
  if (!glPipeline.ready || !glPipeline.pboFence) return false;
  var gl = glPipeline.gl;

  // Check if the readback is done
  var status = gl.clientWaitSync(glPipeline.pboFence, 0, 0);
  if (status === gl.TIMEOUT_EXPIRED) return false;  // not ready yet

  gl.deleteSync(glPipeline.pboFence);
  glPipeline.pboFence = null;

  var cols = glPipeline.pboCols;
  var rows = glPipeline.pboRows;

  // Map PBO and unpack
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, glPipeline.pbo);
  var readBuf = new Float32Array(cols * rows * 4);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, readBuf);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  // Unpack (same Y-flip as synchronous path)
  for (var gy = 0; gy < rows; gy++) {
    var fboRow = rows - 1 - gy;
    var srcOff = fboRow * cols * 4;
    var dstOff = gy * cols;
    for (var gx = 0; gx < cols; gx++) {
      var si = srcOff + gx * 4;
      var di = dstOff + gx;
      outGrids[0][di] = readBuf[si];
      outGrids[1][di] = readBuf[si + 1];
      outGrids[2][di] = readBuf[si + 2];
      outGrids[3][di] = readBuf[si + 3];
    }
  }

  glPipeline.pboReady = true;
  return true;
}


// ================================================================
// GPU GAUSSIAN BLUR — topology acceleration
// ================================================================
// Moves the 4-pass 3×3 Gaussian blur from CPU to GPU.
// CPU cost at res=1: ~10-15ms. GPU cost: <1ms.
//
// Used by computeTopology when available. Falls back to CPU blur
// if the GPU path isn't initialized or fails.
//
// Architecture: uploads intensity as R32F texture, ping-pongs
// between two FBOs with a fullscreen Gaussian shader, reads back
// the final smoothed result. Same WebGL2 context as the beam
// pipeline — no extra context overhead.
// ================================================================

var _gpuBlur = {
  ready:    false,
  program:  null,
  fboA:     null,     // ping FBO
  fboB:     null,     // pong FBO
  texA:     null,     // ping texture (R32F)
  texB:     null,     // pong texture (R32F)
  vao:      null,     // fullscreen triangle VAO
  uTexSize: null,     // uniform: texture dimensions
  cols:     0,        // last allocated dimensions
  rows:     0,
  readBuf:  null,     // pooled readback buffer
};

// Blur shader: 3×3 Gaussian kernel [1,2,1; 2,4,2; 1,2,1] / 16
var _BLUR_VS = [
  "#version 300 es",
  "void main() {",
  "  vec2 pos = vec2(gl_VertexID % 2, gl_VertexID / 2) * 2.0;",
  "  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);",
  "}",
].join("\n");

var _BLUR_FS = [
  "#version 300 es",
  "precision highp float;",
  "",
  "uniform sampler2D uSrc;",
  "uniform vec2 uTexSize;",    // 1.0 / vec2(cols, rows)
  "",
  "out vec4 fragColor;",
  "",
  "void main() {",
  "  vec2 uv = gl_FragCoord.xy * uTexSize;",
  "  float dx = uTexSize.x;",
  "  float dy = uTexSize.y;",
  "",
  "  // 3×3 Gaussian: [1,2,1; 2,4,2; 1,2,1] / 16",
  "  float v = ",
  "    texture(uSrc, uv + vec2(-dx, -dy)).r       +",
  "    texture(uSrc, uv + vec2(  0, -dy)).r * 2.0 +",
  "    texture(uSrc, uv + vec2( dx, -dy)).r       +",
  "    texture(uSrc, uv + vec2(-dx,   0)).r * 2.0 +",
  "    texture(uSrc, uv).r                  * 4.0 +",
  "    texture(uSrc, uv + vec2( dx,   0)).r * 2.0 +",
  "    texture(uSrc, uv + vec2(-dx,  dy)).r       +",
  "    texture(uSrc, uv + vec2(  0,  dy)).r * 2.0 +",
  "    texture(uSrc, uv + vec2( dx,  dy)).r;",
  "",
  "  fragColor = vec4(v * 0.0625, 0.0, 0.0, 1.0);",
  "}",
].join("\n");


function initGPUBlur() {
  if (!glPipeline.ready) return false;
  var gl = glPipeline.gl;

  try {
    var vs = _pipeCompile(gl, gl.VERTEX_SHADER, _BLUR_VS, "blur VS");
    var fs = _pipeCompile(gl, gl.FRAGMENT_SHADER, _BLUR_FS, "blur FS");
    if (!vs || !fs) return false;

    var prog = _pipeLink(gl, vs, fs, "blur");
    if (!prog) return false;

    _gpuBlur.program  = prog;
    _gpuBlur.uTexSize = gl.getUniformLocation(prog, "uTexSize");

    // VAO for fullscreen triangle (no vertex data)
    _gpuBlur.vao = gl.createVertexArray();

    // Create textures and FBOs for ping-pong
    _gpuBlur.texA = gl.createTexture();
    _gpuBlur.texB = gl.createTexture();
    _gpuBlur.fboA = gl.createFramebuffer();
    _gpuBlur.fboB = gl.createFramebuffer();

    _gpuBlur.ready = true;
    console.log("[gl-pipeline] GPU blur initialized");
    return true;
  } catch (e) {
    console.warn("[gl-pipeline] GPU blur init failed:", e);
    return false;
  }
}


// Ensure blur FBOs are the right size
function _ensureBlurFBOs(gl, cols, rows) {
  if (cols === _gpuBlur.cols && rows === _gpuBlur.rows) return;

  // Texture A
  gl.bindTexture(gl.TEXTURE_2D, _gpuBlur.texA);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, rows, 0,
                gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, _gpuBlur.fboA);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                          gl.TEXTURE_2D, _gpuBlur.texA, 0);

  // Texture B
  gl.bindTexture(gl.TEXTURE_2D, _gpuBlur.texB);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, rows, 0,
                gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, _gpuBlur.fboB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                          gl.TEXTURE_2D, _gpuBlur.texB, 0);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  _gpuBlur.cols = cols;
  _gpuBlur.rows = rows;
  _gpuBlur.readBuf = new Float32Array(cols * rows * 4);
}


// ================================================================
// gpuBlurIntensity — blur a Float32Array on the GPU
// ================================================================
// Takes an intensity grid, applies 4 passes of 3×3 Gaussian blur,
// returns the blurred result in a new Float32Array.
//
// Parameters:
//   data — Float32Array(cols × rows), the signed intensity field
//   cols, rows — grid dimensions
//   passes — number of blur passes (default 4)
//
// Returns Float32Array(cols × rows) with blurred result, or null on failure.

function gpuBlurIntensity(data, cols, rows, passes) {
  if (!_gpuBlur.ready) return null;
  if (!passes) passes = 4;

  var gl = glPipeline.gl;
  var t0 = performance.now();

  _ensureBlurFBOs(gl, cols, rows);

  // Upload intensity data into texture A
  gl.bindTexture(gl.TEXTURE_2D, _gpuBlur.texA);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, rows, 0,
                gl.RED, gl.FLOAT, data);

  // Set up shader
  gl.useProgram(_gpuBlur.program);
  gl.uniform2f(_gpuBlur.uTexSize, 1.0 / cols, 1.0 / rows);
  gl.viewport(0, 0, cols, rows);

  // Ping-pong blur passes
  var srcTex = _gpuBlur.texA;
  var dstFbo = _gpuBlur.fboB;
  var dstTex = _gpuBlur.texB;

  for (var p = 0; p < passes; p++) {
    // Render from srcTex into dstFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(_gpuBlur.program, "uSrc"), 0);

    gl.bindVertexArray(_gpuBlur.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // Swap for next pass
    if (dstFbo === _gpuBlur.fboB) {
      srcTex = _gpuBlur.texB;
      dstFbo = _gpuBlur.fboA;
      dstTex = _gpuBlur.texA;
    } else {
      srcTex = _gpuBlur.texA;
      dstFbo = _gpuBlur.fboB;
      dstTex = _gpuBlur.texB;
    }
  }

  // Read back from the last destination (which is now srcTex after swap)
  // The last write went into dstFbo BEFORE the swap, so read from the
  // FBO we just wrote to. After the final swap, dstFbo points to where
  // we WOULD write next — so the result is in the OTHER FBO.
  var resultFbo = (dstFbo === _gpuBlur.fboB) ? _gpuBlur.fboA : _gpuBlur.fboB;
  gl.bindFramebuffer(gl.FRAMEBUFFER, resultFbo);

  var readBuf = _gpuBlur.readBuf;
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, readBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Extract R channel into output array
  var result = new Float32Array(cols * rows);
  for (var i = 0; i < cols * rows; i++) {
    result[i] = readBuf[i * 4];
  }

  var elapsed = performance.now() - t0;
  if (elapsed > 1) {
    console.log("[gpuBlur] " + cols + "×" + rows + " × " + passes + " passes: " + elapsed.toFixed(1) + "ms");
  }

  return result;
}

