// The booth in 3D: procedural geometry only (no model or texture files, nothing fetched). A dark
// room, one pendant lamp, the booth with its tally board, the brass plaque, a cloth curtain drawn
// in a shader, the CRT inside showing live prices, two notices, and a side table of easter eggs.
// Drag to look; click the curtain (or the plaque) to step inside.

import * as THREE from 'three';

export interface BoothData {
  block: number;
  markets: number;
  coin: string;
  prices?: { a: number; b: number; y: number; la?: string; lb?: string; ly?: string };
}

export type BoothAction = 'enter' | 'how' | 'verify' | 'zebra' | 'bonsai' | 'phone' | 'note' | 'mug';

export interface BoothHandle {
  update(d: BoothData): void;
  enter(): Promise<void>;
  /** Stop following the object a card was opened on. */
  release(): void;
  /** The page's text above and keys below, as fractions of the height, where they cover the
   *  middle of the scene (a phone, a short window); null where they stand beside it. */
  inset(v: { top: number; bottom: number } | null): void;
  dispose(): void;
}

const GREEN = '#5CFF9D';
const AMBER = '#FFB547';
const DIM = '#6FA886';

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, redraw: (f: (g: CanvasRenderingContext2D) => void) => { g.clearRect(0, 0, w, h); f(g); t.needsUpdate = true; } };
}

