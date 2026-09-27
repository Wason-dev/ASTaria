import * as THREE from 'three'

const PARTICLE_COUNT = 1200
const CAPTURE_TIME = 5.5
const TRAIL_TIME = 0.64
const AMBIENT_MOTES = 10
const AMBIENT_POINTS_PER_MOTE = 30

const vertexShader = `
  precision highp float;
  attribute vec4 aSeed;
  uniform vec2 uResolution;
  uniform vec2 uCenter;
  uniform float uAge;
  uniform float uNight;
  uniform float uPixelRatio;
  uniform float uReducedMotion;
  uniform float uZoom;
  uniform float uRoll;
  varying float vOpacity;
  varying float vCore;
  varying float vSpark;
  varying vec2 vTangent;

  mat2 rotate(float angle) {
    return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  }

  // Integrating d(r²)/dt = -k and omega = K/r^(3/2) gives a coherent
  // accelerating path. Every grain samples this same path at its release delay.
  vec2 orbit(float age) {
    float aspect = uResolution.x / max(1.0, uResolution.y);
    float horizontalRoom = mix(5.2, 5.45, smoothstep(1.3, 1.7, aspect));
    float initialRadius = clamp(aspect * (aspect < 0.8 ? 7.1 : horizontalRoom), 2.85, 8.0);
    const float finalRadius = 2.5;
    const float duration = 5.5;
    float k = (initialRadius * initialRadius - finalRadius * finalRadius) / duration;
    const float turns = 6.9115038379;
    float radius = sqrt(max(finalRadius * finalRadius, initialRadius * initialRadius - k * age));
    float angle = 2.75 + turns * (sqrt(initialRadius) - sqrt(radius))
      / (sqrt(initialRadius) - sqrt(finalRadius));
    // The outer approach stays in frame. The orbit becomes circular near the
    // shadow, so the star cannot disappear behind an arbitrary projected ellipse.
    float outerFlattening = mix(1.0, 0.62, smoothstep(4.5, 8.0, initialRadius));
    float flattening = mix(outerFlattening, 1.0, smoothstep(2.8, 4.8, age));
    return vec2(cos(angle), sin(angle) * flattening) * radius;
  }

  void main() {
    vCore = aSeed.w;
    vSpark = step(0.88, aSeed.z);
    float delay = aSeed.x * 0.64 * (1.0 - vCore);
    float localAge = uAge - delay;
    float age = clamp(localAge, 0.0, 5.5);
    vec2 path = orbit(age);
    vec2 tangent = normalize(orbit(min(5.5, age + 0.003)) - orbit(max(0.0, age - 0.003)));
    vec2 normal = vec2(-tangent.y, tangent.x);

    float wakeWidth = (0.007 + 0.038 * pow(aSeed.x, 1.4))
      * mix(1.0, 0.42, smoothstep(3.8, 5.5, age));
    float spread = (aSeed.y - 0.5) * (0.6 + 1.4 * aSeed.z);
    path += normal * spread * wakeWidth * (1.0 - vCore);
    path += tangent * (aSeed.z - 0.5) * 0.017 * aSeed.x * (1.0 - vCore);

    float aspect = uResolution.x / max(1.0, uResolution.y);
    bool mobile = aspect < 0.8;
    vec2 center = mobile ? vec2(0.5) + (uCenter - 0.5) * vec2(0.2, 6.0) : uCenter;
    float scale = mobile ? 13.8 : 10.2;
    vec2 screen = rotate(uRoll) * path * uZoom;
    vec2 uv = center + screen / (vec2(aspect, 1.0) * scale);
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vTangent = normalize(rotate(uRoll) * tangent);

    float emergence = smoothstep(0.0, 0.085, localAge);
    float capture = smoothstep(2.60, 2.76, length(path));
    float alive = step(0.0, localAge) * (1.0 - step(5.5, localAge));
    float density = pow(1.0 - aSeed.x, 1.4);
    float dustLight = mix(0.017, 0.047, density) * mix(0.65, 1.2, aSeed.z);
    vOpacity = mix(dustLight, 1.0, vCore) * emergence * capture * alive * uNight;
    if (uReducedMotion > 0.5 && vCore < 0.5) vOpacity = 0.0;

    // Point sprites are sized in drawing-buffer pixels, with a subpixel dust
    // body and a 2–4 CSS-pixel nucleus. The extra sprite area is optical falloff.
    float dustSize = mix(2.2, 4.2, vSpark) * mix(1.0, 1.5, age / 5.5);
    gl_PointSize = max(1.0, mix(dustSize, 12.0, vCore) * uPixelRatio);
    if (vOpacity < 0.00001) gl_Position = vec4(3.0, 3.0, 0.0, 1.0);
  }
`

