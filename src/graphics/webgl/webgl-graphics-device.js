import { setupVertexArrayObject } from '../../polyfill/OESVertexArrayObject.js';
import { now } from '../../core/time.js';
import { Debug } from '../../core/debug.js';
import { platform } from '../../core/platform.js';

import {
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_ADD,
    BLENDMODE_ZERO, BLENDMODE_ONE,
    CLEARFLAG_COLOR, CLEARFLAG_DEPTH, CLEARFLAG_STENCIL,
    CULLFACE_BACK, CULLFACE_NONE,
    FILTER_NEAREST, FILTER_LINEAR, FILTER_NEAREST_MIPMAP_NEAREST, FILTER_NEAREST_MIPMAP_LINEAR,
    FILTER_LINEAR_MIPMAP_NEAREST, FILTER_LINEAR_MIPMAP_LINEAR,
    FUNC_ALWAYS, FUNC_LESSEQUAL,
    PIXELFORMAT_R8_G8_B8_A8, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F,
    STENCILOP_KEEP,
    UNIFORMTYPE_BOOL, UNIFORMTYPE_INT, UNIFORMTYPE_FLOAT, UNIFORMTYPE_VEC2, UNIFORMTYPE_VEC3,
    UNIFORMTYPE_VEC4, UNIFORMTYPE_IVEC2, UNIFORMTYPE_IVEC3, UNIFORMTYPE_IVEC4, UNIFORMTYPE_BVEC2,
    UNIFORMTYPE_BVEC3, UNIFORMTYPE_BVEC4, UNIFORMTYPE_MAT2, UNIFORMTYPE_MAT3, UNIFORMTYPE_MAT4,
    UNIFORMTYPE_TEXTURE2D, UNIFORMTYPE_TEXTURECUBE, UNIFORMTYPE_FLOATARRAY, UNIFORMTYPE_TEXTURE2D_SHADOW,
    UNIFORMTYPE_TEXTURECUBE_SHADOW, UNIFORMTYPE_TEXTURE3D, UNIFORMTYPE_VEC2ARRAY, UNIFORMTYPE_VEC3ARRAY, UNIFORMTYPE_VEC4ARRAY,
    semanticToLocation
} from '../constants.js';

import { GraphicsDevice } from '../graphics-device.js';
import { createShaderFromCode } from '../program-lib/utils.js';
import { drawQuadWithShader } from '../simple-post-effect.js';
import { shaderChunks } from '../program-lib/chunks/chunks.js';
import { RenderTarget } from '../render-target.js';
import { Texture } from '../texture.js';
import { DebugGraphics } from '../debug-graphics.js';

import { WebglVertexBuffer } from './webgl-vertex-buffer.js';
import { WebglIndexBuffer } from './webgl-index-buffer.js';
import { WebglShader } from './webgl-shader.js';
import { WebglTexture } from './webgl-texture.js';
import { WebglRenderTarget } from './webgl-render-target.js';
import { Color } from '../../math/color.js';

/** @typedef {import('../index-buffer.js').IndexBuffer} IndexBuffer */
/** @typedef {import('../shader.js').Shader} Shader */
/** @typedef {import('../vertex-buffer.js').VertexBuffer} VertexBuffer */
/** @typedef {import('../render-pass.js').RenderPass} RenderPass */

const invalidateAttachments = [];

function testRenderable(gl, pixelFormat) {
    let result = true;

    // Create a 2x2 texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, pixelFormat, null);

    // Try to use this texture as a render target
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // It is legal for a WebGL implementation exposing the OES_texture_float extension to
    // support floating-point textures but not as attachments to framebuffer objects.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        result = false;
    }

    // Clean up
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);

    return result;
}

function testTextureHalfFloatUpdatable(gl, pixelFormat) {
    let result = true;

    // Create a 2x2 texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // upload some data - on iOS prior to about November 2019, passing data to half texture would fail here
    // see details here: https://bugs.webkit.org/show_bug.cgi?id=169999
    // note that if not supported, this prints an error to console, the error can be safely ignored as it's handled
    const data = new Uint16Array(4 * 2 * 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, pixelFormat, data);

    if (gl.getError() !== gl.NO_ERROR) {
        result = false;
        console.log("Above error related to HALF_FLOAT_OES can be ignored, it was triggered by testing half float texture support");
    }

    // Clean up
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(texture);

    return result;
}

function testTextureFloatHighPrecision(device) {
    if (!device.textureFloatRenderable)
        return false;

    const test1 = createShaderFromCode(device, shaderChunks.fullscreenQuadVS, shaderChunks.precisionTestPS, "ptest1");
    const test2 = createShaderFromCode(device, shaderChunks.fullscreenQuadVS, shaderChunks.precisionTest2PS, "ptest2");

    const textureOptions = {
        format: PIXELFORMAT_RGBA32F,
        width: 1,
        height: 1,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        name: 'testFHP'
    };
    const tex1 = new Texture(device, textureOptions);
    const targ1 = new RenderTarget({
        colorBuffer: tex1,
        depth: false
    });
    drawQuadWithShader(device, targ1, test1);

    textureOptions.format = PIXELFORMAT_R8_G8_B8_A8;
    const tex2 = new Texture(device, textureOptions);
    const targ2 = new RenderTarget({
        colorBuffer: tex2,
        depth: false
    });
    device.constantTexSource.setValue(tex1);
    drawQuadWithShader(device, targ2, test2);

    const prevFramebuffer = device.activeFramebuffer;
    device.setFramebuffer(targ2.impl._glFrameBuffer);

    const pixels = new Uint8Array(4);
    device.readPixels(0, 0, 1, 1, pixels);

    device.setFramebuffer(prevFramebuffer);

    const x = pixels[0] / 255;
    const y = pixels[1] / 255;
    const z = pixels[2] / 255;
    const w = pixels[3] / 255;
    const f = x / (256 * 256 * 256) + y / (256 * 256) + z / 256 + w;

    tex1.destroy();
    targ1.destroy();
    tex2.destroy();
    targ2.destroy();

    return f === 0;
}

/**
 * @event
 * @name GraphicsDevice#resizecanvas
 * @description The 'resizecanvas' event is fired when the canvas is resized.
 * @param {number} width - The new width of the canvas in pixels.
 * @param {number} height - The new height of the canvas in pixels.
 */

/**
 * The graphics device manages the underlying graphics context. It is responsible for submitting
 * render state changes and graphics primitives to the hardware. A graphics device is tied to a
 * specific canvas HTML element. It is valid to have more than one canvas element per page and
 * create a new graphics device against each.
 *
 * @augments GraphicsDevice
 */
class WebglGraphicsDevice extends GraphicsDevice {
    /**
     * The WebGL context managed by the graphics device. The type could also technically be
     * `WebGLRenderingContext` if WebGL 2.0 is not available. But in order for IntelliSense to be
     * able to function for all WebGL calls in the codebase, we specify `WebGL2RenderingContext`
     * here instead.
     *
     * @type {WebGL2RenderingContext}
     * @ignore
     */
    gl;

    /**
     * True if the WebGL context of this device is using the WebGL 2.0 API. If false, WebGL 1.0 is
     * being used.
     *
     * @type {boolean}
     * @ignore
     */
    webgl2;

