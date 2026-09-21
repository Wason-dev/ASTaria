export const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Schwarzschild null rays: r_s = 1, ISCO = 3. Emission is sampled at
// actual equatorial-plane crossings; the disk is never a stack of tori.
export const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uNight;
uniform float uInclination;
uniform float uZoom;
uniform float uRoll;
uniform vec2 uCenter;
uniform float uLens;
uniform float uDoppler;
uniform float uQuality;
uniform sampler2D uStars;
uniform float uBurst;
uniform sampler2D uGeodesics;
uniform sampler2D uTermination;
uniform vec2 uLutSize;
uniform float uMaxPhi;
uniform float uCriticalImpact;
uniform float uMaxImpact;
uniform float uCameraRadius;
uniform float uResponseStrength;
uniform float uResponseReply;
uniform float uResponseTime;
uniform float uResponseMotion;
uniform vec3 uResponseWeights;
uniform float uDecisionActive;
uniform float uDecisionHorizon;
uniform float uDecisionBranch;
uniform float uDecisionComparing;
uniform float uDecisionEmphasis;
uniform float uDecisionRadius;
uniform float uDecisionWarp;
uniform float uDecisionThickness;
uniform float uDecisionLens;
uniform float uDecisionFlow;
uniform float uDecisionTime;
const float PI = 3.14159265359;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),w.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),w.x),w.y);
}
float fbm(vec2 p) {
  return .57*noise(p) + .28*noise(p*2.03+13.1) + .15*noise(p*4.09+21.7);
}
mat2 rotate(float a) { return mat2(cos(a),sin(a),-sin(a),cos(a)); }

// Decision paths deform one emitting surface in three dimensions. The
// geodesic crossing solver below intersects this height field, so the lifted
// flow is occluded and lensed with the disk instead of being drawn on top.
float decisionSurfaceHeight(vec3 p) {
  if (uDecisionWarp <= .00001) return 0.0;
  float r = length(p.xz);
  float a = atan(p.z,p.x);
  float phase = a+uDecisionTime*.075+uDecisionBranch*.85;
  float outer = smoothstep(3.3,9.5,r);
  float curl = sin(phase)*.63+sin(phase*2.0-1.4)*.22;
  // A sparse tapered plume lifts out of the outer surface. Its entire curve
  // remains finite and derivative-filtered with the rest of the disk.
  float plume = pow(max(0.0,.5+.5*cos(phase-.7)),8.0)
    *smoothstep(4.8,8.0,r)*(1.0-smoothstep(10.5,16.0,r));
  return uDecisionWarp*(outer*curl+plume*.8);
}

vec3 decisionDiskPoint(vec3 p) {
  // Keep the ISCO at r=3; only the outer streams contract or spread outward.
  if (abs(uDecisionRadius-1.0) < .000001) return p;
  float r = length(p.xz);
  float sourceRadius = 3.0+(r-3.0)/max(.6,uDecisionRadius);
  p.xz *= sourceRadius/max(r,.00001);
  return p;
}

vec3 geodesicPoint(float phi, float lutX, vec3 e1, vec3 e2) {
  float lutY = (phi/uMaxPhi*(uLutSize.y-1.0)+.5)/uLutSize.y;
  float inverseRadius = texture2D(uGeodesics,vec2(lutX,lutY)).r;
  return (e1*cos(phi)+e2*sin(phi))/max(inverseRadius,.0001);
}

