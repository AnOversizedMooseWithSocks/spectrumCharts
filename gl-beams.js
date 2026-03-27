/*
 * ================================================================
 * gl-beams.js  —  GPU Beam Accumulation (Phase 2)
 * ================================================================
 * Depends on: config.js (state)
 *             Must be loaded BEFORE heatmap.js
 *
 * Replaces the CPU paintBeam loop with GPU instanced rendering.
 * Each beam is an oriented quad; the fragment shader marches along
 * the beam checking the occlusion grid texture, attenuating on
 * candle crossings, and writing to the correct color channel.
 *
 * Architecture:
 *   - Beam params packed into instance attributes (7 floats each)
 *   - OccGrid uploaded as a R16UI texture
 *   - Rendered into an RGBA32F framebuffer with additive blending
 *   - ReadPixels back into the 4 CPU grid arrays
 *
 * Performance: ALL beams (background + visible) in < 1ms total,
 * vs ~40ms+ on CPU. Eliminates the Phase 1 caching requirement.
 * ================================================================
 */

// ----------------------------------------------------------------
// STATE: WebGL2 context and GPU resources (created once, reused)
// ----------------------------------------------------------------
var glBeams = {
  canvas:      null,    // offscreen <canvas> for beam WebGL context
  gl:          null,    // WebGL2 rendering context
  program:     null,    // compiled shader program
  fbo:         null,    // framebuffer object (render target)
  fboTex:      null,    // RGBA32F color attachment on the FBO
  occTex:      null,    // R16UI texture holding the occlusion grid
  vao:         null,    // vertex array object (quad + instance attrs)
  quadBuf:     null,    // vertex buffer for the base quad (4 verts)
  idxBuf:      null,    // index buffer for quad triangles (6 indices)
  instanceBuf: null,    // instance buffer for beam parameters
  readBuf:     null,    // Float32Array for readPixels output
  // Uniform locations
  uCols:       null,
  uRows:       null,
  uOpacity:    null,
  uHalfWidth:  null,
  // Tracking
  ready:       false,   // true after successful init
  lastCols:    0,       // last FBO dimensions (to detect resize)
  lastRows:    0,
  maxBeams:    0,       // current instance buffer capacity
  callCount:   0,       // how many times gpuPaintBeams has been called
  tooSlow:     false,   // set true if GPU is slower than CPU threshold
};


// ----------------------------------------------------------------
// SHADER SOURCE
// ----------------------------------------------------------------

// -- Vertex shader: positions an oriented quad for each beam --
// Base quad has corners at (0,-1), (1,-1), (1,1), (0,1).
// x: 0..1 = along beam (start to end)
// y: -1..1 = perpendicular to beam
//
// Instance attributes carry per-beam data: endpoints, intensity,
// which color grid to write to, and which candle to skip.