    /**
     * Creates a new WebglGraphicsDevice instance.
     *
     * @param {HTMLCanvasElement} canvas - The canvas to which the graphics device will render.
     * @param {object} [options] - Options passed when creating the WebGL context.
     * @param {boolean} [options.alpha=true] - Boolean that indicates if the canvas contains an
     * alpha buffer.
     * @param {boolean} [options.depth=true] - Boolean that indicates that the drawing buffer is
     * requested to have a depth buffer of at least 16 bits.
     * @param {boolean} [options.stencil=false] - Boolean that indicates that the drawing buffer is
     * requested to have a stencil buffer of at least 8 bits.
     * @param {boolean} [options.antialias=true] - Boolean that indicates whether or not to perform
     * anti-aliasing if possible.
     * @param {boolean} [options.premultipliedAlpha=true] - Boolean that indicates that the page
     * compositor will assume the drawing buffer contains colors with pre-multiplied alpha.
     * @param {boolean} [options.preserveDrawingBuffer=false] - If the value is true the buffers
     * will not be cleared and will preserve their values until cleared or overwritten by the
     * author.
     * @param {'default'|'high-performance'|'low-power'} [options.powerPreference ='default'] - A
     * hint to the user agent indicating what configuration of GPU is suitable for the WebGL
     * context. Possible values are:
     *
     * - 'default': Let the user agent decide which GPU configuration is most suitable. This is the
     * default value.
     * - 'high-performance': Prioritizes rendering performance over power consumption.
     * - 'low-power': Prioritizes power saving over rendering performance.
     *
     * @param {boolean} [options.failIfMajorPerformanceCaveat=false] - Boolean that indicates if a
     * context will be created if the system performance is low or if no hardware GPU is available.
     * @param {boolean} [options.desynchronized=false] - Boolean that hints the user agent to
     * reduce the latency by desynchronizing the canvas paint cycle from the event loop.
     */
    constructor(canvas, options = {}) {
        super(canvas);

        this.defaultFramebuffer = null;

        // true if the default framebuffer has alpha
        this.defaultFramebufferAlpha = options.alpha;

        this.updateClientRect();

        // Add handlers for when the WebGL context is lost or restored
        this.contextLost = false;

        this._contextLostHandler = (event) => {
            event.preventDefault();
            this.contextLost = true;
            this.loseContext();
            Debug.log('pc.GraphicsDevice: WebGL context lost.');
            this.fire('devicelost');
        };

        this._contextRestoredHandler = () => {
            Debug.log('pc.GraphicsDevice: WebGL context restored.');
            this.restoreContext();
            this.contextLost = false;
            this.fire('devicerestored');
        };

        // options defaults
        options.stencil = true;
        if (!options.powerPreference) {
            options.powerPreference = 'high-performance';
        }

        // #4136 - turn off antialiasing on AppleWebKit browsers 15.4
        const ua = (typeof navigator !== 'undefined') && navigator.userAgent;
        this.forceDisableMultisampling = ua && ua.includes('AppleWebKit') && (ua.includes('15.4') || ua.includes('15_4'));
        if (this.forceDisableMultisampling) {
            options.antialias = false;
            Debug.log("Antialiasing has been turned off due to rendering issues on AppleWebKit 15.4");
        }

        // Retrieve the WebGL context
        const preferWebGl2 = (options.preferWebGl2 !== undefined) ? options.preferWebGl2 : true;

        const names = preferWebGl2 ? ["webgl2", "webgl", "experimental-webgl"] : ["webgl", "experimental-webgl"];
        let gl = null;
        for (let i = 0; i < names.length; i++) {
            gl = canvas.getContext(names[i], options);

            if (gl) {
                this.webgl2 = (names[i] === 'webgl2');
                break;
            }
        }

        if (!gl) {
            throw new Error("WebGL not supported");
        }

        const isChrome = platform.browser && !!window.chrome;
        const isMac = platform.browser && navigator.appVersion.indexOf("Mac") !== -1;

        this.gl = gl;

        // enable temporary texture unit workaround on desktop safari
        this._tempEnableSafariTextureUnitWorkaround = platform.browser && !!window.safari;

        // enable temporary workaround for glBlitFramebuffer failing on Mac Chrome (#2504)
        this._tempMacChromeBlitFramebufferWorkaround = isMac && isChrome && !options.alpha;

        // init polyfill for VAOs under webgl1
        if (!this.webgl2) {
            setupVertexArrayObject(gl);
        }

        canvas.addEventListener("webglcontextlost", this._contextLostHandler, false);
        canvas.addEventListener("webglcontextrestored", this._contextRestoredHandler, false);

        this.initializeExtensions();
        this.initializeCapabilities();
        this.initializeRenderState();
        this.initializeContextCaches();

        this.defaultClearOptions = {
            color: [0, 0, 0, 1],
            depth: 1,
            stencil: 0,
            flags: CLEARFLAG_COLOR | CLEARFLAG_DEPTH
        };

        this.glAddress = [
            gl.REPEAT,
            gl.CLAMP_TO_EDGE,
            gl.MIRRORED_REPEAT
        ];

        this.glBlendEquation = [
            gl.FUNC_ADD,
            gl.FUNC_SUBTRACT,
            gl.FUNC_REVERSE_SUBTRACT,
            this.webgl2 ? gl.MIN : this.extBlendMinmax ? this.extBlendMinmax.MIN_EXT : gl.FUNC_ADD,
            this.webgl2 ? gl.MAX : this.extBlendMinmax ? this.extBlendMinmax.MAX_EXT : gl.FUNC_ADD
        ];

        this.glBlendFunction = [
            gl.ZERO,
            gl.ONE,
            gl.SRC_COLOR,
            gl.ONE_MINUS_SRC_COLOR,
            gl.DST_COLOR,
            gl.ONE_MINUS_DST_COLOR,
            gl.SRC_ALPHA,
            gl.SRC_ALPHA_SATURATE,
            gl.ONE_MINUS_SRC_ALPHA,
            gl.DST_ALPHA,
            gl.ONE_MINUS_DST_ALPHA,
            gl.CONSTANT_COLOR,
            gl.ONE_MINUS_CONSTANT_COLOR,
            gl.CONSTANT_ALPHA,
            gl.ONE_MINUS_CONSTANT_ALPHA
        ];

        this.glComparison = [
            gl.NEVER,
            gl.LESS,
            gl.EQUAL,
            gl.LEQUAL,
            gl.GREATER,
            gl.NOTEQUAL,
            gl.GEQUAL,
            gl.ALWAYS
        ];

        this.glStencilOp = [
            gl.KEEP,
            gl.ZERO,
            gl.REPLACE,
            gl.INCR,
            gl.INCR_WRAP,
            gl.DECR,
            gl.DECR_WRAP,
            gl.INVERT
        ];

        this.glClearFlag = [
            0,
            gl.COLOR_BUFFER_BIT,
            gl.DEPTH_BUFFER_BIT,
            gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT,
            gl.STENCIL_BUFFER_BIT,
            gl.STENCIL_BUFFER_BIT | gl.COLOR_BUFFER_BIT,
            gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT,
            gl.STENCIL_BUFFER_BIT | gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT
        ];

        this.glCull = [
            0,
            gl.BACK,
            gl.FRONT,
            gl.FRONT_AND_BACK
        ];

        this.glFilter = [
            gl.NEAREST,
            gl.LINEAR,
            gl.NEAREST_MIPMAP_NEAREST,
            gl.NEAREST_MIPMAP_LINEAR,
            gl.LINEAR_MIPMAP_NEAREST,
            gl.LINEAR_MIPMAP_LINEAR
        ];

        this.glPrimitive = [
            gl.POINTS,
            gl.LINES,
            gl.LINE_LOOP,
            gl.LINE_STRIP,
            gl.TRIANGLES,
            gl.TRIANGLE_STRIP,
            gl.TRIANGLE_FAN
        ];

        this.glType = [
            gl.BYTE,
            gl.UNSIGNED_BYTE,
            gl.SHORT,
            gl.UNSIGNED_SHORT,
            gl.INT,
            gl.UNSIGNED_INT,
            gl.FLOAT
        ];

        this.pcUniformType = {};
        this.pcUniformType[gl.BOOL]         = UNIFORMTYPE_BOOL;
        this.pcUniformType[gl.INT]          = UNIFORMTYPE_INT;
        this.pcUniformType[gl.FLOAT]        = UNIFORMTYPE_FLOAT;
        this.pcUniformType[gl.FLOAT_VEC2]   = UNIFORMTYPE_VEC2;
        this.pcUniformType[gl.FLOAT_VEC3]   = UNIFORMTYPE_VEC3;
        this.pcUniformType[gl.FLOAT_VEC4]   = UNIFORMTYPE_VEC4;
        this.pcUniformType[gl.INT_VEC2]     = UNIFORMTYPE_IVEC2;
        this.pcUniformType[gl.INT_VEC3]     = UNIFORMTYPE_IVEC3;
        this.pcUniformType[gl.INT_VEC4]     = UNIFORMTYPE_IVEC4;
        this.pcUniformType[gl.BOOL_VEC2]    = UNIFORMTYPE_BVEC2;
        this.pcUniformType[gl.BOOL_VEC3]    = UNIFORMTYPE_BVEC3;
        this.pcUniformType[gl.BOOL_VEC4]    = UNIFORMTYPE_BVEC4;
        this.pcUniformType[gl.FLOAT_MAT2]   = UNIFORMTYPE_MAT2;
        this.pcUniformType[gl.FLOAT_MAT3]   = UNIFORMTYPE_MAT3;
        this.pcUniformType[gl.FLOAT_MAT4]   = UNIFORMTYPE_MAT4;
        this.pcUniformType[gl.SAMPLER_2D]   = UNIFORMTYPE_TEXTURE2D;
        this.pcUniformType[gl.SAMPLER_CUBE] = UNIFORMTYPE_TEXTURECUBE;
        if (this.webgl2) {
            this.pcUniformType[gl.SAMPLER_2D_SHADOW]   = UNIFORMTYPE_TEXTURE2D_SHADOW;
            this.pcUniformType[gl.SAMPLER_CUBE_SHADOW] = UNIFORMTYPE_TEXTURECUBE_SHADOW;
            this.pcUniformType[gl.SAMPLER_3D]          = UNIFORMTYPE_TEXTURE3D;
        }

        this.targetToSlot = {};
        this.targetToSlot[gl.TEXTURE_2D] = 0;
        this.targetToSlot[gl.TEXTURE_CUBE_MAP] = 1;
        this.targetToSlot[gl.TEXTURE_3D] = 2;

        // Define the uniform commit functions
        let scopeX, scopeY, scopeZ, scopeW;
        let uniformValue;
        this.commitFunction = [];
        this.commitFunction[UNIFORMTYPE_BOOL] = function (uniform, value) {
            if (uniform.value !== value) {
                gl.uniform1i(uniform.locationId, value);
                uniform.value = value;
            }
        };
        this.commitFunction[UNIFORMTYPE_INT] = this.commitFunction[UNIFORMTYPE_BOOL];
        this.commitFunction[UNIFORMTYPE_FLOAT] = function (uniform, value) {
            if (uniform.value !== value) {
                gl.uniform1f(uniform.locationId, value);
                uniform.value = value;
            }
        };
        this.commitFunction[UNIFORMTYPE_VEC2]  = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY) {
                gl.uniform2fv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
            }
        };
        this.commitFunction[UNIFORMTYPE_VEC3]  = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            scopeZ = value[2];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY || uniformValue[2] !== scopeZ) {
                gl.uniform3fv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
                uniformValue[2] = scopeZ;
            }
        };
        this.commitFunction[UNIFORMTYPE_VEC4]  = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            scopeZ = value[2];
            scopeW = value[3];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY || uniformValue[2] !== scopeZ || uniformValue[3] !== scopeW) {
                gl.uniform4fv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
                uniformValue[2] = scopeZ;
                uniformValue[3] = scopeW;
            }
        };
        this.commitFunction[UNIFORMTYPE_IVEC2] = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY) {
                gl.uniform2iv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
            }
        };
        this.commitFunction[UNIFORMTYPE_BVEC2] = this.commitFunction[UNIFORMTYPE_IVEC2];
        this.commitFunction[UNIFORMTYPE_IVEC3] = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            scopeZ = value[2];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY || uniformValue[2] !== scopeZ) {
                gl.uniform3iv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
                uniformValue[2] = scopeZ;
            }
        };
        this.commitFunction[UNIFORMTYPE_BVEC3] = this.commitFunction[UNIFORMTYPE_IVEC3];
        this.commitFunction[UNIFORMTYPE_IVEC4] = function (uniform, value) {
            uniformValue = uniform.value;
            scopeX = value[0];
            scopeY = value[1];
            scopeZ = value[2];
            scopeW = value[3];
            if (uniformValue[0] !== scopeX || uniformValue[1] !== scopeY || uniformValue[2] !== scopeZ || uniformValue[3] !== scopeW) {
                gl.uniform4iv(uniform.locationId, value);
                uniformValue[0] = scopeX;
                uniformValue[1] = scopeY;
                uniformValue[2] = scopeZ;
                uniformValue[3] = scopeW;
            }
        };
        this.commitFunction[UNIFORMTYPE_BVEC4] = this.commitFunction[UNIFORMTYPE_IVEC4];
        this.commitFunction[UNIFORMTYPE_MAT2]  = function (uniform, value) {
            gl.uniformMatrix2fv(uniform.locationId, false, value);
        };
        this.commitFunction[UNIFORMTYPE_MAT3]  = function (uniform, value) {
            gl.uniformMatrix3fv(uniform.locationId, false, value);
        };
        this.commitFunction[UNIFORMTYPE_MAT4]  = function (uniform, value) {
            gl.uniformMatrix4fv(uniform.locationId, false, value);
        };
        this.commitFunction[UNIFORMTYPE_FLOATARRAY] = function (uniform, value) {
            gl.uniform1fv(uniform.locationId, value);
        };
        this.commitFunction[UNIFORMTYPE_VEC2ARRAY]  = function (uniform, value) {
            gl.uniform2fv(uniform.locationId, value);
        };
        this.commitFunction[UNIFORMTYPE_VEC3ARRAY]  = function (uniform, value) {
            gl.uniform3fv(uniform.locationId, value);
        };
        this.commitFunction[UNIFORMTYPE_VEC4ARRAY]  = function (uniform, value) {
            gl.uniform4fv(uniform.locationId, value);
        };

        this.supportsBoneTextures = this.extTextureFloat && this.maxVertexTextures > 0;

        // Calculate an estimate of the maximum number of bones that can be uploaded to the GPU
        // based on the number of available uniforms and the number of uniforms required for non-
        // bone data.  This is based off of the Standard shader.  A user defined shader may have
        // even less space available for bones so this calculated value can be overridden via
        // pc.GraphicsDevice.setBoneLimit.
        let numUniforms = this.vertexUniformsCount;
        numUniforms -= 4 * 4; // Model, view, projection and shadow matrices
        numUniforms -= 8;     // 8 lights max, each specifying a position vector
        numUniforms -= 1;     // Eye position
        numUniforms -= 4 * 4; // Up to 4 texture transforms
        this.boneLimit = Math.floor(numUniforms / 3);   // each bone uses 3 uniforms

        // Put a limit on the number of supported bones before skin partitioning must be performed
        // Some GPUs have demonstrated performance issues if the number of vectors allocated to the
        // skin matrix palette is left unbounded
        this.boneLimit = Math.min(this.boneLimit, 128);

        if (this.unmaskedRenderer === 'Mali-450 MP') {
            this.boneLimit = 34;
        }

        this.constantTexSource = this.scope.resolve("source");
        this.textureBias = this.scope.resolve("textureBias");

        this.textureBias.setValue(0.0);

        if (this.extTextureFloat) {
            if (this.webgl2) {
                // In WebGL2 float texture renderability is dictated by the EXT_color_buffer_float extension
                this.textureFloatRenderable = !!this.extColorBufferFloat;
            } else {
                // In WebGL1 we should just try rendering into a float texture
                this.textureFloatRenderable = testRenderable(gl, gl.FLOAT);
            }
        } else {
            this.textureFloatRenderable = false;
        }

        // two extensions allow us to render to half float buffers
        if (this.extColorBufferHalfFloat) {
            this.textureHalfFloatRenderable = !!this.extColorBufferHalfFloat;
        } else if (this.extTextureHalfFloat) {
            if (this.webgl2) {
                // EXT_color_buffer_float should affect both float and halffloat formats
                this.textureHalfFloatRenderable = !!this.extColorBufferFloat;
            } else {
                // Manual render check for half float
                this.textureHalfFloatRenderable = testRenderable(gl, this.extTextureHalfFloat.HALF_FLOAT_OES);
            }
        } else {
            this.textureHalfFloatRenderable = false;
        }

        this.supportsMorphTargetTexturesCore = (this.maxPrecision === "highp" && this.maxVertexTextures >= 2);

        this._textureFloatHighPrecision = undefined;
        this._textureHalfFloatUpdatable = undefined;

        // #if _DEBUG
        this._spectorMarkers = [];
        this._spectorCurrentMarker = "";
        // #endif

        // area light LUT format - order of preference: half, float, 8bit
        this.areaLightLutFormat = PIXELFORMAT_R8_G8_B8_A8;
        if (this.extTextureHalfFloat && this.textureHalfFloatUpdatable && this.extTextureHalfFloatLinear) {
            this.areaLightLutFormat = PIXELFORMAT_RGBA16F;
        } else if (this.extTextureFloat && this.extTextureFloatLinear) {
            this.areaLightLutFormat = PIXELFORMAT_RGBA32F;
        }
    }

    /**
     * Destroy the graphics device.
     */
    destroy() {
        super.destroy();
        const gl = this.gl;

        if (this.webgl2 && this.feedback) {
            gl.deleteTransformFeedback(this.feedback);
        }

        this.clearShaderCache();
        this.clearVertexArrayObjectCache();

        this.canvas.removeEventListener('webglcontextlost', this._contextLostHandler, false);
        this.canvas.removeEventListener('webglcontextrestored', this._contextRestoredHandler, false);

        this._contextLostHandler = null;
        this._contextRestoredHandler = null;

        this.gl = null;

        super.postDestroy();
    }

    // provide webgl implementation for the vertex buffer
    createVertexBufferImpl(vertexBuffer, format) {
        return new WebglVertexBuffer();
    }

    // provide webgl implementation for the index buffer
    createIndexBufferImpl(indexBuffer) {
        return new WebglIndexBuffer(indexBuffer);
    }

    createShaderImpl(shader) {
        return new WebglShader(shader);
    }

    createTextureImpl() {
        return new WebglTexture();
    }

    createRenderTargetImpl(renderTarget) {
        return new WebglRenderTarget();
    }

    // #if _DEBUG
    updateMarker() {
        this._spectorCurrentMarker = this._spectorMarkers.join(" | ") + " # ";
    }

    pushMarker(name) {
        if (window.spector) {
            this._spectorMarkers.push(name);
            this.updateMarker();
            window.spector.setMarker(this._spectorCurrentMarker);
        }
    }

    popMarker() {
        if (window.spector) {
            if (this._spectorMarkers.length) {
                this._spectorMarkers.pop();
                this.updateMarker();

                if (this._spectorMarkers.length)
                    window.spector.setMarker(this._spectorCurrentMarker);
                else
                    window.spector.clearMarker();
            }
        }
    }
    // #endif

    /**
     * Query the precision supported by ints and floats in vertex and fragment shaders. Note that
     * getShaderPrecisionFormat is not guaranteed to be present (such as some instances of the
     * default Android browser). In this case, assume highp is available.
     *
     * @returns {string} "highp", "mediump" or "lowp"
     * @ignore
     */
    getPrecision() {
        const gl = this.gl;
        let precision = "highp";

        if (gl.getShaderPrecisionFormat) {
            const vertexShaderPrecisionHighpFloat = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
            const vertexShaderPrecisionMediumpFloat = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT);

            const fragmentShaderPrecisionHighpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
            const fragmentShaderPrecisionMediumpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);

            const highpAvailable = vertexShaderPrecisionHighpFloat.precision > 0 && fragmentShaderPrecisionHighpFloat.precision > 0;
            const mediumpAvailable = vertexShaderPrecisionMediumpFloat.precision > 0 && fragmentShaderPrecisionMediumpFloat.precision > 0;

            if (!highpAvailable) {
                if (mediumpAvailable) {
                    precision = "mediump";
                    Debug.warn("WARNING: highp not supported, using mediump");
                } else {
                    precision = "lowp";
                    Debug.warn("WARNING: highp and mediump not supported, using lowp");
                }
            }
        }

        return precision;
    }

    /**
     * Initialize the extensions provided by the WebGL context.
     *
     * @ignore
     */
    initializeExtensions() {
        const gl = this.gl;
        const supportedExtensions = gl.getSupportedExtensions();

        const getExtension = function () {
            for (let i = 0; i < arguments.length; i++) {
                if (supportedExtensions.indexOf(arguments[i]) !== -1) {
                    return gl.getExtension(arguments[i]);
                }
            }
            return null;
        };

        if (this.webgl2) {
            this.extBlendMinmax = true;
            this.extDrawBuffers = true;
            this.extInstancing = true;
            this.extStandardDerivatives = true;
            this.extTextureFloat = true;
            this.extTextureHalfFloat = true;
            this.extTextureLod = true;
            this.extUintElement = true;
            this.extVertexArrayObject = true;
            this.extColorBufferFloat = getExtension('EXT_color_buffer_float');
            // Note that Firefox exposes EXT_disjoint_timer_query under WebGL2 rather than
            // EXT_disjoint_timer_query_webgl2
            this.extDisjointTimerQuery = getExtension('EXT_disjoint_timer_query_webgl2', 'EXT_disjoint_timer_query');
            this.extDepthTexture = true;
        } else {
            this.extBlendMinmax = getExtension("EXT_blend_minmax");
            this.extDrawBuffers = getExtension('EXT_draw_buffers');
            this.extInstancing = getExtension("ANGLE_instanced_arrays");
            if (this.extInstancing) {
                // Install the WebGL 2 Instancing API for WebGL 1.0
                const ext = this.extInstancing;
                gl.drawArraysInstanced = ext.drawArraysInstancedANGLE.bind(ext);
                gl.drawElementsInstanced = ext.drawElementsInstancedANGLE.bind(ext);
                gl.vertexAttribDivisor = ext.vertexAttribDivisorANGLE.bind(ext);
            }

            this.extStandardDerivatives = getExtension("OES_standard_derivatives");
            this.extTextureFloat = getExtension("OES_texture_float");
            this.extTextureHalfFloat = getExtension("OES_texture_half_float");
            this.extTextureLod = getExtension('EXT_shader_texture_lod');
            this.extUintElement = getExtension("OES_element_index_uint");
            this.extVertexArrayObject = getExtension("OES_vertex_array_object");
            if (this.extVertexArrayObject) {
                // Install the WebGL 2 VAO API for WebGL 1.0
                const ext = this.extVertexArrayObject;
                gl.createVertexArray = ext.createVertexArrayOES.bind(ext);
                gl.deleteVertexArray = ext.deleteVertexArrayOES.bind(ext);
                gl.isVertexArray = ext.isVertexArrayOES.bind(ext);
                gl.bindVertexArray = ext.bindVertexArrayOES.bind(ext);
            }
            this.extColorBufferFloat = null;
            this.extDisjointTimerQuery = null;
            this.extDepthTexture = gl.getExtension('WEBGL_depth_texture');
        }

        this.extDebugRendererInfo = getExtension('WEBGL_debug_renderer_info');
        this.extTextureFloatLinear = getExtension("OES_texture_float_linear");
        this.extTextureHalfFloatLinear = getExtension("OES_texture_half_float_linear");
        this.extFloatBlend = getExtension("EXT_float_blend");
        this.extTextureFilterAnisotropic = getExtension('EXT_texture_filter_anisotropic', 'WEBKIT_EXT_texture_filter_anisotropic');
        this.extCompressedTextureETC1 = getExtension('WEBGL_compressed_texture_etc1');
        this.extCompressedTextureETC = getExtension('WEBGL_compressed_texture_etc');
        this.extCompressedTexturePVRTC = getExtension('WEBGL_compressed_texture_pvrtc', 'WEBKIT_WEBGL_compressed_texture_pvrtc');
        this.extCompressedTextureS3TC = getExtension('WEBGL_compressed_texture_s3tc', 'WEBKIT_WEBGL_compressed_texture_s3tc');
        this.extCompressedTextureATC = getExtension('WEBGL_compressed_texture_atc');
        this.extCompressedTextureASTC = getExtension('WEBGL_compressed_texture_astc');
        this.extParallelShaderCompile = getExtension('KHR_parallel_shader_compile');

        // iOS exposes this for half precision render targets on both Webgl1 and 2 from iOS v 14.5beta
        this.extColorBufferHalfFloat = getExtension("EXT_color_buffer_half_float");
    }

    /**
     * Query the capabilities of the WebGL context.
     *
     * @ignore
     */
    initializeCapabilities() {
        const gl = this.gl;
        let ext;

        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : "";

        this.maxPrecision = this.precision = this.getPrecision();

        const contextAttribs = gl.getContextAttributes();
        this.supportsMsaa = contextAttribs.antialias;
        this.supportsStencil = contextAttribs.stencil;

        this.supportsInstancing = !!this.extInstancing;

        // Query parameter values from the WebGL context
        this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        this.maxCubeMapSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
        this.maxRenderBufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        this.maxTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
        this.maxCombinedTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
        this.maxVertexTextures = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
        this.vertexUniformsCount = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
        this.fragmentUniformsCount = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
        if (this.webgl2) {
            this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
            this.maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
            this.maxVolumeSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
        } else {
            ext = this.extDrawBuffers;
            this.maxDrawBuffers = ext ? gl.getParameter(ext.MAX_DRAW_BUFFERS_EXT) : 1;
            this.maxColorAttachments = ext ? gl.getParameter(ext.MAX_COLOR_ATTACHMENTS_EXT) : 1;
            this.maxVolumeSize = 1;
        }

        ext = this.extDebugRendererInfo;
        this.unmaskedRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
        this.unmaskedVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '';

        // Check if we support GPU particles. At the moment, Samsung devices with Exynos (ARM) either crash or render
        // incorrectly when using GPU for particles. See:
        // https://github.com/playcanvas/engine/issues/3967
        // https://github.com/playcanvas/engine/issues/3415
        const samsungModelRegex = /SM-[a-zA-Z0-9]+\)/;
        this.supportsGpuParticles = !(this.unmaskedVendor === 'ARM' && userAgent.match(samsungModelRegex));

        ext = this.extTextureFilterAnisotropic;
        this.maxAnisotropy = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

        this.samples = gl.getParameter(gl.SAMPLES);
        this.maxSamples = this.webgl2 && !this.forceDisableMultisampling ? gl.getParameter(gl.MAX_SAMPLES) : 1;

        // Don't allow area lights on old android devices, they often fail to compile the shader, run it incorrectly or are very slow.
        this.supportsAreaLights = this.webgl2 || !platform.android;

        // Also do not allow them when we only have small number of texture units
        if (this.maxTextures <= 8) {
            this.supportsAreaLights = false;
        }
    }

    /**
     * Set the initial render state on the WebGL context.
     *
     * @ignore
     */
    initializeRenderState() {
        const gl = this.gl;

        // Initialize render state to a known start state
        this.blending = false;
        gl.disable(gl.BLEND);

        this.blendSrc = BLENDMODE_ONE;
        this.blendDst = BLENDMODE_ZERO;
        this.blendSrcAlpha = BLENDMODE_ONE;
        this.blendDstAlpha = BLENDMODE_ZERO;
        this.separateAlphaBlend = false;
        this.blendEquation = BLENDEQUATION_ADD;
        this.blendAlphaEquation = BLENDEQUATION_ADD;
        this.separateAlphaEquation = false;
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.blendEquation(gl.FUNC_ADD);

        this.blendColor = new Color(0, 0, 0, 0);
        gl.blendColor(0, 0, 0, 0);

        this.writeRed = true;
        this.writeGreen = true;
        this.writeBlue = true;
        this.writeAlpha = true;
        gl.colorMask(true, true, true, true);

        this.cullMode = CULLFACE_BACK;
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        this.depthTest = true;
        gl.enable(gl.DEPTH_TEST);

        this.depthFunc = FUNC_LESSEQUAL;
        gl.depthFunc(gl.LEQUAL);

        this.depthWrite = true;
        gl.depthMask(true);

        this.stencil = false;
        gl.disable(gl.STENCIL_TEST);

        this.stencilFuncFront = this.stencilFuncBack = FUNC_ALWAYS;
        this.stencilRefFront = this.stencilRefBack = 0;
        this.stencilMaskFront = this.stencilMaskBack = 0xFF;
        gl.stencilFunc(gl.ALWAYS, 0, 0xFF);

        this.stencilFailFront = this.stencilFailBack = STENCILOP_KEEP;
        this.stencilZfailFront = this.stencilZfailBack = STENCILOP_KEEP;
        this.stencilZpassFront = this.stencilZpassBack = STENCILOP_KEEP;
        this.stencilWriteMaskFront = 0xFF;
        this.stencilWriteMaskBack = 0xFF;
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.stencilMask(0xFF);

        this.alphaToCoverage = false;
        this.raster = true;
        if (this.webgl2) {
            gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            gl.disable(gl.RASTERIZER_DISCARD);
        }

        this.depthBiasEnabled = false;
        gl.disable(gl.POLYGON_OFFSET_FILL);

        this.clearDepth = 1;
        gl.clearDepth(1);

        this.clearColor = new Color(0, 0, 0, 0);
        gl.clearColor(0, 0, 0, 0);

        this.clearStencil = 0;
        gl.clearStencil(0);

        // Cached viewport and scissor dimensions
        this.vx = this.vy = this.vw = this.vh = 0;
        this.sx = this.sy = this.sw = this.sh = 0;

        if (this.webgl2) {
            gl.hint(gl.FRAGMENT_SHADER_DERIVATIVE_HINT, gl.NICEST);
        } else {
            if (this.extStandardDerivatives) {
                gl.hint(this.extStandardDerivatives.FRAGMENT_SHADER_DERIVATIVE_HINT_OES, gl.NICEST);
            }
        }

        gl.enable(gl.SCISSOR_TEST);

        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

        this.unpackFlipY = false;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        this.unpackPremultiplyAlpha = false;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }

    initializeContextCaches() {
        super.initializeContextCaches();

        // Shader code to WebGL shader cache
        this.vertexShaderCache = {};
        this.fragmentShaderCache = {};

        // cache of VAOs
        this._vaoMap = new Map();

        this.boundVao = null;
        this.activeFramebuffer = null;
        this.feedback = null;
        this.transformFeedbackBuffer = null;

        this.textureUnit = 0;
        this.textureUnits = [];
        for (let i = 0; i < this.maxCombinedTextures; i++) {
            this.textureUnits.push([null, null, null]);
        }
    }

    /**
     * Called when the WebGL context was lost. It releases all context related resources.
     *
     * @ignore
     */
    loseContext() {
        // release shaders
        for (const shader of this.shaders) {
            shader.loseContext();
        }

        // release textures
        for (const texture of this.textures) {
            texture.loseContext();
        }

        // release vertex and index buffers
        for (const buffer of this.buffers) {
            buffer.loseContext();
        }

        // Reset all render targets so they'll be recreated as required.
        // TODO: a solution for the case where a render target contains something
        // that was previously generated that needs to be re-rendered.
        for (const target of this.targets) {
            target.loseContext();
        }
    }

    /**
     * Called when the WebGL context is restored. It reinitializes all context related resources.
     *
     * @ignore
     */
    restoreContext() {
        this.initializeExtensions();
        this.initializeCapabilities();
        this.initializeRenderState();
        this.initializeContextCaches();

        // Recompile all shaders (they'll be linked when they're next actually used)
        for (const shader of this.shaders) {
            shader.restoreContext();
        }

        // Recreate buffer objects and reupload buffer data to the GPU
        for (const buffer of this.buffers) {
            buffer.unlock();
        }
    }

    /**
     * Set the active rectangle for rendering on the specified device.
     *
     * @param {number} x - The pixel space x-coordinate of the bottom left corner of the viewport.
     * @param {number} y - The pixel space y-coordinate of the bottom left corner of the viewport.
     * @param {number} w - The width of the viewport in pixels.
     * @param {number} h - The height of the viewport in pixels.
     */
    setViewport(x, y, w, h) {
        if ((this.vx !== x) || (this.vy !== y) || (this.vw !== w) || (this.vh !== h)) {
            this.gl.viewport(x, y, w, h);
            this.vx = x;
            this.vy = y;
            this.vw = w;
            this.vh = h;
        }
    }

    /**
     * Set the active scissor rectangle on the specified device.
     *
     * @param {number} x - The pixel space x-coordinate of the bottom left corner of the scissor rectangle.
     * @param {number} y - The pixel space y-coordinate of the bottom left corner of the scissor rectangle.
     * @param {number} w - The width of the scissor rectangle in pixels.
     * @param {number} h - The height of the scissor rectangle in pixels.
     */
    setScissor(x, y, w, h) {
        if ((this.sx !== x) || (this.sy !== y) || (this.sw !== w) || (this.sh !== h)) {
            this.gl.scissor(x, y, w, h);
            this.sx = x;
            this.sy = y;
            this.sw = w;
            this.sh = h;
        }
    }

    /**
     * Binds the specified framebuffer object.
     *
     * @param {WebGLFramebuffer | null} fb - The framebuffer to bind.
     * @ignore
     */
    setFramebuffer(fb) {
        if (this.activeFramebuffer !== fb) {
            const gl = this.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            this.activeFramebuffer = fb;
        }
    }

    /**
     * Copies source render target into destination render target. Mostly used by post-effects.
     *
     * @param {RenderTarget} [source] - The source render target. Defaults to frame buffer.
     * @param {RenderTarget} [dest] - The destination render target. Defaults to frame buffer.
     * @param {boolean} [color] - If true will copy the color buffer. Defaults to false.
     * @param {boolean} [depth] - If true will copy the depth buffer. Defaults to false.
     * @returns {boolean} True if the copy was successful, false otherwise.
     */
    copyRenderTarget(source, dest, color, depth) {
        const gl = this.gl;

        if (!this.webgl2 && depth) {
            Debug.error("Depth is not copyable on WebGL 1.0");
            return false;
        }
        if (color) {
            if (!dest) {
                // copying to backbuffer
                if (!source._colorBuffer) {
                    Debug.error("Can't copy empty color buffer to backbuffer");
                    return false;
                }
            } else if (source) {
                // copying to render target
                if (!source._colorBuffer || !dest._colorBuffer) {
                    Debug.error("Can't copy color buffer, because one of the render targets doesn't have it");
                    return false;
                }
                if (source._colorBuffer._format !== dest._colorBuffer._format) {
                    Debug.error("Can't copy render targets of different color formats");
                    return false;
                }
            }
        }
        if (depth && source) {
            if (!source._depth) {   // when depth is automatic, we cannot test the buffer nor its format
                if (!source._depthBuffer || !dest._depthBuffer) {
                    Debug.error("Can't copy depth buffer, because one of the render targets doesn't have it");
                    return false;
                }
                if (source._depthBuffer._format !== dest._depthBuffer._format) {
                    Debug.error("Can't copy render targets of different depth formats");
                    return false;
                }
            }
        }

        DebugGraphics.pushGpuMarker(this, 'COPY-RT');

        if (this.webgl2 && dest) {
            const prevRt = this.renderTarget;
            this.renderTarget = dest;
            this.updateBegin();
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source ? source.impl._glFrameBuffer : null);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.impl._glFrameBuffer);
            const w = source ? source.width : dest.width;
            const h = source ? source.height : dest.height;
            gl.blitFramebuffer(0, 0, w, h,
                               0, 0, w, h,
                               (color ? gl.COLOR_BUFFER_BIT : 0) | (depth ? gl.DEPTH_BUFFER_BIT : 0),
                               gl.NEAREST);
            this.renderTarget = prevRt;
            gl.bindFramebuffer(gl.FRAMEBUFFER, prevRt ? prevRt.impl._glFrameBuffer : null);
        } else {
            const shader = this.getCopyShader();
            this.constantTexSource.setValue(source._colorBuffer);
            drawQuadWithShader(this, dest, shader);
        }

        DebugGraphics.popGpuMarker(this);

        return true;
    }

    /**
     * Initialize render target before it can be used.
     *
     * @param {RenderTarget} target - The render target to be initialized.
     * @ignore
     */
    initRenderTarget(target) {
        if (target.impl._glFrameBuffer) return;

        // #if _PROFILER
        const startTime = now();
        this.fire('fbo:create', {
            timestamp: startTime,
            target: this
        });
        // #endif

        target.init();
        this.targets.push(target);

        // #if _PROFILER
        this._renderTargetCreationTime += now() - startTime;
        // #endif
    }

    /**
     * Get copy shader for efficient rendering of fullscreen-quad with texture.
     *
     * @returns {Shader} The copy shader (based on `fullscreenQuadVS` and `outputTex2DPS` in
     * `shaderChunks`).
     * @ignore
     */
    getCopyShader() {
        if (!this._copyShader) {
            const vs = shaderChunks.fullscreenQuadVS;
            const fs = shaderChunks.outputTex2DPS;
            this._copyShader = createShaderFromCode(this, vs, fs, "outputTex2D");
        }
        return this._copyShader;
    }

    /**
     * Start a render pass.
     *
     * @param {RenderPass} renderPass - The render pass to start.
     * @ignore
     */
    startPass(renderPass) {

        DebugGraphics.pushGpuMarker(this, `START-PASS`);

        // set up render target
        this.setRenderTarget(renderPass.renderTarget);
        this.updateBegin();

        // clear the render target
        const colorOps = renderPass.colorOps;
        const depthStencilOps = renderPass.depthStencilOps;
        if (colorOps.clear || depthStencilOps.clearDepth || depthStencilOps.clearStencil) {

            // the pass always clears full target
            const rt = renderPass.renderTarget;
            const width = rt ? rt.width : this.width;
            const height = rt ? rt.height : this.height;
            this.setViewport(0, 0, width, height);
            this.setScissor(0, 0, width, height);

            let clearFlags = 0;
            const clearOptions = {};

            if (colorOps.clear) {
                clearFlags |= CLEARFLAG_COLOR;
                clearOptions.color = [colorOps.clearValue.r, colorOps.clearValue.g, colorOps.clearValue.b, colorOps.clearValue.a];
            }

            if (depthStencilOps.clearDepth) {
                clearFlags |= CLEARFLAG_DEPTH;
                clearOptions.depth = depthStencilOps.clearDepthValue;
            }

            if (depthStencilOps.clearStencil) {
                clearFlags |= CLEARFLAG_STENCIL;
                clearOptions.stencil = depthStencilOps.clearStencilValue;
            }

            // clear it
            clearOptions.flags = clearFlags;
            this.clear(clearOptions);
        }

        Debug.assert(!this.insideRenderPass);
        this.insideRenderPass = true;

        DebugGraphics.popGpuMarker(this);
    }

    /**
     * End a render pass.
     *
     * @param {RenderPass} renderPass - The render pass to end.
     * @ignore
     */
    endPass(renderPass) {

        DebugGraphics.pushGpuMarker(this, `END-PASS`);

        this.unbindVertexArray();

        const target = this.renderTarget;
        if (target) {

            // invalidate buffers to stop them being written to on tiled architextures
            if (this.webgl2) {
                invalidateAttachments.length = 0;
                const gl = this.gl;

                // invalidate color only if we don't need to resolve it
                if (!(renderPass.colorOps.store || renderPass.colorOps.resolve)) {
                    invalidateAttachments.push(gl.COLOR_ATTACHMENT0);
                }
                if (!renderPass.depthStencilOps.storeDepth) {
                    invalidateAttachments.push(gl.DEPTH_ATTACHMENT);
                }
                if (!renderPass.depthStencilOps.storeStencil) {
                    invalidateAttachments.push(gl.STENCIL_ATTACHMENT);
                }

                if (invalidateAttachments.length > 0) {

                    // invalidate the whole buffer
                    // TODO: we could handle viewport invalidation as well
                    if (renderPass.fullSizeClearRect) {
                        gl.invalidateFramebuffer(gl.DRAW_FRAMEBUFFER, invalidateAttachments);
                    }
                }
            }

            // resolve the color buffer
            if (renderPass.colorOps.resolve) {
                if (this.webgl2 && renderPass.samples > 1 && target.autoResolve) {
                    target.resolve(true, false);
                }
            }

            // generate mipmaps
            if (renderPass.colorOps.mipmaps) {
                const colorBuffer = target._colorBuffer;
                if (colorBuffer && colorBuffer.impl._glTexture && colorBuffer.mipmaps && (colorBuffer.pot || this.webgl2)) {
                    this.activeTexture(this.maxCombinedTextures - 1);
                    this.bindTexture(colorBuffer);
                    this.gl.generateMipmap(colorBuffer.impl._glTarget);
                }
            }
        }

        this.insideRenderPass = false;

        DebugGraphics.popGpuMarker(this);
    }

    /**
     * Marks the beginning of a block of rendering. Internally, this function binds the render
     * target currently set on the device. This function should be matched with a call to
     * {@link GraphicsDevice#updateEnd}. Calls to {@link GraphicsDevice#updateBegin} and
     * {@link GraphicsDevice#updateEnd} must not be nested.
     *
     * @ignore
     */
    updateBegin() {
        DebugGraphics.pushGpuMarker(this, 'UPDATE-BEGIN');

        this.boundVao = null;

        // clear texture units once a frame on desktop safari
        if (this._tempEnableSafariTextureUnitWorkaround) {
            for (let unit = 0; unit < this.textureUnits.length; ++unit) {
                for (let slot = 0; slot < 3; ++slot) {
                    this.textureUnits[unit][slot] = null;
                }
            }
        }

        // Set the render target
        const target = this.renderTarget;
        if (target) {
            // Create a new WebGL frame buffer object
            if (!target.impl._glFrameBuffer) {
                this.initRenderTarget(target);
            } else {
                this.setFramebuffer(target.impl._glFrameBuffer);
            }
        } else {
            this.setFramebuffer(this.defaultFramebuffer);
        }

        DebugGraphics.popGpuMarker(this);
    }

    /**
     * Marks the end of a block of rendering. This function should be called after a matching call
     * to {@link GraphicsDevice#updateBegin}. Calls to {@link GraphicsDevice#updateBegin} and
     * {@link GraphicsDevice#updateEnd} must not be nested.
     *
     * @ignore
     */
    updateEnd() {

        DebugGraphics.pushGpuMarker(this, `UPDATE-END`);

        this.unbindVertexArray();

        // Unset the render target
        const target = this.renderTarget;
        if (target) {
            // If the active render target is auto-mipmapped, generate its mip chain
            const colorBuffer = target._colorBuffer;
            if (colorBuffer && colorBuffer.impl._glTexture && colorBuffer.mipmaps && (colorBuffer.pot || this.webgl2)) {
                // FIXME: if colorBuffer is a cubemap currently we're re-generating mipmaps after
                // updating each face!
                this.activeTexture(this.maxCombinedTextures - 1);
                this.bindTexture(colorBuffer);
                this.gl.generateMipmap(colorBuffer.impl._glTarget);
            }

            // Resolve MSAA if needed
            if (this.webgl2 && target._samples > 1 && target.autoResolve) {
                target.resolve();
            }
        }

        DebugGraphics.popGpuMarker(this);
    }

    /**
     * Updates a texture's vertical flip.
     *
     * @param {boolean} flipY - True to flip the texture vertically.
     * @ignore
     */
    setUnpackFlipY(flipY) {
        if (this.unpackFlipY !== flipY) {
            this.unpackFlipY = flipY;

            // Note: the WebGL spec states that UNPACK_FLIP_Y_WEBGL only affects
            // texImage2D and texSubImage2D, not compressedTexImage2D
            const gl = this.gl;
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
        }
    }

    /**
     * Updates a texture to have its RGB channels premultiplied by its alpha channel or not.
     *
     * @param {boolean} premultiplyAlpha - True to premultiply the alpha channel against the RGB
     * channels.
     * @ignore
     */
    setUnpackPremultiplyAlpha(premultiplyAlpha) {
        if (this.unpackPremultiplyAlpha !== premultiplyAlpha) {
            this.unpackPremultiplyAlpha = premultiplyAlpha;

            // Note: the WebGL spec states that UNPACK_PREMULTIPLY_ALPHA_WEBGL only affects
            // texImage2D and texSubImage2D, not compressedTexImage2D
            const gl = this.gl;
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplyAlpha);
        }
    }

    /**
     * Activate the specified texture unit.
     *
     * @param {number} textureUnit - The texture unit to activate.
     * @ignore
     */
    activeTexture(textureUnit) {
        if (this.textureUnit !== textureUnit) {
            this.gl.activeTexture(this.gl.TEXTURE0 + textureUnit);
            this.textureUnit = textureUnit;
        }
    }

    /**
     * If the texture is not already bound on the currently active texture unit, bind it.
     *
     * @param {Texture} texture - The texture to bind.
     * @ignore
     */
    bindTexture(texture) {
        const impl = texture.impl;
        const textureTarget = impl._glTarget;
        const textureObject = impl._glTexture;
        const textureUnit = this.textureUnit;
        const slot = this.targetToSlot[textureTarget];
        if (this.textureUnits[textureUnit][slot] !== textureObject) {
            this.gl.bindTexture(textureTarget, textureObject);
            this.textureUnits[textureUnit][slot] = textureObject;
        }
    }

    /**
     * If the texture is not bound on the specified texture unit, active the texture unit and bind
     * the texture to it.
     *
     * @param {Texture} texture - The texture to bind.
     * @param {number} textureUnit - The texture unit to activate and bind the texture to.
     * @ignore
     */
    bindTextureOnUnit(texture, textureUnit) {
        const impl = texture.impl;
        const textureTarget = impl._glTarget;
        const textureObject = impl._glTexture;
        const slot = this.targetToSlot[textureTarget];
        if (this.textureUnits[textureUnit][slot] !== textureObject) {
            this.activeTexture(textureUnit);
            this.gl.bindTexture(textureTarget, textureObject);
            this.textureUnits[textureUnit][slot] = textureObject;
        }
    }

    /**
     * Update the texture parameters for a given texture if they have changed.
     *
     * @param {Texture} texture - The texture to update.
     * @ignore
     */
    setTextureParameters(texture) {
        const gl = this.gl;
        const flags = texture._parameterFlags;
        const target = texture.impl._glTarget;

        if (flags & 1) {
            let filter = texture._minFilter;
            if ((!texture.pot && !this.webgl2) || !texture._mipmaps || (texture._compressed && texture._levels.length === 1)) {
                if (filter === FILTER_NEAREST_MIPMAP_NEAREST || filter === FILTER_NEAREST_MIPMAP_LINEAR) {
                    filter = FILTER_NEAREST;
                } else if (filter === FILTER_LINEAR_MIPMAP_NEAREST || filter === FILTER_LINEAR_MIPMAP_LINEAR) {
                    filter = FILTER_LINEAR;
                }
            }
            gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, this.glFilter[filter]);
        }
        if (flags & 2) {
            gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, this.glFilter[texture._magFilter]);
        }
        if (flags & 4) {
            if (this.webgl2) {
                gl.texParameteri(target, gl.TEXTURE_WRAP_S, this.glAddress[texture._addressU]);
            } else {
                // WebGL1 doesn't support all addressing modes with NPOT textures
                gl.texParameteri(target, gl.TEXTURE_WRAP_S, this.glAddress[texture.pot ? texture._addressU : ADDRESS_CLAMP_TO_EDGE]);
            }
        }
        if (flags & 8) {
            if (this.webgl2) {
                gl.texParameteri(target, gl.TEXTURE_WRAP_T, this.glAddress[texture._addressV]);
            } else {
                // WebGL1 doesn't support all addressing modes with NPOT textures
                gl.texParameteri(target, gl.TEXTURE_WRAP_T, this.glAddress[texture.pot ? texture._addressV : ADDRESS_CLAMP_TO_EDGE]);
            }
        }
        if (flags & 16) {
            if (this.webgl2) {
                gl.texParameteri(target, gl.TEXTURE_WRAP_R, this.glAddress[texture._addressW]);
            }
        }
        if (flags & 32) {
            if (this.webgl2) {
                gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, texture._compareOnRead ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
            }
        }
        if (flags & 64) {
            if (this.webgl2) {
                gl.texParameteri(target, gl.TEXTURE_COMPARE_FUNC, this.glComparison[texture._compareFunc]);
            }
        }
        if (flags & 128) {
            const ext = this.extTextureFilterAnisotropic;
            if (ext) {
                gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, Math.min(Math.round(texture._anisotropy), this.maxAnisotropy)));
            }
        }
    }

    /**
     * Sets the specified texture on the specified texture unit.
     *
     * @param {Texture} texture - The texture to set.
     * @param {number} textureUnit - The texture unit to set the texture on.
     * @ignore
     */
    setTexture(texture, textureUnit) {

        if (!texture.impl._glTexture)
            texture.impl.initialize(this, texture);

        if (texture._parameterFlags > 0 || texture._needsUpload || texture._needsMipmapsUpload) {

            // Ensure the specified texture unit is active
            this.activeTexture(textureUnit);

            // Ensure the texture is bound on correct target of the specified texture unit
            this.bindTexture(texture);

            if (texture._parameterFlags) {
                this.setTextureParameters(texture);
                texture._parameterFlags = 0;
            }

            if (texture._needsUpload || texture._needsMipmapsUpload) {
                texture.impl.upload(this, texture);
                texture._needsUpload = false;
                texture._needsMipmapsUpload = false;
            }
        } else {
            // Ensure the texture is currently bound to the correct target on the specified texture unit.
            // If the texture is already bound to the correct target on the specified unit, there's no need
            // to actually make the specified texture unit active because the texture itself does not need
            // to be updated.
            this.bindTextureOnUnit(texture, textureUnit);
        }
    }

    // function creates VertexArrayObject from list of vertex buffers
    createVertexArray(vertexBuffers) {

        let key, vao;

        // only use cache when more than 1 vertex buffer, otherwise it's unique
        const useCache = vertexBuffers.length > 1;
        if (useCache) {

            // generate unique key for the vertex buffers
            key = "";
            for (let i = 0; i < vertexBuffers.length; i++) {
                const vertexBuffer = vertexBuffers[i];
                key += vertexBuffer.id + vertexBuffer.format.renderingingHash;
            }

            // try to get VAO from cache
            vao = this._vaoMap.get(key);
        }

        // need to create new vao
        if (!vao) {

            // create VA object
            const gl = this.gl;
            vao = gl.createVertexArray();
            gl.bindVertexArray(vao);

            // don't capture index buffer in VAO
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

            let locZero = false;
            for (let i = 0; i < vertexBuffers.length; i++) {

                // bind buffer
                const vertexBuffer = vertexBuffers[i];
                gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer.impl.bufferId);

                // for each attribute
                const elements = vertexBuffer.format.elements;
                for (let j = 0; j < elements.length; j++) {
                    const e = elements[j];
                    const loc = semanticToLocation[e.name];

                    if (loc === 0) {
                        locZero = true;
                    }

                    gl.vertexAttribPointer(loc, e.numComponents, this.glType[e.dataType], e.normalize, e.stride, e.offset);
                    gl.enableVertexAttribArray(loc);

                    if (vertexBuffer.instancing) {
                        gl.vertexAttribDivisor(loc, 1);
                    }
                }
            }

            // end of VA object
            gl.bindVertexArray(null);

            // unbind any array buffer
            gl.bindBuffer(gl.ARRAY_BUFFER, null);

            // add it to cache
            if (useCache) {
                this._vaoMap.set(key, vao);
            }

            if (!locZero) {
                Debug.warn("No vertex attribute is mapped to location 0, which might cause compatibility issues on Safari on MacOS - please use attribute SEMANTIC_POSITION or SEMANTIC_ATTR15");
            }
        }

        return vao;
    }

    unbindVertexArray() {
        // unbind VAO from device to protect it from being changed
        if (this.boundVao) {
            this.boundVao = null;
            this.gl.bindVertexArray(null);
        }
    }

    setBuffers() {
        const gl = this.gl;
        let vao;

        // create VAO for specified vertex buffers
        if (this.vertexBuffers.length === 1) {

            // single VB keeps its VAO
            const vertexBuffer = this.vertexBuffers[0];
            Debug.assert(vertexBuffer.device === this, "The VertexBuffer was not created using current GraphicsDevice");
            if (!vertexBuffer.impl.vao) {
                vertexBuffer.impl.vao = this.createVertexArray(this.vertexBuffers);
            }
            vao = vertexBuffer.impl.vao;
        } else {
            // obtain temporary VAO for multiple vertex buffers
            vao = this.createVertexArray(this.vertexBuffers);
        }

        // set active VAO
        if (this.boundVao !== vao) {
            this.boundVao = vao;
            gl.bindVertexArray(vao);
        }

        // empty array of vertex buffers
        this.vertexBuffers.length = 0;

        // Set the active index buffer object
        // Note: we don't cache this state and set it only when it changes, as VAO captures last bind buffer in it
        // and so we don't know what VAO sets it to.
        const bufferId = this.indexBuffer ? this.indexBuffer.impl.bufferId : null;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufferId);
    }

    /**
     * Submits a graphical primitive to the hardware for immediate rendering.
     *
     * @param {object} primitive - Primitive object describing how to submit current vertex/index
     * buffers.
     * @param {number} primitive.type - The type of primitive to render. Can be:
     *
     * - {@link PRIMITIVE_POINTS}
     * - {@link PRIMITIVE_LINES}
     * - {@link PRIMITIVE_LINELOOP}
     * - {@link PRIMITIVE_LINESTRIP}
     * - {@link PRIMITIVE_TRIANGLES}
     * - {@link PRIMITIVE_TRISTRIP}
     * - {@link PRIMITIVE_TRIFAN}
     *
     * @param {number} primitive.base - The offset of the first index or vertex to dispatch in the
     * draw call.
     * @param {number} primitive.count - The number of indices or vertices to dispatch in the draw
     * call.
     * @param {boolean} [primitive.indexed] - True to interpret the primitive as indexed, thereby
     * using the currently set index buffer and false otherwise.
     * @param {number} [numInstances=1] - The number of instances to render when using
     * ANGLE_instanced_arrays. Defaults to 1.
     * @param {boolean} [keepBuffers] - Optionally keep the current set of vertex / index buffers /
     * VAO. This is used when rendering of multiple views, for example under WebXR.
     * @example
     * // Render a single, unindexed triangle
     * device.draw({
     *     type: pc.PRIMITIVE_TRIANGLES,
     *     base: 0,
     *     count: 3,
     *     indexed: false
     * });
     */
    draw(primitive, numInstances, keepBuffers) {
        const gl = this.gl;

        let sampler, samplerValue, texture, numTextures; // Samplers
        let uniform, scopeId, uniformVersion, programVersion; // Uniforms
        const shader = this.shader;
        if (!shader)
            return;
        const samplers = shader.impl.samplers;
        const uniforms = shader.impl.uniforms;

        // vertex buffers
        if (!keepBuffers) {
            this.setBuffers();
        }

        // Commit the shader program variables
        let textureUnit = 0;

        for (let i = 0, len = samplers.length; i < len; i++) {
            sampler = samplers[i];
            samplerValue = sampler.scopeId.value;
            if (!samplerValue) {

                // #if _DEBUG
                const samplerName = sampler.scopeId.name;
                if (samplerName === 'uSceneDepthMap' || samplerName === 'uDepthMap') {
                    Debug.warnOnce(`A sampler ${samplerName} is used by the shader but a scene depth texture is not available. Use CameraComponent.requestSceneDepthMap to enable it.`);
                }
                if (samplerName === 'uSceneColorMap' || samplerName === 'texture_grabPass') {
                    Debug.warnOnce(`A sampler ${samplerName} is used by the shader but a scene depth texture is not available. Use CameraComponent.requestSceneColorMap to enable it.`);
                }
                // #endif

                continue; // Because unset constants shouldn't raise random errors
            }

            if (samplerValue instanceof Texture) {
                texture = samplerValue;
                this.setTexture(texture, textureUnit);

                // #if _DEBUG
                if (this.renderTarget) {
                    // Set breakpoint here to debug "Source and destination textures of the draw are the same" errors
                    if (this.renderTarget._samples < 2) {
                        if (this.renderTarget.colorBuffer && this.renderTarget.colorBuffer === texture) {
                            Debug.error("Trying to bind current color buffer as a texture");
                        } else if (this.renderTarget.depthBuffer && this.renderTarget.depthBuffer === texture) {
                            Debug.error("Trying to bind current depth buffer as a texture");
                        }
                    }
                }
                // #endif

                if (sampler.slot !== textureUnit) {
                    gl.uniform1i(sampler.locationId, textureUnit);
                    sampler.slot = textureUnit;
                }
                textureUnit++;
            } else { // Array
                sampler.array.length = 0;
                numTextures = samplerValue.length;
                for (let j = 0; j < numTextures; j++) {
                    texture = samplerValue[j];
                    this.setTexture(texture, textureUnit);

                    sampler.array[j] = textureUnit;
                    textureUnit++;
                }
                gl.uniform1iv(sampler.locationId, sampler.array);
            }
        }

        // Commit any updated uniforms
        for (let i = 0, len = uniforms.length; i < len; i++) {
            uniform = uniforms[i];
            scopeId = uniform.scopeId;
            uniformVersion = uniform.version;
            programVersion = scopeId.versionObject.version;

            // Check the value is valid
            if (uniformVersion.globalId !== programVersion.globalId || uniformVersion.revision !== programVersion.revision) {
                uniformVersion.globalId = programVersion.globalId;
                uniformVersion.revision = programVersion.revision;

                // Call the function to commit the uniform value
                if (scopeId.value !== null) {
                    this.commitFunction[uniform.dataType](uniform, scopeId.value);
                }
            }
        }

        if (this.webgl2 && this.transformFeedbackBuffer) {
            // Enable TF, start writing to out buffer
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.transformFeedbackBuffer.impl.bufferId);
            gl.beginTransformFeedback(gl.POINTS);
        }

        const mode = this.glPrimitive[primitive.type];
        const count = primitive.count;

        if (primitive.indexed) {
            const indexBuffer = this.indexBuffer;
            Debug.assert(indexBuffer.device === this, "The IndexBuffer was not created using current GraphicsDevice");

            const format = indexBuffer.impl.glFormat;
            const offset = primitive.base * indexBuffer.bytesPerIndex;

            if (numInstances > 0) {
                gl.drawElementsInstanced(mode, count, format, offset, numInstances);
            } else {
                gl.drawElements(mode, count, format, offset);
            }
        } else {
            const first = primitive.base;

            if (numInstances > 0) {
                gl.drawArraysInstanced(mode, first, count, numInstances);
            } else {
                gl.drawArrays(mode, first, count);
            }
        }

        if (this.webgl2 && this.transformFeedbackBuffer) {
            // disable TF
            gl.endTransformFeedback();
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        }

        this._drawCallsPerFrame++;

        // #if _PROFILER
        this._primsPerFrame[primitive.type] += primitive.count * (numInstances > 1 ? numInstances : 1);
        // #endif
    }

    /**
     * Clears the frame buffer of the currently set render target.
     *
     * @param {object} [options] - Optional options object that controls the behavior of the clear
     * operation defined as follows:
     * @param {number[]} [options.color] - The color to clear the color buffer to in the range 0.0
     * to 1.0 for each component.
     * @param {number} [options.depth=1] - The depth value to clear the depth buffer to in the
     * range 0.0 to 1.0.
     * @param {number} [options.flags] - The buffers to clear (the types being color, depth and
     * stencil). Can be any bitwise combination of:
     *
     * - {@link CLEARFLAG_COLOR}
     * - {@link CLEARFLAG_DEPTH}
     * - {@link CLEARFLAG_STENCIL}
     *
     * @param {number} [options.stencil=0] - The stencil value to clear the stencil buffer to. Defaults to 0.
     * @example
     * // Clear color buffer to black and depth buffer to 1.0
     * device.clear();
     *
     * // Clear just the color buffer to red
     * device.clear({
     *     color: [1, 0, 0, 1],
     *     flags: pc.CLEARFLAG_COLOR
     * });
     *
     * // Clear color buffer to yellow and depth to 1.0
     * device.clear({
     *     color: [1, 1, 0, 1],
     *     depth: 1,
     *     flags: pc.CLEARFLAG_COLOR | pc.CLEARFLAG_DEPTH
     * });
     */
    clear(options) {
        const defaultOptions = this.defaultClearOptions;
        options = options || defaultOptions;

        const flags = (options.flags == undefined) ? defaultOptions.flags : options.flags;
        if (flags !== 0) {
            const gl = this.gl;

            // Set the clear color
            if (flags & CLEARFLAG_COLOR) {
                const color = (options.color == undefined) ? defaultOptions.color : options.color;
                this.setClearColor(color[0], color[1], color[2], color[3]);
                this.setColorWrite(true, true, true, true);
            }

            if (flags & CLEARFLAG_DEPTH) {
                // Set the clear depth
                const depth = (options.depth == undefined) ? defaultOptions.depth : options.depth;
                this.setClearDepth(depth);
                this.setDepthWrite(true);
            }

            if (flags & CLEARFLAG_STENCIL) {
                // Set the clear stencil
                const stencil = (options.stencil == undefined) ? defaultOptions.stencil : options.stencil;
                this.setClearStencil(stencil);
            }

            // Clear the frame buffer
            gl.clear(this.glClearFlag[flags]);
        }
    }

    /**
     * Reads a block of pixels from a specified rectangle of the current color framebuffer into an
     * ArrayBufferView object.
     *
     * @param {number} x - The x-coordinate of the rectangle's lower-left corner.
     * @param {number} y - The y-coordinate of the rectangle's lower-left corner.
     * @param {number} w - The width of the rectangle, in pixels.
     * @param {number} h - The height of the rectangle, in pixels.
     * @param {ArrayBufferView} pixels - The ArrayBufferView object that holds the returned pixel
     * data.
     * @ignore
     */
    readPixels(x, y, w, h, pixels) {
        const gl = this.gl;
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    /**
     * Set the depth value used when the depth buffer is cleared.
     *
     * @param {number} depth - The depth value to clear the depth buffer to in the range 0.0
     * to 1.0.
     * @ignore
     */
    setClearDepth(depth) {
        if (depth !== this.clearDepth) {
            this.gl.clearDepth(depth);
            this.clearDepth = depth;
        }
    }

    /**
     * Set the clear color used when the frame buffer is cleared.
     *
     * @param {number} r - The red component of the color in the range 0.0 to 1.0.
     * @param {number} g - The green component of the color in the range 0.0 to 1.0.
     * @param {number} b - The blue component of the color in the range 0.0 to 1.0.
     * @param {number} a - The alpha component of the color in the range 0.0 to 1.0.
     * @ignore
     */
    setClearColor(r, g, b, a) {
        const c = this.clearColor;
        if ((r !== c.r) || (g !== c.g) || (b !== c.b) || (a !== c.a)) {
            this.gl.clearColor(r, g, b, a);
            this.clearColor.set(r, g, b, a);
        }
    }

    /**
     * Set the stencil clear value used when the stencil buffer is cleared.
     *
     * @param {number} value - The stencil value to clear the stencil buffer to.
     */
    setClearStencil(value) {
        if (value !== this.clearStencil) {
            this.gl.clearStencil(value);
            this.clearStencil = value;
        }
    }

    /**
     * Queries whether depth testing is enabled.
     *
     * @returns {boolean} True if depth testing is enabled and false otherwise.
     * @example
     * var depthTest = device.getDepthTest();
     * console.log('Depth testing is ' + depthTest ? 'enabled' : 'disabled');
     */
    getDepthTest() {
        return this.depthTest;
    }

    /**
     * Enables or disables depth testing of fragments. Once this state is set, it persists until it
     * is changed. By default, depth testing is enabled.
     *
     * @param {boolean} depthTest - True to enable depth testing and false otherwise.
     * @example
     * device.setDepthTest(true);
     */
    setDepthTest(depthTest) {
        if (this.depthTest !== depthTest) {
            const gl = this.gl;
            if (depthTest) {
                gl.enable(gl.DEPTH_TEST);
            } else {
                gl.disable(gl.DEPTH_TEST);
            }
            this.depthTest = depthTest;
        }
    }

    /**
     * Configures the depth test.
     *
     * @param {number} func - A function to compare a new depth value with an existing z-buffer
     * value and decide if to write a pixel. Can be:
     *
     * - {@link FUNC_NEVER}: don't draw
     * - {@link FUNC_LESS}: draw if new depth < depth buffer
     * - {@link FUNC_EQUAL}: draw if new depth == depth buffer
     * - {@link FUNC_LESSEQUAL}: draw if new depth <= depth buffer
     * - {@link FUNC_GREATER}: draw if new depth > depth buffer
     * - {@link FUNC_NOTEQUAL}: draw if new depth != depth buffer
     * - {@link FUNC_GREATEREQUAL}: draw if new depth >= depth buffer
     * - {@link FUNC_ALWAYS}: always draw
     */
    setDepthFunc(func) {
        if (this.depthFunc === func) return;
        this.gl.depthFunc(this.glComparison[func]);
        this.depthFunc = func;
    }

    /**
     * Queries whether writes to the depth buffer are enabled.
     *
     * @returns {boolean} True if depth writing is enabled and false otherwise.
     * @example
     * var depthWrite = device.getDepthWrite();
     * console.log('Depth writing is ' + depthWrite ? 'enabled' : 'disabled');
     */
    getDepthWrite() {
        return this.depthWrite;
    }

    /**
     * Enables or disables writes to the depth buffer. Once this state is set, it persists until it
     * is changed. By default, depth writes are enabled.
     *
     * @param {boolean} writeDepth - True to enable depth writing and false otherwise.
     * @example
     * device.setDepthWrite(true);
     */
    setDepthWrite(writeDepth) {
        if (this.depthWrite !== writeDepth) {
            this.gl.depthMask(writeDepth);
            this.depthWrite = writeDepth;
        }
    }

    /**
     * Enables or disables writes to the color buffer. Once this state is set, it persists until it
     * is changed. By default, color writes are enabled for all color channels.
     *
     * @param {boolean} writeRed - True to enable writing of the red channel and false otherwise.
     * @param {boolean} writeGreen - True to enable writing of the green channel and false otherwise.
     * @param {boolean} writeBlue - True to enable writing of the blue channel and false otherwise.
     * @param {boolean} writeAlpha - True to enable writing of the alpha channel and false otherwise.
     * @example
     * // Just write alpha into the frame buffer
     * device.setColorWrite(false, false, false, true);
     */
    setColorWrite(writeRed, writeGreen, writeBlue, writeAlpha) {
        if ((this.writeRed !== writeRed) ||
            (this.writeGreen !== writeGreen) ||
            (this.writeBlue !== writeBlue) ||
            (this.writeAlpha !== writeAlpha)) {
            this.gl.colorMask(writeRed, writeGreen, writeBlue, writeAlpha);
            this.writeRed = writeRed;
            this.writeGreen = writeGreen;
            this.writeBlue = writeBlue;
            this.writeAlpha = writeAlpha;
        }
    }

    /**
     * Enables or disables alpha to coverage (WebGL2 only).
     *
     * @param {boolean} state - True to enable alpha to coverage and false to disable it.
     * @ignore
     */
    setAlphaToCoverage(state) {
        if (!this.webgl2) return;
        if (this.alphaToCoverage === state) return;
        this.alphaToCoverage = state;

        if (state) {
            this.gl.enable(this.gl.SAMPLE_ALPHA_TO_COVERAGE);
        } else {
            this.gl.disable(this.gl.SAMPLE_ALPHA_TO_COVERAGE);
        }
    }

    /**
     * Sets the output vertex buffer. It will be written to by a shader with transform feedback
     * varyings.
     *
     * @param {VertexBuffer} tf - The output vertex buffer.
     * @ignore
     */
    setTransformFeedbackBuffer(tf) {
        if (this.transformFeedbackBuffer === tf)
            return;

        this.transformFeedbackBuffer = tf;

        if (this.webgl2) {
            const gl = this.gl;
            if (tf) {
                if (!this.feedback) {
                    this.feedback = gl.createTransformFeedback();
                }
                gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
            } else {
                gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
            }
        }
    }

    /**
     * Toggles the rasterization render state. Useful with transform feedback, when you only need
     * to process the data without drawing.
     *
     * @param {boolean} on - True to enable rasterization and false to disable it.
     * @ignore
     */
    setRaster(on) {
        if (this.raster === on) return;

        this.raster = on;

        if (this.webgl2) {
            if (on) {
                this.gl.disable(this.gl.RASTERIZER_DISCARD);
            } else {
                this.gl.enable(this.gl.RASTERIZER_DISCARD);
            }
        }
    }

    /**
     * Toggles the polygon offset render state.
     *
     * @param {boolean} on - True to enable polygon offset and false to disable it.
     * @ignore
     */
    setDepthBias(on) {
        if (this.depthBiasEnabled === on) return;

        this.depthBiasEnabled = on;

        if (on) {
            this.gl.enable(this.gl.POLYGON_OFFSET_FILL);
        } else {
            this.gl.disable(this.gl.POLYGON_OFFSET_FILL);
        }
    }

    /**
     * Specifies the scale factor and units to calculate depth values. The offset is added before
     * the depth test is performed and before the value is written into the depth buffer.
     *
     * @param {number} constBias - The multiplier by which an implementation-specific value is
     * multiplied with to create a constant depth offset.
     * @param {number} slopeBias - The scale factor for the variable depth offset for each polygon.
     * @ignore
     */
    setDepthBiasValues(constBias, slopeBias) {
        this.gl.polygonOffset(slopeBias, constBias);
    }

    /**
     * Queries whether blending is enabled.
     *
     * @returns {boolean} True if blending is enabled and false otherwise.
     */
    getBlending() {
        return this.blending;
    }

    /**
     * Enables or disables blending.
     *
     * @param {boolean} blending - True to enable blending and false to disable it.
     */
    setBlending(blending) {
        if (this.blending !== blending) {
            const gl = this.gl;
            if (blending) {
                gl.enable(gl.BLEND);
            } else {
                gl.disable(gl.BLEND);
            }
            this.blending = blending;
        }
    }

    /**
     * Enables or disables stencil test.
     *
     * @param {boolean} enable - True to enable stencil test and false to disable it.
     */
    setStencilTest(enable) {
        if (this.stencil !== enable) {
            const gl = this.gl;
            if (enable) {
                gl.enable(gl.STENCIL_TEST);
            } else {
                gl.disable(gl.STENCIL_TEST);
            }
            this.stencil = enable;
        }
    }

    /**
     * Configures stencil test for both front and back faces.
     *
     * @param {number} func - A comparison function that decides if the pixel should be written,
     * based on the current stencil buffer value, reference value, and mask value. Can be:
     *
     * - {@link FUNC_NEVER}: never pass
     * - {@link FUNC_LESS}: pass if (ref & mask) < (stencil & mask)
     * - {@link FUNC_EQUAL}: pass if (ref & mask) == (stencil & mask)
     * - {@link FUNC_LESSEQUAL}: pass if (ref & mask) <= (stencil & mask)
     * - {@link FUNC_GREATER}: pass if (ref & mask) > (stencil & mask)
     * - {@link FUNC_NOTEQUAL}: pass if (ref & mask) != (stencil & mask)
     * - {@link FUNC_GREATEREQUAL}: pass if (ref & mask) >= (stencil & mask)
     * - {@link FUNC_ALWAYS}: always pass
     *
     * @param {number} ref - Reference value used in comparison.
     * @param {number} mask - Mask applied to stencil buffer value and reference value before
     * comparison.
     */
    setStencilFunc(func, ref, mask) {
        if (this.stencilFuncFront !== func || this.stencilRefFront !== ref || this.stencilMaskFront !== mask ||
            this.stencilFuncBack !== func || this.stencilRefBack !== ref || this.stencilMaskBack !== mask) {
            const gl = this.gl;
            gl.stencilFunc(this.glComparison[func], ref, mask);
            this.stencilFuncFront = this.stencilFuncBack = func;
            this.stencilRefFront = this.stencilRefBack = ref;
            this.stencilMaskFront = this.stencilMaskBack = mask;
        }
    }

    /**
     * Configures stencil test for front faces.
     *
     * @param {number} func - A comparison function that decides if the pixel should be written,
     * based on the current stencil buffer value, reference value, and mask value. Can be:
     *
     * - {@link FUNC_NEVER}: never pass
     * - {@link FUNC_LESS}: pass if (ref & mask) < (stencil & mask)
     * - {@link FUNC_EQUAL}: pass if (ref & mask) == (stencil & mask)
     * - {@link FUNC_LESSEQUAL}: pass if (ref & mask) <= (stencil & mask)
     * - {@link FUNC_GREATER}: pass if (ref & mask) > (stencil & mask)
     * - {@link FUNC_NOTEQUAL}: pass if (ref & mask) != (stencil & mask)
     * - {@link FUNC_GREATEREQUAL}: pass if (ref & mask) >= (stencil & mask)
     * - {@link FUNC_ALWAYS}: always pass
     *
     * @param {number} ref - Reference value used in comparison.
     * @param {number} mask - Mask applied to stencil buffer value and reference value before comparison.
     */
    setStencilFuncFront(func, ref, mask) {
        if (this.stencilFuncFront !== func || this.stencilRefFront !== ref || this.stencilMaskFront !== mask) {
            const gl = this.gl;
            gl.stencilFuncSeparate(gl.FRONT, this.glComparison[func], ref, mask);
            this.stencilFuncFront = func;
            this.stencilRefFront = ref;
            this.stencilMaskFront = mask;
        }
    }

    /**
     * Configures stencil test for back faces.
     *
     * @param {number} func - A comparison function that decides if the pixel should be written,
     * based on the current stencil buffer value, reference value, and mask value. Can be:
     *
     * - {@link FUNC_NEVER}: never pass
     * - {@link FUNC_LESS}: pass if (ref & mask) < (stencil & mask)
     * - {@link FUNC_EQUAL}: pass if (ref & mask) == (stencil & mask)
     * - {@link FUNC_LESSEQUAL}: pass if (ref & mask) <= (stencil & mask)
     * - {@link FUNC_GREATER}: pass if (ref & mask) > (stencil & mask)
     * - {@link FUNC_NOTEQUAL}: pass if (ref & mask) != (stencil & mask)
     * - {@link FUNC_GREATEREQUAL}: pass if (ref & mask) >= (stencil & mask)
     * - {@link FUNC_ALWAYS}: always pass
     *
     * @param {number} ref - Reference value used in comparison.
     * @param {number} mask - Mask applied to stencil buffer value and reference value before comparison.
     */
    setStencilFuncBack(func, ref, mask) {
        if (this.stencilFuncBack !== func || this.stencilRefBack !== ref || this.stencilMaskBack !== mask) {
            const gl = this.gl;
            gl.stencilFuncSeparate(gl.BACK, this.glComparison[func], ref, mask);
            this.stencilFuncBack = func;
            this.stencilRefBack = ref;
            this.stencilMaskBack = mask;
        }
    }

    /**
     * Configures how stencil buffer values should be modified based on the result of depth/stencil
     * tests. Works for both front and back faces.
     *
     * @param {number} fail - Action to take if stencil test is failed. Can be:
     *
     * - {@link STENCILOP_KEEP}: don't change the stencil buffer value
     * - {@link STENCILOP_ZERO}: set value to zero
     * - {@link STENCILOP_REPLACE}: replace value with the reference value (see {@link GraphicsDevice#setStencilFunc})
     * - {@link STENCILOP_INCREMENT}: increment the value
     * - {@link STENCILOP_INCREMENTWRAP}: increment the value, but wrap it to zero when it's larger
     * than a maximum representable value
     * - {@link STENCILOP_DECREMENT}: decrement the value
     * - {@link STENCILOP_DECREMENTWRAP}: decrement the value, but wrap it to a maximum
     * representable value, if the current value is 0
     * - {@link STENCILOP_INVERT}: invert the value bitwise
     *
     * @param {number} zfail - Action to take if depth test is failed.  Accepts the same values as
     * `fail`.
     * @param {number} zpass - Action to take if both depth and stencil test are passed. Accepts
     * the same values as `fail`.
     * @param {number} writeMask - A bit mask applied to the reference value, when written.
     */
    setStencilOperation(fail, zfail, zpass, writeMask) {
        if (this.stencilFailFront !== fail || this.stencilZfailFront !== zfail || this.stencilZpassFront !== zpass ||
            this.stencilFailBack !== fail || this.stencilZfailBack !== zfail || this.stencilZpassBack !== zpass) {
            this.gl.stencilOp(this.glStencilOp[fail], this.glStencilOp[zfail], this.glStencilOp[zpass]);
            this.stencilFailFront = this.stencilFailBack = fail;
            this.stencilZfailFront = this.stencilZfailBack = zfail;
            this.stencilZpassFront = this.stencilZpassBack = zpass;
        }
        if (this.stencilWriteMaskFront !== writeMask || this.stencilWriteMaskBack !== writeMask) {
            this.gl.stencilMask(writeMask);
            this.stencilWriteMaskFront = writeMask;
            this.stencilWriteMaskBack = writeMask;
        }
    }

    /**
     * Configures how stencil buffer values should be modified based on the result of depth/stencil
     * tests. Works for front faces.
     *
     * @param {number} fail - Action to take if stencil test is failed. Can be:
     *
     * - {@link STENCILOP_KEEP}: don't change the stencil buffer value
     * - {@link STENCILOP_ZERO}: set value to zero
     * - {@link STENCILOP_REPLACE}: replace value with the reference value (see {@link GraphicsDevice#setStencilFunc})
     * - {@link STENCILOP_INCREMENT}: increment the value
     * - {@link STENCILOP_INCREMENTWRAP}: increment the value, but wrap it to zero when it's larger
     * than a maximum representable value
     * - {@link STENCILOP_DECREMENT}: decrement the value
     * - {@link STENCILOP_DECREMENTWRAP}: decrement the value, but wrap it to a maximum
     * representable value, if the current value is 0
     * - {@link STENCILOP_INVERT}: invert the value bitwise
     *
     * @param {number} zfail - Action to take if depth test is failed.  Accepts the same values as
     * `fail`.
     * @param {number} zpass - Action to take if both depth and stencil test are passed.  Accepts
     * the same values as `fail`.
     * @param {number} writeMask - A bit mask applied to the reference value, when written.
     */
    setStencilOperationFront(fail, zfail, zpass, writeMask) {
        if (this.stencilFailFront !== fail || this.stencilZfailFront !== zfail || this.stencilZpassFront !== zpass) {
            this.gl.stencilOpSeparate(this.gl.FRONT, this.glStencilOp[fail], this.glStencilOp[zfail], this.glStencilOp[zpass]);
            this.stencilFailFront = fail;
            this.stencilZfailFront = zfail;
            this.stencilZpassFront = zpass;
        }
        if (this.stencilWriteMaskFront !== writeMask) {
            this.gl.stencilMaskSeparate(this.gl.FRONT, writeMask);
            this.stencilWriteMaskFront = writeMask;
        }
    }

    /**
     * Configures how stencil buffer values should be modified based on the result of depth/stencil
     * tests. Works for back faces.
     *
     * @param {number} fail - Action to take if stencil test is failed. Can be:
     *
     * - {@link STENCILOP_KEEP}: don't change the stencil buffer value
     * - {@link STENCILOP_ZERO}: set value to zero
     * - {@link STENCILOP_REPLACE}: replace value with the reference value (see {@link GraphicsDevice#setStencilFunc})
     * - {@link STENCILOP_INCREMENT}: increment the value
     * - {@link STENCILOP_INCREMENTWRAP}: increment the value, but wrap it to zero when it's larger
     * than a maximum representable value
     * - {@link STENCILOP_DECREMENT}: decrement the value
     * - {@link STENCILOP_DECREMENTWRAP}: decrement the value, but wrap it to a maximum
     * representable value, if the current value is 0
     * - {@link STENCILOP_INVERT}: invert the value bitwise
     *
     * @param {number} zfail - Action to take if depth test is failed. Accepts the same values as
     * `fail`.
     * @param {number} zpass - Action to take if both depth and stencil test are passed. Accepts
     * the same values as `fail`.
     * @param {number} writeMask - A bit mask applied to the reference value, when written.
     */
    setStencilOperationBack(fail, zfail, zpass, writeMask) {
        if (this.stencilFailBack !== fail || this.stencilZfailBack !== zfail || this.stencilZpassBack !== zpass) {
            this.gl.stencilOpSeparate(this.gl.BACK, this.glStencilOp[fail], this.glStencilOp[zfail], this.glStencilOp[zpass]);
            this.stencilFailBack = fail;
            this.stencilZfailBack = zfail;
            this.stencilZpassBack = zpass;
        }
        if (this.stencilWriteMaskBack !== writeMask) {
            this.gl.stencilMaskSeparate(this.gl.BACK, writeMask);
            this.stencilWriteMaskBack = writeMask;
        }
    }

    /**
     * Configures blending operations. Both source and destination blend modes can take the
     * following values:
     *
     * - {@link BLENDMODE_ZERO}
     * - {@link BLENDMODE_ONE}
     * - {@link BLENDMODE_SRC_COLOR}
     * - {@link BLENDMODE_ONE_MINUS_SRC_COLOR}
     * - {@link BLENDMODE_DST_COLOR}
     * - {@link BLENDMODE_ONE_MINUS_DST_COLOR}
     * - {@link BLENDMODE_SRC_ALPHA}
     * - {@link BLENDMODE_SRC_ALPHA_SATURATE}
     * - {@link BLENDMODE_ONE_MINUS_SRC_ALPHA}
     * - {@link BLENDMODE_DST_ALPHA}
     * - {@link BLENDMODE_ONE_MINUS_DST_ALPHA}
     * - {@link BLENDMODE_CONSTANT_COLOR}
     * - {@link BLENDMODE_ONE_MINUS_CONSTANT_COLOR}
     * - {@link BLENDMODE_CONSTANT_ALPHA}
     * - {@link BLENDMODE_ONE_MINUS_CONSTANT_ALPHA}
     *
     * @param {number} blendSrc - The source blend function.
     * @param {number} blendDst - The destination blend function.
     */
    setBlendFunction(blendSrc, blendDst) {
        if (this.blendSrc !== blendSrc || this.blendDst !== blendDst || this.separateAlphaBlend) {
            this.gl.blendFunc(this.glBlendFunction[blendSrc], this.glBlendFunction[blendDst]);
            this.blendSrc = blendSrc;
            this.blendDst = blendDst;
            this.separateAlphaBlend = false;
        }
    }

    /**
     * Configures blending operations. Both source and destination blend modes can take the
     * following values:
     *
     * - {@link BLENDMODE_ZERO}
     * - {@link BLENDMODE_ONE}
     * - {@link BLENDMODE_SRC_COLOR}
     * - {@link BLENDMODE_ONE_MINUS_SRC_COLOR}
     * - {@link BLENDMODE_DST_COLOR}
     * - {@link BLENDMODE_ONE_MINUS_DST_COLOR}
     * - {@link BLENDMODE_SRC_ALPHA}
     * - {@link BLENDMODE_SRC_ALPHA_SATURATE}
     * - {@link BLENDMODE_ONE_MINUS_SRC_ALPHA}
     * - {@link BLENDMODE_DST_ALPHA}
     * - {@link BLENDMODE_ONE_MINUS_DST_ALPHA}
     *
     * @param {number} blendSrc - The source blend function.
     * @param {number} blendDst - The destination blend function.
     * @param {number} blendSrcAlpha - The separate source blend function for the alpha channel.
     * @param {number} blendDstAlpha - The separate destination blend function for the alpha channel.
     */
    setBlendFunctionSeparate(blendSrc, blendDst, blendSrcAlpha, blendDstAlpha) {
        if (this.blendSrc !== blendSrc || this.blendDst !== blendDst || this.blendSrcAlpha !== blendSrcAlpha || this.blendDstAlpha !== blendDstAlpha || !this.separateAlphaBlend) {
            this.gl.blendFuncSeparate(this.glBlendFunction[blendSrc], this.glBlendFunction[blendDst],
                                      this.glBlendFunction[blendSrcAlpha], this.glBlendFunction[blendDstAlpha]);
            this.blendSrc = blendSrc;
            this.blendDst = blendDst;
            this.blendSrcAlpha = blendSrcAlpha;
            this.blendDstAlpha = blendDstAlpha;
            this.separateAlphaBlend = true;
        }
    }

    /**
     * Configures the blending equation. The default blend equation is {@link BLENDEQUATION_ADD}.
     *
     * @param {number} blendEquation - The blend equation. Can be:
     *
     * - {@link BLENDEQUATION_ADD}
     * - {@link BLENDEQUATION_SUBTRACT}
     * - {@link BLENDEQUATION_REVERSE_SUBTRACT}
     * - {@link BLENDEQUATION_MIN}
     * - {@link BLENDEQUATION_MAX}
     *
     * Note that MIN and MAX modes require either EXT_blend_minmax or WebGL2 to work (check
     * device.extBlendMinmax).
     */
    setBlendEquation(blendEquation) {
        if (this.blendEquation !== blendEquation || this.separateAlphaEquation) {
            this.gl.blendEquation(this.glBlendEquation[blendEquation]);
            this.blendEquation = blendEquation;
            this.separateAlphaEquation = false;
        }
    }

    /**
     * Configures the blending equation. The default blend equation is {@link BLENDEQUATION_ADD}.
     *
     * @param {number} blendEquation - The blend equation. Can be:
     *
     * - {@link BLENDEQUATION_ADD}
     * - {@link BLENDEQUATION_SUBTRACT}
     * - {@link BLENDEQUATION_REVERSE_SUBTRACT}
     * - {@link BLENDEQUATION_MIN}
     * - {@link BLENDEQUATION_MAX}
     *
     * Note that MIN and MAX modes require either EXT_blend_minmax or WebGL2 to work (check
     * device.extBlendMinmax).
     * @param {number} blendAlphaEquation - A separate blend equation for the alpha channel.
     * Accepts same values as `blendEquation`.
     */
    setBlendEquationSeparate(blendEquation, blendAlphaEquation) {
        if (this.blendEquation !== blendEquation || this.blendAlphaEquation !== blendAlphaEquation || !this.separateAlphaEquation) {
            this.gl.blendEquationSeparate(this.glBlendEquation[blendEquation], this.glBlendEquation[blendAlphaEquation]);
            this.blendEquation = blendEquation;
            this.blendAlphaEquation = blendAlphaEquation;
            this.separateAlphaEquation = true;
        }
    }

    /**
     * Set the source and destination blending factors.
     *
     * @param {number} r - The red component in the range of 0 to 1. Default value is 0.
     * @param {number} g - The green component in the range of 0 to 1. Default value is 0.
     * @param {number} b - The blue component in the range of 0 to 1. Default value is 0.
     * @param {number} a - The alpha component in the range of 0 to 1. Default value is 0.
     * @ignore
     */
    setBlendColor(r, g, b, a) {
        const c = this.blendColor;
        if ((r !== c.r) || (g !== c.g) || (b !== c.b) || (a !== c.a)) {
            this.gl.blendColor(r, g, b, a);
            c.set(r, g, b, a);
        }
    }

    /**
     * Controls how triangles are culled based on their face direction. The default cull mode is
     * {@link CULLFACE_BACK}.
     *
     * @param {number} cullMode - The cull mode to set. Can be:
     *
     * - {@link CULLFACE_NONE}
     * - {@link CULLFACE_BACK}
     * - {@link CULLFACE_FRONT}
     * - {@link CULLFACE_FRONTANDBACK}
     */
    setCullMode(cullMode) {
        if (this.cullMode !== cullMode) {
            if (cullMode === CULLFACE_NONE) {
                this.gl.disable(this.gl.CULL_FACE);
            } else {
                if (this.cullMode === CULLFACE_NONE) {
                    this.gl.enable(this.gl.CULL_FACE);
                }

                const mode = this.glCull[cullMode];
                if (this.cullFace !== mode) {
                    this.gl.cullFace(mode);
                    this.cullFace = mode;
                }
            }
            this.cullMode = cullMode;
        }
    }

    /**
     * Gets the current cull mode.
     *
     * @returns {number} The current cull mode.
     * @ignore
     */
    getCullMode() {
        return this.cullMode;
    }

    /**
     * Sets the current index buffer on the graphics device. On subsequent calls to
     * {@link GraphicsDevice#draw}, the specified index buffer will be used to provide index data
     * for any indexed primitives.
     *
     * @param {IndexBuffer} indexBuffer - The index buffer to assign to the device.
     */
    setIndexBuffer(indexBuffer) {
        // Store the index buffer
        this.indexBuffer = indexBuffer;
    }

    /**
     * Sets the current vertex buffer on the graphics device. On subsequent calls to
     * {@link GraphicsDevice#draw}, the specified vertex buffer(s) will be used to provide vertex
     * data for any primitives.
     *
     * @param {VertexBuffer} vertexBuffer - The vertex buffer to assign to the device.
     */
    setVertexBuffer(vertexBuffer) {

        if (vertexBuffer) {
            this.vertexBuffers.push(vertexBuffer);
        }
    }

    /**
     * Sets the active shader to be used during subsequent draw calls.
     *
     * @param {Shader} shader - The shader to set to assign to the device.
     * @returns {boolean} True if the shader was successfully set, false otherwise.
     */
    setShader(shader) {
        if (shader !== this.shader) {
            if (shader.failed) {
                return false;
            } else if (!shader.ready && !shader.impl.postLink(this, shader)) {
                shader.failed = true;
                return false;
            }

            this.shader = shader;

            // Set the active shader
            this.gl.useProgram(shader.impl.glProgram);

            // #if _PROFILER
            this._shaderSwitchesPerFrame++;
            // #endif

            this.attributesInvalidated = true;
        }
        return true;
    }

    /**
     * Get the supported HDR pixel format.
     * Note that for WebGL2, PIXELFORMAT_RGB16F and PIXELFORMAT_RGB32F are not renderable according to this:
     * https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float
     * For WebGL1, only PIXELFORMAT_RGBA16F and PIXELFORMAT_RGBA32F are tested for being renderable.
     *
     * @returns {number} The HDR pixel format.
     * @ignore
     */
    getHdrFormat() {
        if (this.textureHalfFloatRenderable) {
            return PIXELFORMAT_RGBA16F;
        } else if (this.textureFloatRenderable) {
            return PIXELFORMAT_RGBA32F;
        }
        return PIXELFORMAT_R8_G8_B8_A8;
    }

    /**
     * Queries the maximum number of bones that can be referenced by a shader. The shader
     * generators (programlib) use this number to specify the matrix array size of the uniform
     * 'matrix_pose[0]'. The value is calculated based on the number of available uniform vectors
     * available after subtracting the number taken by a typical heavyweight shader. If a different
     * number is required, it can be tuned via {@link GraphicsDevice#setBoneLimit}.
     *
     * @returns {number} The maximum number of bones that can be supported by the host hardware.
     * @ignore
     */
    getBoneLimit() {
        return this.boneLimit;
    }

    /**
     * Specifies the maximum number of bones that the device can support on the current hardware.
     * This function allows the default calculated value based on available vector uniforms to be
     * overridden.
     *
     * @param {number} maxBones - The maximum number of bones supported by the host hardware.
     * @ignore
     */
    setBoneLimit(maxBones) {
        this.boneLimit = maxBones;
    }

    /**
     * Frees memory from all shaders ever allocated with this device.
     *
     * @ignore
     */
    clearShaderCache() {
        const gl = this.gl;
        for (const shaderSrc in this.fragmentShaderCache) {
            gl.deleteShader(this.fragmentShaderCache[shaderSrc]);
            delete this.fragmentShaderCache[shaderSrc];
        }
        for (const shaderSrc in this.vertexShaderCache) {
            gl.deleteShader(this.vertexShaderCache[shaderSrc]);
            delete this.vertexShaderCache[shaderSrc];
        }

        this.programLib.clearCache();
    }

    /**
     * Frees memory from all vertex array objects ever allocated with this device.
     *
     * @ignore
     */
    clearVertexArrayObjectCache() {
        const gl = this.gl;
        this._vaoMap.forEach((item, key, mapObj) => {
            gl.deleteVertexArray(item);
        });

        this._vaoMap.clear();
    }

    /**
     * Removes a shader from the cache.
     *
     * @param {Shader} shader - The shader to remove from the cache.
     * @ignore
     */
    removeShaderFromCache(shader) {
        this.programLib.removeFromCache(shader);
    }

    /**
     * Width of the back buffer in pixels.
     *
     * @type {number}
     */
    get width() {
        return this.gl.drawingBufferWidth || this.canvas.width;
    }

    /**
     * Height of the back buffer in pixels.
     *
     * @type {number}
     */
    get height() {
        return this.gl.drawingBufferHeight || this.canvas.height;
    }

    /**
     * Fullscreen mode.
     *
     * @type {boolean}
     */
    set fullscreen(fullscreen) {
        if (fullscreen) {
            const canvas = this.gl.canvas;
            canvas.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }

    get fullscreen() {
        return !!document.fullscreenElement;
    }

    /**
     * Check if high precision floating-point textures are supported.
     *
     * @type {boolean}
     */
    get textureFloatHighPrecision() {
        if (this._textureFloatHighPrecision === undefined) {
            this._textureFloatHighPrecision = testTextureFloatHighPrecision(this);
        }
        return this._textureFloatHighPrecision;
    }

    /**
     * Check if texture with half float format can be updated with data.
     *
     * @type {boolean}
     */
    get textureHalfFloatUpdatable() {
        if (this._textureHalfFloatUpdatable === undefined) {
            if (this.webgl2) {
                this._textureHalfFloatUpdatable = true;
            } else {
                this._textureHalfFloatUpdatable = testTextureHalfFloatUpdatable(this.gl, this.extTextureHalfFloat.HALF_FLOAT_OES);
            }
        }
        return this._textureHalfFloatUpdatable;
    }
}

export { WebglGraphicsDevice };