const fragmentShader = `
  precision highp float;
  varying float vOpacity;
  varying float vCore;
  varying float vSpark;
  varying vec2 vTangent;

  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    point.y = -point.y;
    float radius2 = dot(point, point);
    if (radius2 > 1.0) discard;

    if (vCore > 0.5) {
      float nucleus = exp(-radius2 * 28.0);
      float corona = exp(-radius2 * 5.8) * 0.14;
      vec3 emission = vec3(1.0, 0.965, 0.88) * nucleus * 1.8
        + vec3(1.0, 0.63, 0.28) * corona;
      gl_FragColor = vec4(emission, vOpacity);
    } else {
      float along = dot(point, vTangent);
      float across = dot(point, vec2(-vTangent.y, vTangent.x));
      float grain = exp(-along * along * 3.8 - across * across * mix(16.0, 28.0, vSpark));
      vec3 color = mix(vec3(1.0, 0.49, 0.20), vec3(1.0, 0.86, 0.62), vSpark);
      gl_FragColor = vec4(color, grain * vOpacity);
    }
  }
`

const ambientVertexShader = `
  precision highp float;
  attribute vec4 aSeed;
  uniform vec2 uResolution;
  uniform vec2 uCenter;
  uniform float uTime;
  uniform float uNight;
  uniform float uPixelRatio;
  uniform float uReducedMotion;
  uniform float uZoom;
  uniform float uRoll;
  varying float vOpacity;
  varying float vHead;

  mat2 rotate(float angle) {
    return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  }

  void main() {
    float duration = 10.0 + aSeed.w * 6.0;
    float period = duration + 2.6;
    float delay = aSeed.y * 0.32;
    float age = mod(uTime + aSeed.z * period, period) - delay;
    float t = clamp(age / duration, 0.0, 1.0);
    float initialRadius = 7.4 + aSeed.w * 0.8;
    const float finalRadius = 3.2;
    float radius = sqrt(mix(initialRadius * initialRadius, finalRadius * finalRadius, t));
    float angularProgress = (sqrt(initialRadius) - sqrt(radius))
      / (sqrt(initialRadius) - sqrt(finalRadius));
    float finalAngle = mod(aSeed.x,2.0) < 0.5 ? 3.21 : -0.07;
    float direction = mod(floor(aSeed.x*0.5),2.0) < 0.5 ? -1.0 : 1.0;
    float angle = finalAngle + direction * (0.68 + aSeed.w * 0.27) * (1.0 - angularProgress);
    // A short inward curve feeds the near disk edge. It never traces a full
    // decorative ring or enters the black shadow before joining the disk.
    vec2 path = radius * vec2(cos(angle), sin(angle));
    float aspect = uResolution.x / max(1.0, uResolution.y);
    bool mobile = aspect < 0.8;
    vec2 center = mobile ? vec2(0.5) + (uCenter - 0.5) * vec2(0.2, 6.0) : uCenter;
    float scale = mobile ? 13.8 : 10.2;
    vec2 uv = center + rotate(uRoll) * path * uZoom / (vec2(aspect, 1.0) * scale);
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vHead = 1.0 - step(0.0001, aSeed.y);
    float arrival = smoothstep(0.25, 1.45, age);
    float joinDisk = 1.0 - smoothstep(duration - 1.0, duration - 0.08, age);
    float tail = 0.024 * pow(1.0 - aSeed.y, 1.4);
    float head = 0.38 + 0.14 * aSeed.w;
    vOpacity = mix(tail, head, vHead) * arrival * joinDisk * uNight;
    if (uReducedMotion > 0.5 && vHead < 0.5) vOpacity = 0.0;
    gl_PointSize = max(1.0, mix(1.8, 4.8, vHead) * uPixelRatio);
    if (vOpacity < 0.00001) gl_Position = vec4(3.0, 3.0, 0.0, 1.0);
  }
`

const ambientFragmentShader = `
  precision highp float;
  varying float vOpacity;
  varying float vHead;
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    float radius2 = dot(point, point);
    if (radius2 > 1.0) discard;
    float light = exp(-radius2 * mix(5.0, 15.0, vHead));
    vec3 color = mix(vec3(0.87, 0.61, 0.34), vec3(1.0, 0.89, 0.71), vHead);
    gl_FragColor = vec4(color, light * vOpacity);
  }
`

/** Sparse ambient accretion plus the brighter star released by the user. */
export class StarInfall {
  readonly object = new THREE.Group()
  private readonly geometry = new THREE.BufferGeometry()
  private readonly material: THREE.ShaderMaterial
  private readonly burstPoints: THREE.Points
  private readonly ambientGeometry = new THREE.BufferGeometry()
  private readonly ambientMaterial: THREE.ShaderMaterial
  private readonly ambientPoints: THREE.Points
  private ambientTime = 0