var BEAM_VS = [
  "#version 300 es",
  "",
  "// Per-vertex: quad corner position",
  "layout(location = 0) in vec2 aPos;",
  "",
  "// Per-instance: beam parameters (advance once per beam)",
  "layout(location = 1) in vec4 aStartEnd;   // x1, y1, x2, y2 (grid coords)",
  "layout(location = 2) in vec3 aParams;      // intensity, gridIdx, skipSrcId",
  "",
  "uniform float uCols;",
  "uniform float uRows;",
  "uniform float uHalfWidth;",
  "",
  "// Passed to fragment shader",
  "out float vT;             // 0..1 along beam",
  "out float vPerpNorm;      // -1..1 perpendicular (quad space)",
  "flat out float vIntensity;",
  "flat out float vGridIdx;",
  "flat out float vSkipSrcId;",
  "flat out vec2  vBeamStart;",
  "flat out vec2  vBeamDir;   // normalized direction",
  "flat out float vBeamLen;",
  "",
  "void main() {",
  "  vec2 start = aStartEnd.xy;",
  "  vec2 end   = aStartEnd.zw;",
  "  vec2 dir   = end - start;",
  "  float len  = length(dir);",
  "",
  "  // Degenerate beam — move off screen",
  "  if (len < 0.5) {",
  "    gl_Position = vec4(-9.0, -9.0, 0.0, 1.0);",
  "    return;",
  "  }",
  "",
  "  vec2 norm = dir / len;",
  "  vec2 perp = vec2(-norm.y, norm.x);",
  "",
  "  // Expand quad: half-width + 1 grid cell for falloff fade-out",
  "  float expandedHW = uHalfWidth + 1.0;",
  "",
  "  // Position this vertex in grid space",
  "  vec2 pos = start + norm * (aPos.x * len)",
  "                   + perp * (aPos.y * expandedHW);",
  "",
  "  // Grid coords → clip space.",
  "  // Y is flipped: grid y=0 is top of chart → clip y=+1",
  "  gl_Position = vec4(",
  "    pos.x / uCols * 2.0 - 1.0,",
  "    1.0 - pos.y / uRows * 2.0,",
  "    0.0, 1.0",
  "  );",
  "",
  "  // Pass along for the fragment shader",
  "  vT         = aPos.x;",
  "  vPerpNorm  = aPos.y;",
  "  vIntensity = aParams.x;",
  "  vGridIdx   = aParams.y;",
  "  vSkipSrcId = aParams.z;",
  "  vBeamStart = start;",
  "  vBeamDir   = norm;",
  "  vBeamLen   = len;",
  "}",
].join("\n");


// -- Fragment shader: march along beam, check occlusion, deposit --
// For each fragment:
//   1. Figure out where we are on the beam (t = fraction along)
//   2. March from beam start to here, checking occGrid at each step
//   3. Each candle crossing attenuates intensity by (1 - opacity)
//   4. Check our own position — skip if inside a candle
//   5. Apply perpendicular falloff (quadratic, matches CPU)
//   6. Write to the correct RGBA channel (additive blending sums them)

var BEAM_FS = [
  "#version 300 es",
  "precision highp float;",
  "precision highp usampler2D;",     // needed for R16UI sampling
  "",
  "uniform usampler2D uOccGrid;",    // Uint16 occlusion grid texture
  "uniform float uOpacity;",         // candle translucency (0..1)",
  "uniform float uCols;",
  "uniform float uRows;",
  "uniform float uHalfWidth;",       // beamHalfWidth (3.0)",
  "",
  "in float vT;",
  "in float vPerpNorm;",
  "flat in float vIntensity;",
  "flat in float vGridIdx;",
  "flat in float vSkipSrcId;",
  "flat in vec2  vBeamStart;",
  "flat in vec2  vBeamDir;",
  "flat in float vBeamLen;",
  "",
  "out vec4 fragColor;",
  "",
  "void main() {",
  "  float expandedHW = uHalfWidth + 1.0;",
  "",
  "  // ---- Perpendicular falloff (same as CPU) ----",
  "  // vPerpNorm is -1..1 across the expanded quad.",
  "  // Actual grid distance = |vPerpNorm| * expandedHW",
  "  float perpDist = abs(vPerpNorm) * expandedHW;",
  "  float distNorm = perpDist / expandedHW;",
  "  float falloff  = 1.0 - distNorm * distNorm;",
  "  if (falloff <= 0.0) discard;",
  "",
  "  // ---- Check if this fragment is inside a candle ----",
  "  // Same as CPU: skip depositing light in candle cells",
  "  vec2 fragGridPos = vBeamStart + vBeamDir * (vT * vBeamLen)",
  "                   + vec2(-vBeamDir.y, vBeamDir.x) * (vPerpNorm * expandedHW);",
  "  int fgx = int(fragGridPos.x);",
  "  int fgy = int(fragGridPos.y);",
  "  int skipId = int(vSkipSrcId);",
  "  if (fgx >= 0 && fgx < int(uCols) && fgy >= 0 && fgy < int(uRows)) {",
  "    uint cellId = texelFetch(uOccGrid, ivec2(fgx, fgy), 0).r;",
  "    if (cellId > 0u && int(cellId) != skipId) discard;",
  "  }",
  "",
  "  // ---- March along beam center, accumulate occlusion ----",
  "  float intensity = vIntensity;",
  "  float marchDist = vT * vBeamLen;",
  "  int   steps     = min(int(ceil(marchDist)), 800);",  // cap to prevent GPU timeout
  "  int   lastOcc   = -1;",
  "",
  "  for (int s = 0; s <= steps; s++) {",
  "    vec2 sp = vBeamStart + vBeamDir * float(s);",
  "    int gx  = int(sp.x);",
  "    int gy  = int(sp.y);",
  "",
  "    if (gx >= 0 && gx < int(uCols) && gy >= 0 && gy < int(uRows)) {",
  "      uint cid = texelFetch(uOccGrid, ivec2(gx, gy), 0).r;",
  "      int icid = int(cid);",
  "      if (icid > 0 && icid != skipId && icid != lastOcc) {",
  "        intensity *= (1.0 - uOpacity);",
  "        lastOcc = icid;",
  "        if (intensity < 0.01) discard;",
  "      }",
  "    }",
  "  }",
  "",
  "  float value = intensity * falloff;",
  "",
  "  // ---- Write to the correct color channel ----",
  "  // gridIdx: 0=green(R), 1=yellow(G), 2=blue(B), 3=red(A)",
  "  int idx = int(vGridIdx);",
  "  fragColor = vec4(0.0);",
  "  if      (idx == 0) fragColor.r = value;",
  "  else if (idx == 1) fragColor.g = value;",
  "  else if (idx == 2) fragColor.b = value;",
  "  else               fragColor.a = value;",
  "}",
].join("\n");


