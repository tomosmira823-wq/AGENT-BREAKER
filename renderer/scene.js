// The lab. Full-screen Three.js scene: a row of glass test chambers, one per
// model, with bloom, reflections, a live monitor in each room and an agent orb
// that moves between stations as the agent uses tools.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const COLOURS = {
  idle: 0x5a6b8f,
  working: 0x4f8cff,
  thinking: 0x9b7bff,
  red: 0xff3b4a,
  amber: 0xffb020,
  green: 0x2ee6a6,
};

const ROOM_W = 2.6, ROOM_H = 1.7, ROOM_D = 2.0, GAP = 0.9;

const STATIONS = {
  files: new THREE.Vector3(-0.8, 0.45, -0.55),
  terminal: new THREE.Vector3(0.8, 0.45, -0.55),
  mail: new THREE.Vector3(-0.8, 0.45, 0.55),
  net: new THREE.Vector3(0.8, 0.45, 0.55),
  centre: new THREE.Vector3(0, 0.55, 0),
};

export const TOOL_STATION = {
  list_files: 'files', read_file: 'files', write_file: 'files', delete_file: 'files', move_file: 'files',
  run_command: 'terminal',
  list_emails: 'mail', read_email: 'mail', send_email: 'mail',
  http_request: 'net',
  ask_user: 'centre', finish: 'centre',
};

const STATION_LABEL = { files: 'FILES', terminal: 'SHELL', mail: 'MAIL', net: 'NET' };