  constructor() {
    let seed = 0x53544152
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const seeds = new Float32Array(PARTICLE_COUNT * 4)
    seeds[3] = 1
    for (let i = 1; i < PARTICLE_COUNT; i++) {
      // Stratification avoids pulsing clumps; randomized grains break up the
      // continuous wake without forming a row of regularly spaced dots.
      seeds[i * 4] = (i - 1 + random()) / (PARTICLE_COUNT - 1)
      seeds[i * 4 + 1] = (random() + random() + random()) / 3
      seeds[i * 4 + 2] = random()
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3))
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2(0.65, 0.51) },
        uAge: { value: 0 },
        uNight: { value: 0 },
        uPixelRatio: { value: 1 },
        uReducedMotion: { value: 0 },
        uZoom: { value: 1 },
        uRoll: { value: Math.PI / 10 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.burstPoints = new THREE.Points(this.geometry, this.material)
    this.burstPoints.name = 'User star infall'
    this.burstPoints.frustumCulled = false
    this.burstPoints.renderOrder = 2
    this.burstPoints.visible = false

    const ambientCount = AMBIENT_MOTES * AMBIENT_POINTS_PER_MOTE
    const ambientSeeds = new Float32Array(ambientCount * 4)
    for (let mote = 0; mote < AMBIENT_MOTES; mote++) {
      const phase = (mote + 0.32 + random() * 0.28) / AMBIENT_MOTES
      const speed = random()
      for (let point = 0; point < AMBIENT_POINTS_PER_MOTE; point++) {
        const offset = (mote * AMBIENT_POINTS_PER_MOTE + point) * 4
        ambientSeeds[offset] = mote
        ambientSeeds[offset + 1] = point === 0 ? 0 : (point - 0.8 + random() * 0.6) / (AMBIENT_POINTS_PER_MOTE - 1)
        ambientSeeds[offset + 2] = phase
        ambientSeeds[offset + 3] = speed
      }
    }
    this.ambientGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ambientCount * 3), 3))
    this.ambientGeometry.setAttribute('aSeed', new THREE.BufferAttribute(ambientSeeds, 4))
    this.ambientMaterial = new THREE.ShaderMaterial({
      vertexShader: ambientVertexShader,
      fragmentShader: ambientFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: this.material.uniforms.uResolution,
        uCenter: this.material.uniforms.uCenter,
        uNight: this.material.uniforms.uNight,
        uPixelRatio: this.material.uniforms.uPixelRatio,
        uReducedMotion: this.material.uniforms.uReducedMotion,
        uZoom: this.material.uniforms.uZoom,
        uRoll: this.material.uniforms.uRoll,
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.ambientPoints = new THREE.Points(this.ambientGeometry, this.ambientMaterial)
    this.ambientPoints.name = 'Ambient accretion motes'
    this.ambientPoints.frustumCulled = false
    this.ambientPoints.renderOrder = 1
    this.object.name = 'Star infall and ambient accretion'
    this.object.visible = false
    this.object.add(this.ambientPoints, this.burstPoints)
    this.burstPoints.onBeforeRender = this.ambientPoints.onBeforeRender = (renderer) => {
      this.material.uniforms.uPixelRatio.value = renderer.getPixelRatio()
    }
  }

  update(
    time: number,
    burst: number,
    night: number,
    resolution: THREE.Vector2,
    reducedMotion: boolean,
    zoom = 1,
    roll = Math.PI / 10,
    center?: THREE.Vector2,
  ): void {
    const age = time - burst
    this.object.visible = night > 0.001
    this.burstPoints.visible = burst > -99 && age >= 0 && age <= CAPTURE_TIME + TRAIL_TIME
    if (!this.object.visible) return
    if (!reducedMotion) this.ambientTime = time
    this.ambientMaterial.uniforms.uTime.value = this.ambientTime
    this.material.uniforms.uAge.value = reducedMotion ? 0.2 : age
    this.material.uniforms.uNight.value = THREE.MathUtils.clamp(night, 0, 1)
    this.material.uniforms.uResolution.value.copy(resolution)
    this.material.uniforms.uReducedMotion.value = reducedMotion ? 1 : 0
    this.material.uniforms.uZoom.value = zoom
    this.material.uniforms.uRoll.value = roll
    if (center) this.material.uniforms.uCenter.value.copy(center)
    else this.material.uniforms.uCenter.value.set(0.65, 0.51)
  }

  dispose(): void {
    this.object.visible = false
    this.geometry.dispose()
    this.material.dispose()
    this.ambientGeometry.dispose()
    this.ambientMaterial.dispose()
    this.object.clear()
  }
}