// ----------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------
// Creates an offscreen WebGL2 context, compiles shaders, sets up
// the base quad geometry and instance attribute layout.
// Returns true on success, false if WebGL2 / float FBO not available.

function initGLBeams() {
  try {
    glBeams.canvas = document.createElement("canvas");
    var gl = glBeams.canvas.getContext("webgl2", {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      console.warn("[gl-beams] WebGL2 not available");
      return false;
    }

    // We need float framebuffers (RGBA32F render target)
    var floatExt = gl.getExtension("EXT_color_buffer_float");
    if (!floatExt) {
      console.warn("[gl-beams] EXT_color_buffer_float not available — need float FBO");
      return false;
    }

    glBeams.gl = gl;

    // ---- Compile shaders ----
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, BEAM_VS);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn("[gl-beams] VS error:", gl.getShaderInfoLog(vs));
      return false;
    }

    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, BEAM_FS);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn("[gl-beams] FS error:", gl.getShaderInfoLog(fs));
      return false;
    }

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[gl-beams] Link error:", gl.getProgramInfoLog(prog));
      return false;
    }
    glBeams.program = prog;

    // ---- Uniform locations ----
    glBeams.uCols      = gl.getUniformLocation(prog, "uCols");
    glBeams.uRows      = gl.getUniformLocation(prog, "uRows");
    glBeams.uOpacity   = gl.getUniformLocation(prog, "uOpacity");
    glBeams.uHalfWidth = gl.getUniformLocation(prog, "uHalfWidth");

    // ---- Base quad geometry ----
    // 4 corners: x=0..1 (along beam), y=-1..+1 (perpendicular)
    //   v0 = (0, -1)   v1 = (1, -1)
    //   v2 = (0, +1)   v3 = (1, +1)
    var quadVerts = new Float32Array([
      0, -1,    // v0: beam start, bottom edge
      1, -1,    // v1: beam end,   bottom edge
      0,  1,    // v2: beam start, top edge
      1,  1,    // v3: beam end,   top edge
    ]);
    glBeams.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBeams.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    // Two triangles: (v0, v1, v2) and (v2, v1, v3)
    var quadIdx = new Uint16Array([0, 1, 2, 2, 1, 3]);
    glBeams.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glBeams.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIdx, gl.STATIC_DRAW);

    // ---- Instance buffer (allocated on first use, grown as needed) ----
    glBeams.instanceBuf = gl.createBuffer();
    glBeams.maxBeams = 0;  // will allocate on demand

    // ---- VAO: bind vertex + instance attribute layout ----
    glBeams.vao = gl.createVertexArray();
    gl.bindVertexArray(glBeams.vao);

    // Attribute 0: aPos (vec2, per-vertex)
    gl.bindBuffer(gl.ARRAY_BUFFER, glBeams.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // divisor = 0 → per-vertex (default)

    // Attributes 1-2: per-instance, set up with the instance buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, glBeams.instanceBuf);

    // Attribute 1: aStartEnd (vec4: x1, y1, x2, y2) — offset 0, stride 28
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);  // advance once per instance

    // Attribute 2: aParams (vec3: intensity, gridIdx, skipSrcId) — offset 16, stride 28
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(2, 1);  // advance once per instance

    // Index buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glBeams.idxBuf);

    gl.bindVertexArray(null);

    // ---- OccGrid texture (R16UI, allocated on demand) ----
    glBeams.occTex = gl.createTexture();

    // ---- FBO + color attachment (RGBA32F, allocated on demand) ----
    glBeams.fbo    = gl.createFramebuffer();
    glBeams.fboTex = gl.createTexture();

    glBeams.ready = true;
    console.log("[gl-beams] GPU beam renderer initialized (WebGL2 + float FBO)");
    return true;

  } catch (e) {
    console.warn("[gl-beams] Init failed:", e);
    return false;
  }
}


