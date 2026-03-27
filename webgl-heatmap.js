/*
 * ================================================================
 * webgl-heatmap.js  —  GPU-Accelerated Heatmap Rendering
 * ================================================================
 * Depends on: config.js (state), must be loaded before heatmap.js
 *
 * Replaces the slow per-cell fillRect loop with either:
 *   1. WebGL: packs 4 grids into one RGBA texture, shader does
 *      color mapping + additive blend on GPU, one draw call.
 *   2. ImageData fallback: computes pixels into a typed array,
 *      one putImageData call. Still ~50x faster than fillRect.
 *
 * The old renderHeatmap did up to 1 million fillRect calls per
 * frame (4 grids × ~280K cells at res=2). Each call created a
 * CSS color string, parsed it, and issued a draw command.
 *
 * WebGL: ~1ms for the whole thing (one texture upload + one quad).
 * ImageData: ~5-10ms (tight loop writing bytes + one putImageData).
 * Old fillRect: ~100-300ms (million draw calls with string creation).
 * ================================================================
 */

// ----------------------------------------------------------------
// STATE: WebGL context and resources (created once, reused)
// ----------------------------------------------------------------
var glHeatmap = {
  canvas:    null,     // offscreen <canvas> for WebGL
  gl:        null,     // WebGL context
  program:   null,     // compiled shader program
  texture:   null,     // RGBA texture holding 4 grids
  vao:       null,     // vertex array for fullscreen quad
  uRefVal:   null,     // uniform locations
  uAccent:   null,
  uUseAccent: null,
  ready:     false,    // true after successful init
  lastW:     0,        // last canvas dimensions (to detect resize)
  lastH:     0,
};


// ----------------------------------------------------------------
// SHADER SOURCE
// ----------------------------------------------------------------
// Vertex shader: draws a fullscreen triangle (no vertex buffer needed).
// Fragment shader: samples the packed RGBA texture, maps each channel
// to its base color, scales by intensity, and sums them together.

var VS_SOURCE = [
  "#version 300 es",
  "void main() {",
  "  // Fullscreen triangle: 3 vertices cover the entire screen",
  "  vec2 pos = vec2(gl_VertexID % 2, gl_VertexID / 2) * 2.0;",
  "  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);",
  "}",
].join("\n");

var FS_SOURCE = [
  "#version 300 es",
  "precision mediump float;",
  "",
  "uniform sampler2D uGridTex;    // RGBA: R=green, G=yellow, B=blue, A=red",
  "uniform float uRefVal;          // 85th percentile normalization reference",
  "uniform bool uUseAccent;        // true = multi-asset tinting",
  "uniform vec3 uAccent;           // accent color (hex-derived)",
  "",
  "out vec4 fragColor;",
  "",
  "// Map normalized intensity to a color-scaled value.",
  "// Same ramp as the old renderHeatmap:",
  "//   < 1.0: dim to medium (base color × intensity × 0.4)",
  "//   >= 1.0: push toward white (hot zone glow)",
  "vec3 applyRamp(float intensity, vec3 baseCol) {",
  "  intensity = min(intensity, 3.0);",
  "  if (intensity < 1.0) {",
  "    return baseCol * intensity * 0.4;",
  "  } else {",
  "    float excess = min((intensity - 1.0) / 2.0, 1.0);",
  "    vec3 full = baseCol * 0.4;",
  "    return full + excess * (vec3(1.0) - full);",
  "  }",
  "}",
  "",
  "void main() {",
  "  // Texture coordinates from fragment position",
  "  ivec2 texSize = textureSize(uGridTex, 0);",
  "  vec2 uv = gl_FragCoord.xy / vec2(texSize);",
  "  // Flip Y: canvas pixel 0 is top, texture 0 is bottom",
  "  uv.y = 1.0 - uv.y;",
  "",
  "  vec4 packed = texture(uGridTex, uv);",
  "  // Decode: stored as raw/refVal, already normalized in 0..N range",
  "  // The texture contains (green, yellow, blue, red) in RGBA",
  "  float greenVal  = packed.r;",
  "  float yellowVal = packed.g;",
  "  float blueVal   = packed.b;",
  "  float redVal    = packed.a;",
  "",
  "  // Skip empty pixels",
  "  float total = greenVal + yellowVal + blueVal + redVal;",
  "  if (total < 0.001) discard;",
  "",
  "  vec3 color;",
  "  if (uUseAccent) {",
  "    float scale = min(total * 0.4, 1.0);",
  "    color = uAccent * scale;",
  "  } else {",
  "    // Base colors (normalized to 0..1 for the shader)",
  "    vec3 cGreen  = vec3(0.118, 0.863, 0.353);",  // 30, 220, 90
  "    vec3 cYellow = vec3(0.941, 0.784, 0.157);",  // 240, 200, 40
  "    vec3 cBlue   = vec3(0.157, 0.549, 1.000);",  // 40, 140, 255
  "    vec3 cRed    = vec3(0.941, 0.196, 0.196);",  // 240, 50, 50
  "",
  "    color = applyRamp(greenVal, cGreen)",
  "         + applyRamp(yellowVal, cYellow)",
  "         + applyRamp(blueVal, cBlue)",
  "         + applyRamp(redVal, cRed);",
  "  }",
  "",
  "  color = min(color, vec3(1.0));",
  "  fragColor = vec4(color, 0.6);",
  "}",
].join("\n");


