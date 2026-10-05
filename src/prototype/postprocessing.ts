import * as THREE from 'three'

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

function renderTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
}

/** A soft luminance gate keeps disk emission isolated from the dark sky. */
export class SelectiveBloom {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new THREE.PlaneGeometry(2, 2)
  private readonly ping = renderTarget()
  private readonly pong = renderTarget()
  private readonly prefilter = new THREE.ShaderMaterial({
    vertexShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uInput: { value: null },
      uSourceTexel: { value: new THREE.Vector2(1, 1) },
    },
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uInput;
      uniform vec2 uSourceTexel;
      void main() {
        vec2 offset = uSourceTexel * 1.2;
        vec3 color = (
          texture2D(uInput, vUv + vec2(-offset.x, -offset.y)).rgb +
          texture2D(uInput, vUv + vec2( offset.x, -offset.y)).rgb +
          texture2D(uInput, vUv + vec2(-offset.x,  offset.y)).rgb +
          texture2D(uInput, vUv + vec2( offset.x,  offset.y)).rgb
        ) * 0.25;
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        const float threshold = 0.70;
        const float knee = 0.12;
        float shoulder = clamp(luminance - threshold + knee, 0.0, 2.0 * knee);
        shoulder = shoulder * shoulder / (4.0 * knee + 0.00001);
        float contribution = max(shoulder, luminance - threshold) / max(luminance, 0.00001);
        gl_FragColor = vec4(color * contribution, 1.0);
      }
    `,
  })
  private readonly blur = new THREE.ShaderMaterial({
    vertexShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uInput: { value: null },
      uDirection: { value: new THREE.Vector2() },
    },
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uInput;
      uniform vec2 uDirection;
      void main() {
        vec3 color = texture2D(uInput, vUv).rgb * 0.2270270270;
        color += (texture2D(uInput, vUv + uDirection).rgb + texture2D(uInput, vUv - uDirection).rgb) * 0.1945945946;
        color += (texture2D(uInput, vUv + uDirection * 2.0).rgb + texture2D(uInput, vUv - uDirection * 2.0).rgb) * 0.1216216216;
        color += (texture2D(uInput, vUv + uDirection * 3.0).rgb + texture2D(uInput, vUv - uDirection * 3.0).rgb) * 0.0540540541;
        color += (texture2D(uInput, vUv + uDirection * 4.0).rgb + texture2D(uInput, vUv - uDirection * 4.0).rgb) * 0.0162162162;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  })
  private readonly composite = new THREE.ShaderMaterial({
    vertexShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uBase: { value: null },
      uBloom: { value: this.ping.texture },
      uNight: { value: 1 },
      uPointer: { value: new THREE.Vector2(0.5, 0.5) },
      uPointerStrength: { value: 0 },
      uAspect: { value: 1 },
      uCssHeight: { value: 1 },
    },
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uBase;
      uniform sampler2D uBloom;
      uniform float uNight;
      uniform vec2 uPointer;
      uniform float uPointerStrength;
      uniform float uAspect;
      uniform float uCssHeight;
      void main() {
        float strength = clamp(uPointerStrength, 0.0, 1.0);
        // At exactly zero the lens, ring and halo contribute nothing. Keep
        // the same base/bloom samples without evaluating their spatial math.
        if (strength == 0.0) {
          vec3 color = texture2D(uBase, vUv).rgb;
          if (uNight > 0.0) color += texture2D(uBloom, vUv).rgb * vec3(1.0, 0.91, 0.78) * 0.36 * uNight;
          gl_FragColor = vec4(color, 1.0);
          return;
        }
        vec2 screenScale = vec2(uAspect, 1.0);
        vec2 impact = (vUv - uPointer) * screenScale * uCssHeight;
        float radius2 = dot(impact, impact);
        float radius = sqrt(radius2);
        float footprint = max(fwidth(radius), 0.25);
        vec2 radial = impact / max(radius, 0.0001);
        vec2 clockwise = vec2(radial.y, -radial.x);
        // Thin-lens beta = theta - alpha(theta), softened inside the shadow.
        // Near the critical region alpha exceeds theta, folding source light
        // across the center instead of applying a generic magnifying-glass scale.
        // A Gaussian falloff avoids an artificial outer rim; all sizes use CSS pixels.
        float rawDeflection = 260.0 * radius / (radius2 + 25.0);
        float deflection = 13.0 * (1.0 - exp(-rawDeflection / 13.0));
        float locality = exp(-radius2 / 1152.0);
        deflection *= locality * strength;
        vec2 displacement = (radial + clockwise * 0.08) * deflection;
        vec2 sceneUv = vUv - displacement / (screenScale * uCssHeight);
        vec3 base = texture2D(uBase, sceneUv).rgb;
        vec3 bloom = uNight > 0.0 ? texture2D(uBloom, sceneUv).rgb : vec3(0.0);
        vec3 color = base + bloom * vec3(1.0, 0.91, 0.78) * 0.36 * uNight;

        float shadowRadius = 4.0 * strength;
        float shadow = (1.0 - smoothstep(shadowRadius - footprint * 0.55,
          shadowRadius + footprint * 0.55, radius)) * strength;
        float localLight = sqrt(clamp(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0));
        color *= 1.0 - shadow;

        float ringRadius = 4.7 * strength;
        float ringWidth = max(0.28, footprint * 0.45);
        float ringDistance = (radius - ringRadius) / ringWidth;
        float photonRing = exp(-ringDistance * ringDistance) * strength;
        color += vec3(1.0, 0.90, 0.76) * photonRing * (0.46 + 0.20 * localLight);
        float haloDistance = max(radius - ringRadius, 0.0);
        float halo = exp(-haloDistance * haloDistance / 4.0)
          * (1.0 - smoothstep(8.0 * strength, 11.0 * strength + 0.001, radius));
        color += vec3(1.0, 0.78, 0.52) * halo * 0.065 * strength * (1.0 - shadow);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  })
  private readonly quad = new THREE.Mesh(this.geometry, this.prefilter)
  private width = 1
  private height = 1

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  resize(width: number, height: number, safe: boolean) {
    this.width = width
    this.height = height
    const divisor = safe ? 8 : 4
    this.ping.setSize(Math.max(1, Math.ceil(width / divisor)), Math.max(1, Math.ceil(height / divisor)))
    this.pong.setSize(Math.max(1, Math.ceil(width / divisor)), Math.max(1, Math.ceil(height / divisor)))
    this.prefilter.uniforms.uSourceTexel.value.set(1 / width, 1 / height)
    this.composite.uniforms.uAspect.value = width / height
    this.composite.uniforms.uCssHeight.value = height / this.renderer.getPixelRatio()
  }

  render(input: THREE.Texture, night: number, pointer: THREE.Vector2, pointerStrength: number) {
    // The light-theme endpoint multiplies bloom by zero. Resume all three
    // passes on the very first nonzero transition frame, with no threshold.
    if (night > 0) {
      this.prefilter.uniforms.uInput.value = input
      this.pass(this.prefilter, this.ping)
      this.blur.uniforms.uInput.value = this.ping.texture
      this.blur.uniforms.uDirection.value.set(3 / this.width, 0)
      this.pass(this.blur, this.pong)
      this.blur.uniforms.uInput.value = this.pong.texture
      this.blur.uniforms.uDirection.value.set(0, 3 / this.height)
      this.pass(this.blur, this.ping)
    }
    this.composite.uniforms.uBase.value = input
    this.composite.uniforms.uNight.value = night
    this.composite.uniforms.uPointer.value = pointer
    this.composite.uniforms.uPointerStrength.value = pointerStrength
    this.pass(this.composite, null)
  }

  dispose() {
    this.ping.dispose()
    this.pong.dispose()
    this.prefilter.dispose()
    this.blur.dispose()
    this.composite.dispose()
    this.geometry.dispose()
    this.scene.clear()
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }
}