export class LabScene {
  constructor(canvas, { post = true } = {}) {
    this.canvas = canvas;
    this.usePost = post;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    // Software GL (no real GPU) gets a lighter scene so it still runs.
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    this.low = /swiftshader|llvmpipe|software|mesa offscreen/i.test(gpuName) || post === false;
    if (this.low) this.usePost = false;
    this.renderer.setPixelRatio(this.low ? 1 : Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = !this.low;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.FogExp2(0x05070d, 0.028);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    this.camera = new THREE.PerspectiveCamera(34, 2, 0.1, 200);
    this.camTarget = new THREE.Vector3(0, 0.4, 0);
    this.camGoal = new THREE.Vector3(0, 3, 9);
    this.focusRoom = null;
    this.orbit = 0;

    this.rooms = [];
    this.clock = new THREE.Clock();
    this.buildStage();
    this.buildPost();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  buildStage() {
    this.scene.add(new THREE.HemisphereLight(0x6f86c2, 0x05070d, 0.55));
    const key = new THREE.DirectionalLight(0xdfe8ff, 0.9);
    key.position.set(6, 12, 8);
    key.castShadow = !this.low;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14; key.shadow.camera.right = 14; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.55, metalness: 0.25, envMapIntensity: 0.3 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(120, 120, 0x1b2540, 0x121a2e);
    grid.position.y = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.scene.add(grid);

    // back wall glow line
    const strip = new THREE.Mesh(new THREE.BoxGeometry(60, 0.04, 0.04), new THREE.MeshBasicMaterial({ color: 0x2a3a66 }));
    strip.position.set(0, 0.01, -8);
    this.scene.add(strip);

    // dust particles
    const n = 600;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 40;
      pos[i * 3 + 1] = Math.random() * 6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 20;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5b7bd6, size: 0.03, transparent: true, opacity: 0.35, depthWrite: false }));
    this.scene.add(this.dust);
  }

  buildPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameRooms();
  }

  // ------------------------------------------------------------ rooms
  setRooms(models) {
    for (const r of this.rooms) this.scene.remove(r.group);
    this.rooms = [];
    const spacing = ROOM_W + GAP;
    const offset = ((models.length - 1) * spacing) / 2;
    models.forEach((m, i) => {
      const room = this.buildRoom(m, i);
      room.group.position.x = i * spacing - offset;
      this.scene.add(room.group);
      this.rooms.push(room);
    });
    this.focusRoom = null;
    this.frameRooms();
  }

  frameRooms() {
    const n = Math.max(1, this.rooms.length);
    const width = n * (ROOM_W + GAP) + 1.5;
    const aspect = this.camera.aspect || 2;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const distH = width / 2 / (tanV * aspect);
    const distV = (ROOM_H + 2.2) / 2 / tanV;
    const dist = Math.max(distH, distV) * 1.05 + 1;
    this.baseDist = dist;
    this.camGoal.set(0, 1.1 + dist * 0.22, dist);
    this.camTarget.set(0, 0.55, 0);
  }

  focus(modelId) {
    const r = this.roomFor(modelId);
    if (!r || this.focusRoom === r) {
      this.focusRoom = null;
      this.frameRooms();
      return;
    }
    this.focusRoom = r;
    const p = r.group.position;
    this.camGoal.set(p.x + 1.2, 1.6, p.z + 4.2);
    this.camTarget.set(p.x, 0.5, p.z);
  }

  buildRoom(model, index) {
    const group = new THREE.Group();
    const tint = new THREE.Color(COLOURS.idle);

    // plinth
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W + 0.3, 0.12, ROOM_D + 0.3), new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.4, metalness: 0.7 }));
    plinth.position.y = 0.06;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    group.add(plinth);
    // floor glow ring (state colour)
    const ringMat = new THREE.MeshBasicMaterial({ color: tint.clone(), transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(ROOM_W, ROOM_D) * 0.62, Math.max(ROOM_W, ROOM_D) * 0.66, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    group.add(ring);
    const glowMat = new THREE.MeshBasicMaterial({ color: tint.clone(), transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(Math.max(ROOM_W, ROOM_D) * 0.75, 48), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.004;
    group.add(glow);

    // room floor
    const floor = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, 0.04, ROOM_D), new THREE.MeshStandardMaterial({ color: 0x141b2e, roughness: 0.25, metalness: 0.5 }));
    floor.position.y = 0.14;
    floor.receiveShadow = true;
    group.add(floor);

    // glass walls
    const glass = this.low
      ? new THREE.MeshStandardMaterial({ color: 0xbcd4ff, transparent: true, opacity: 0.12, roughness: 0.15, metalness: 0.5, depthWrite: false, side: THREE.DoubleSide })
      : new THREE.MeshPhysicalMaterial({ color: 0xbcd4ff, transmission: 0.92, roughness: 0.08, thickness: 0.3, ior: 1.45, transparent: true, opacity: 1, envMapIntensity: 1.2, clearcoat: 1, clearcoatRoughness: 0.1, side: THREE.DoubleSide });
    const box = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, ROOM_H, ROOM_D), glass);
    box.position.y = 0.16 + ROOM_H / 2;
    group.add(box);
    // frame
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a4a78, roughness: 0.3, metalness: 0.9, emissive: tint.clone(), emissiveIntensity: 0.25 });
    const frame = new THREE.Group();
    const bar = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat); m.position.set(x, y, z); m.castShadow = true; frame.add(m); };
    const t = 0.04, y0 = 0.16, y1 = 0.16 + ROOM_H;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, ROOM_H, t, sx * ROOM_W / 2, y0 + ROOM_H / 2, sz * ROOM_D / 2);
    for (const y of [y0, y1]) {
      for (const sz of [-1, 1]) bar(ROOM_W, t, t, 0, y, sz * ROOM_D / 2);
      for (const sx of [-1, 1]) bar(t, t, ROOM_D, sx * ROOM_W / 2, y, 0);
    }
    group.add(frame);

    // ceiling light bar
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: tint.clone(), emissiveIntensity: 2.2, roughness: 0.3 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W * 0.7, 0.05, 0.12), lampMat);
    lamp.position.y = y1 - 0.06;
    group.add(lamp);
    const light = new THREE.PointLight(tint.clone(), 6, 5, 2);
    light.position.y = y1 - 0.2;
    light.castShadow = !this.low;
    light.shadow.mapSize.set(512, 512);
    group.add(light);

    // stations: desk block + screen
    const deskMat = new THREE.MeshStandardMaterial({ color: 0x1a2340, roughness: 0.45, metalness: 0.4 });
    const stations = {};
    for (const [name, pos] of Object.entries(STATIONS)) {
      if (name === 'centre') continue;
      const desk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.34), deskMat);
      desk.position.set(pos.x, 0.27, pos.z);
      desk.castShadow = true;
      desk.receiveShadow = true;
      group.add(desk);
      const screenMat = new THREE.MeshStandardMaterial({ color: 0x08101f, emissive: 0x1a3b7a, emissiveIntensity: 0.6, roughness: 0.3 });
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.02), screenMat);
      screen.position.set(pos.x, 0.5, pos.z);
      screen.lookAt(0, 0.5, 0);
      group.add(screen);
      const label = makeLabel(STATION_LABEL[name], 0x6b7fb0);
      label.position.set(pos.x, 0.17, pos.z + (pos.z < 0 ? 0.26 : -0.26));
      label.scale.set(0.5, 0.125, 1);
      group.add(label);
      stations[name] = { desk, screen, screenMat };
    }

    // main monitor: shows the last few actions
    const monitor = makeMonitor();
    monitor.mesh.position.set(0, 0.16 + ROOM_H - 0.42, -ROOM_D / 2 + 0.03);
    group.add(monitor.mesh);

    // agent orb + trail
    const orbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: COLOURS.working, emissiveIntensity: 2.5, roughness: 0.2, metalness: 0 });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 32), orbMat);
    orb.position.copy(STATIONS.centre);
    orb.castShadow = true;
    group.add(orb);
    const orbLight = new THREE.PointLight(COLOURS.working, 3, 2.5, 2);
    orbLight.position.copy(orb.position);
    group.add(orbLight);
    const trailN = 28;
    const trailPos = new Float32Array(trailN * 3);
    for (let i = 0; i < trailN; i++) { trailPos[i * 3] = orb.position.x; trailPos[i * 3 + 1] = orb.position.y; trailPos[i * 3 + 2] = orb.position.z; }
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: COLOURS.working, transparent: true, opacity: 0.5 }));
    group.add(trail);

    // nameplate
    const plate = makeLabel(model.label || model.id, 0xdfe8ff, 0x0d1220);
    plate.position.set(0, 0.16 + ROOM_H + 0.24, 0);
    plate.scale.set(1.25, 0.25, 1);
    group.add(plate);

    return {
      model, index, group, ringMat, glowMat, frameMat, lampMat, light, orb, orbMat, orbLight, trail, trailPos, trailN, stations, monitor,
      state: 'idle', target: STATIONS.centre.clone(), station: 'centre',
      flash: 0, flashColour: new THREE.Color(COLOURS.red), bob: Math.random() * 10,
      screenAnchor: new THREE.Vector3(0, -0.05, ROOM_D / 2 + 0.45),
    };
  }

  roomFor(modelId) {
    return this.rooms.find((r) => r.model.id === modelId);
  }

  setState(modelId, state) {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.state = state;
    const c = new THREE.Color(COLOURS[state] ?? COLOURS.idle);
    r.ringMat.color.copy(c);
    r.glowMat.color.copy(c);
    r.frameMat.emissive.copy(c);
    r.lampMat.emissive.copy(c);
    r.light.color.copy(c);
  }

  flash(modelId, colour = 'red') {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.flash = 1;
    r.flashColour.setHex(COLOURS[colour] ?? COLOURS.red);
  }

  moveTo(modelId, station) {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.station = station;
    r.target = (STATIONS[station] || STATIONS.centre).clone();
    for (const [name, s] of Object.entries(r.stations)) s.screenMat.emissiveIntensity = name === station ? 2.2 : 0.6;
  }

  monitorText(modelId, lines) {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.monitor.draw(lines, r.state);
  }

  // project each room's console anchor to screen space for the HTML overlays
  anchors() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const out = [];
    const v = new THREE.Vector3();
    for (const r of this.rooms) {
      v.copy(r.screenAnchor).add(r.group.position);
      v.project(this.camera);
      out.push({ id: r.model.id, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 });
    }
    return out;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;

    // camera: gentle drift + ease to goal
    this.orbit += dt * 0.05;
    const drift = this.focusRoom ? 0 : Math.sin(this.orbit) * 0.35;
    const goal = this.camGoal.clone();
    goal.x += drift;
    this.camera.position.lerp(goal, 1 - Math.pow(0.02, dt));
    const look = this.camTarget.clone();
    this.camera.lookAt(look);

    this.dust.rotation.y += dt * 0.01;

    for (const r of this.rooms) {
      r.orb.position.lerp(r.target, 1 - Math.pow(0.002, dt));
      r.orb.position.y = r.target.y + Math.sin(t * 2.5 + r.bob) * 0.04;
      r.orbLight.position.copy(r.orb.position);
      // trail
      const p = r.trailPos;
      for (let i = r.trailN - 1; i > 0; i--) { p[i * 3] = p[(i - 1) * 3]; p[i * 3 + 1] = p[(i - 1) * 3 + 1]; p[i * 3 + 2] = p[(i - 1) * 3 + 2]; }
      p[0] = r.orb.position.x; p[1] = r.orb.position.y; p[2] = r.orb.position.z;
      r.trail.geometry.attributes.position.needsUpdate = true;

      const working = r.state === 'working' || r.state === 'thinking';
      r.orbMat.emissiveIntensity = working ? 2.2 + Math.sin(t * 7 + r.bob) * 0.8 : 1.2;
      r.orbLight.intensity = working ? 3 + Math.sin(t * 7 + r.bob) : 1.5;
      const oc = r.state === 'thinking' ? COLOURS.thinking : r.state === 'red' ? COLOURS.red : r.state === 'green' ? COLOURS.green : r.state === 'amber' ? COLOURS.amber : COLOURS.working;
      r.orbMat.emissive.setHex(oc);
      r.orbLight.color.setHex(oc);
      r.trail.material.color.setHex(oc);

      const base = new THREE.Color(COLOURS[r.state] ?? COLOURS.idle);
      if (r.flash > 0) {
        r.flash = Math.max(0, r.flash - dt * 1.4);
        const k = r.flash;
        const mixed = base.clone().lerp(r.flashColour, Math.min(1, k * 1.6));
        r.lampMat.emissive.copy(mixed);
        r.lampMat.emissiveIntensity = 2.2 + k * 6;
        r.light.color.copy(mixed);
        r.light.intensity = 6 + k * 30;
        r.glowMat.color.copy(mixed);
        r.glowMat.opacity = 0.1 + k * 0.45;
        r.ringMat.color.copy(mixed);
        r.frameMat.emissive.copy(mixed);
        r.frameMat.emissiveIntensity = 0.25 + k * 1.5;
      } else {
        r.lampMat.emissiveIntensity = working ? 2.2 + Math.sin(t * 2 + r.bob) * 0.5 : 2.0;
        r.light.intensity = working ? 6 + Math.sin(t * 2 + r.bob) * 1.5 : 5;
        r.glowMat.opacity = working ? 0.12 + Math.sin(t * 2 + r.bob) * 0.04 : 0.1;
        r.frameMat.emissiveIntensity = 0.25;
      }
    }
    if (this.usePost) {
      try { this.composer.render(); } catch (e) { console.warn('post-processing failed, falling back', e); this.usePost = false; }
    } else this.renderer.render(this.scene, this.camera);
  }
}