// ----------------------------------------------------------------
// ENSURE FBO SIZE
// ----------------------------------------------------------------
// (Re)allocates the framebuffer color texture when grid dims change.

function ensureBeamFBO(gl, cols, rows) {
  if (cols === glBeams.lastCols && rows === glBeams.lastRows) return;

  gl.bindTexture(gl.TEXTURE_2D, glBeams.fboTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0,
                gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Attach to FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, glBeams.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                          gl.TEXTURE_2D, glBeams.fboTex, 0);

  var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn("[gl-beams] FBO incomplete:", status);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // (Re)allocate the readback buffer
  glBeams.readBuf = new Float32Array(cols * rows * 4);

  glBeams.lastCols = cols;
  glBeams.lastRows = rows;
}


// ----------------------------------------------------------------
// ENSURE INSTANCE BUFFER CAPACITY
// ----------------------------------------------------------------
// Grows the instance buffer if we have more beams than last time.

function ensureBeamInstanceBuf(gl, beamCount) {
  if (beamCount <= glBeams.maxBeams) return;

  // Grow to 1.5× requested count to avoid frequent reallocs
  var newCap = Math.max(beamCount, Math.ceil(glBeams.maxBeams * 1.5));
  gl.bindBuffer(gl.ARRAY_BUFFER, glBeams.instanceBuf);
  gl.bufferData(gl.ARRAY_BUFFER, newCap * 7 * 4, gl.DYNAMIC_DRAW);
  glBeams.maxBeams = newCap;
}


// ----------------------------------------------------------------
// UPLOAD OCCLUSION GRID
// ----------------------------------------------------------------
// Packs the Uint16Array occGrid into a R16UI texture.

function uploadOccGrid(gl, occGrid, cols, rows) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glBeams.occTex);
  // R16UI = 2 bytes/pixel. Default UNPACK_ALIGNMENT is 4, which
  // expects rows padded to 4-byte boundaries. With odd col counts,
  // the buffer would be "not big enough". Set alignment to 2.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, cols, rows, 0,
                gl.RED_INTEGER, gl.UNSIGNED_SHORT, occGrid);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);  // restore default
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}


// ================================================================
// gpuPaintBeams  —  the main GPU entry point
// ================================================================
// Renders ALL beams in one GPU pass and reads results back into
// the 4 CPU grid arrays. Call this instead of the CPU paintBeam loop.
//
// Parameters:
//   beamData  — Float32Array with 7 floats per beam:
//               [x1_grid, y1_grid, x2_grid, y2_grid, intensity, gridIdx, skipSrcId]
//               Coordinates are in GRID SPACE (pixel / resolution).
//   beamCount — number of beams in beamData
//   occGrid   — Uint16Array[cols*rows], the candle occlusion grid
//   cols      — grid columns
//   rows      — grid rows
//   opacity   — candle translucency (state.translucency)
//   outGrids  — array of 4 Float32Arrays to fill [green, yellow, blue, red]
//
// Returns true on success, false on failure (caller should use CPU fallback).