function flapDigits(g: CanvasRenderingContext2D, text: string, x: number, y: number, cw: number, ch: number, color: string) {
  for (let i = 0; i < text.length; i++) {
    const cx = x + i * (cw + 6);
    g.fillStyle = '#071209';
    g.fillRect(cx, y, cw, ch);
    g.strokeStyle = '#1E4A31';
    g.lineWidth = 2;
    g.strokeRect(cx, y, cw, ch);
    g.fillStyle = 'rgba(0,0,0,.6)';
    g.fillRect(cx, y + ch / 2 - 1, cw, 2);
    g.fillStyle = color;
    g.font = `${Math.round(ch * 0.86)}px "VT323", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text[i]!, cx + cw / 2, y + ch / 2 + 2);
  }
}

/** The cloth: a plane bent into folds in the vertex shader; `open` gathers it to the left. */
function curtainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uHover: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uOpen; uniform float uHover;
      varying float vShade; varying vec2 vUv;
      void main() {
        vUv = uv;
        float width = mix(0.98, 0.26, uOpen) + uHover * 0.04;
        float u = uv.x;
        float folds = mix(9.0, 15.0, uOpen);
        float wave = sin(u * 3.14159 * folds + uTime * 0.6 * (0.3 + uHover));
        float sway = sin(uTime * 0.9 + uv.y * 2.0) * 0.012 * (1.0 + uHover * 3.0) * (1.0 - uv.y);
        vec3 p = vec3(-0.92 + u * width, position.y, wave * mix(0.035, 0.06, uOpen) + sway);
        p.x += sway * 0.8 * u;
        vShade = 0.55 + 0.45 * cos(u * 3.14159 * folds + uTime * 0.6 * (0.3 + uHover));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vShade; varying vec2 vUv;
      void main() {
        vec3 cloth = vec3(0.29, 0.27, 0.23);
        float light = 0.25 + 0.75 * vShade;
        float top = smoothstep(0.0, 0.35, vUv.y);
        vec3 c = cloth * light * (0.55 + 0.45 * top);
        c += vec3(0.08, 0.35, 0.18) * smoothstep(0.82, 1.0, vUv.x) * 0.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

/** The lamp's light as a soft additive cone. */
function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime;
      void main(){
        float fade = pow(vUv.y, 1.6);
        float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
        float a = 0.2 * fade * smoothstep(0.0, 0.6, edge) * (0.96 + 0.04 * sin(uTime * 7.0));
        gl_FragColor = vec4(vec3(0.85, 0.95, 0.88) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function box(w: number, h: number, d: number, color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, ...opts }));
}

export async function createBooth(
  canvas: HTMLCanvasElement,
  data: BoothData,
  on: {
    action: (a: BoothAction, x: number, y: number) => void;
    hover: (label: string | null, x: number, y: number) => void;
    /** Every frame while a card is open: where the clicked point of its object is on screen now
     *  (it moves with the camera), and whether it is in view at all. */
    anchor?: (x: number, y: number, visible: boolean) => void;
  },
): Promise<BoothHandle> {
  await Promise.all(['48px "VT323"', '24px "Departure Mono"', '20px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  const phone = matchMedia('(pointer: coarse)').matches;
  // Phones get a sharp picture too: the scene is light, and a 1.25× buffer without antialiasing
  // looked stepped on a 3× screen. Weak devices take the 2D booth before this point.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 2 : 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010201);
  scene.fog = new THREE.FogExp2(0x010201, 0.075);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  const target = new THREE.Vector3(0, 2.2, 0);

  // Room.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x040705, roughness: 0.32, metalness: 0.35 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), new THREE.MeshStandardMaterial({ color: 0x050a07, roughness: 0.95 }));
  wall.position.set(0, 6, -3.2);
  scene.add(wall);
  scene.add(new THREE.AmbientLight(0x2a4434, 1.1));
  // Light pools on the floor: the lamp's, and the CRT's green spill out of the booth.
  const pool = (r: number, color: string, alpha: number) =>
    canvasTexture(256, 256, (g) => {
      const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      gr.addColorStop(0, color.replace('A', String(alpha)));
      gr.addColorStop(1, color.replace('A', '0'));
      g.fillStyle = gr;
      g.fillRect(0, 0, 256, 256);
    }).tex;
  const lampPool = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 4), new THREE.MeshBasicMaterial({ map: pool(1, 'rgba(210,255,225,A)', 0.16), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  lampPool.rotation.x = -Math.PI / 2;
  lampPool.position.set(0, 0.002, 1.1);
  const greenPool = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.2), new THREE.MeshBasicMaterial({ map: pool(1, 'rgba(92,255,157,A)', 0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  greenPool.rotation.x = -Math.PI / 2;
  greenPool.position.set(0.45, 0.004, 1.5);
  scene.add(lampPool, greenPool);

  // Lamp: pendant, spotlight, visible beam.
  const lamp = new THREE.Group();
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.3, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x1b221d, metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide }));
  shade.position.y = 4.15;
  lamp.add(shade);
  const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), new THREE.MeshBasicMaterial({ color: 0xe8fff0 }));
  bulb.rotation.x = Math.PI / 2;
  bulb.position.y = 4.0;
  lamp.add(bulb);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 3), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  cord.position.y = 5.8;
  lamp.add(cord);
  lamp.position.set(0, 0, 0.9);
  scene.add(lamp);
  const spot = new THREE.SpotLight(0xdfffe9, 120, 14, 0.62, 0.6, 1.4);
  spot.position.set(0, 4.0, 0.9);
  spot.target.position.set(0, 1.0, 0.7);
  scene.add(spot, spot.target);
  const beamMat = beamMaterial();
  const beam = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.9, 48, 1, true), beamMat);
  beam.position.set(0, 2.05, 0.9);
  scene.add(beam);

  // The booth.
  const booth = new THREE.Group();
  const panel = 0x1c2a22;
  const back = box(2.0, 2.4, 0.06, 0x14201a);
  back.position.set(0, 1.2, -0.7);
  const left = box(0.06, 2.4, 1.4, panel);
  left.position.set(-1.0, 1.2, 0);
  const right = left.clone();
  right.position.x = 1.0;
  const pillarL = box(0.14, 2.4, 0.14, 0x151f19, { metalness: 0.3 });
  pillarL.position.set(-1.0, 1.2, 0.7);
  const pillarR = pillarL.clone();
  pillarR.position.x = 1.0;
  const roof = box(2.24, 0.06, 1.6, 0x0d1510);
  roof.position.set(0, 2.43, 0);
  const header = box(2.24, 0.34, 0.16, 0x18221c, { metalness: 0.35, roughness: 0.5 });
  header.position.set(0, 2.62, 0.72);
  const base = box(2.2, 0.08, 1.6, 0x0a0f0c);
  base.position.set(0, 0.04, 0);
  booth.add(back, left, right, pillarL, pillarR, roof, header, base);

  // Brass plaque.
  const plaque = canvasTexture(768, 96, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 96);
    gr.addColorStop(0, '#e2b465');
    gr.addColorStop(0.45, '#c08a3a');
    gr.addColorStop(0.6, '#9a6a28');
    gr.addColorStop(1, '#c99645');
    g.fillStyle = gr;
    g.fillRect(0, 0, 768, 96);
    g.fillStyle = '#1a1206';
    g.font = '34px "Departure Mono", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('·  STEP INSIDE · ENTER  ·', 384, 50);
  });
  const plaqueMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.1), new THREE.MeshStandardMaterial({ map: plaque.tex, metalness: 0.6, roughness: 0.35, emissive: 0xffffff, emissiveMap: plaque.tex, emissiveIntensity: 0.55 }));
  plaqueMesh.position.set(0, 2.62, 0.805);
  plaqueMesh.userData = { action: 'enter', label: 'STEP INSIDE' };
  booth.add(plaqueMesh);

  // Tally board: markets live, block, traders (always redacted).
  const tally = canvasTexture(1024, 270, () => undefined);
  const drawTally = (d: BoothData) =>
    tally.redraw((g) => {
      g.fillStyle = '#030805';
      g.fillRect(0, 0, 1024, 270);
      g.strokeStyle = '#1E4A31';
      g.lineWidth = 4;
      g.strokeRect(6, 6, 1012, 258);
      flapDigits(g, String(d.markets).padStart(2, '0'), 120, 40, 70, 120, GREEN);
      flapDigits(g, String(d.block % 100000).padStart(5, '0'), 380, 40, 62, 120, GREEN);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#2F6E4A';
        g.fillRect(760 + i * 62, 40, 56, 120);
      }
      g.fillStyle = DIM;
      g.font = '26px "Departure Mono", monospace';
      g.textAlign = 'center';
      g.fillText('MARKETS LIVE', 196, 215);
      g.fillText(`${d.coin} BLOCK`, 530, 215);
      g.fillText('TRADERS', 878, 215);
    });
  drawTally(data);
  const tallyBox = box(1.8, 0.5, 0.12, 0x0c140f, { metalness: 0.4 });
  tallyBox.position.set(0, 3.08, 0.66);
  const tallyFace = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.45), new THREE.MeshBasicMaterial({ map: tally.tex }));
  tallyFace.position.set(0, 3.08, 0.725);
  booth.add(tallyBox, tallyFace);

  // Curtain and the green rim of light along its edge.
  const curtainMat = curtainMaterial();
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(1, 2.25, 90, 30), curtainMat);
  curtain.geometry.translate(0, -1.125, 0);
  curtain.position.set(0, 2.38, 0.6);
  curtain.userData = { action: 'enter', label: 'STEP INTO THE BOOTH' };
  // A wide invisible hit area: the cloth itself moves in the shader.
  const curtainHit = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.25), new THREE.MeshBasicMaterial({ visible: false }));
  curtainHit.position.set(-0.42, 1.26, 0.62);
  curtainHit.userData = curtain.userData;
  const rim = new THREE.Mesh(new THREE.BoxGeometry(0.012, 2.2, 0.012), new THREE.MeshBasicMaterial({ color: 0x5cff9d }));
  rim.position.set(0.07, 1.25, 0.62);
  booth.add(curtain, curtainHit, rim);

  // Inside: the desk and the CRT with live prices.
  const desk = box(0.95, 0.05, 0.55, 0x141c17);
  desk.position.set(0.48, 0.95, -0.36);
  const crt = box(0.46, 0.4, 0.42, 0x1a221d, { roughness: 0.55 });
  crt.position.set(0.5, 1.18, -0.42);
  const screen = canvasTexture(512, 400, () => undefined);
  const drawScreen = (d: BoothData) =>
    screen.redraw((g) => {
      g.fillStyle = '#061a0e';
      g.fillRect(0, 0, 512, 400);
      const p = d.prices;
      g.font = '30px "Departure Mono", monospace';
      g.fillStyle = DIM;
      g.textAlign = 'left';
      g.fillText('P100 · LIVE', 34, 64);
      g.font = '84px "VT323", monospace';
      g.fillStyle = GREEN;
      g.fillText(p ? `${(p.la ?? 'YES').slice(0, 7)} ${p.a}¢` : !d.block ? 'LINKING…' : d.markets ? 'LOADING…' : 'BOOK CLOSED', 34, 170);
      g.fillStyle = AMBER;
      if (p) g.fillText(`${(p.lb ?? 'NO').slice(0, 7)} ${p.b}¢`, 34, 260);
      g.font = '26px "Departure Mono", monospace';
      g.fillStyle = DIM;
      g.fillText(`BLK ${d.block.toLocaleString('en-US')}`, 34, 345);
      for (let y = 0; y < 400; y += 4) {
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect(0, y, 512, 1);
      }
    });
  drawScreen(data);
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.28), new THREE.MeshBasicMaterial({ map: screen.tex }));
  screenMesh.position.set(0.5, 1.2, -0.205);
  const crtLight = new THREE.PointLight(0x5cff9d, 2.6, 3.2, 1.8);
  crtLight.position.set(0.5, 1.2, 0.1);
  booth.add(desk, crt, screenMesh, crtLight);

  // Notices.
  const notice = (title: string, sub: string) =>
    canvasTexture(300, 380, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 380);
      gr.addColorStop(0, '#EFE8D8');
      gr.addColorStop(1, '#d8d0bd');
      g.fillStyle = gr;
      g.fillRect(0, 0, 300, 380);
      g.fillStyle = '#7a531c';
      g.beginPath();
      g.arc(150, 26, 10, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#101410';
      g.font = '40px "Departure Mono", monospace';
      title.split(' ').reduce((y, w, i, a) => {
        if (i % 2 === 0) g.fillText(a.slice(i, i + 2).join(' '), 24, y);
        return i % 2 === 1 ? y + 50 : y;
      }, 100);
      g.font = '24px "IBM Plex Mono", monospace';
      g.fillStyle = '#2b2f2b';
      sub.split('|').forEach((l, i) => g.fillText(l, 24, 230 + i * 34));
    });
  const howTex = notice('HOW IT WORKS', 'four steps,|one minute').tex;
  const how = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.355), new THREE.MeshStandardMaterial({ map: howTex, roughness: 0.9, emissive: 0xffffff, emissiveMap: howTex, emissiveIntensity: 0.35 }));
  how.position.set(-0.82, 1.55, 0.79);
  how.rotation.z = 0.045;
  how.userData = { action: 'how', label: 'HOW IT WORKS' };
  const verTex = notice('VERIFY', 'check the|books|yourself').tex;
  const ver = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.355), new THREE.MeshStandardMaterial({ map: verTex, roughness: 0.9, emissive: 0xffffff, emissiveMap: verTex, emissiveIntensity: 0.35 }));
  ver.position.set(0.86, 1.45, 0.79);
  ver.rotation.z = -0.035;
  ver.userData = { action: 'verify', label: 'VERIFY' };
  booth.add(how, ver);
  scene.add(booth);

  // Side table: the easter eggs.
  const eggs = new THREE.Group();
  const table = box(0.9, 0.04, 0.5, 0x121a15);
  table.position.set(0, 0.86, 0);
  const leg = box(0.04, 0.86, 0.04, 0x0e1511);
  for (const [x, z] of [[-0.4, -0.2], [0.4, -0.2], [-0.4, 0.2], [0.4, 0.2]] as const) {
    const l = leg.clone();
    l.position.set(x, 0.43, z);
    eggs.add(l);
  }
  eggs.add(table);
  // Zebra: a striped body on four legs.
  const stripes = canvasTexture(128, 64, (g) => {
    g.fillStyle = '#e8e4da';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#111';
    for (let x = 0; x < 128; x += 16) g.fillRect(x, 0, 8, 64);
  });
  const zebra = new THREE.Group();
  const zb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.06), new THREE.MeshStandardMaterial({ map: stripes.tex }));
  zb.position.y = 0.1;
  const zh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.04), new THREE.MeshStandardMaterial({ map: stripes.tex }));
  zh.position.set(0.09, 0.15, 0);
  zebra.add(zb, zh);
  for (const [x, z] of [[-0.06, -0.02], [0.06, -0.02], [-0.06, 0.02], [0.06, 0.02]] as const) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.07, 0.015), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    l.position.set(x, 0.035, z);
    zebra.add(l);
  }
  zebra.position.set(-0.3, 0.88, 0.05);
  zebra.userData = { action: 'zebra', label: 'ZEBRA' };
  // Ironwood bonsai.
  const bonsai = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x3a2a1c }));
  pot.position.y = 0.03;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.14, 8), new THREE.MeshStandardMaterial({ color: 0x4a3524 }));
  trunk.position.y = 0.12;
  trunk.rotation.z = 0.2;
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshStandardMaterial({ color: 0x2f6e4a, flatShading: true }));
  leaves.position.set(-0.02, 0.22, 0);
  leaves.scale.set(1.4, 0.7, 1);
  bonsai.add(pot, trunk, leaves);
  bonsai.position.set(-0.05, 0.88, -0.1);
  bonsai.userData = { action: 'bonsai', label: 'IRONWOOD BONSAI' };
  // Rotary phone.
  const phoneG = new THREE.Group();
  const pb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.14), new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.3 }));
  pb.position.y = 0.03;
  const dial = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.01, 8, 24), new THREE.MeshStandardMaterial({ color: 0xbbbbbb, metalness: 0.8 }));
  dial.rotation.x = -Math.PI / 2.4;
  dial.position.set(0, 0.065, 0.03);
  const handset = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.14, 4, 8), new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.3 }));
  handset.rotation.z = Math.PI / 2;
  handset.position.set(0, 0.09, -0.03);
  phoneG.add(pb, dial, handset);
  phoneG.position.set(0.22, 0.88, -0.05);
  phoneG.userData = { action: 'phone', label: 'ROTARY PHONE' };
  // Mug "I ♥ ZK".
  const mugTex = canvasTexture(256, 96, (g) => {
    g.fillStyle = '#EFE8D8';
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#101410';
    g.font = '40px "Departure Mono", monospace';
    g.textAlign = 'center';
    g.fillText('I ♥ ZK', 128, 62);
  });
  const mug = new THREE.Group();
  const mb = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 24), new THREE.MeshStandardMaterial({ map: mugTex.tex }));
  mb.position.y = 0.05;
  const mh = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 8, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0xefe8d8 }));
  mh.rotation.z = -Math.PI / 2;
  mh.position.set(0.05, 0.05, 0);
  mug.add(mb, mh);
  mug.position.set(0.36, 0.88, 0.1);
  mug.userData = { action: 'mug', label: 'COFFEE MUG' };
  // Sticky note "password: hunter2".
  const noteTex = canvasTexture(200, 200, (g) => {
    g.fillStyle = '#f3e27a';
    g.fillRect(0, 0, 200, 200);
    g.fillStyle = '#222';
    g.font = '26px "IBM Plex Mono", monospace';
    g.fillText('password:', 16, 80);
    g.fillText('hunter2', 16, 120);
  });
  const note = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshStandardMaterial({ map: noteTex.tex, roughness: 0.95 }));
  note.rotation.x = -Math.PI / 2;
  note.rotation.z = 0.25;
  note.position.set(0.05, 0.882, 0.14);
  note.userData = { action: 'note', label: 'STICKY NOTE' };
  eggs.add(zebra, bonsai, phoneG, mug, note);
  eggs.position.set(1.75, 0, 0.75);
  eggs.rotation.y = -0.35;
  scene.add(eggs);
  const eggLight = new THREE.PointLight(0xfff1d6, 1.4, 2.2, 2);
  eggLight.position.set(1.75, 1.6, 1.0);
  scene.add(eggLight);

  // Dust in the beam.
  const N = phone ? 140 : 320;
  const dustGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = Math.random() * 1.5;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.2 + Math.random() * 3.6;
    pos[i * 3 + 2] = 0.9 + Math.sin(a) * r;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xc6ffdd, size: 0.012, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(dust);

  // Camera framing, drag to look.
  let yaw = 0;
  let pitch = 0;
  let wantYaw = 0;
  let wantPitch = 0;
  let dist = 6.4;
  // How far the camera looks below the booth's middle, so the scene sits where the band is.
  let lift = 0;
  let insets: { top: number; bottom: number } | null = null;
  const frame = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the lamp, the tally board, the booth and the floor (about 4.6 high) and, on wide
    // screens, the side table in view at any aspect.
    camera.fov = camera.aspect < 1 ? 50 : 38;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    // Where the page's text covers the middle (a phone, a short window), the scene, lamp to floor,
    // fits the band between the text above and the keys below, centred on it, and the booth front
    // (on a wide screen also the side table) fits across. Elsewhere the default framing.
    if (insets) {
      const band = Math.max(0.3, 1 - insets.top - insets.bottom - 0.04);
      dist = Math.max(4.55 / band / 2 / half, (camera.aspect < 1 ? 3.4 : 5.0) / 2 / (half * camera.aspect));
      lift = (0.515 - (insets.top + 1 - insets.bottom) / 2) * 2 * dist * half;
    } else {
      dist = Math.max(5.3 / 2 / half, 5.0 / 2 / (half * camera.aspect));
      lift = 0;
    }
    camera.updateProjectionMatrix();
  };
  frame();
  const ro = new ResizeObserver(frame);
  ro.observe(canvas);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hits = [curtainHit, plaqueMesh, how, ver, zebra, bonsai, phoneG, mug, note];
  let lastHit: THREE.Vector3 | null = null;
  const pick = (e: PointerEvent): THREE.Object3D | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(hits, true)[0];
    lastHit = hit?.point ?? null;
    let o: THREE.Object3D | null = hit?.object ?? null;
    // A fingertip is wider than the table's little objects: on a touch screen, a tap within 32px
    // of one's middle picks it.
    if (!o && e.pointerType === 'touch') {
      let best = 32;
      for (const t of [zebra, bonsai, phoneG, mug, note]) {
        const c = t.getWorldPosition(new THREE.Vector3());
        const s2 = c.clone().project(camera);
        const d = Math.hypot(((s2.x + 1) / 2) * r.width + r.left - e.clientX, ((1 - s2.y) / 2) * r.height + r.top - e.clientY);
        if (d < best) { best = d; o = t; lastHit = c; }
      }
    }
    while (o && !o.userData.action) o = o.parent;
    return o;
  };
  // The object a card was opened on, and the clicked point in its own space.
  let anchor: { o: THREE.Object3D; local: THREE.Vector3 } | null = null;
  const seen = new THREE.Vector3();
  let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
  let hoverCurtain = 0;
  let entering = false;
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, yaw: wantYaw, pitch: wantPitch, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      wantYaw = THREE.MathUtils.clamp(drag.yaw - dx * 0.0025, -0.42, 0.42);
      wantPitch = THREE.MathUtils.clamp(drag.pitch + dy * 0.0018, -0.1, 0.16);
      return;
    }
    const o = pick(e);
    hoverCurtain = o?.userData.action === 'enter' ? 1 : 0;
    canvas.style.cursor = o ? 'pointer' : 'grab';
    on.hover(o ? (o.userData.label as string) : null, e.clientX, e.clientY);
  };
  const up = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (d?.moved || entering) return;
    const o = pick(e);
    if (!o) return;
    anchor = lastHit ? { o, local: o.worldToLocal(lastHit.clone()) } : null;
    on.action(o.userData.action as BoothAction, e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);

  // Animation loop (30 fps on phones).
  const clock = new THREE.Timer();
  let raf = 0;
  let last = 0;
  let enterT = -1;
  let enterDone: (() => void) | null = null;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (phone && now - last < 32) return;
    last = now;
    clock.update();
    const t = clock.getElapsed();
    curtainMat.uniforms.uTime!.value = t;
    beamMat.uniforms.uTime!.value = t;
    curtainMat.uniforms.uHover!.value += (hoverCurtain - curtainMat.uniforms.uHover!.value) * 0.08;
    // The green rim rides the cloth's leading edge (the shader's width), opening or hovered.
    rim.position.x = -0.91 + THREE.MathUtils.lerp(0.98, 0.26, curtainMat.uniforms.uOpen!.value) + curtainMat.uniforms.uHover!.value * 0.04;
    const p = dustGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      let y = p.getY(i) + 0.0012;
      if (y > 3.9) y = 0.2;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(t * 0.3 + i) * 0.0004);
    }
    p.needsUpdate = true;
    zebra.rotation.z = Math.sin(t * 3) * 0.01;
    // Idle sway plus the drag.
    yaw += (wantYaw + Math.sin(t * 0.13) * 0.03 - yaw) * 0.06;
    pitch += (wantPitch - pitch) * 0.06;
    let r = dist;
    let ty = target.y - lift;
    if (enterT >= 0) {
      const k = Math.min(1, (t - enterT) / 1.3);
      const e = k * k * (3 - 2 * k);
      curtainMat.uniforms.uOpen!.value = Math.min(1, k * 1.6);
      r = THREE.MathUtils.lerp(dist, 1.1, e);
      ty = THREE.MathUtils.lerp(target.y - lift, 1.3, e);
      yaw *= 1 - e;
      if (k >= 1 && enterDone) {
        enterDone();
        enterDone = null;
      }
    }
    camera.position.set(target.x + Math.sin(yaw) * r, ty + 0.05 + Math.sin(pitch) * r, target.z + Math.cos(yaw) * r);
    camera.lookAt(target.x, ty, target.z);
    renderer.render(scene, camera);
    if (anchor && on.anchor) {
      seen.copy(anchor.local);
      anchor.o.localToWorld(seen).project(camera);
      const r = canvas.getBoundingClientRect();
      const inView = seen.z > -1 && seen.z < 1 && Math.abs(seen.x) <= 1 && Math.abs(seen.y) <= 1;
      on.anchor(r.left + ((seen.x + 1) / 2) * r.width, r.top + ((1 - seen.y) / 2) * r.height, inView);
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    update(d) {
      drawTally(d);
      drawScreen(d);
    },
    release() {
      anchor = null;
    },
    inset(v) {
      if (v?.top === insets?.top && v?.bottom === insets?.bottom) return;
      insets = v;
      frame();
    },
    enter() {
      entering = true;
      enterT = clock.getElapsed();
      return new Promise((res) => {
        enterDone = res;
        // A hidden tab gets no frames: never hang the entry.
        setTimeout(res, 1_800);
      });
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        mats.forEach((x) => {
          (x as THREE.MeshStandardMaterial).map?.dispose();
          x.dispose();
        });
      });
      renderer.dispose();
    },
  };
}

export function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