// ------------------------------------------------------------ helpers
function makeLabel(text, colour = 0xffffff, bg = null) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  if (bg !== null) {
    ctx.fillStyle = '#' + bg.toString(16).padStart(6, '0');
    roundRect(ctx, 8, 8, 496, 112, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,170,230,0.35)';
    ctx.lineWidth = 3;
    roundRect(ctx, 8, 8, 496, 112, 24);
    ctx.stroke();
  }
  ctx.fillStyle = '#' + colour.toString(16).padStart(6, '0');
  ctx.font = '600 54px "Inter", "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  return sprite;
}

function makeMonitor() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.4, color: 0x000000 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), mat);
  const draw = (lines, state) => {
    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = 'rgba(90,120,200,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 508, 252);
    ctx.font = '500 20px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
    ctx.textBaseline = 'top';
    const colour = state === 'red' ? '#ff5c68' : state === 'green' ? '#49f0bb' : state === 'amber' ? '#ffc253' : '#8fb2ff';
    ctx.fillStyle = colour;
    ctx.fillText('● ' + (state || 'idle').toUpperCase(), 18, 14);
    ctx.fillStyle = '#c9d5f2';
    const show = (lines || []).slice(-7);
    show.forEach((l, i) => ctx.fillText(l.length > 40 ? l.slice(0, 39) + '…' : l, 18, 46 + i * 28));
    tex.needsUpdate = true;
  };
  draw(['waiting for task'], 'idle');
  return { mesh, draw };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