// Periodic angular coordinates remove the atan seam. Each radius advects
// its own phase at Keplerian angular velocity, omega = k / r^1.5.
vec4 diskAtTime(vec3 p, vec3 ray, float order, float flowTime) {
  p = decisionDiskPoint(p);
  float route = 1.0-clamp(uDecisionComparing,0.0,1.0);
  float amount = clamp(uDecisionActive,0.0,1.0);
  float horizon = clamp(uDecisionHorizon,0.0,1.0)*route*amount;
  float branch = clamp(uDecisionBranch,0.0,2.0);
  float r = length(p.xz);
  float inner = smoothstep(2.95,3.24,r);
  float outer = 1.0-smoothstep(8.0,14.5,r);
  float phase = atan(p.z,p.x) - flowTime * 1.9 * uDecisionFlow / pow(max(r,3.0),1.5);
  phase -= horizon*(.12+.07*r)*(branch*.55+.2);
  vec2 orbit = vec2(cos(phase),sin(phase));
  float turbulence = fbm(orbit*3.7 + vec2(r*.45,r*.7));
  float fine = noise(orbit*13.0 + vec2(r*9.0,-r*5.0));
  // Unequal stream widths: domain-warp the radial coordinate before
  // sampling a multi-scale density field. No evenly spaced concentric rings.
  float radialWarp = r + .20*noise(vec2(r*1.9,0.0)) + .09*turbulence;
  float broad = noise(vec2(radialWarp*5.1,0.0) + orbit*.28);
  float mid = noise(vec2(radialWarp*17.3,4.7) + orbit*.44);
  float thin = noise(vec2(radialWarp*48.0,11.3) + orbit*.7);
  float silk = noise(vec2(radialWarp*103.0,21.7) + orbit*.55);
  // Derivative filtering prevents fine streams from flickering at grazing
  // angles and in the mobile/low-resolution views.
  thin = mix(thin,.5,smoothstep(.3,1.1,fwidth(radialWarp)*48.0));
  silk = mix(silk,.5,smoothstep(.3,1.1,fwidth(radialWarp)*103.0));
  float density = (.08 + .85*pow(broad,1.8) + .7*pow(mid,2.0)
                 + .35*thin + .14*silk) * (.52+.8*turbulence);
  // Split paths open the mid-stream; postponing pushes a little more mass to
  // the outer rim, which makes the long-term cost visible without a badge.
  density *= 1.0 + horizon*(uDecisionEmphasis*.15 + mix(-.04,.12,branch*.5));
  float heat = pow(3.0/max(r,3.0),1.9) * inner * outer;
  heat *= 1.0 + horizon*mix(.045,-.035,branch*.5);
  float beta = .30 * sqrt(3.0/max(r,3.0));
  vec3 velocity = normalize(vec3(-p.z,0.0,p.x));
  float lineVelocity = dot(velocity,-normalize(ray));
  float doppler = sqrt(1.0-beta*beta)/(1.0-beta*lineVelocity);
  float boost = mix(1.0,pow(doppler,3.0),uDoppler);
  float radiance = heat * density * boost * 6.7;
  vec3 warm = mix(vec3(.24,.095,.029), vec3(1.0,.76,.46), clamp(heat*2.0,0.0,1.0));
  warm = mix(warm,vec3(1.0,.955,.86),smoothstep(.55,1.3,radiance));
  float pathColor = clamp(uDecisionActive*(1.0-uDecisionComparing),0.0,1.0);
  vec3 cool = mix(vec3(.73,.83,1.0),vec3(.86,.77,1.0),clamp(branch-1.0,0.0,1.0));
  warm = mix(warm,warm*cool,pathColor*clamp(branch,0.0,1.0)*.36);
  vec3 light = warm * radiance;
  float ink = heat * (.65+.65*density) * (.65+.35*boost);
  // Optical depth varies across the flow; gaps reveal secondary images.
  float opticalDepth = density * (1.6 + heat*2.8) * uDecisionThickness;
  float opacity = inner*outer*(1.0-exp(-opticalDepth));
  // The same material changes absorption/emission with paper transmission.
  vec3 material = mix(vec3(.12,.115,.105)*ink,light,uNight);
  material += (fine-.5)*.009*uNight*outer*inner;
  return vec4(material,opacity * mix(1.0,.60,order));
}

vec4 diskBase(vec3 p, vec3 ray, float order) {
  // Unbounded differential advection winds every stream into subpixel noise
  // after a few minutes. Overlap two finite-age copies of the original field:
  // each copy resets only while fully hidden, with zero blend slope at either
  // end. This retains the original material and angular velocity indefinitely.
  float ageA = mod(uTime + 24.0,48.0) - 24.0;
  float ageB = mod(uTime,48.0) - 24.0;
  float blend = smoothstep(12.0,24.0,abs(ageA));
  vec4 a = diskAtTime(p,ray,order,ageA);
  if (blend <= 0.0) return a;
  vec4 b = diskAtTime(p,ray,order,ageB);
  float opacity = mix(a.a,b.a,blend);
  vec3 emission = mix(a.rgb*a.a,b.rgb*b.a,blend);
  return vec4(emission/max(opacity,.00001),opacity);
}