function gpuPaintBeams(beamData, beamCount, occGrid, cols, rows, opacity, outGrids) {
  if (!glBeams.ready || beamCount === 0) return false;

  // ---- Auto-disable if GPU proved slower than CPU caching ----
  // The per-fragment occlusion march is too heavy for some GPUs.
  // Skip call 0 (shader compilation overhead), then check calls 1-2.
  // If average > 50ms, disable GPU and fall back to Phase 1 caching.
  if (glBeams.tooSlow) return false;

  var gl = glBeams.gl;
  var BEAM_HALF_WIDTH = 3.0;
  var gpuT0 = performance.now();

  // ---- Ensure GPU resources are the right size ----
  ensureBeamFBO(gl, cols, rows);
  ensureBeamInstanceBuf(gl, beamCount);

  // ---- Upload occlusion grid texture ----
  uploadOccGrid(gl, occGrid, cols, rows);

  // ---- Upload beam instance data ----
  gl.bindBuffer(gl.ARRAY_BUFFER, glBeams.instanceBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, beamData, 0, beamCount * 7);

  // ---- Set up rendering state ----
  glBeams.canvas.width  = cols;
  glBeams.canvas.height = rows;

  gl.bindFramebuffer(gl.FRAMEBUFFER, glBeams.fbo);
  gl.viewport(0, 0, cols, rows);

  // Clear FBO to zero (all grids start empty)
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Additive blending: fragments from different beams stack up
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);  // pure additive: src + dst

  // Bind shader and set uniforms
  gl.useProgram(glBeams.program);
  gl.uniform1f(glBeams.uCols,      cols);
  gl.uniform1f(glBeams.uRows,      rows);
  gl.uniform1f(glBeams.uOpacity,   opacity);
  gl.uniform1f(glBeams.uHalfWidth, BEAM_HALF_WIDTH);

  // Bind occGrid texture to unit 0
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glBeams.occTex);
  gl.uniform1i(gl.getUniformLocation(glBeams.program, "uOccGrid"), 0);

  // ---- Draw all beams as instanced quads ----
  gl.bindVertexArray(glBeams.vao);
  gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, beamCount);
  gl.bindVertexArray(null);

  // ---- Read back results ----
  var readBuf = glBeams.readBuf;
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, readBuf);

  // ---- Unpack RGBA → 4 separate grids ----
  // FBO Y is flipped relative to our grid convention:
  //   Grid y=0 (top of chart) → clip y=+1 → FBO row (rows-1)
  //   readPixels returns from FBO row 0 (bottom) upward
  //   So readBuf row 0 = grid row (rows-1), need to reverse.
  for (var gy = 0; gy < rows; gy++) {
    var fboRow = rows - 1 - gy;
    var srcOff = fboRow * cols * 4;
    var dstOff = gy * cols;
    for (var gx = 0; gx < cols; gx++) {
      var si = srcOff + gx * 4;
      var di = dstOff + gx;
      outGrids[0][di] = readBuf[si];      // R → green grid
      outGrids[1][di] = readBuf[si + 1];  // G → yellow grid
      outGrids[2][di] = readBuf[si + 2];  // B → blue grid
      outGrids[3][di] = readBuf[si + 3];  // A → red grid
    }
  }

  // Clean up state
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.BLEND);

  // ---- Auto-speed check ----
  // Call 0 is always slow (shader compilation). Check calls 1+.
  // If it's still > 50ms, this GPU can't handle the per-fragment
  // occlusion march efficiently — fall back to Phase 1 CPU caching.
  glBeams.callCount++;
  var gpuElapsed = performance.now() - gpuT0;
  if (glBeams.callCount >= 2 && gpuElapsed > 50) {
    glBeams.tooSlow = true;
    console.warn("[gl-beams] GPU beam path too slow (" + gpuElapsed.toFixed(0)
      + "ms) — disabling, falling back to CPU Phase 1 caching");
  }

  return true;
}