// ----------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------
// Creates an offscreen canvas, gets WebGL2, compiles shaders.
// Returns true on success, false if WebGL2 isn't available.

function initGLHeatmap() {
  try {
    glHeatmap.canvas = document.createElement("canvas");
    var gl = glHeatmap.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) return false;
    glHeatmap.gl = gl;

    // Compile vertex shader
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS_SOURCE);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn("GL heatmap VS error:", gl.getShaderInfoLog(vs));
      return false;
    }

    // Compile fragment shader
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FS_SOURCE);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn("GL heatmap FS error:", gl.getShaderInfoLog(fs));
      return false;
    }

    // Link program
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("GL heatmap link error:", gl.getProgramInfoLog(prog));
      return false;
    }
    glHeatmap.program = prog;

    // Get uniform locations
    glHeatmap.uRefVal    = gl.getUniformLocation(prog, "uRefVal");
    glHeatmap.uAccent    = gl.getUniformLocation(prog, "uAccent");
    glHeatmap.uUseAccent = gl.getUniformLocation(prog, "uUseAccent");

    // Create a VAO for the fullscreen triangle (no actual vertex data)
    glHeatmap.vao = gl.createVertexArray();

    // Create the texture
    glHeatmap.texture = gl.createTexture();

    glHeatmap.ready = true;
    console.log("WebGL heatmap renderer initialized");
    return true;

  } catch (e) {
    console.warn("WebGL heatmap init failed:", e);
    return false;
  }
}


// ----------------------------------------------------------------
// RENDER WITH WEBGL
// ----------------------------------------------------------------
// Packs the 4 grid Float32Arrays into one RGBA float texture,
// uploads to GPU, renders a fullscreen quad with the color-mapping
// shader, then draws the result onto the main 2D canvas.
//
// Returns true if it rendered, false if it couldn't (caller should
// use the ImageData fallback).

function renderHeatmapGL(hmData, accentHex, refVal, mainCtx) {
  if (!glHeatmap.ready) return false;

  var gl = glHeatmap.gl;
  var grids = hmData.grids;
  var cols = hmData.cols;
  var rows = hmData.rows;
  var resolution = state.heatmapRes;
  var canvasW = cols * resolution;
  var canvasH = rows * resolution;

  // Resize offscreen canvas if needed
  if (glHeatmap.canvas.width !== cols || glHeatmap.canvas.height !== rows) {
    glHeatmap.canvas.width = cols;
    glHeatmap.canvas.height = rows;
    gl.viewport(0, 0, cols, rows);
  }

  // Pack 4 grids into one RGBA float texture.
  // Each pixel: R = green grid, G = yellow grid, B = blue grid, A = red grid.
  // Values are pre-normalized by refVal so the shader doesn't need to.
  var texData = new Float32Array(cols * rows * 4);
  var invRef = 1.0 / refVal;

  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      var srcIdx = y * cols + x;
      var dstIdx = srcIdx * 4;
      texData[dstIdx]     = grids[0][srcIdx] * invRef;  // green
      texData[dstIdx + 1] = grids[1][srcIdx] * invRef;  // yellow
      texData[dstIdx + 2] = grids[2][srcIdx] * invRef;  // blue
      texData[dstIdx + 3] = grids[3][srcIdx] * invRef;  // red
    }
  }

  // Upload texture
  gl.bindTexture(gl.TEXTURE_2D, glHeatmap.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0,
                gl.RGBA, gl.FLOAT, texData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Set up program and uniforms
  gl.useProgram(glHeatmap.program);
  gl.uniform1f(glHeatmap.uRefVal, 1.0);  // already normalized in texture

  if (accentHex) {
    var ar = parseInt(accentHex.slice(1, 3), 16) / 255;
    var ag = parseInt(accentHex.slice(3, 5), 16) / 255;
    var ab = parseInt(accentHex.slice(5, 7), 16) / 255;
    gl.uniform1i(glHeatmap.uUseAccent, 1);
    gl.uniform3f(glHeatmap.uAccent, ar, ag, ab);
  } else {
    gl.uniform1i(glHeatmap.uUseAccent, 0);
    gl.uniform3f(glHeatmap.uAccent, 0, 0, 0);
  }

  // Clear and draw fullscreen triangle
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);  // additive blending

  gl.bindVertexArray(glHeatmap.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Draw the GL canvas onto the main 2D canvas, scaled up by resolution
  mainCtx.save();
  mainCtx.globalCompositeOperation = "lighter";
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(glHeatmap.canvas, 0, 0, cols, rows,
                    0, 0, canvasW, canvasH);
  mainCtx.restore();

  return true;
}