// AI response light is emission on the same equatorial surface as the disk.
// It therefore follows every geodesic crossing, its occlusion and its optical
// depth. No screen-space halo or displaced horizon is introduced.
float responseBand(float distanceToCurve, float width) {
  float footprint = max(fwidth(distanceToCurve),.001);
  float filteredWidth = sqrt(width*width+footprint*footprint*.65);
  float normalizedDistance = distanceToCurve/filteredWidth;
  return exp(-.5*normalizedDistance*normalizedDistance)*width/filteredWidth;
}

vec2 responseLight(vec3 p) {
  float r = length(p.xz);
  float angle = atan(p.z,p.x);
  float t = uResponseTime;
  float speaking = uResponseReply;
  float breathing = 1.0-uResponseMotion*(.08+.08*cos(t*.73));
  float light = 0.0;
  float spark = 0.0;

  if (uResponseWeights.x > .001) {
    // Broad unequal tide fronts carry soft light through existing material.
    float phase = angle-t*.14;
    float centerA = mix(4.5,5.4,speaking)+.75*sin(phase+.3)+.23*sin(phase*2.0-1.1);
    float centerB = mix(7.0,8.2,speaking)+1.1*sin(phase-1.9);
    float tideA = responseBand(r-centerA,mix(.43,.78,speaking));
    float tideB = responseBand(r-centerB,mix(.64,1.04,speaking));
    float arcA = pow(max(0.0,.5+.5*cos(phase-.65)),2.0);
    float arcB = pow(max(0.0,.5+.5*cos(phase+2.1)),3.0);
    light += (tideA*(.24+.76*arcA)+tideB*arcB*.64)*breathing*uResponseWeights.x;
  }

  if (uResponseWeights.y > .001) {
    // Three tapered filaments, with analytic curvature and derivative-filtered
    // width. Their paths stay finite; no ever-tightening differential winding.
    float filaments = 0.0;
    for (int i=0;i<3;i++) {
      float seed = float(i);
      float phase = angle-t*.19+seed*2.23;
      float curve = 4.0+seed*1.93+(1.0+seed*.22)*sin(phase)+.18*sin(phase*2.0+.7);
      float taper = pow(max(0.0,.5+.5*cos(phase-1.2)),mix(5.0,2.2,speaking));
      float core = responseBand(r-curve,.065+seed*.025);
      float shoulder = responseBand(r-curve,.19+seed*.032)*.23;
      filaments += (core+shoulder)*taper;
    }
    light += filaments*1.85*breathing*uResponseWeights.y;
  }

  if (uResponseWeights.z > .001) {
    // Five sparse grains spiral inward in the disk plane. Every cycle resets
    // while invisible, so waiting longer never accumulates grains or brightness.
    for (int i=0;i<5;i++) {
      float seed = float(i);
      float age = fract(t/(18.0+seed*1.7)+seed*.213);
      float journey = age*age*(3.0-2.0*age);
      float radius = mix(12.2-seed*.23,4.4+seed*.37,journey);
      float orbit = seed*2.399+age*3.2;
      float angularDistance = atan(sin(orbit-angle),cos(orbit-angle));
      float fade = smoothstep(.0,.16,age)*(1.0-smoothstep(.78,1.0,age));
      float tangent = angularDistance*radius;
      float head = responseBand(r-radius,.075)*responseBand(tangent,.095);
      // The tail's larger radius follows the earlier part of the same curved
      // trajectory instead of drawing a straight segment behind the grain.
      float trailRadius = radius+max(angularDistance,0.0)*2.1;
      float tail = responseBand(r-trailRadius,.055)
        *exp(-max(tangent,0.0)/mix(.23,.66,speaking))
        *smoothstep(-.06,.1,tangent)*(1.0-smoothstep(.9,2.5,tangent));
      float merge = responseBand(r-(4.4+seed*.37),.17)
        *pow(max(0.0,.5+.5*cos(angle-orbit)),12.0)*smoothstep(.62,.84,age)
        *(1.0-smoothstep(.88,1.0,age));
      spark += (head*6.0+tail*1.4)*fade*uResponseWeights.z;
      light += merge*.8*speaking*uResponseWeights.z;
    }
  }
  return vec2(light,spark);
}

vec4 disk(vec3 p, vec3 ray, float order) {
  vec4 material = diskBase(p,ray,order);
  // Exact zero restores the original material path, including after a fade.
  if (uResponseStrength <= 0.0) return material;
  vec3 decisionP = decisionDiskPoint(p);
  float r = length(decisionP.xz);
  vec2 response = responseLight(decisionP);
  float aperture = smoothstep(3.05,3.65,r)*(1.0-smoothstep(11.5,14.2,r));
  float surface = mix(.28,.65,uResponseReply)*response.x;
  float amount = aperture*uResponseStrength;
  // Keep the original fine flow visible inside the soft tide rather than
  // laying a uniform emissive fog over it. HDR light enters existing bloom.
  vec3 warm = vec3(1.0,.83,.57);
  vec3 emission = material.rgb*surface+warm*(surface*.45+response.y*.34);
  material.rgb += emission*amount*uNight;
  // Day mode uses the same paths as a small warm-ink contrast change.
  material.rgb *= 1.0+(surface+response.y*.12)*amount*(1.0-uNight)*.24;
  return material;
}

vec3 sky(vec3 direction, vec2 p) {
  // The two distant star populations drift at different angular speeds.
  // Sampling after geodesic deflection makes their paths stretch into arcs.
  vec3 farDirection = direction;
  farDirection.xz = rotate(uTime*.0032)*farDirection.xz;
  vec2 uv = vec2(atan(farDirection.x,-farDirection.z)/(2.0*PI)+.5,
                 asin(clamp(farDirection.y,-1.0,1.0))/PI+.5);
  vec3 stars = texture2D(uStars,fract(uv)).rgb;
  vec3 distantStars = texture2D(uStars,fract(uv*1.37+vec2(.413+uTime*.00017,.219))).rgb;

  // Sparse, advected interstellar dust: locally luminous filaments alternate
  // with absorbing lanes. Most of the sky retains its deep black floor.
  vec2 skyPlane = vec2(farDirection.x,farDirection.y)*vec2(1.15,1.0);
  vec2 current = skyPlane*4.1+vec2(uTime*.008,-uTime*.004);
  float warp = fbm(current*1.8+vec2(12.7,3.1));
  float clouds = fbm(current*3.2+warp*1.3);
  float filaments = fbm(current*9.0+vec2(warp*2.1,clouds));
  float lane = exp(-pow((skyPlane.x*.58+skyPlane.y*.82+.12+warp*.12)/.19,2.0));
  float veil = lane*pow(max(0.0,clouds-.34),1.7);
  float absorption = smoothstep(.28,.69,filaments);
  vec3 night = vec3(.00045,.00055,.0008);
  night += vec3(.003,.0035,.0045)*veil*absorption;
  night += vec3(.002,.0015,.001)*veil*pow(filaments,3.0);
  // Outside the strong lens, resolve a locally planar star atlas at pixel
  // scale. Near the hole, use the exact curved-ray celestial coordinates.
  vec2 localSkyUv = vUv*.18+vec2(.32+uTime*.000035,.47-uTime*.000012);
  vec3 crispStars = texture2D(uStars,fract(localSkyUv)).rgb;
  float strongLens = 1.0-smoothstep(4.0,7.5,length(p));
  night += mix(crispStars,stars,strongLens)*.42 + distantStars*.012*strongLens;
  float grain = hash(gl_FragCoord.xy)-.5;
  vec3 paper = vec3(.92,.905,.87) + grain*.012;
  float shade = exp(-max(0.0,length(p)-2.5)*.72)*.12;
  paper -= shade;
  return mix(paper,night,smoothstep(.05,.95,uNight));
}