// ----------------------------------------------------------------
// IMAGEDATA FALLBACK
// ----------------------------------------------------------------
// If WebGL isn't available, this is still ~50x faster than fillRect.
// Computes all pixels into a Uint8ClampedArray, then does one
// putImageData call instead of millions of individual fillRect calls.

function renderHeatmapImageData(hmData, accentHex, refVal, mainCtx) {
  var grids = hmData.grids;
  var cols = hmData.cols;
  var rows = hmData.rows;
  var resolution = state.heatmapRes;

  // Create an ImageData at grid resolution (cols × rows pixels)
  var imgData = new ImageData(cols, rows);
  var pixels = imgData.data;  // Uint8ClampedArray [R,G,B,A, R,G,B,A, ...]

  var invRef = 1.0 / refVal;

  // Base colors
  var baseR = [30, 240, 40, 240];   // green, yellow, blue, red
  var baseG = [220, 200, 140, 50];
  var baseB = [90, 40, 255, 50];

  var ar = 0, ag = 0, ab = 0;
  if (accentHex) {
    ar = parseInt(accentHex.slice(1, 3), 16);
    ag = parseInt(accentHex.slice(3, 5), 16);
    ab = parseInt(accentHex.slice(5, 7), 16);
  }

  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      var srcIdx = y * cols + x;
      var dstIdx = srcIdx * 4;

      // Read all 4 grid values
      var vals = [
        grids[0][srcIdx] * invRef,
        grids[1][srcIdx] * invRef,
        grids[2][srcIdx] * invRef,
        grids[3][srcIdx] * invRef,
      ];

      var total = vals[0] + vals[1] + vals[2] + vals[3];
      if (total < 0.01) continue;  // leave as transparent black

      var r = 0, g = 0, b = 0;

      if (accentHex) {
        var scale = Math.min(total * 0.4, 1.0);
        r = ar * scale;
        g = ag * scale;
        b = ab * scale;
      } else {
        // Additive blend of all 4 color channels
        for (var gi = 0; gi < 4; gi++) {
          var v = vals[gi];
          if (v < 0.01) continue;
          var intensity = v < 3.0 ? v : 3.0;
          var cr, cg, cb;
          if (intensity < 1.0) {
            cr = baseR[gi] * intensity * 0.4;
            cg = baseG[gi] * intensity * 0.4;
            cb = baseB[gi] * intensity * 0.4;
          } else {
            var excess = (intensity - 1.0) / 2.0;
            if (excess > 1.0) excess = 1.0;
            var fr = baseR[gi] * 0.4;
            var fg = baseG[gi] * 0.4;
            var fb = baseB[gi] * 0.4;
            cr = fr + excess * (255 - fr);
            cg = fg + excess * (255 - fg);
            cb = fb + excess * (255 - fb);
          }
          r += cr;
          g += cg;
          b += cb;
        }
      }

      // Clamp and write
      pixels[dstIdx]     = r > 255 ? 255 : r;
      pixels[dstIdx + 1] = g > 255 ? 255 : g;
      pixels[dstIdx + 2] = b > 255 ? 255 : b;
      pixels[dstIdx + 3] = 153;  // 0.6 * 255 = 153
    }
  }

  // Draw at grid resolution, then the canvas scales it up
  // Use a temporary small canvas to avoid affecting the main canvas size
  var tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = cols;
  tmpCanvas.height = rows;
  var tmpCtx = tmpCanvas.getContext("2d");
  tmpCtx.putImageData(imgData, 0, 0);

  // Draw scaled up onto the main canvas with additive blending
  mainCtx.save();
  mainCtx.globalCompositeOperation = "lighter";
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(tmpCanvas, 0, 0, cols, rows,
                    0, 0, cols * resolution, rows * resolution);
  mainCtx.restore();
}