void main() {
  float aspect = uResolution.x/uResolution.y;
  vec2 center = aspect < .8 ? vec2(.5)+(uCenter-vec2(.5))*vec2(.2,6.0) : uCenter;
  float scale = (aspect < .8 ? 13.8 : 10.2)/uZoom;
  vec2 screen = (vUv-center)*vec2(aspect,1.0)*scale;
  vec2 p = rotate(-uRoll)*screen;
  float screenRadius = length(p);
  float bendRegion = smoothstep(3.15,4.6,screenRadius)*(1.0-smoothstep(10.0,19.0,screenRadius));
  float bendAngle = atan(p.y,p.x);
  // Optical distortion changes the incident ray before geodesic lookup. The
  // event-horizon silhouette is untouched; distant stellar rays really move.
  p *= 1.0-uDecisionLens*.24*bendRegion*(.78+.22*cos(bendAngle*2.0+uDecisionBranch));
  // Keep the observer distance fixed; zoom is a stable image-plane framing
  // control, so preset transitions cannot introduce a second hidden motion.
  const float cameraDistance = 30.0;
  vec3 origin = vec3(0.0,cos(uInclination),sin(uInclination))*cameraDistance;
  vec3 forward = -normalize(origin);
  vec3 right = vec3(1,0,0);
  vec3 up = normalize(cross(right,forward));
  vec3 ray = normalize(forward*cameraDistance + right*p.x + up*p.y);
  vec3 e1 = normalize(origin);
  vec3 tangentPart = ray - dot(ray,e1)*e1;
  vec3 e2 = length(tangentPart) > 1e-6 ? normalize(tangentPart) : up;
  float b = uCameraRadius*length(cross(e1,ray))/sqrt(1.0-1.0/uCameraRadius);
  float delta = b-uCriticalImpact;
  float span = delta < 0.0 ? uCriticalImpact : uMaxImpact-uCriticalImpact;
  float q = sign(delta)*pow(abs(delta)/span,1.0/3.0);
  float lutX = ((q+1.0)*.5*(uLutSize.x-1.0)+.5)/uLutSize.x;
  vec4 terminal = texture2D(uTermination,vec2(lutX,.5));
  float phi0 = mod(atan(-e1.y,e2.y)+PI,PI);
  vec3 color = vec3(0.0);
  float transmission = 1.0;
  float hit = 0.0;
  // Keep the event-horizon silhouette geometric. Paper grain belongs in the
  // material paths; moving this boundary with high-frequency noise produces
  // a visibly serrated circle at retina resolution.
  float horizonAA = max(length(vec2(dFdx(b),dFdy(b)))*.8, .00001);
  float shadowCoverage = 1.0-smoothstep(uCriticalImpact-horizonAA,uCriticalImpact+horizonAA,b);
  float swallowed = shadowCoverage;
  if (uLens > .5) {
    for(int i=0;i<3;i++) {
      float phi = phi0+float(i)*PI;
      if(phi >= terminal.r) break;
      if (uDecisionWarp > .00001) {
        // Three bounded Newton steps refine the original plane crossing.
        // With deformation disabled this entire branch is skipped.
        for (int j=0;j<3;j++) {
          if (uQuality < 2.0 && j == 2) break;
          vec3 point = geodesicPoint(phi,lutX,e1,e2);
          float diskRadius = length(point.xz);
          if (diskRadius < 2.7 || diskRadius > 5.0+11.5*uDecisionRadius) break;
          vec3 ahead = geodesicPoint(phi+.006,lutX,e1,e2);
          vec3 behind = geodesicPoint(max(0.0,phi-.006),lutX,e1,e2);
          float residual = point.y-decisionSurfaceHeight(point);
          float derivative = ((ahead.y-decisionSurfaceHeight(ahead))
            -(behind.y-decisionSurfaceHeight(behind)))/.012;
          if (abs(derivative) > .05) phi -= clamp(residual/derivative,-.10,.10);
          phi = clamp(phi,0.00001,max(.00002,terminal.r-.00001));
        }
      }
      float lutY = (phi/uMaxPhi*(uLutSize.y-1.0)+.5)/uLutSize.y;
      float invR = texture2D(uGeodesics,vec2(lutX,lutY)).r;
      float r = 1.0/max(invR,.0001);
      if(r > 2.95 && r < 3.0+11.5*uDecisionRadius) {
        vec3 radial = e1*cos(phi)+e2*sin(phi);
        vec3 tangential = -e1*sin(phi)+e2*cos(phi);
        float row = 1.0/uLutSize.y;
        float w = (texture2D(uGeodesics,vec2(lutX,lutY+row)).r-
                   texture2D(uGeodesics,vec2(lutX,lutY-row)).r)/
                   (2.0*uMaxPhi/(uLutSize.y-1.0));
        vec3 localRay = normalize(-w/sqrt(max(.01,1.0-invR))*radial+invR*tangential);
        vec4 sampleDisk = disk(radial*r,localRay,min(float(i),1.0));
        color += transmission*sampleDisk.rgb*sampleDisk.a;
        transmission *= 1.0-sampleDisk.a;
        hit += 1.0;
      }
    }
    ray = e1*cos(terminal.r)+e2*sin(terminal.r);
  } else {
    float dist = -origin.y/ray.y;
    if(dist > 0.0) {
      if (uDecisionWarp > .00001 && abs(ray.y) > .01) {
        for (int j=0;j<3;j++) {
          vec3 point = origin+ray*dist;
          dist -= clamp((point.y-decisionSurfaceHeight(point))/ray.y,-3.0,3.0);
        }
      }
      vec3 intersect = origin+ray*dist;
      vec4 sampleDisk = disk(intersect,ray,0.0);
      color = sampleDisk.rgb*sampleDisk.a;
      transmission = 1.0-sampleDisk.a;
      hit = sampleDisk.a > 0.0 ? 1.0 : 0.0;
    }
    float directImpact = length(cross(origin,ray));
    float directAA = max(length(vec2(dFdx(directImpact),dFdy(directImpact)))*.8, .00001);
    swallowed = 1.0-smoothstep(1.0-directAA,1.0+directAA,directImpact);
  }
  vec3 background = sky(normalize(ray),p);
  vec3 horizon = mix(vec3(.014,.012,.01),vec3(.00002),uNight);
  color += transmission*mix(background,horizon,swallowed);
  // A subpixel SDF ring has a sharp threshold and a separate decaying
  // scattering shoulder. The radius is the critical impact parameter.
  float theta = atan(p.y,p.x);
  float edge = abs(b-uCriticalImpact);
  float pixel = scale/uResolution.y;
  float ringWidth = max(fwidth(b)*.64,pixel*.42);
  float ring = exp(-.5*pow(edge/ringWidth,2.0));
  float shoulder = exp(-edge*85.0)*.16;
  float ringGrain = .94+.06*noise(vec2(cos(theta),sin(theta))*93.0);
  float side = mix(.65,1.6,smoothstep(-2.6,2.6,p.x));
  color += vec3(1.0,.77,.52)*(ring*.25+shoulder)*ringGrain*side*uNight*transmission*uLens;
  // Long-horizon routes bend the near-horizon light shoulder; this is a
  // shader contribution to the existing lens, not a screen-space icon.
  float decisionShoulder = exp(-edge*42.0)*uDecisionLens*ringGrain;
  color += vec3(1.0,.69,.40)*decisionShoulder*uNight*transmission;
  // Photographic compression preserves fine hot strands, without bloom.
  vec3 mapped = color/(1.0+color);
  vec3 nightColor = pow(max(mapped,vec3(0.0)),vec3(.4545));
  // Ink absorbs light continuously at the thinning outer edge. Adding the
  // paper a second time would create a white halo around the daytime disk.
  vec3 dayColor = color;
  vec3 finalColor = mix(dayColor,nightColor,uNight);
  finalColor += (hash(gl_FragCoord.xy+vec2(7,13))-.5)/255.0;
  gl_FragColor = vec4(clamp(finalColor,0.0,1.0),1.0);
}
`
